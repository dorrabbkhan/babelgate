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
 * Merge the pipeline's finish fields into the ambient trace, stamp
 * totalMs, and emit it exactly once — a second call for the same
 * trace (e.g. an error path plus the stream's finally) is a no-op.
 * Outside a trace scope it is a no-op: the caller decides nothing —
 * the middleware decides what is traced.
 */
export async function finishTrace(update: TraceFinish): Promise<void> {
  const trace = currentTrace();
  if (trace === undefined || emitted.has(trace)) return;
  emitted.add(trace);
  Object.assign(trace, update);
  trace.totalMs = Date.now() - trace.startedAt;
  emitTrace(trace);
}
