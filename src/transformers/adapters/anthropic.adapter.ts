import { randomUUID } from "crypto";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalError,
  CanonicalErrorKind,
  CanonicalFinishReason,
  CanonicalModelList,
  CanonicalToolCall,
  ProviderAdapter,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { logger } from "../../utils/logger";
import type {
  MessageCreateParams,
  Message,
  ContentBlock,
  ToolResultBlockParam,
} from "../../types/anthropic.types";
import {
  anthropicUsageToCanonical,
  canonicalUsageToAnthropic,
  hasUncarriedCacheControl,
  toAnthropicSystem,
  toCanonicalSystem,
} from "./anthropic.cache";
import {
  toCanonicalMessage,
  toCanonicalTool,
  toCanonicalToolChoice,
  toMessageParam,
  toToolResultBlock,
  toToolUseBlock,
  toAnthropicTool,
  toAnthropicToolChoice,
} from "./anthropic.messages";
import {
  createStreamDecoder,
  createStreamEncoder,
} from "./anthropic.stream";

export const anthropicAdapter: ProviderAdapter<MessageCreateParams, Message> = {
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

// ============ REQUEST: Anthropic → Canonical ============

/**
 * Claude Code fields with no canonical equivalent are dropped safely
 * (spec §3.5) — a debug line names the dropped thing, never its content.
 */
function logDropped(request: MessageCreateParams): void {
  if (request.thinking !== undefined) {
    logger.debug('Dropping request field "thinking" (no canonical equivalent)');
  }
  if (request.metadata !== undefined) {
    logger.debug('Dropping request field "metadata" (no canonical equivalent)');
  }
  if (hasUncarriedCacheControl(request)) {
    logger.debug('Dropping "cache_control" fields (no canonical equivalent)');
  }
}

export function toCanonicalRequest(
  request: MessageCreateParams,
): CanonicalRequest {
  logDropped(request);

  const messages: CanonicalMessage[] = request.messages.flatMap((m) =>
    toCanonicalMessage(m),
  );

  // §3.5: a system array's text blocks join with a blank line — unless a
  // block carries cache_control, which turns the prompt into hinted
  // parts (§3.2).
  const systemPrompt = !request.system
    ? undefined
    : typeof request.system === "string"
      ? request.system
      : toCanonicalSystem(request.system);

  // Add system as first message if present
  if (systemPrompt !== undefined) {
    messages.unshift({
      role: "system",
      content: systemPrompt,
    });
  }

  const result: CanonicalRequest = {
    model: request.model,
    messages,
    // Canonical treats absent and stream:false identically — only an
    // explicit true turns streaming on.
    ...(request.stream === true && { stream: true }),
    ...(request.tools && { tools: request.tools.map(toCanonicalTool) }),
    ...(request.tool_choice && {
      toolChoice: toCanonicalToolChoice(request.tool_choice),
    }),
    ...(systemPrompt !== undefined && { systemPrompt }),
    config: {
      maxTokens: request.max_tokens,
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.top_p !== undefined && { topP: request.top_p }),
      ...(request.top_k !== undefined && { topK: request.top_k }),
      ...(request.stop_sequences && { stopSequences: request.stop_sequences }),
    },
  };

  return result;
}

// ============ REQUEST: Canonical → Anthropic ============

export function fromCanonicalRequest(
  request: CanonicalRequest,
): MessageCreateParams {
  const nonSystem = request.messages.filter((m) => m.role !== "system");
  const messages: MessageCreateParams["messages"] = [];
  for (let i = 0; i < nonSystem.length; i++) {
    const m = nonSystem[i];
    if (m.role === "tool") {
      // Merge the run of consecutive tool messages into ONE user
      // message of tool_result blocks (spec §3.4).
      const results: ToolResultBlockParam[] = [];
      while (i < nonSystem.length && nonSystem[i].role === "tool") {
        results.push(toToolResultBlock(nonSystem[i]));
        i++;
      }
      i--;
      messages.push({ role: "user", content: results });
      continue;
    }
    messages.push(toMessageParam(m));
  }

  const systemInput =
    request.systemPrompt ||
    request.messages.find((m) => m.role === "system")?.content;
  // §3.2: parts become a system block array (with cache_control); a
  // string stays a string.
  const system = toAnthropicSystem(systemInput);

  const result: MessageCreateParams = {
    model: request.model,
    messages,
    max_tokens: request.config?.maxTokens ?? 4096,
    ...(system !== undefined && system.length > 0 && { system }),
    ...(request.config?.temperature !== undefined && {
      temperature: request.config.temperature,
    }),
    ...(request.config?.topP !== undefined && { top_p: request.config.topP }),
    ...(request.config?.topK !== undefined && { top_k: request.config.topK }),
    ...(request.config?.stopSequences && {
      stop_sequences: request.config.stopSequences,
    }),
    ...(request.tools && { tools: request.tools.map(toAnthropicTool) }),
    ...(request.toolChoice && {
      tool_choice: toAnthropicToolChoice(request.toolChoice),
    }),
  };

  if (request.stream !== undefined) {
    (result as { stream?: boolean }).stream = request.stream;
  }

  return result;
}

// ============ RESPONSE: Anthropic → Canonical ============

export function toCanonicalResponse(
  response: Message,
  model: string,
): CanonicalResponse {
  const textContent = response.content
    .filter(
      (block): block is ContentBlock & { type: "text" } =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");

  const toolCalls = response.content
    .filter(
      (block): block is ContentBlock & { type: "tool_use" } =>
        block.type === "tool_use",
    )
    .map(
      (block): CanonicalToolCall => ({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }),
    );

  return {
    id: response.id || `anthropic-${randomUUID()}`,
    model,
    message: {
      role: "assistant",
      content: textContent,
      ...(toolCalls.length > 0 && { toolCalls }),
    },
    finishReason: mapFinishReason(response.stop_reason),
    usage: anthropicUsageToCanonical(response.usage),
  };
}

export function mapFinishReason(
  reason: string | null,
): CanonicalFinishReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_call";
    default:
      return "stop";
  }
}

// ============ RESPONSE: Canonical → Anthropic ============

export function fromCanonicalResponse(response: CanonicalResponse): Message {
  const text =
    typeof response.message.content === "string"
      ? response.message.content
      : "";

  // Text comes before tool_use blocks (spec §3.4).
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  > = [];
  if (text) {
    content.push({ type: "text", text });
  }
  for (const tc of response.message.toolCalls ?? []) {
    content.push(toToolUseBlock(tc));
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: response.id || `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    content: content as Message["content"],
    model: response.model,
    stop_reason: mapToAnthropicStopReason(response.finishReason),
    stop_sequence: null,
    usage: canonicalUsageToAnthropic(
      response.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    ),
  } as Message;
}

// ============ MODEL LIST (/v1/models) ============

interface AnthropicModelListResponse {
  data?: {
    id?: string;
    display_name?: string;
    created_at?: string;
    type?: string;
  }[];
  has_more?: boolean;
}

export function toCanonicalModelList(response: unknown): CanonicalModelList {
  const res = response as AnthropicModelListResponse;
  return {
    models: (res.data ?? [])
      .filter(
        (m): m is { id: string; display_name?: string; created_at?: string } =>
          Boolean(m.id),
      )
      .map((m) => ({
        id: m.id,
        displayName: m.display_name,
        // ISO timestamp → Unix seconds
        created: m.created_at
          ? Math.floor(Date.parse(m.created_at) / 1000)
          : undefined,
      })),
  };
}

export function fromCanonicalModelList(
  list: CanonicalModelList,
): AnthropicModelListResponse {
  return {
    data: list.models.map((m) => ({
      id: m.id,
      display_name: m.displayName,
      created_at: m.created
        ? new Date(m.created * 1000).toISOString()
        : undefined,
      type: "model",
    })),
    has_more: false,
  };
}

export function mapToAnthropicStopReason(
  reason: CanonicalFinishReason,
): "end_turn" | "max_tokens" | "tool_use" | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_call":
      return "tool_use";
    default:
      return "end_turn";
  }
}

// ============ ERRORS ============

const ANTHROPIC_ERROR_TYPE: Record<CanonicalErrorKind, string> = {
  invalid_request: "invalid_request_error",
  authentication: "authentication_error",
  permission: "permission_error",
  not_found: "not_found_error",
  request_too_large: "request_too_large",
  rate_limit: "rate_limit_error",
  unsupported: "api_error",
  upstream: "api_error",
  unavailable: "overloaded_error",
  timeout: "timeout_error",
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
      : `Upstream anthropic returned ${status}`;
  return makeCanonicalError(kindFromStatus(status), message);
}

export function fromCanonicalError(err: CanonicalError): unknown {
  return {
    type: "error",
    error: {
      type: ANTHROPIC_ERROR_TYPE[err.kind],
      message: err.message,
    },
  };
}

// Message/tool conversion lives in ./anthropic.messages; streaming in
// ./anthropic.stream — re-exported on the adapter above.
