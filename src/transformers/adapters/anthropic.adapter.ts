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
import { recordNote } from "../../observe/context";
import { budgetFor } from "../reasoning-effort";
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
  limitCacheBreakpoints,
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
 * (spec §3.5) — a translation note names the dropped thing's code and
 * path, never its content.
 */
function logDropped(request: MessageCreateParams): void {
  if (request.thinking !== undefined) {
    recordNote(
      {
        stage: "decode",
        adapter: "anthropic",
        code: "thinking_dropped",
        path: "thinking",
      },
      'Dropping request field "thinking" (no canonical equivalent)',
    );
  }
  if (request.metadata !== undefined) {
    recordNote(
      {
        stage: "decode",
        adapter: "anthropic",
        code: "metadata_dropped",
        path: "metadata",
      },
      'Dropping request field "metadata" (no canonical equivalent)',
    );
  }
  if (hasUncarriedCacheControl(request)) {
    recordNote(
      {
        stage: "decode",
        adapter: "anthropic",
        code: "cache_control_dropped",
        path: "cache_control",
      },
      'Dropping "cache_control" fields (no canonical equivalent)',
    );
  }
}

export function toCanonicalRequest(
  request: MessageCreateParams,
): CanonicalRequest {
  logDropped(request);

  const messages: CanonicalMessage[] = request.messages.flatMap((m, i) =>
    toCanonicalMessage(m, i),
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

/**
 * Models that accept `thinking: {type: "adaptive"}` — the per-model
 * thinking table on
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 * decides adaptive support (extended-only models — the whole 4.5
 * family — reject `"adaptive"` with a 400). `xhigh: true` marks the
 * subset whose effort-level table includes `xhigh` on
 * https://platform.claude.com/docs/en/build-with-claude/effort —
 * `max` has no canonical slot so it never appears here. Matched by
 * prefix so dated variants resolve. Models not in the list take
 * legacy extended thinking instead
 * (`thinking: {type:"enabled", budget_tokens}` —
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
 */
const ADAPTIVE_MODELS: { prefix: string; xhigh: boolean }[] = [
  { prefix: "claude-fable-5", xhigh: true },
  { prefix: "claude-mythos-preview", xhigh: false },
  { prefix: "claude-mythos-5", xhigh: true },
  { prefix: "claude-opus-5", xhigh: true },
  { prefix: "claude-sonnet-5", xhigh: true },
  { prefix: "claude-haiku-5", xhigh: true },
  { prefix: "claude-opus-4-8", xhigh: true },
  { prefix: "claude-opus-4-7", xhigh: true },
  { prefix: "claude-opus-4-6", xhigh: false },
  { prefix: "claude-sonnet-4-6", xhigh: false },
];

/**
 * Extended-thinking-only models that additionally take
 * `output_config.effort` alongside `budget_tokens` — the effort doc
 * calls `claude-opus-4-5` "the only extended-thinking-only model
 * that supports effort" and pairs it with `budget_tokens`
 * (https://platform.claude.com/docs/en/build-with-claude/effort);
 * its level set is low/medium/high, so `xhigh` lowers to `high`.
 */
const EXTENDED_EFFORT_MODELS: { prefix: string; xhigh: boolean }[] = [
  { prefix: "claude-opus-4-5", xhigh: false },
];

function adaptiveModel(
  model: string,
): { prefix: string; xhigh: boolean } | undefined {
  return ADAPTIVE_MODELS.find((entry) => model.startsWith(entry.prefix));
}

function extendedEffortModel(
  model: string,
): { prefix: string; xhigh: boolean } | undefined {
  return EXTENDED_EFFORT_MODELS.find((entry) =>
    model.startsWith(entry.prefix),
  );
}

/**
 * Canonical `config.reasoning` → `thinking`/`output_config` (v1.4
 * spec §3.3). Adaptive models get `thinking:{type:"adaptive"}` plus
 * `output_config.effort`; legacy models get
 * `thinking:{type:"enabled", budget_tokens}` — `claude-opus-4-5`
 * also gets `output_config.effort` alongside it per the effort doc
 * (min budget 1024, and
 * `budget_tokens` must stay below `max_tokens`, so max_tokens is
 * raised when needed). `budget_tokens` counts toward max_tokens —
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking.
 * Mutates `result.max_tokens` when the budget requires it.
 */
function applyReasoning(
  result: MessageCreateParams,
  request: CanonicalRequest,
): void {
  const reasoning = request.config?.reasoning;
  if (reasoning === undefined) return;

  if (reasoning.summary === true) {
    recordNote(
      {
        stage: "encode",
        adapter: "anthropic",
        code: "reasoning_summary_dropped",
        path: "reasoning.summary",
      },
      "Dropping reasoning.summary (no Anthropic equivalent)",
    );
  }

  const adaptive = adaptiveModel(request.model);
  if (adaptive !== undefined) {
    if (reasoning.budgetTokens !== undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "anthropic",
          code: "reasoning_budget_dropped",
          path: "reasoning.budget_tokens",
        },
        "Dropping reasoning.budget_tokens (adaptive thinking takes a level, not a budget)",
      );
    }
    const effort = reasoning.effort;
    if (effort === undefined || effort === "none") {
      // No effort → thinking stays off (a dropped budget keeps the
      // old model-default adaptive mode); none → no thinking at all.
      if (effort === undefined && reasoning.budgetTokens !== undefined) {
        (result as { thinking?: unknown }).thinking = {
          type: "adaptive",
        };
      }
      return;
    }
    if (effort === "minimal") {
      // The wire floor is `low` — canonical `minimal` can't be
      // expressed, so thinking is left off entirely.
      recordNote(
        {
          stage: "encode",
          adapter: "anthropic",
          code: "reasoning_effort_lowered",
          path: "reasoning.effort",
        },
        'Dropping adaptive thinking for effort "minimal" (Anthropic floor is "low")',
      );
      return;
    }
    let wireEffort: string = effort;
    if (effort === "xhigh" && !adaptive.xhigh) {
      wireEffort = "high";
      recordNote(
        {
          stage: "encode",
          adapter: "anthropic",
          code: "reasoning_effort_lowered",
          path: "reasoning.effort",
        },
        `Lowering reasoning effort "xhigh" to "high" (${request.model} has no xhigh level)`,
      );
    }
    (result as { thinking?: unknown }).thinking = { type: "adaptive" };
    (result as { output_config?: unknown }).output_config = {
      effort: wireEffort,
    };
    return;
  }

  // Legacy extended thinking: budget_tokens per
  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking
  // — minimum 1024, and the budget counts toward (must stay below)
  // max_tokens.
  if (reasoning.effort === "none") {
    if (reasoning.budgetTokens !== undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "anthropic",
          code: "reasoning_budget_dropped",
          path: "reasoning.budget_tokens",
        },
        'Dropping reasoning.budget_tokens (effort "none" leaves thinking off)',
      );
    }
    return;
  }
  // No effort and no budget → thinking stays off; an explicit
  // budget alone still enables it.
  if (reasoning.effort === undefined && reasoning.budgetTokens === undefined)
    return;

  const budget = reasoning.budgetTokens ?? budgetFor(reasoning.effort!);
  (result as { thinking?: unknown }).thinking = {
    type: "enabled",
    budget_tokens: budget,
  };
  if (result.max_tokens <= budget) {
    const raised = budget + 1024;
    recordNote(
      {
        stage: "encode",
        adapter: "anthropic",
        code: "max_tokens_raised",
        path: "max_tokens",
      },
      `Raising max_tokens from ${result.max_tokens} to ${raised} (thinking budget ${budget} must stay below it)`,
    );
    result.max_tokens = raised;
  }

  // `claude-opus-4-5` is extended-only but still takes
  // `output_config.effort` alongside `budget_tokens` per
  // https://platform.claude.com/docs/en/build-with-claude/effort.
  const extended = extendedEffortModel(request.model);
  if (extended !== undefined && reasoning.effort !== undefined) {
    if (reasoning.effort === "minimal") {
      // Below the wire floor — the 1024-token budget already
      // carries it; there is no level to send.
      recordNote(
        {
          stage: "encode",
          adapter: "anthropic",
          code: "reasoning_effort_lowered",
          path: "reasoning.effort",
        },
        `Dropping reasoning effort "minimal" (${request.model} takes low/medium/high)`,
      );
    } else {
      let wireEffort: string = reasoning.effort;
      if (wireEffort === "xhigh" && !extended.xhigh) {
        wireEffort = "high";
        recordNote(
          {
            stage: "encode",
            adapter: "anthropic",
            code: "reasoning_effort_lowered",
            path: "reasoning.effort",
          },
          `Lowering reasoning effort "xhigh" to "high" (${request.model} has no xhigh level)`,
        );
      }
      (result as { output_config?: unknown }).output_config = {
        effort: wireEffort,
      };
    }
  }
}

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

  // §3.2: Anthropic accepts at most 4 cache breakpoints — the last 4
  // in tools → system → messages order are kept.
  const dropped = limitCacheBreakpoints(result);
  if (dropped > 0) {
    recordNote(
      {
        stage: "encode",
        adapter: "anthropic",
        code: "cache_limit",
        path: "cache_control",
      },
      `Dropping ${dropped} cache_control breakpoint(s): Anthropic allows at most 4`,
    );
  }

  applyReasoning(result, request);

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
