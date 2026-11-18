import { randomUUID } from "crypto";
import type {
  CanonicalCacheHint,
  CanonicalDocument,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalContentPart,
  CanonicalError,
  CanonicalErrorKind,
  CanonicalImageMimeType,
  CanonicalModelList,
  CanonicalResponseFormat,
  CanonicalToolChoice,
  CanonicalUsage,
  ProviderAdapter,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { UpstreamError, ValidationError } from "../../utils/errors";
import { currentAttempt, recordNote } from "../../observe/context";
import type { TranslationNote } from "../../observe/trace";
import type { Gap } from "../../config/provider-presets";
import { systemText } from "../system-text";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionMessageParam,
  OpenAICompatibleUsage,
} from "../../types/openai.types";
import { isSchemaObject } from "../response-format";
import { decodeOrigin, originMatchesCurrent } from "../reasoning-origin";
import { EFFORT_LADDER, type Effort } from "../reasoning-effort";
import {
  createStreamDecoder,
  createStreamEncoder,
} from "./openai.stream";

import type { MediaSupport } from "../../services/media-inline";

/**
 * Chat Completions media support (v1.5 spec §3.2.2):
 *  - `image_url.url` takes remote http(s) URLs —
 *    https://platform.openai.com/docs/guides/images-vision
 *  - `file` carries base64 `file_data` only — no file_url field —
 *    https://platform.openai.com/docs/guides/pdf-files
 *  - tool messages take text content parts only
 *    (ChatCompletionToolMessageParam —
 *    https://platform.openai.com/docs/api-reference/chat/create).
 */
export const MEDIA_SUPPORT: MediaSupport = {
  imageUrl: true,
  documentData: true,
  documentUrl: false,
  toolMessageImages: false,
};

export const openaiAdapter: ProviderAdapter<
  ChatCompletionRequest,
  ChatCompletionResponse
> = {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
  toCanonicalModelList,
  fromCanonicalModelList,
  toCanonicalError,
  fromCanonicalError,
  createStreamDecoder,
  createStreamEncoder,
};

// ============ REQUEST: OpenAI → Canonical ============

type CanonicalReasoning = NonNullable<
  NonNullable<CanonicalRequest["config"]>["reasoning"]
>;

/**
 * `reasoning_effort` → `config.reasoning.effort` (v1.5 spec §3.1;
 * field per
 * https://platform.openai.com/docs/api-reference/chat/create#chat-create-reasoning_effort).
 * The shared OpenAI vocabulary (ReasoningEffort in shared.d.ts) is
 * the canonical ladder plus `"max"`, which has no canonical slot →
 * `xhigh` with a note (the Responses decoder's convention); an
 * unknown or non-string value keeps a `field_dropped` note.
 */
function toCanonicalReasoning(
  request: ChatCompletionRequest,
): CanonicalReasoning | undefined {
  const effort = request.reasoning_effort;
  if (effort === undefined || effort === null) return undefined;
  if (typeof effort === "string") {
    if ((EFFORT_LADDER as readonly string[]).includes(effort)) {
      return { effort: effort as Effort };
    }
    if (effort === "max") {
      recordNote(
        {
          stage: "decode",
          adapter: "openai",
          code: "reasoning_effort_lowered",
          path: "reasoning_effort",
        },
        'Lowering reasoning effort "max" to "xhigh" (canonical maximum)',
      );
      return { effort: "xhigh" };
    }
  }
  recordNote(
    {
      stage: "decode",
      adapter: "openai",
      code: "field_dropped",
      path: "reasoning_effort",
    },
    'Dropping request field "reasoning_effort" (not a level string)',
  );
  return undefined;
}

export function toCanonicalRequest(
  request: ChatCompletionRequest,
): CanonicalRequest {
  const reasoning = toCanonicalReasoning(request);
  const messages: CanonicalMessage[] = [];
  let systemPrompt: string | undefined;

  for (const [messageIndex, msg] of request.messages.entries()) {
    if (msg.role === "system") {
      systemPrompt = extractTextContent(msg);
    }
    messages.push(convertToCanonicalMessage(msg, messageIndex));
  }

  // Canonical has no field for `parallel_tool_calls` (a spec
  // non-goal) — make the drop visible instead of silent, same as
  // Anthropic's `disable_parallel_tool_use` (task 9).
  if (request.parallel_tool_calls !== undefined) {
    recordNote(
      {
        stage: "decode",
        adapter: "openai",
        code: "parallel_tool_calls_dropped",
        path: "parallel_tool_calls",
      },
      'Dropping request field "parallel_tool_calls" (no canonical equivalent)',
    );
  }

  const responseFormat = toCanonicalResponseFormat(
    request.response_format,
  );

  return {
    model: request.model,
    messages,
    ...(responseFormat !== undefined && { responseFormat }),
    ...(systemPrompt && { systemPrompt }),
    config: {
      ...(request.temperature !== undefined &&
        request.temperature !== null && { temperature: request.temperature }),
      ...(request.max_tokens !== undefined &&
        request.max_tokens !== null && { maxTokens: request.max_tokens }),
      ...(request.top_p !== undefined &&
        request.top_p !== null && { topP: request.top_p }),
      ...(request.stop && {
        stopSequences: Array.isArray(request.stop)
          ? request.stop
          : [request.stop],
      }),
      ...(request.n !== undefined &&
        request.n !== null && { candidateCount: request.n }),
      ...(request.seed !== undefined &&
        request.seed !== null && { seed: request.seed }),
      ...(request.frequency_penalty !== undefined &&
        request.frequency_penalty !== null && {
          frequencyPenalty: request.frequency_penalty,
        }),
      ...(request.presence_penalty !== undefined &&
        request.presence_penalty !== null && {
          presencePenalty: request.presence_penalty,
        }),
      ...(reasoning !== undefined && { reasoning }),
    },
    ...(request.stream === true && { stream: true }),
    ...(request.stream === false && { stream: false }),
    ...(request.tools && { tools: toCanonicalTools(request.tools) }),
    ...(request.tool_choice !== undefined && {
      toolChoice: toCanonicalToolChoice(request.tool_choice),
    }),
  };
}

/**
 * `response_format` → canonical `responseFormat` (v1.4 spec §3.5).
 * Wire fields per the Chat Completions reference
 * (https://platform.openai.com/docs/api-reference/chat/create):
 * `{type:"json_schema", json_schema:{name, schema, strict?,
 * description?}}`, `{type:"json_object"}`; `{type:"text"}` is the
 * documented default — no constraint, decoded silently. The schema
 * object passes through by reference — never cloned or rewritten.
 */
function toCanonicalResponseFormat(
  format: ChatCompletionRequest["response_format"],
): CanonicalResponseFormat | undefined {
  if (format === undefined || format === null) return undefined;
  const f = format as unknown as Record<string, unknown>;
  if (f.type === "text") return undefined;
  if (f.type === "json_object") return { type: "json_object" };
  if (f.type === "json_schema" && isSchemaObject(f.json_schema)) {
    const js = f.json_schema;
    if (
      typeof js.name === "string" &&
      js.name !== "" &&
      isSchemaObject(js.schema)
    ) {
      return {
        type: "json_schema",
        name: js.name,
        schema: js.schema,
        ...(typeof js.strict === "boolean" && { strict: js.strict }),
        ...(typeof js.description === "string" && {
          description: js.description,
        }),
      };
    }
  }
  recordNote(
    {
      stage: "decode",
      adapter: "openai",
      code: "field_dropped",
      path: "response_format",
    },
    "Dropping an unsupported response_format value",
  );
  return undefined;
}

function toCanonicalTools(
  tools: NonNullable<ChatCompletionRequest["tools"]>,
): CanonicalRequest["tools"] {
  return tools.map((tool, index) => {
    if (tool.type !== "function" || !("function" in tool)) {
      throw new ValidationError(
        `Unsupported OpenAI tool type "${String(tool.type)}"`,
      );
    }
    // `strict` has no canonical equivalent — dropped, but visibly.
    if (tool.function.strict != null) {
      recordNote(
        {
          stage: "decode",
          adapter: "openai",
          code: "tool_strict_dropped",
          path: `tools[${index}].function.strict`,
        },
        'Dropping tool field "strict" (no canonical equivalent)',
      );
    }
    return {
      type: "function" as const,
      function: {
        name: tool.function.name,
        ...(tool.function.description !== undefined && {
          description: tool.function.description,
        }),
        ...(tool.function.parameters !== undefined && {
          parameters: tool.function.parameters,
        }),
      },
    };
  });
}

function toCanonicalToolChoice(
  choice: NonNullable<ChatCompletionRequest["tool_choice"]>,
): CanonicalToolChoice {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  if (
    typeof choice === "object" &&
    choice.type === "function" &&
    typeof choice.function?.name === "string"
  ) {
    return { type: "function", function: { name: choice.function.name } };
  }
  throw new ValidationError(
    `Unsupported OpenAI tool_choice "${
      typeof choice === "object" ? String(choice.type) : String(choice)
    }"`,
  );
}

function convertToCanonicalMessage(
  msg: ChatCompletionMessageParam,
  messageIndex = 0,
): CanonicalMessage {
  const base: CanonicalMessage = {
    role: msg.role as CanonicalMessage["role"],
    content: "",
  };

  // v1.5 spec §3.1 (Task 5) + conductor's call (b): a client-echoed
  // `reasoning_content` (the DeepSeek/OpenRouter field our replies
  // now carry) arrives with no origin — no encoder could ever send
  // it — so it drops with a `reasoning_dropped` note naming the
  // path. Not in the SDK's assistant-param type; the field is real
  // on the wire the same way it is in responses.
  if (msg.role === "assistant") {
    const returned = (msg as { reasoning_content?: unknown })
      .reasoning_content;
    if (typeof returned === "string" && returned !== "") {
      recordNote(
        {
          stage: "decode",
          adapter: "openai",
          code: "reasoning_dropped",
          path: `messages[${messageIndex}].reasoning_content`,
        },
        'Dropping "reasoning_content" on an assistant message (no origin — it can never be sent on)',
      );
    }
  }

  if ("content" in msg && msg.content !== null) {
    if (typeof msg.content === "string") {
      base.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      base.content = msg.content.map(convertToCanonicalPart);
    }
  }

  if ("tool_calls" in msg && msg.tool_calls) {
    base.toolCalls = msg.tool_calls.map((tc) => {
      if (tc.type !== "function" || !("function" in tc)) {
        // e.g. type:"custom" — no canonical equivalent; 400 naming
        // the type rather than silently filtering the call out.
        throw new ValidationError(
          `OpenAI tool call type "${String(tc.type)}" is not supported`,
        );
      }
      return {
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      };
    });
  }

  if ("tool_call_id" in msg && msg.tool_call_id) {
    base.toolCallId = msg.tool_call_id;
  }

  if ("name" in msg && msg.name) {
    base.name = msg.name;
  }

  return base;
}

/**
 * A `data:` URL → base64 + mime; anything else is undefined. File and
 * image parts share the shape (spec §3.2.2 decode).
 */
function parseDataUrl(
  url: string,
): { data: string; mimeType: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match === null
    ? undefined
    : { data: match[2], mimeType: match[1] };
}

/**
 * `file` part → document (v1.5 spec §3.2.2): `file_data` carries a
 * `data:` URL or raw base64 — raw base64 is a PDF per
 * https://platform.openai.com/docs/guides/pdf-files (the only file
 * type the reference documents). `file_id` is a stored-file
 * reference the proxy cannot resolve — refused, never silently
 * dropped.
 */
function toCanonicalDocument(file: {
  file_data?: string;
  file_id?: string;
  filename?: string;
}): CanonicalDocument {
  const name =
    typeof file.filename === "string" && file.filename !== ""
      ? { name: file.filename }
      : {};
  if (typeof file.file_data === "string" && file.file_data !== "") {
    const parsed = parseDataUrl(file.file_data);
    const data = parsed?.data ?? file.file_data;
    const mimeType = parsed?.mimeType ?? "application/pdf";
    if (mimeType !== "application/pdf" && mimeType !== "text/plain") {
      throw new ValidationError(
        `OpenAI file part has unsupported file_data mime type "${mimeType}"`,
      );
    }
    return { data, mimeType, ...name };
  }
  if (typeof file.file_id === "string" && file.file_id !== "") {
    throw new ValidationError(
      'OpenAI file part "file_id" is a stored-file reference with no fetchable bytes',
    );
  }
  throw new ValidationError(
    'OpenAI "file" content part needs "file_data"',
  );
}

function convertToCanonicalPart(part: {
  type: string;
  text?: string;
  image_url?: { url: string };
  file?: { file_data?: string; file_id?: string; filename?: string };
}): CanonicalContentPart {
  if (part.type === "text" && part.text) {
    return { type: "text", text: part.text };
  }

  if (part.type === "image_url" && part.image_url) {
    const url = part.image_url.url;
    if (url.startsWith("data:")) {
      const [meta, data] = url.split(",");
      const mimeType = (meta.split(":")[1]?.split(";")[0] ||
        "image/png") as CanonicalImageMimeType;
      return {
        type: "image",
        image: { data, mimeType },
      };
    }
    // v1.5 spec §3.2.2 (E4): a remote image URL keeps its URL —
    // media-inline fetches or passes it through per target.
    return { type: "image", image: { url } };
  }

  if (part.type === "file" && part.file) {
    return { type: "document", document: toCanonicalDocument(part.file) };
  }

  if (part.type === "input_audio") {
    // No canonical audio part (v1.5 spec §3.2.2) — a loud 400, never
    // an empty text part pretending to carry the audio.
    throw new ValidationError(
      'Unsupported OpenAI content part type "input_audio"',
    );
  }

  return { type: "text", text: "" };
}

function extractTextContent(msg: ChatCompletionMessageParam): string {
  if (!("content" in msg) || msg.content === null) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

// ============ REQUEST: Canonical → OpenAI ============

/**
 * Anthropic-style `cache_control` emitted for cache_hints providers
 * (spec §3.2) — the SDK message/tool types don't declare it, so the
 * request parts that can carry it are widened locally at the emit site.
 */
interface OpenAICacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

/** canonical hint → wire cache_control. */
function toCacheControl(
  hint: CanonicalCacheHint | undefined,
): OpenAICacheControl | undefined {
  if (!hint) return undefined;
  return { type: "ephemeral", ...(hint.ttl !== undefined && { ttl: hint.ttl }) };
}

export function fromCanonicalRequest(
  request: CanonicalRequest,
): ChatCompletionRequest {
  const messages: ChatCompletionMessageParam[] = request.messages.map(
    convertFromCanonicalMessage,
  );

  const result: ChatCompletionRequest = {
    model: request.model,
    messages,
  };

  if (request.config) {
    const c = request.config;
    if (c.temperature !== undefined) result.temperature = c.temperature;
    if (c.maxTokens !== undefined) result.max_tokens = c.maxTokens;
    if (c.topP !== undefined) result.top_p = c.topP;
    if (c.stopSequences && c.stopSequences.length > 0) {
      result.stop = c.stopSequences;
    }
    if (c.candidateCount !== undefined) result.n = c.candidateCount;
    if (c.seed !== undefined) result.seed = c.seed;
    if (c.frequencyPenalty !== undefined) {
      result.frequency_penalty = c.frequencyPenalty;
    }
    if (c.presencePenalty !== undefined) {
      result.presence_penalty = c.presencePenalty;
    }

    // v1.4 spec §3.3: `reasoning_effort` per the Chat Completions
    // reference
    // https://developers.openai.com/api/reference/resources/chat —
    // the docs state the accepted set is model-dependent and include
    // none/minimal/low/medium/high/xhigh (+`max`, which has no
    // canonical slot, so the Responses decoder already lowered it).
    // The canonical ladder is passed through verbatim.
    const reasoning = c.reasoning;
    if (reasoning !== undefined) {
      if (reasoning.effort !== undefined) {
        (result as { reasoning_effort?: string }).reasoning_effort =
          reasoning.effort;
      }
      if (reasoning.budgetTokens !== undefined) {
        recordNote(
          {
            stage: "encode",
            adapter: "openai",
            code: "reasoning_budget_dropped",
            path: "reasoning.budget_tokens",
          },
          "Dropping reasoning.budget_tokens (no Chat Completions equivalent)",
        );
      }
      if (reasoning.summary === true) {
        recordNote(
          {
            stage: "encode",
            adapter: "openai",
            code: "reasoning_summary_dropped",
            path: "reasoning.summary",
          },
          "Dropping reasoning.summary (no Chat Completions equivalent)",
        );
      }
    }
  }

  if (request.tools && request.tools.length > 0) {
    result.tools = request.tools.map((tool) => {
      if (tool.type !== "function") {
        // Custom tools are lowered to function tools by
        // canonicalForTarget before encode (v1.4 spec §3.6).
        throw new ValidationError(
          `Unsupported tool type "${tool.type}" in tools[]`,
        );
      }
      const cacheControl = toCacheControl(tool.cache);
      return {
        type: "function" as const,
        function: {
          name: tool.function.name,
          ...(tool.function.description !== undefined && {
            description: tool.function.description,
          }),
          ...(tool.function.parameters !== undefined && {
            parameters: tool.function.parameters,
          }),
        },
        // §3.2: cache_control passes through for cache_hints
        // providers (OpenRouter-style); other targets never see a
        // hint — canonicalForTarget strips them first.
        ...(cacheControl && { cache_control: cacheControl }),
      };
    }) as ChatCompletionRequest["tools"];
  }
  if (request.toolChoice !== undefined) {
    result.tool_choice = request.toolChoice;
  }

  // v1.4 spec §3.6: Chat Completions honours the wire field directly.
  if (request.parallelToolCalls !== undefined) {
    (result as { parallel_tool_calls?: boolean }).parallel_tool_calls =
      request.parallelToolCalls;
  }

  // v1.4 spec §3.5: `response_format` per the Chat Completions
  // reference — json_schema nests under `json_schema` and keeps
  // name/strict/description; json_object is bare. The schema passes
  // through by reference — never cloned or rewritten.
  if (request.responseFormat !== undefined) {
    const rf = request.responseFormat;
    (result as { response_format?: unknown }).response_format =
      rf.type === "json_object"
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: {
              name: rf.name,
              schema: rf.schema,
              ...(rf.strict !== undefined && { strict: rf.strict }),
              ...(rf.description !== undefined && {
                description: rf.description,
              }),
            },
          };
  }

  if (request.stream !== undefined) {
    (result as { stream?: boolean }).stream = request.stream;
  }
  if (request.stream === true) {
    // Ask the upstream for a final usage chunk (spec §3.2).
    (result as { stream_options?: { include_usage: boolean } })
      .stream_options = { include_usage: true };
  }

  return result;
}

function convertFromCanonicalMessage(
  msg: CanonicalMessage,
): ChatCompletionMessageParam {
  const content = convertFromCanonicalContent(msg.content);

  if (msg.role === "assistant") {
    const assistantMsg = {
      role: "assistant" as const,
      content: typeof content === "string" ? content : null,
    };
    // v1.4 spec §3.3 (Task 8): reasoning parts become
    // `reasoning_content` when they survive canonicalForTarget — only
    // reasoning_passback entries keep them. Origin-checked like every
    // encoder: a foreign part drops with `reasoning_dropped`.
    // Field name per DeepSeek (https://api-docs.deepseek.com/guides/reasoning_model)
    // and OpenRouter (https://openrouter.ai/docs/use-cases/reasoning-tokens).
    const reasoningText = reasoningContent(msg);
    if (reasoningText !== undefined) {
      (assistantMsg as { reasoning_content?: string }).reasoning_content =
        reasoningText;
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      (assistantMsg as { tool_calls?: unknown }).tool_calls = msg.toolCalls.map(
        (tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }),
      );
    }
    return assistantMsg;
  }

  if (msg.role === "tool") {
    // v1.5 spec §3.2.1: media has no slot on a Chat tool message —
    // media-inline refuses it for this target first; an encode
    // reaching one is a loud 400, never a silent drop.
    const media = Array.isArray(msg.content)
      ? msg.content.find(
          (p) => p.type === "image" || p.type === "document",
        )
      : undefined;
    if (media !== undefined) {
      throw new ValidationError(
        `Unsupported "${media.type}" content part in a tool message`,
      );
    }
    const cacheControl = toCacheControl(msg.cache);
    // Task 17a: a hint reaching the encoder (cache_hints targets
    // only) becomes a one-part content array — OpenAI tool messages
    // accept text content parts and OpenRouter passes the breakpoint
    // through to Anthropic upstreams. Unhinted stays a plain string,
    // byte-identical to before.
    if (cacheControl !== undefined) {
      const part: {
        type: "text";
        text: string;
        cache_control?: OpenAICacheControl;
      } = {
        type: "text",
        text: toolResultText(msg.content),
        cache_control: cacheControl,
      };
      return {
        role: "tool",
        content: [part],
        tool_call_id: msg.toolCallId || "",
      } as ChatCompletionMessageParam;
    }
    return {
      role: "tool",
      content: typeof content === "string" ? content : "",
      tool_call_id: msg.toolCallId || "",
    };
  }

  if (msg.role === "system") {
    // §3.2: a hint that reaches the encoder (cache_hints targets
    // only) is emitted on a one-part content array — cache_control
    // marks the end of the system text; the last hinted part wins.
    const hint =
      Array.isArray(msg.content) && msg.content.some((p) => p.cache)
        ? [...msg.content].reverse().find((p) => p.cache)?.cache
        : undefined;
    const cacheControl = toCacheControl(hint);
    const content =
      cacheControl === undefined
        ? (systemText(msg.content) ?? "")
        : [
            {
              type: "text" as const,
              text: systemText(msg.content) ?? "",
              cache_control: cacheControl,
            },
          ];
    return {
      role: "system",
      content,
    } as ChatCompletionMessageParam;
  }

  // User message
  return { role: "user", content } as ChatCompletionMessageParam;
}

/**
 * A canonical tool message's text — string content as-is; parts join
 * their text with "\n" (the anthropic decoder's tool_result join), so
 * the hinted part covers the whole result text.
 */
function toolResultText(content: string | CanonicalContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

/**
 * An assistant message's visible reasoning text: matching-origin
 * reasoning parts joined in order (`reasoning_content` /
 * DeepSeek-style). Foreign parts — and signatures, which have no
 * OpenAI slot — drop with `reasoning_dropped` (spec §3.2).
 */
function reasoningContent(msg: CanonicalMessage): string | undefined {
  if (!Array.isArray(msg.content)) return undefined;
  let text = "";
  let seen = false;
  for (const part of msg.content) {
    if (part.type === "reasoning" && part.reasoning) {
      if (originMatchesCurrent(part.reasoning.origin)) {
        text += part.reasoning.text ?? "";
        seen = true;
      } else {
        recordNote(
          {
            stage: "encode",
            adapter: "openai",
            code: "reasoning_dropped",
            path: "reasoning_content",
          },
          "Dropping reasoning part (origin does not match the current attempt)",
        );
      }
      continue;
    }
    if (part.signature !== undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "openai",
          code: "reasoning_dropped",
          path: "signature",
        },
        "Dropping signature (no OpenAI equivalent)",
      );
    }
  }
  for (const call of msg.toolCalls ?? []) {
    if (call.signature !== undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "openai",
          code: "reasoning_dropped",
          path: "signature",
        },
        "Dropping signature (no OpenAI equivalent)",
      );
    }
  }
  // A matching part with no text (redacted, signature-only) emits no
  // empty `reasoning_content`.
  return seen && text !== "" ? text : undefined;
}

function convertFromCanonicalContent(
  content: string | CanonicalContentPart[],
):
  | string
  | Array<
      | { type: "text"; text: string; cache_control?: OpenAICacheControl }
      | {
          type: "image_url";
          image_url: { url: string };
          cache_control?: OpenAICacheControl;
        }
      | {
          type: "file";
          file: { file_data: string; filename?: string };
          cache_control?: OpenAICacheControl;
        }
    > {
  if (typeof content === "string") return content;

  return content
    .filter((part) => part.type !== "reasoning")
    .map((part) => {
    const cacheControl = toCacheControl(part.cache);
    if (part.type === "text") {
      return {
        type: "text" as const,
        text: part.text || "",
        ...(cacheControl && { cache_control: cacheControl }),
      };
    }
    if (part.type === "image" && part.image) {
      // v1.5 §3.2.2: a URL passes through unchanged — image_url.url
      // accepts http(s) on the wire
      // (https://platform.openai.com/docs/guides/images-vision).
      const url =
        part.image.data === undefined
          ? part.image.url!
          : `data:${part.image.mimeType};base64,${part.image.data}`;
      return {
        type: "image_url" as const,
        image_url: { url },
        ...(cacheControl && { cache_control: cacheControl }),
      };
    }
    if (part.type === "document" && part.document) {
      const document = part.document;
      // Text documents become text parts for every target (§3.2.2);
      // a url-only text document needs the services' fetch first.
      if (document.mimeType === "text/plain") {
        if (document.data === undefined) {
          throw new ValidationError(
            'Unsupported "document" content: "url" without "data"',
          );
        }
        return {
          type: "text" as const,
          text: Buffer.from(document.data, "base64").toString("utf8"),
          ...(cacheControl && { cache_control: cacheControl }),
        };
      }
      if (document.url !== undefined || document.data === undefined) {
        // Chat Completions `file` carries bytes only — no file_url
        // field (https://platform.openai.com/docs/guides/pdf-files);
        // media-inline fetches the URL first.
        throw new ValidationError(
          'Unsupported "document" content: "url" without "data"',
        );
      }
      return {
        type: "file" as const,
        file: {
          file_data: `data:${document.mimeType};base64,${document.data}`,
          ...(document.name !== undefined && { filename: document.name }),
        },
        ...(cacheControl && { cache_control: cacheControl }),
      };
    }
    return { type: "text" as const, text: "" };
  });
}

// ============ RESPONSE: OpenAI → Canonical ============

export function toCanonicalResponse(
  response: ChatCompletionResponse,
  model: string,
): CanonicalResponse {
  const choice = response.choices[0];

  // v1.4 spec §3.3 (Task 8): `reasoning_content` / `reasoning`
  // (DeepSeek, OpenRouter, vLLM) decode to a reasoning part with no
  // signature, tagged with the attempt's origin. Field names per
  // https://api-docs.deepseek.com/guides/reasoning_model (`reasoning_content`)
  // and https://openrouter.ai/docs/use-cases/reasoning-tokens (`reasoning`).
  const wire = choice?.message as
    | { content?: string | null; reasoning_content?: unknown; reasoning?: unknown }
    | undefined;
  const reasoningText =
    typeof wire?.reasoning_content === "string"
      ? wire.reasoning_content
      : typeof wire?.reasoning === "string"
        ? wire.reasoning
        : undefined;
  const message: CanonicalMessage = {
    role: "assistant",
    content:
      reasoningText !== undefined && reasoningText !== ""
        ? [
            {
              type: "reasoning",
              reasoning: {
                text: reasoningText,
                origin: decodeOrigin(model || response.model),
              },
            },
            { type: "text", text: wire?.content ?? "" },
          ]
        : (wire?.content ?? ""),
  };

  if (choice?.message?.tool_calls) {
    message.toolCalls = choice.message.tool_calls.map((tc) => {
      if (tc.type !== "function" || !("function" in tc)) {
        // e.g. type:"custom" — an upstream wire shape canonical
        // cannot express; error naming the type (kind "upstream",
        // like the stream decoder's undecodable-chunk error) rather
        // than returning an empty toolCalls.
        throw new UpstreamError(
          `Upstream openai sent unsupported tool call type "${String(
            tc.type,
          )}"`,
        );
      }
      return {
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      };
    });
  }

  return {
    id: response.id,
    model: model || response.model,
    message,
    finishReason: mapFinishReason(choice?.finish_reason),
    usage: response.usage
      ? openaiUsageToCanonical(response.usage as OpenAICompatibleUsage)
      : undefined,
    created: response.created,
  };
}

/**
 * Wire usage → canonical (spec §3.2): `prompt_tokens_details.cached_tokens`
 * and `cache_write_tokens` map to read/write; DeepSeek-style
 * `prompt_cache_hit_tokens` maps to read when the details object is absent.
 * `prompt_tokens` already includes cached tokens, so `inputTokens` needs
 * no summing. Cache fields are emitted only when non-zero.
 */
export function openaiUsageToCanonical(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
}): CanonicalUsage {
  const read =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    0;
  const write = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.total_tokens ?? input + output,
    ...(read > 0 && { cacheReadTokens: read }),
    ...(write > 0 && { cacheWriteTokens: write }),
  };
}

/** Canonical → wire usage; `prompt_tokens_details` appears only with non-zero cache fields. */
export function openaiUsageFromCanonical(
  usage: NonNullable<CanonicalResponse["usage"]>,
): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
} {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(((usage.cacheReadTokens ?? 0) > 0 ||
      (usage.cacheWriteTokens ?? 0) > 0) && {
      prompt_tokens_details: {
        ...(usage.cacheReadTokens !== undefined &&
          usage.cacheReadTokens > 0 && {
            cached_tokens: usage.cacheReadTokens,
          }),
        ...(usage.cacheWriteTokens !== undefined &&
          usage.cacheWriteTokens > 0 && {
            cache_write_tokens: usage.cacheWriteTokens,
          }),
      },
    }),
  };
}

function mapFinishReason(
  reason: string | null | undefined,
): CanonicalResponse["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_call";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

// ============ RESPONSE: Canonical → OpenAI ============

export function fromCanonicalResponse(
  response: CanonicalResponse,
): ChatCompletionResponse {
  const toolCalls: ChatCompletionResponse["choices"][0]["message"]["tool_calls"] =
    response.message.toolCalls?.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  // v1.5 spec §3.1 (Task 5): non-redacted reasoning parts reach the
  // Chat client as `message.reasoning_content` (text joined "\n\n") —
  // the DeepSeek/OpenRouter field
  // (https://api-docs.deepseek.com/guides/reasoning_model,
  // https://openrouter.ai/docs/use-cases/reasoning-tokens). Redacted
  // parts carry no readable text — nothing to emit. Signatures have
  // no Chat field and are never emitted; their drop is noted.
  const parts =
    typeof response.message.content === "string"
      ? []
      : (response.message.content ?? []);
  const reasoningTexts: string[] = [];
  for (const part of parts) {
    if (part.signature !== undefined) {
      noteSignatureDrop();
    }
    if (
      part.type === "reasoning" &&
      part.reasoning?.redacted !== true &&
      part.reasoning?.text !== undefined &&
      part.reasoning.text !== ""
    ) {
      reasoningTexts.push(part.reasoning.text);
    }
  }
  for (const tc of response.message.toolCalls ?? []) {
    if (tc.signature !== undefined) {
      noteSignatureDrop();
    }
  }
  const text =
    typeof response.message.content === "string"
      ? response.message.content
      : parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");

  const message = {
    role: "assistant" as const,
    content: text,
    refusal: null,
    ...(reasoningTexts.length > 0 && {
      reasoning_content: reasoningTexts.join("\n\n"),
    }),
    ...(toolCalls && { tool_calls: toolCalls }),
  };

  return {
    id: response.id || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: response.created || Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: message as ChatCompletionResponse["choices"][0]["message"],
        finish_reason: mapToOpenaiFinishReason(response.finishReason),
        logprobs: null,
      },
    ],
    usage: response.usage
      ? openaiUsageFromCanonical(response.usage)
      : undefined,
  };
}

/** Signatures never reach a Chat client (no field carries them). */
function noteSignatureDrop(): void {
  recordNote(
    {
      stage: "encode",
      adapter: "openai",
      code: "reasoning_dropped",
      path: "signature",
    },
    "Dropping signature (no Chat Completions equivalent)",
  );
}

// ============ MODEL LIST ============

interface OpenAIModelListResponse {
  object?: string;
  data?: { id?: string; created?: number; owned_by?: string }[];
}

export function toCanonicalModelList(response: unknown): CanonicalModelList {
  const res = response as OpenAIModelListResponse;
  return {
    models: (res.data ?? [])
      .filter((m): m is { id: string; created?: number; owned_by?: string } =>
        Boolean(m.id),
      )
      .map((m) => ({
        id: m.id,
        created: m.created,
        ownedBy: m.owned_by,
      })),
  };
}

export function fromCanonicalModelList(
  list: CanonicalModelList,
): OpenAIModelListResponse {
  return {
    object: "list",
    data: list.models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created ?? 0,
      owned_by: m.ownedBy ?? "babelgate",
    })),
  };
}

export function mapToOpenaiFinishReason(
  reason: CanonicalResponse["finishReason"],
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

// ============ ERRORS ============

const OPENAI_ERROR_TYPE: Record<CanonicalErrorKind, string> = {
  invalid_request: "invalid_request_error",
  authentication: "authentication_error",
  permission: "permission_error",
  not_found: "not_found_error",
  request_too_large: "invalid_request_error",
  rate_limit: "rate_limit_error",
  unsupported: "invalid_request_error",
  upstream: "api_error",
  unavailable: "service_unavailable_error",
  timeout: "api_error",
  internal: "api_error",
};

export function toCanonicalError(
  status: number,
  body: unknown,
): CanonicalError {
  const err = (body as { error?: { message?: unknown } } | null)?.error;
  const message =
    typeof err?.message === "string" && err.message.length > 0
      ? err.message
      : `Upstream openai returned ${status}`;
  return makeCanonicalError(kindFromStatus(status), message);
}

export function fromCanonicalError(err: CanonicalError): unknown {
  return {
    error: {
      message: err.message,
      type: OPENAI_ERROR_TYPE[err.kind],
      param: null,
      code: err.kind,
    },
  };
}

// Streaming lives in ./openai.stream — re-exported on the adapter above.

// ============ GAP FIXES (v1.5 spec §3.3) ============

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function gapTarget(): string {
  return currentAttempt()?.providerName ?? "the target";
}

/** The `{data, mimeType}` placeholder applyGapFixes writes between passes. */
function isInlineRef(v: Obj): boolean {
  return (
    typeof v.data === "string" &&
    typeof v.mimeType === "string" &&
    v.url === undefined
  );
}

function stripCacheControl(
  node: unknown,
  path: string,
  note: (code: string, path?: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => stripCacheControl(v, `${path}[${i}]`, note));
    return;
  }
  if (!isObj(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const p = path === "" ? key : `${path}.${key}`;
    if (key === "cache_control") {
      delete node[key];
      note("cache_control_dropped", p);
      continue;
    }
    stripCacheControl(value, p, note);
  }
}

function walkJson(
  node: unknown,
  path: string,
  visit: (obj: Obj, path: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkJson(v, `${path}[${i}]`, visit));
    return;
  }
  if (!isObj(node)) return;
  visit(node, path);
  for (const [key, value] of Object.entries(node)) {
    walkJson(value, path === "" ? key : `${path}.${key}`, visit);
  }
}

/**
 * Chat Completions-dialect gap fixes for pass-through bodies (v1.5
 * spec §3.3, Task 9) — same two-pass protocol as the anthropic
 * adapter's patchGaps (see gap-fixes.ts): pass one strips/rewrites
 * and reports url-bearing `image_url` refs as `needsMedia` JSON
 * paths, pass two renders each fetched `{data, mimeType}`
 * placeholder as a `data:` URL. The input body is never mutated.
 *
 * `documents` refuses the OpenAI `file` content part in the
 * dialect's own error; `stream_usage` sets
 * `stream_options.include_usage` so the upstream emits its terminal
 * usage chunk; `count_tokens` carries no request-body change. Only
 * http(s) `image_url.url` values are queued — a `data:` URL is
 * already inline and another scheme is the upstream's own to judge.
 */
export function patchGaps(
  body: Record<string, unknown>,
  gaps: readonly Gap[],
): {
  body: Record<string, unknown>;
  notes: TranslationNote[];
  needsMedia: string[];
} {
  const notes: TranslationNote[] = [];
  const needsMedia: string[] = [];
  const note = (code: string, path?: string): void => {
    notes.push({
      stage: "encode",
      adapter: "openai",
      code,
      ...(path !== undefined ? { path } : {}),
    });
  };
  if (gaps.length === 0) return { body, notes, needsMedia };
  const out = structuredClone(body) as Obj;

  // tool_choice: "none" stays — some upstreams honour it and sending
  // it is never worse than deleting it; "auto" is the API default and
  // drops silently; required/named choices earn the note.
  if (gaps.includes("tool_choice") && out.tool_choice !== undefined) {
    if (out.tool_choice !== "none") {
      const silent = out.tool_choice === "auto";
      delete out.tool_choice;
      if (!silent) note("tool_choice_dropped", "tool_choice");
    }
  }

  // prompt_cache: some OpenAI-compatible shims accept Anthropic-style
  // cache_control markers — strip every one.
  if (gaps.includes("prompt_cache")) stripCacheControl(out, "", note);

  // stream_usage: ask the upstream for the terminal usage chunk —
  // absent there, the trace estimates instead (passthrough-trace.ts).
  if (gaps.includes("stream_usage") && out.stream === true) {
    const opts = isObj(out.stream_options) ? out.stream_options : {};
    if (opts.include_usage !== true) {
      out.stream_options = { ...opts, include_usage: true };
    }
  }

  const wantDocuments = gaps.includes("documents");
  const wantUrlImages = gaps.includes("url_images");
  if (wantDocuments || wantUrlImages) {
    walkJson(out, "", (part, path) => {
      if (wantDocuments && part.type === "file") {
        throw new ValidationError(
          `Unsupported media at ${path}: documents are not supported by ${gapTarget()}`,
        );
      }
      if (part.type === "image_url") {
        const ref = part.image_url;
        if (!isObj(ref)) return;
        if (
          wantUrlImages &&
          typeof ref.url === "string" &&
          /^https?:\/\//i.test(ref.url)
        ) {
          needsMedia.push(`${path}.image_url`);
        } else if (isInlineRef(ref)) {
          // Second pass: fetched bytes waiting at this slot.
          part.image_url = {
            url: `data:${ref.mimeType};base64,${ref.data}`,
          };
        }
      }
    });
  }

  return { body: out, notes, needsMedia };
}
