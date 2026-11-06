import { getConfig } from "../config/env-config";
import { computeCost } from "../cost/compute";
import { lookupPrice } from "../cost/price-table";
import { parseTarget } from "../routing/rules";
import type { CanonicalUsage } from "../types/canonical.types";
import { logger } from "../utils/logger";
import { currentTrace } from "./context";
import { createLogSink } from "./sinks/log";
import type { RequestTrace } from "./trace";

/** §3.1.1: one trace consumer, isolated from every other. */
export interface TraceSink {
  name: string;
  accept(trace: RequestTrace): void;
}

/** The finish-side fields the pipeline knows — merged onto the trace. */
export type TraceFinish = Pick<
  RequestTrace,
  | "reason"
  | "requestedModel"
  | "hops"
  | "winner"
  | "stream"
  | "status"
  | "httpStatus"
> &
  Partial<
    Pick<
      RequestTrace,
      | "errorType"
      | "inputTokens"
      | "outputTokens"
      | "cacheReadTokens"
      | "cacheWriteTokens"
      | "finishReason"
      | "maxTokensClamp"
      | "ttfbMs"
      | "costEstimated"
    >
  >;

/** Sinks allowed to see `bodies` (spec §3.1.1); all others get a copy. */
const BODY_SINKS = new Set(["body-ring", "usage-store"]);

const WARN_THROTTLE_MS = 60_000;

// The log sink is the default — it is the v1.2 route log line's home.
// Module-level so a fresh module graph (vi.resetModules) re-registers
// it exactly once; later tasks register their sinks alongside it.
const sinks: TraceSink[] = [createLogSink()];
const warnedAt = new Map<string, number>();
const emitted = new WeakSet<RequestTrace>();

export function registerSink(sink: TraceSink): void {
  sinks.push(sink);
}

/** Test helper: drop every sink (including the default log sink). */
export function resetSinks(): void {
  sinks.length = 0;
  warnedAt.clear();
}

/**
 * Fan a finished trace out to every sink (spec §3.1.1). `bodies` is
 * stripped once before the trace reaches any sink that is not
 * body-ring/usage-store. Each accept is try/catch: a throwing sink
 * earns one warn per sink per minute and never stops the others —
 * a sink never affects a response.
 */
export function emitTrace(
  trace: RequestTrace,
  now: () => number = Date.now,
): void {
  let stripped: Omit<RequestTrace, "bodies"> | undefined;
  for (const sink of sinks) {
    try {
      if (BODY_SINKS.has(sink.name)) {
        sink.accept(trace);
      } else {
        if (stripped === undefined) {
          const { bodies: _bodies, ...rest } = trace;
          stripped = rest;
        }
        sink.accept(stripped);
      }
    } catch (err) {
      const t = now();
      const last = warnedAt.get(sink.name);
      if (last === undefined || t - last >= WARN_THROTTLE_MS) {
        warnedAt.set(sink.name, t);
        logger.warn(
          { sink: sink.name, err },
          "Trace sink failed — trace dropped for that sink",
        );
      }
    }
  }
}

/**
 * §3.6: price the winning hop's (provider, model) — never the alias
 * or requested string — from the trace's own usage (real or, for a
 * usage-less successful stream, the caller's estimate). A local row
 * priced at $0 also gets `wouldCostUsd` when observe
 * .wouldCostReference resolves through the registry. Unknown price
 * leaves costUsd null, never 0; any failure here leaves the trace
 * unpriced — pricing never reaches the client.
 */
async function priceTrace(trace: RequestTrace): Promise<void> {
  try {
    const config = getConfig();
    const okHop =
      trace.winner === undefined
        ? undefined
        : [...trace.hops]
            .reverse()
            .find(
              (h) =>
                h.provider === trace.winner && h.outcome === "ok",
            );
    if (okHop === undefined) return;
    const { inputTokens, outputTokens } = trace;
    if (inputTokens === undefined || outputTokens === undefined) return;
    const usage: CanonicalUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(trace.cacheReadTokens !== undefined
        ? { cacheReadTokens: trace.cacheReadTokens }
        : {}),
      ...(trace.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: trace.cacheWriteTokens }
        : {}),
    };

    const hit = await lookupPrice(
      config.registry.get(okHop.provider),
      okHop.model,
      config,
    );
    if (hit === undefined) return;
    const cost = computeCost(usage, hit.price);
    trace.costUsd = cost.usd;
    trace.priceSource = hit.source;
    trace.costEstimated = trace.costEstimated || cost.estimated;

    if (
      hit.source === "local" &&
      config.observe.wouldCostReference !== undefined
    ) {
      const ref = parseTarget(
        config.observe.wouldCostReference,
        new Set(config.registry.names()),
      );
      if (ref !== undefined) {
        const refHit = await lookupPrice(
          config.registry.get(ref.provider),
          ref.model,
          config,
        );
        if (refHit !== undefined) {
          trace.wouldCostUsd = computeCost(usage, refHit.price).usd;
        }
      }
    }
  } catch (err) {
    logger.debug(
      { requestId: trace.requestId, err },
      "Cost lookup failed; trace emitted unpriced",
    );
  }
}

/**
 * Merge the pipeline's finish fields into the ambient trace, stamp
 * totalMs, price it (§3.6) and emit it exactly once — a second call
 * for the same trace (e.g. an error path plus the stream's finally)
 * is a no-op. Outside a trace scope it is a no-op: the caller decides
 * nothing — the middleware decides what is traced.
 */
export async function finishTrace(update: TraceFinish): Promise<void> {
  const trace = currentTrace();
  if (trace === undefined || emitted.has(trace)) return;
  emitted.add(trace);
  Object.assign(trace, update);
  trace.totalMs = Date.now() - trace.startedAt;
  await priceTrace(trace);
  emitTrace(trace);
}
