import type { ProviderEntry, ProviderRegistry } from "../routing/registry";
import type { RoutePlan, RouteTarget } from "../routing/plan-route";
import { hopOutcome, isFallbackEligible } from "../routing/fallback";
import type { Hop } from "../routing/route-log";
import type { Provider } from "../transformers";
import type { CanonicalRequest } from "../types/canonical.types";
import { ProxyError, UpstreamError } from "../utils/errors";
import { toClientError } from "./upstream-errors";

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
  return out;
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
