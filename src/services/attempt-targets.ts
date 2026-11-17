import type { ProviderEntry, ProviderRegistry } from "../routing/registry";
import type { RoutePlan, RouteTarget } from "../routing/plan-route";
import { hopOutcome, isFallbackEligible } from "../routing/fallback";
import type { Hop } from "../routing/route-log";
import type { Provider } from "../transformers";
import { systemText } from "../transformers/system-text";
import type {
  CanonicalContentPart,
  CanonicalRequest,
  CanonicalTool,
} from "../types/canonical.types";
import { ProxyError, UpstreamError } from "../utils/errors";
import { recordNote } from "../observe/context";
import { lowerCustomTools } from "../transformers/custom-tools";
import type { TraceFinish } from "../observe/emit";
import { toClientError } from "./upstream-errors";
import {
  applyReasoningPolicy,
  type ReasoningPolicySource,
} from "./reasoning-policy";

export type { Hop } from "../routing/route-log";

export interface AttemptResult<T> {
  value: T;
  target: RouteTarget;
  entry: ProviderEntry;
  hops: Hop[];
}

/**
 * Attach the spec §3.3 client-facing rendering to an upstream failure
 * (moved from proxy.service). Only real upstream error statuses (≥ 400)
 * go through the mapping table — timeouts, transport failures and
 * non-JSON 2xx replies already carry their final client-facing message.
 */
export function toClientFacing(
  err: UpstreamError,
  target: Provider,
): UpstreamError {
  if (err.upstreamStatus !== undefined && err.upstreamStatus >= 400) {
    err.clientError = toClientError(
      target,
      err.upstreamStatus,
      err.upstreamBody,
      err.retryAfterSeconds,
    );
  }
  return err;
}

/**
 * The canonical request this attempt sends upstream: the routed model
 * and the target provider's contextWindow (unset → config untouched,
 * spec §3.1), set on a COPY — the decoded request is never mutated.
 */
export function canonicalForTarget(
  canonical: CanonicalRequest,
  entry: ProviderEntry,
  target: RouteTarget,
  policySource?: ReasoningPolicySource,
): CanonicalRequest {
  const out: CanonicalRequest = { ...canonical, model: target.model };
  if (entry.contextWindow !== undefined) {
    out.config = { ...canonical.config, contextWindow: entry.contextWindow };
  }
  const clamp = maxTokensClampOf(canonical, entry);
  if (clamp !== undefined) {
    out.config = {
      ...(out.config ?? canonical.config),
      maxTokens: clamp.to,
    };
  }
  // §3.6: custom and namespace tools lower to function tools for
  // non-Responses targets; a Responses target keeps them native (the
  // same copy carries the lowered call history).
  const lowered =
    entry.type === "responses" ? out : lowerCustomTools(out, entry.type);
  // §3.3 (Task 8): `reasoning_content`/`thinking` passback is opt-in
  // per provider (`reasoning_passback`) — an openai/ollama entry
  // without it sees no reasoning parts, and signatures (no wire slot)
  // go either way. Anthropic/Gemini/Responses encoders keep and
  // origin-filter them themselves.
  const reasoned = stripReasoningForTarget(lowered, entry);
  // §3.2: Anthropic and providers with cache_hints honour hints;
  // everywhere else they are removed from the copy before encode.
  const shaped =
    entry.type !== "anthropic" && entry.cacheHints !== true
      ? stripCacheHints(reasoned, entry.type)
      : reasoned;
  // v1.5 §3.1: `reasoning: false` on the entry strips the reasoning
  // config the source decoder mapped, with the source's v1.4 note.
  return policySource === undefined
    ? shaped
    : applyReasoningPolicy(
        shaped,
        entry,
        policySource.source,
        policySource.sourceBody,
      );
}

/**
 * Task 8 (spec §3.3): for `openai`/`ollama` targets, drop reasoning
 * parts unless the entry opted into passback, and drop signatures
 * always (neither dialect carries them). Parts come out of message
 * content; `signature` fields come off remaining parts and tool
 * calls — a single `reasoning_dropped` note per request covers the
 * strip (the encoders note nothing they never saw).
 */
function stripReasoningForTarget(
  canonical: CanonicalRequest,
  entry: ProviderEntry,
): CanonicalRequest {
  if (entry.type !== "openai" && entry.type !== "ollama") {
    return canonical;
  }
  const stripParts = entry.reasoningPassback !== true;
  let stripped = false;
  const messages = canonical.messages.map((m) => {
    if (!Array.isArray(m.content)) {
      if ((m.toolCalls ?? []).some((c) => c.signature !== undefined)) {
        stripped = true;
        return {
          ...m,
          toolCalls: m.toolCalls?.map((c) => {
            const { signature: _s, ...rest } = c;
            return rest;
          }),
        };
      }
      return m;
    }
    const content = m.content.filter(
      (p) => !(stripParts && p.type === "reasoning"),
    );
    const cleaned = content.map((p) => {
      if (p.signature === undefined) return p;
      stripped = true;
      const { signature: _s, ...rest } = p;
      return rest;
    });
    const droppedParts = content.length !== m.content.length;
    if (droppedParts) stripped = true;
    const toolCalls = m.toolCalls?.map((c) => {
      if (c.signature === undefined) return c;
      stripped = true;
      const { signature: _s, ...rest } = c;
      return rest;
    });
    if (!droppedParts && cleaned.every((p, i) => p === m.content[i])) {
      // Nothing changed in content — keep the message object when
      // toolCalls are unchanged too.
      if (toolCalls === m.toolCalls) return m;
      return { ...m, toolCalls };
    }
    return {
      ...m,
      content: cleaned.length === 0 ? "" : cleaned,
      toolCalls,
    };
  });
  if (!stripped) return canonical;
  recordNote(
    {
      stage: "encode",
      adapter: entry.type,
      code: "reasoning_dropped",
    },
    `Dropping reasoning content (target "${entry.type}" has no reasoning_passback slot)`,
  );
  return { ...canonical, messages };
}

/** Return `part` without its cache hint; shares the object when unhinted. */
function withoutHint(part: CanonicalContentPart): CanonicalContentPart {
  if (part.cache === undefined) return part;
  const { cache: _hint, ...rest } = part;
  return rest;
}

function withoutToolHint(tool: CanonicalTool): CanonicalTool {
  if (tool.cache === undefined) return tool;
  const { cache: _hint, ...rest } = tool;
  return rest;
}

/**
 * Remove every cache hint from a per-target copy (spec §3.2). Parts
 * prompts exist only to carry hints, so a system prompt or system
 * message whose parts lose their hints collapses back to the string
 * the decoder produced (systemText's "\n\n" join) — the strip changes
 * no prompt text. Hinted arrays elsewhere keep their shape (a user
 * message may mix text and images); tools keep theirs too. Ollama
 * drops hints silently per the spec table.
 */
function stripCacheHints(
  canonical: CanonicalRequest,
  target: Provider,
): CanonicalRequest {
  let stripped = false;
  const out: CanonicalRequest = { ...canonical };

  if (
    Array.isArray(canonical.systemPrompt) &&
    canonical.systemPrompt.some((p) => p.cache !== undefined)
  ) {
    out.systemPrompt = systemText(canonical.systemPrompt);
    stripped = true;
  }

  out.messages = canonical.messages.map((m) => {
    // A tool result's hint lives on the message itself (Task 17a);
    // hints on other roles live on their content parts.
    let next = m;
    if (m.cache !== undefined) {
      stripped = true;
      const { cache: _hint, ...rest } = m;
      next = rest;
    }
    if (!Array.isArray(next.content)) return next;
    if (!next.content.some((p) => p.cache !== undefined)) return next;
    stripped = true;
    if (
      next.role === "system" &&
      next.content.every((p) => p.type === "text")
    ) {
      return { ...next, content: systemText(next.content) ?? "" };
    }
    return { ...next, content: next.content.map(withoutHint) };
  });

  if (canonical.tools?.some((t) => t.cache !== undefined)) {
    out.tools = canonical.tools.map(withoutToolHint);
    stripped = true;
  }

  if (stripped && target !== "ollama") {
    recordNote(
      {
        stage: "encode",
        adapter: target,
        code: "cache_control_dropped",
      },
      `Dropping cache hints (target provider "${target}" has no cache_hints)`,
    );
  }
  return out;
}

/**
 * The trace's status/httpStatus/errorType for a failed chat request
 * (spec §3.1): the client-facing values — the canonical error's status
 * and kind, matching what the error handler renders. A client abort
 * before any response went out records 499 (nginx's client-closed
 * convention); mid-stream aborts record the 200 already sent.
 */
export function errorTraceFields(
  err: unknown,
  aborted: boolean,
): Pick<TraceFinish, "status" | "httpStatus" | "errorType"> {
  if (aborted) {
    return { status: "aborted", httpStatus: 499 };
  }
  const canonical =
    err instanceof ProxyError ? err.toCanonical() : undefined;
  return {
    status: "error",
    httpStatus: canonical?.status ?? 500,
    errorType: canonical?.kind ?? "internal",
  };
}

/**
 * The clamp canonicalForTarget's max_output_tokens applied (spec §3.3),
 * for the trace's maxTokensClamp: `{from, to}` when a requested
 * maxTokens was reduced, `{to}` when the cap filled an unset one, and
 * undefined when there is no cap or the request was already under it.
 */
export function maxTokensClampOf(
  canonical: CanonicalRequest,
  entry: ProviderEntry,
): { from?: number; to: number } | undefined {
  const cap = entry.maxOutputTokens;
  if (cap === undefined) return undefined;
  const requested = canonical.config?.maxTokens;
  if (requested === undefined) return { to: cap };
  if (requested <= cap) return undefined;
  return { from: requested, to: cap };
}

/**
 * The fallback loop shared by both chat services (spec §3.4): try each
 * of plan's targets in order. A client abort rethrows immediately —
 * no further target is tried. A fallback-eligible failure with targets
 * remaining records its hop and continues; anything else, and the last
 * target's error, carries `x-babelgate-attempts` in responseHeaders and
 * is rethrown. `ctx.hops`, when given, is filled with every upstream
 * hop (ok and failed) so the caller can emit the route log line even on
 * failure; the same array is returned on success.
 */
export async function attemptTargets<T>(
  plan: RoutePlan,
  registry: ProviderRegistry,
  attempt: (entry: ProviderEntry, target: RouteTarget) => Promise<T>,
  ctx: { requestId: string; signal?: AbortSignal; hops?: Hop[] },
): Promise<AttemptResult<T>> {
  const hops = ctx.hops ?? [];

  for (const [index, target] of plan.targets.entries()) {
    const entry = registry.get(target.provider);
    const start = Date.now();
    try {
      const value = await attempt(entry, target);
      hops.push({
        provider: target.provider,
        model: target.model,
        outcome: "ok",
        ms: Date.now() - start,
      });
      return { value, target, entry, hops };
    } catch (err) {
      // Client went away — stop; try no further target.
      if (ctx.signal?.aborted) throw err;

      // Only upstream failures are hops: an error raised before the
      // request left (validation, transform) is no route outcome.
      const outcome = hopOutcome(err);
      if (outcome !== undefined) {
        hops.push({
          provider: target.provider,
          model: target.model,
          outcome,
          ...(outcome === "http_error"
            ? { status: (err as UpstreamError).upstreamStatus }
            : {}),
          ms: Date.now() - start,
        });
      }

      if (
        index < plan.targets.length - 1 &&
        isFallbackEligible(err)
      ) {
        continue;
      }
      if (err instanceof ProxyError) {
        err.responseHeaders = {
          ...err.responseHeaders,
          "x-babelgate-attempts": String(index + 1),
        };
      }
      throw err;
    }
  }

  // plan.targets is never empty (planRoute always returns ≥ 1 target).
  throw new Error("attemptTargets: plan has no targets");
}
