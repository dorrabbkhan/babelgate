import type { TraceSink } from "../emit";
import type { RequestTrace } from "../trace";
import { logger } from "../../utils/logger";

/**
 * The v1.2 route log line as a trace sink (spec §3.1): one
 * "Request completed" info line per chat request — every
 * RouteLogRecord field under the same names, plus the trace's
 * identity, status, cache usage, cost and timings. Diagnostics go in
 * as codes only; notes, repairs, bodies and the raw user agent never
 * reach the log (privacy: headers and bodies are never logged).
 */
export function createLogSink(): TraceSink {
  return {
    name: "log",
    accept(trace: RequestTrace): void {
      logger.info(
        {
          requestId: trace.requestId,
          sourceApi: trace.sourceApi,
          requestedModel: trace.requestedModel,
          reason: trace.reason,
          hops: trace.hops,
          winner: trace.winner,
          stream: trace.stream,
          inputTokens: trace.inputTokens,
          outputTokens: trace.outputTokens,
          finishReason: trace.finishReason,
          client: trace.client,
          status: trace.status,
          httpStatus: trace.httpStatus,
          cacheReadTokens: trace.cacheReadTokens,
          cacheWriteTokens: trace.cacheWriteTokens,
          costUsd: trace.costUsd,
          ttfbMs: trace.ttfbMs,
          totalMs: trace.totalMs,
          diagnostics: trace.diagnostics.map((d) => d.code),
        },
        "Request completed",
      );
    },
  };
}
