import { Router } from "express";
import type { Response } from "express";
import {
  onTraceStarted,
  registerSink,
  type TraceSink,
} from "../observe/emit";
import type { RequestRow } from "../observe/sinks/usage-queries";
import type { RequestTrace } from "../observe/trace";

/**
 * `GET /ui/api/live` (spec §3.9): a server-sent-events feed of every
 * traced chat request — `event: started` when the model is resolved
 * (the request is in flight) and `event: finished` with the RequestRow
 * once the trace emits. Bodies never reach the feed: emitTrace strips
 * them before any sink that is not body-ring/usage-store, and this
 * sink's name is "live".
 *
 * The feed wires itself up lazily on the first connection: the sink
 * and the started hook are module singletons registered once — a feed
 * with no subscribers costs nothing, and a reconnected client just
 * rejoins the broadcast.
 */

const KEEPALIVE_MS = 15_000;

const clients = new Set<Response>();

/**
 * The finished trace → the `finished` row — the same shape the
 * `requests` table returns (usage-queries.ts), minus bodies.
 */
function traceToRow(trace: RequestTrace): RequestRow {
  const winner = [...trace.hops]
    .reverse()
    .find((h) => h.outcome === "ok");
  return {
    id: trace.requestId,
    startedAt: trace.startedAt,
    client: trace.client,
    userAgent: trace.userAgent ?? null,
    sourceApi: trace.sourceApi,
    requestedModel: trace.requestedModel,
    routeReason: trace.reason,
    provider: trace.winner ?? null,
    model: winner?.model ?? null,
    stream: trace.stream,
    status: trace.status,
    httpStatus: trace.httpStatus,
    errorType: trace.errorType ?? null,
    inputTokens: trace.inputTokens ?? null,
    outputTokens: trace.outputTokens ?? null,
    cacheReadTokens: trace.cacheReadTokens ?? null,
    cacheWriteTokens: trace.cacheWriteTokens ?? null,
    costUsd: trace.costUsd,
    wouldCostUsd: trace.wouldCostUsd ?? null,
    costEstimated: trace.costEstimated,
    priceSource: trace.priceSource ?? null,
    ttfbMs: trace.ttfbMs ?? null,
    totalMs: trace.totalMs,
    finishReason: trace.finishReason ?? null,
    hops: trace.hops,
    notes: trace.notes,
    diagnostics: trace.diagnostics,
    repairs: trace.repairs,
  };
}

function broadcast(event: string, data: unknown): void {
  if (clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

// Module singletons — registration is idempotent (registerSink /
// onTraceStarted dedupe by identity), so reconnecting clients re-add
// them after a test's resetSinks() without duplicating.
const liveSink: TraceSink = {
  name: "live",
  accept: (trace) => broadcast("finished", traceToRow(trace)),
};

const onStarted = (started: Parameters<typeof broadcast>[1]): void =>
  broadcast("started", started);

export function liveRouter(): Router {
  const router = Router();

  router.get("/live", (req, res) => {
    registerSink(liveSink);
    onTraceStarted(onStarted);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    clients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(":keepalive\n\n");
      } catch {
        // gone — the close handler below removes it
      }
    }, KEEPALIVE_MS);
    keepalive.unref();

    req.on("close", () => {
      clearInterval(keepalive);
      clients.delete(res);
    });
  });

  return router;
}
