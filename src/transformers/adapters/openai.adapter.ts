import { randomUUID } from "crypto";
import type {
  CanonicalCacheHint,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalContentPart,
  CanonicalError,
  CanonicalErrorKind,
  CanonicalImage,
  CanonicalModelList,
  CanonicalToolChoice,
  CanonicalUsage,
  ProviderAdapter,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { UpstreamError, ValidationError } from "../../utils/errors";
import { recordNote } from "../../observe/context";
import { systemText } from "../system-text";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionMessageParam,
  OpenAICompatibleUsage,
} from "../../types/openai.types";
import {
  createStreamDecoder,
  createStreamEncoder,
} from "./openai.stream";

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

export function toCanonicalRequest(
  request: ChatCompletionRequest,
): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  let systemPrompt: string | undefined;

  for (const msg of request.messages) {
    if (msg.role === "system") {
      systemPrompt = extractTextContent(msg);
    }
    messages.push(convertToCanonicalMessage(msg));
  }

  // Canonical has no field for `parallel_tool_calls` (a spec
  // non-goal) — make the drop visible instead of silent, same as
  // Anthropic's `disable_parallel_tool_use` (task 9).
  if (request.parallel_tool_calls !== undefined) {
    recordNote({
      stage: "decode",
      adapter: "openai",
      code: "parallel_tool_calls_dropped",
      path: "parallel_tool_calls",
    });
  }

  return {
    model: request.model,
    messages,
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
    },
    ...(request.stream === true && { stream: true }),
    ...(request.stream === false && { stream: false }),
    ...(request.tools && { tools: toCanonicalTools(request.tools) }),
    ...(request.tool_choice !== undefined && {
      toolChoice: toCanonicalToolChoice(request.tool_choice),
    }),
  };
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
      recordNote({
        stage: "decode",
        adapter: "openai",
        code: "tool_strict_dropped",
        path: `tools[${index}].function.strict`,
      });
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
): CanonicalMessage {
  const base: CanonicalMessage = {
    role: msg.role as CanonicalMessage["role"],
    content: "",
  };

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

function convertToCanonicalPart(part: {
  type: string;
  text?: string;
  image_url?: { url: string };
}): CanonicalContentPart {
  if (part.type === "text" && part.text) {
    return { type: "text", text: part.text };
  }

  if (part.type === "image_url" && part.image_url) {
    const url = part.image_url.url;
    if (url.startsWith("data:")) {
      const [meta, data] = url.split(",");
      const mimeType = (meta.split(":")[1]?.split(";")[0] ||
        "image/png") as CanonicalImage["mimeType"];
      return {
        type: "image",
        image: { data, mimeType },
      };
    }
    // URL-based images - store as text placeholder
    return { type: "text", text: `[Image: ${url}]` };
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
  }

  if (request.tools && request.tools.length > 0) {
    result.tools = request.tools.map((tool) => {
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
    > {
  if (typeof content === "string") return content;

  return content.map((part) => {
    const cacheControl = toCacheControl(part.cache);
    if (part.type === "text") {
      return {
        type: "text" as const,
        text: part.text || "",
        ...(cacheControl && { cache_control: cacheControl }),
      };
    }
    if (part.type === "image" && part.image) {
      return {
        type: "image_url" as const,
        image_url: {
          url: `data:${part.image.mimeType};base64,${part.image.data}`,
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

  const message: CanonicalMessage = {
    role: "assistant",
    content: choice?.message?.content ?? "",
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

  return {
    id: response.id || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: response.created || Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            typeof response.message.content === "string"
              ? response.message.content
              : "",
          refusal: null,
          ...(toolCalls && { tool_calls: toolCalls }),
        },
        finish_reason: mapToOpenaiFinishReason(response.finishReason),
        logprobs: null,
      },
    ],
    usage: response.usage
      ? openaiUsageFromCanonical(response.usage)
      : undefined,
  };
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
