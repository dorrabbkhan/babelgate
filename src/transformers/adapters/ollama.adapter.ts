import { randomUUID } from "crypto";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalContentPart,
  CanonicalError,
  CanonicalModelList,
  IdGenerator,
  ProviderAdapter,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { ValidationError } from "../../utils/errors";
import { createIdGenerator, sequentialIds } from "../../utils/ids";
import { systemText } from "../system-text";
import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaMessage,
} from "../../types/ollama.types";
import {
  createStreamDecoder,
  createStreamEncoder,
} from "./ollama.stream";
import {
  recordCallId,
  resolveCallId,
  resolveToolName,
  toCanonicalToolCalls,
  toCanonicalTools,
  toOllamaToolCalls,
  toOllamaTools,
  type CallNameById,
  type OllamaWireToolCall,
  type PendingCallIds,
} from "./ollama.tools";

export const ollamaAdapter: ProviderAdapter<
  OllamaChatRequest,
  OllamaChatResponse
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

// ============ REQUEST: Ollama → Canonical ============

export function toCanonicalRequest(
  request: OllamaChatRequest,
): CanonicalRequest {
  // Wire ids are kept when present; id-less calls draw call_0, call_1,…
  // (docs/decisions.md "v1.1 Task 3" convention).
  const ids = sequentialIds();
  // Tool results carry only `tool_name` on the wire (docs.ollama.com
  // api.md "Chat request (With history, with tools)"); pair each one
  // with the earliest unconsumed earlier call of that name (FIFO).
  const pendingByName: PendingCallIds = new Map();
  const messages: CanonicalMessage[] = (request.messages || []).map((m) => {
    const out: CanonicalMessage = {
      role: m.role as CanonicalMessage["role"],
      content: extractContent(m),
    };
    const wireCalls = m.tool_calls as OllamaWireToolCall[] | undefined;
    if (wireCalls && wireCalls.length > 0) {
      out.toolCalls = toCanonicalToolCalls(wireCalls, ids);
      for (const tc of out.toolCalls) {
        recordCallId(pendingByName, tc.function.name, tc.id);
      }
    }
    if (typeof m.tool_name === "string" && m.tool_name.length > 0) {
      out.toolCallId = resolveCallId(pendingByName, m.tool_name) ?? m.tool_name;
    }
    return out;
  });

  // Extract system prompt from first system message
  const systemMsg = messages.find((m) => m.role === "system");
  const systemPrompt =
    typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

  const result: CanonicalRequest = {
    model: request.model,
    messages,
    ...(systemPrompt && { systemPrompt }),
  };

  // Convert options to config
  if (request.options) {
    const opts = request.options;
    result.config = {
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.num_predict !== undefined && { maxTokens: opts.num_predict }),
      ...(opts.top_p !== undefined && { topP: opts.top_p }),
      ...(opts.top_k !== undefined && { topK: opts.top_k }),
      ...(opts.stop && { stopSequences: opts.stop }),
      ...(opts.seed !== undefined && { seed: opts.seed }),
    };
  }

  // Ollama's /api/chat streams NDJSON unless the client sends
  // stream:false (api.md: "stream ... if false the response will be
  // returned as a single response object"; default true) — so an
  // omitted flag maps to canonical stream:true and only an explicit
  // false opts out.
  if (request.stream !== false) {
    result.stream = true;
  }

  if (request.tools && request.tools.length > 0) {
    result.tools = toCanonicalTools(request.tools);
  }

  return result;
}

function extractContent(
  message: OllamaMessage,
): string | CanonicalContentPart[] {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }

  // Has images - return multipart
  const parts: CanonicalContentPart[] = [
    { type: "text", text: message.content },
  ];

  for (const img of message.images) {
    // Ollama images can be string (base64) or Uint8Array
    const data =
      typeof img === "string" ? img : Buffer.from(img).toString("base64");
    parts.push({
      type: "image",
      image: {
        data,
        mimeType: "image/png", // Ollama doesn't specify mime type
      },
    });
  }

  return parts;
}

// ============ REQUEST: Canonical → Ollama ============

export function fromCanonicalRequest(
  request: CanonicalRequest,
): OllamaChatRequest {
  // Ollama has no tool_choice parameter (api.md "Tool calling"); auto
  // (or absent) is its only behaviour. Anything else → 400.
  if (request.toolChoice !== undefined && request.toolChoice !== "auto") {
    const value =
      typeof request.toolChoice === "string"
        ? request.toolChoice
        : JSON.stringify(request.toolChoice);
    throw new ValidationError(
      `Ollama does not support tool_choice "${value}"`,
    );
  }

  // `tool_name` on a result is looked up from the matching assistant
  // call in the same request (Ollama carries names, not call ids).
  // The lookup is built while walking the messages, so a tool message
  // resolves only against calls that come BEFORE it.
  const callNameById: CallNameById = new Map();
  const messages: OllamaMessage[] = request.messages.map((m) => {
    const out = convertToOllamaMessage(m, callNameById);
    for (const tc of m.toolCalls ?? []) {
      callNameById.set(tc.id, tc.function.name);
    }
    return out;
  });

  const result: OllamaChatRequest = {
    model: request.model,
    messages,
  };

  if (request.tools && request.tools.length > 0) {
    result.tools = toOllamaTools(request.tools);
  }

  // Convert config to options
  if (request.config) {
    const c = request.config;
    const options: OllamaChatRequest["options"] = {};

    if (c.temperature !== undefined) options.temperature = c.temperature;
    if (c.maxTokens !== undefined) options.num_predict = c.maxTokens;
    if (c.topP !== undefined) options.top_p = c.topP;
    if (c.topK !== undefined) options.top_k = c.topK;
    if (c.stopSequences) options.stop = c.stopSequences;
    if (c.seed !== undefined) options.seed = c.seed;
    if (c.contextWindow !== undefined) options.num_ctx = c.contextWindow;

    if (Object.keys(options).length > 0) {
      result.options = options;
    }
  }

  // Ollama streams NDJSON by default; send stream:false unless the
  // canonical request explicitly asked for streaming.
  result.stream = request.stream ?? false;

  return result;
}

function convertToOllamaMessage(
  msg: CanonicalMessage,
  callNameById: CallNameById,
): OllamaMessage {
  const result: OllamaMessage = {
    role: msg.role as OllamaMessage["role"],
    content: "",
  };

  if (typeof msg.content === "string") {
    result.content = msg.content;
  } else if (Array.isArray(msg.content)) {
    // Extract text and images. §3.2: hinted system parts flatten
    // through systemText ("\n\n", the decoder's separator); the hint
    // itself drops (Task 4 adds cache_hints).
    const textParts =
      msg.role === "system"
        ? (systemText(msg.content) ?? "")
        : msg.content
            .filter((p) => p.type === "text")
            .map((p) => p.text || "")
            .join("\n");

    const images = msg.content
      .filter((p) => p.type === "image" && p.image)
      .map((p) => p.image!.data);

    result.content = textParts;
    if (images.length > 0) {
      result.images = images;
    }
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    result.tool_calls = toOllamaToolCalls(
      msg.toolCalls,
    ) as unknown as OllamaMessage["tool_calls"];
  }

  if (msg.role === "tool") {
    result.tool_name = resolveToolName(callNameById, msg.toolCallId);
  }

  return result;
}

// ============ RESPONSE: Ollama → Canonical ============

export function toCanonicalResponse(
  response: OllamaChatResponse,
  model: string,
  ids: IdGenerator = createIdGenerator(),
): CanonicalResponse {
  const message: CanonicalMessage = {
    role: "assistant",
    content: response.message?.content ?? "",
  };
  const wireCalls = response.message?.tool_calls as
    | OllamaWireToolCall[]
    | undefined;
  if (wireCalls && wireCalls.length > 0) {
    message.toolCalls = toCanonicalToolCalls(wireCalls, ids);
  }
  return {
    id: `ollama-${randomUUID()}`,
    model,
    message,
    // A reply ending in tool calls is a "tool_call" finish — the same
    // rule the stream decoder applies (docs/decisions.md "v1.1 Task 6").
    finishReason: message.toolCalls
      ? "tool_call"
      : response.done
        ? "stop"
        : "unknown",
    usage: {
      inputTokens: response.prompt_eval_count ?? 0,
      outputTokens: response.eval_count ?? 0,
      totalTokens:
        (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
    },
  };
}

// ============ RESPONSE: Canonical → Ollama ============

export function fromCanonicalResponse(
  response: CanonicalResponse,
): OllamaChatResponse {
  const content =
    typeof response.message.content === "string"
      ? response.message.content
      : "";
  const toolCalls = response.message.toolCalls;
  // "stop" covers canonical "tool_call": recorded Ollama answers that
  // end in tool calls report done_reason "stop".
  const stopped =
    response.finishReason === "stop" ||
    response.finishReason === "tool_call";

  return {
    model: response.model,
    created_at: new Date(),
    message: {
      role: "assistant",
      content,
      ...(toolCalls &&
        toolCalls.length > 0 && {
          tool_calls: toOllamaToolCalls(toolCalls),
        }),
    } as OllamaChatResponse["message"],
    done: stopped,
    done_reason: stopped ? "stop" : "length",
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: response.usage?.inputTokens ?? 0,
    prompt_eval_duration: 0,
    eval_count: response.usage?.outputTokens ?? 0,
    eval_duration: 0,
  } as OllamaChatResponse;
}

// ============ MODEL LIST (/api/tags) ============

interface OllamaModelListResponse {
  models?: {
    name?: string;
    model?: string;
    modified_at?: string;
    size?: number;
  }[];
}

export function toCanonicalModelList(response: unknown): CanonicalModelList {
  const res = response as OllamaModelListResponse;
  return {
    models: (res.models ?? [])
      .filter((m) => Boolean(m.name ?? m.model))
      .map((m) => ({
        id: (m.name ?? m.model)!,
        // ISO timestamp → Unix seconds
        created: m.modified_at
          ? Math.floor(Date.parse(m.modified_at) / 1000)
          : undefined,
      })),
  };
}

export function fromCanonicalModelList(
  list: CanonicalModelList,
): OllamaModelListResponse {
  return {
    models: list.models.map((m) => ({
      name: m.id,
      model: m.id,
      modified_at: m.created
        ? new Date(m.created * 1000).toISOString()
        : undefined,
    })),
  };
}

// ============ ERRORS ============

export function toCanonicalError(
  status: number,
  body: unknown,
): CanonicalError {
  const err = (body as { error?: unknown } | null)?.error;
  const message =
    typeof err === "string" && err.length > 0
      ? err
      : `Upstream ollama returned ${status}`;
  return makeCanonicalError(kindFromStatus(status), message);
}

export function fromCanonicalError(err: CanonicalError): unknown {
  return { error: err.message };
}

// Streaming lives in ./ollama.stream — re-exported on the adapter above.
