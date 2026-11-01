import type { Provider } from "../transformers";
import { logger } from "../utils/logger";

/** One tried route target (spec §3.4 route log line). */
export interface Hop {
  provider: string;
  model: string;
  outcome: "ok" | "http_error" | "timeout" | "transport";
  status?: number;
  ms: number;
}

/**
 * The spec §3.4 route log record — one per chat request; the v1.3
 * usage-store row. Only routing and usage fields: never prompt bodies,
 * completions, tool arguments or keys.
 */
export interface RouteLogRecord {
  requestId: string;
  sourceApi: Provider;
  requestedModel: string;
  reason: string;
  hops: Hop[];
  winner?: string;
  stream: boolean;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}

/** One info line per chat request, replacing "Request completed". */
export function logRoute(record: RouteLogRecord): void {
  logger.info(record, "Request completed");
}
