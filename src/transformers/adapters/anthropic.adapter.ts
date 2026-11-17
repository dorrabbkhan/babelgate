import { randomUUID } from "crypto";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalError,
  CanonicalErrorKind,
  CanonicalFinishReason,
  CanonicalModelList,
  CanonicalResponseFormat,
  CanonicalToolCall,
  CanonicalContentPart,
  ProviderAdapter,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { currentAttempt, recordNote } from "../../observe/context";
import type { TranslationNote } from "../../observe/trace";
import type { Gap } from "../../config/provider-presets";
import {
  UnsupportedResponseFormatError,
  ValidationError,
} from "../../utils/errors";
import {
  EFFORT_LADDER,
  budgetFor,
  effortForBudget,
  type Effort,
} from "../reasoning-effort";
import {
  decodeOrigin,
  originMatchesCurrent,
  signatureMatchesCurrent,
} from "../reasoning-origin";
import {
  packEnvelope,
  type EnvelopePayload,
} from "../reasoning-envelope";
import {
  DEFAULT_RESPONSE_FORMAT_NAME,
  isSchemaObject,
  noteDroppedFormatExtras,
} from "../response-format";
import type {
  MessageCreateParams,
  Message,
  ContentBlock,
  ContentBlockParam,
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

import type { MediaSupport } from "../../services/media-inline";

/**
 * Anthropic media support (v1.5 spec §3.2.2):
 *  - image `source.type: "url" | "base64"` —
 *    https://platform.claude.com/docs/en/build-with-claude/vision
 *  - document `source.type: "url" | "base64" | "text"` —
 *    https://platform.claude.com/docs/en/build-with-claude/pdf-support
 *  - tool_result content accepts image blocks —
 *    https://platform.claude.com/docs/en/build-with-claude/tool-use
 */
export const MEDIA_SUPPORT: MediaSupport = {
  imageUrl: true,
  documentData: true,
  documentUrl: true,
  toolMessageImages: true,
};

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

type CanonicalReasoning = NonNullable<
  NonNullable<CanonicalRequest["config"]>["reasoning"]
>;

/**
 * `thinking` + `output_config.effort` → `config.reasoning` (v1.5
 * spec §3.1; field shapes per
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 * and
 * https://platform.claude.com/docs/en/build-with-claude/effort).
 * `{type:"enabled", budget_tokens}` maps the budget to the nearest
 * lower ladder level and keeps it; `{type:"adaptive"}` maps
 * `output_config.effort` (Anthropic's level field per the SDK's
 * OutputConfig — `"max"` lowers to the canonical ceiling `xhigh`,
 * the Responses decoder's convention); `{type:"disabled"}` maps to
 * `none`. Every other shape — an unknown `type`, `enabled` without
 * a numeric budget, `adaptive` without a level, `null` and other
 * non-object values — keeps the v1.4 `thinking_dropped` note.
 */
function toCanonicalReasoning(
  request: MessageCreateParams,
): CanonicalReasoning | undefined {
  const thinking = request.thinking;
  if (thinking === undefined) return undefined;
  const t =
    typeof thinking === "object" && thinking !== null
      ? (thinking as { type?: unknown; budget_tokens?: unknown })
      : {};
  if (t.type === "disabled") return { effort: "none" };
  if (t.type === "enabled" && typeof t.budget_tokens === "number") {
    return {
      effort: effortForBudget(t.budget_tokens),
      budgetTokens: t.budget_tokens,
    };
  }
  if (t.type === "adaptive") {
    const effort = request.output_config?.effort;
    if (typeof effort === "string") {
      if ((EFFORT_LADDER as readonly string[]).includes(effort)) {
        return { effort: effort as Effort };
      }
      if (effort === "max") {
        recordNote(
          {
            stage: "decode",
            adapter: "anthropic",
            code: "reasoning_effort_lowered",
            path: "output_config.effort",
          },
          'Lowering reasoning effort "max" to "xhigh" (canonical maximum)',
        );
        return { effort: "xhigh" };
      }
    }
  }
  recordNote(
    {
      stage: "decode",
      adapter: "anthropic",
      code: "thinking_dropped",
      path: "thinking",
    },
    'Dropping request field "thinking" (no canonical equivalent)',
  );
  return undefined;
}

export function toCanonicalRequest(
  request: MessageCreateParams,
): CanonicalRequest {
  logDropped(request);
  const reasoning = toCanonicalReasoning(request);

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

  // v1.4 spec §3.5: `output_config.format {type:"json_schema",
  // schema}` is the GA structured-output field per
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  // (the beta `output_format` + `structured-outputs-2025-11-13`
  // header is superseded — GA needs no header). It carries no name,
  // so the canonical side gets the fixed default name; other
  // `output_config` keys (`effort`) are ignored as before.
  const format = request.output_config?.format;
  let responseFormat: CanonicalResponseFormat | undefined;
  if (format !== undefined && format !== null) {
    const f = format as unknown as Record<string, unknown>;
    if (f.type === "json_schema" && isSchemaObject(f.schema)) {
      responseFormat = {
        type: "json_schema",
        name: DEFAULT_RESPONSE_FORMAT_NAME,
        schema: f.schema,
      };
    } else {
      recordNote(
        {
          stage: "decode",
          adapter: "anthropic",
          code: "field_dropped",
          path: "output_config.format",
        },
        "Dropping an unsupported output_config.format value",
      );
    }
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
    ...(responseFormat !== undefined && { responseFormat }),
    ...(systemPrompt !== undefined && { systemPrompt }),
    config: {
      maxTokens: request.max_tokens,
      ...(reasoning !== undefined && { reasoning }),
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

  // v1.4 spec §3.6: `disable_parallel_tool_use` lives inside
  // tool_choice on the forms that use tools — auto (the default when
  // none is sent: at most one call), any and tool
  // (https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use
  // and the SDK's ToolChoice types). `none` has no such field — and
  // with no tool use parallel_tool_calls means nothing, so it is
  // dropped silently.
  if (
    request.parallelToolCalls === false &&
    result.tool_choice?.type !== "none"
  ) {
    const choice =
      result.tool_choice ??
      ({ type: "auto" } as NonNullable<typeof result.tool_choice>);
    (result as { tool_choice?: unknown }).tool_choice = {
      ...choice,
      disable_parallel_tool_use: true,
    };
  }

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
  applyContinuityGuard(result, request);
  applyResponseFormat(result, request);

  return result;
}

/**
 * Task 8 (spec §3.2; loop-start rule per owner decision 2026-11-16,
 * PR #108 gate B): a thinking-enabled request whose current tool
 * loop starts with an assistant message carrying no reasoning part
 * of THIS attempt's origin (provider + model, signature included)
 * 400s upstream. Anthropic counts the whole tool loop as ONE
 * assistant turn — "A tool-use loop is one assistant turn. From the
 * model's perspective, an assistant turn ends only when Claude
 * completes its full response, which might include multiple tool
 * calls and results."
 * (https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-with-tool-use)
 * — and manual mode requires that "the final assistant turn of a
 * thinking-enabled request must start with a thinking block"
 * (https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 * §Turn structure in manual mode). The block is therefore required
 * on the FIRST assistant message of the loop, not the last
 * tool-calling one: models without interleaved thinking (Claude
 * Haiku 4.5) think only at the start of the loop, so checking the
 * last step disabled thinking for the rest of the session. The
 * guard removes `thinking` (and `output_config.effort`, which would
 * imply it) and records `reasoning_dropped`/
 * `thinking_disabled_no_prior_block`.
 */
function applyContinuityGuard(
  result: MessageCreateParams,
  request: CanonicalRequest,
): void {
  if ((result as { thinking?: unknown }).thinking === undefined) return;
  let lastCallIndex = -1;
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i];
    if (m.role === "assistant" && (m.toolCalls ?? []).length > 0) {
      lastCallIndex = i;
      break;
    }
  }
  if (lastCallIndex === -1) return;
  // The tool loop is one assistant turn: walk back over the
  // contiguous assistant/tool span (a user or system message ends
  // it) to the loop's first assistant message.
  let loopStart = request.messages[lastCallIndex];
  for (let i = lastCallIndex - 1; i >= 0; i--) {
    const m = request.messages[i];
    if (m.role !== "assistant" && m.role !== "tool") break;
    if (m.role === "assistant") loopStart = m;
  }
  const parts = Array.isArray(loopStart.content) ? loopStart.content : [];
  const hasOwnBlock = parts.some(
    (p) =>
      p.type === "reasoning" &&
      p.reasoning !== undefined &&
      originMatchesCurrent(p.reasoning.origin) &&
      p.signature !== undefined &&
      signatureMatchesCurrent(p.signature),
  );
  if (hasOwnBlock) return;
  delete (result as { thinking?: unknown }).thinking;
  const outputConfig = (result as { output_config?: Record<string, unknown> })
    .output_config;
  if (outputConfig !== undefined && "effort" in outputConfig) {
    const { effort: _e, ...rest } = outputConfig;
    if (Object.keys(rest).length === 0) {
      delete (result as { output_config?: unknown }).output_config;
    } else {
      (result as { output_config?: unknown }).output_config = rest;
    }
  }
  recordNote(
    {
      stage: "encode",
      adapter: "anthropic",
      code: "reasoning_dropped",
      path: "thinking_disabled_no_prior_block",
    },
    "Disabling thinking: the last tool-call turn has no reasoning block of this origin",
  );
}

/**
 * Canonical `responseFormat` → `output_config.format` (v1.4 spec
 * §3.5): `{type:"json_schema", schema}` per the GA structured-outputs
 * doc
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 * — the beta `output_format` + `structured-outputs-2025-11-13` header
 * is superseded; GA needs no header). `output_config` is shared with
 * reasoning effort (Task 6): `format` merges into the object, never
 * overwrites it. `json_object` is a 400 `unsupported_response_format`
 * — Anthropic has no schemaless JSON mode. `name` is never sent;
 * `strict`/`description` have no slot (schema conformance is inherent
 * to the grammar-constrained decode) and are noted.
 */
function applyResponseFormat(
  result: MessageCreateParams,
  request: CanonicalRequest,
): void {
  const rf = request.responseFormat;
  if (rf === undefined) return;
  if (rf.type === "json_object") {
    throw new UnsupportedResponseFormatError(
      'Anthropic does not support response format "json_object" (no schemaless JSON mode)',
    );
  }
  noteDroppedFormatExtras("anthropic", rf);
  result.output_config = {
    ...result.output_config,
    format: { type: "json_schema", schema: rf.schema },
  };
}

// ============ RESPONSE: Anthropic → Canonical ============

export function toCanonicalResponse(
  response: Message,
  model: string,
): CanonicalResponse {
  // v1.4 spec §3.3 (Task 7): thinking/redacted_thinking blocks decode
  // to reasoning parts tagged with the current attempt's origin (or
  // `{provider: "", model}` outside one). A thinking block's
  // `signature` is the part's signature; a redacted block's `data`
  // fills that slot. Parts keep wire order so a thinking block stays
  // in front of the text/tool block it preceded; when no reasoning
  // exists the content stays a plain text string as before.
  const origin = decodeOrigin(model);
  const parts: Array<
    | { type: "reasoning"; reasoning: { text?: string; redacted?: boolean; origin: typeof origin }; signature?: { origin: typeof origin; data: string } }
    | { type: "text"; text: string }
  > = [];
  let hasReasoning = false;

  for (const block of response.content) {
    if (block.type === "thinking") {
      hasReasoning = true;
      const b = block as unknown as { thinking?: string; signature?: string };
      parts.push({
        type: "reasoning",
        reasoning: { text: b.thinking ?? "", origin },
        ...(typeof b.signature === "string" &&
          b.signature !== "" && { signature: { origin, data: b.signature } }),
      });
    } else if (block.type === "redacted_thinking") {
      hasReasoning = true;
      const b = block as unknown as { data?: string };
      parts.push({
        type: "reasoning",
        reasoning: { redacted: true, origin },
        ...(typeof b.data === "string" &&
          b.data !== "" && { signature: { origin, data: b.data } }),
      });
    } else if (block.type === "text") {
      const b = block as { text: string };
      parts.push({ type: "text", text: b.text });
    }
  }

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

  const textContent = parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  return {
    id: response.id || `anthropic-${randomUUID()}`,
    model,
    message: {
      role: "assistant",
      content: hasReasoning ? parts : textContent,
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
  // v1.5 spec §3.1 (Task 4) + conductor's call (a): reasoning reaches
  // the Anthropic client inside the `bg1.` envelope — each thinking
  // block's `signature` packs its reasoning part (real signature
  // included, inside the envelope) plus the tool-call and text
  // signatures up to the next reasoning part. A turn with signatures
  // but no reasoning part gets one `thinking{""}` block first.
  // `thinking`/`redacted_thinking` blocks, `signature` and
  // `redacted_thinking.data`:
  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking
  // (block shapes and signatures per
  // https://platform.claude.com/docs/en/build-with-claude/thinking).
  const message = response.message;
  const parts: CanonicalContentPart[] =
    typeof message.content === "string"
      ? message.content === ""
        ? []
        : [{ type: "text", text: message.content }]
      : (message.content ?? []);

  const sigAt: {
    pos: number;
    entry: EnvelopePayload["signatures"][number];
  }[] = [];
  let textIndex = 0;
  for (const [i, part] of parts.entries()) {
    if (part.type === "text") {
      if (part.signature !== undefined) {
        sigAt.push({
          pos: i,
          entry: { textIndex, signature: part.signature },
        });
      }
      textIndex++;
    } else if (
      part.type !== "reasoning" &&
      part.signature !== undefined
    ) {
      recordNote(
        {
          stage: "encode",
          adapter: "anthropic",
          code: "reasoning_dropped",
          path: "signature",
        },
        "Dropping a signature on a non-text part (no Anthropic field carries it)",
      );
    }
  }
  for (const tc of message.toolCalls ?? []) {
    if (tc.signature !== undefined) {
      sigAt.push({
        pos: parts.length,
        entry: { toolCallId: tc.id, signature: tc.signature },
      });
    }
  }

  const reasoningAt = parts
    .map((p, i) => (p.type === "reasoning" ? i : -1))
    .filter((i) => i >= 0);
  const segmentSigs = (
    after: number,
    before: number,
  ): EnvelopePayload["signatures"] =>
    sigAt
      .filter((s) => s.pos > after && s.pos < before)
      .map((s) => s.entry);
  const leading = sigAt
    .filter(
      (s) => reasoningAt.length === 0 || s.pos < reasoningAt[0],
    )
    .map((s) => s.entry);

  const noteOversize = () =>
    recordNote(
      {
        stage: "encode",
        adapter: "anthropic",
        code: "reasoning_dropped",
        path: "reasoning",
      },
      "Dropping a thinking block's signature (envelope over the 1 MiB cap)",
    );

  const content: ContentBlockParam[] = [];

  if (leading.length > 0) {
    const env = packEnvelope({
      v: 1,
      reasoning: [],
      signatures: leading,
    });
    if (env === undefined) noteOversize();
    content.push({
      type: "thinking",
      thinking: "",
      signature: env ?? "",
    });
  }

  for (const [i, part] of parts.entries()) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text ?? "" });
      continue;
    }
    if (part.type === "reasoning" && part.reasoning) {
      const next =
        reasoningAt[
          reasoningAt.indexOf(i) + 1
        ] ?? Number.POSITIVE_INFINITY;
      const env = packEnvelope({
        v: 1,
        reasoning: [part],
        signatures: segmentSigs(i, next),
      });
      if (env === undefined) noteOversize();
      if (part.reasoning.redacted === true) {
        content.push({
          type: "redacted_thinking",
          data: env ?? "",
        });
      } else {
        content.push({
          type: "thinking",
          thinking: part.reasoning.text ?? "",
          signature: env ?? "",
        });
      }
      continue;
    }
  }
  for (const tc of message.toolCalls ?? []) {
    // The call's signature rides the turn's envelopes, so the wire
    // block itself carries no signature note.
    content.push(toToolUseBlock(tc, { noteSignature: false }));
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: response.id || `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    content: content as unknown as Message["content"],
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
    v.type === undefined &&
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
 * Anthropic-dialect gap fixes for pass-through bodies (v1.5 spec
 * §3.3, Task 9) — all the Anthropic-format knowledge the shim needs;
 * the service runs this twice around a media fetch (see
 * gap-fixes.ts): pass one strips/rewrites and reports the url-bearing
 * image `source` objects to fetch as `needsMedia` JSON paths, pass
 * two renders each fetched `{data, mimeType}` placeholder as the
 * dialect's base64 source. The input body is never mutated — the
 * pass-through body shares nested objects with the client body the
 * next fallback hop re-reads.
 *
 * Only http(s) `source.url` values are queued: a non-http scheme is
 * a provider reference the upstream may itself understand, so it
 * passes through untouched. `documents` refuses in the dialect's own
 * error; `count_tokens` and `stream_usage` carry no request-body
 * change (passthrough.ts and the trace finish honour them).
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
      adapter: "anthropic",
      code,
      ...(path !== undefined ? { path } : {}),
    });
  };
  if (gaps.length === 0) return { body, notes, needsMedia };
  const out = structuredClone(body) as Obj;

  // tool_choice: dropped; only the bare API-default {type:"auto"}
  // goes silently — any/none/named/flagged choices earn the note.
  if (gaps.includes("tool_choice") && out.tool_choice !== undefined) {
    const choice = out.tool_choice;
    const silent =
      isObj(choice) &&
      choice.type === "auto" &&
      Object.keys(choice).length === 1;
    delete out.tool_choice;
    if (!silent) note("tool_choice_dropped", "tool_choice");
  }

  // prompt_cache: every cache_control anywhere — system blocks,
  // content blocks, tool definitions and the top-level marker.
  if (gaps.includes("prompt_cache")) stripCacheControl(out, "", note);

  const wantDocuments = gaps.includes("documents");
  const wantUrlImages = gaps.includes("url_images");
  if (wantDocuments || wantUrlImages) {
    walkJson(out, "", (block, path) => {
      if (wantDocuments && block.type === "document") {
        throw new ValidationError(
          `Unsupported media at ${path}: documents are not supported by ${gapTarget()}`,
        );
      }
      const source = block.source;
      if (block.type === "image" && isObj(source)) {
        if (
          wantUrlImages &&
          source.type === "url" &&
          typeof source.url === "string" &&
          /^https?:\/\//i.test(source.url)
        ) {
          needsMedia.push(`${path}.source`);
        } else if (isInlineRef(source)) {
          // Second pass: fetched bytes waiting at this slot.
          block.source = {
            type: "base64",
            media_type: source.mimeType,
            data: source.data,
          };
        }
      }
    });
  }

  return { body: out, notes, needsMedia };
}
