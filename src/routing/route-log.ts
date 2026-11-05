import type { Provider } from "../transformers";

/** One tried route target (spec §3.4 route log line). */
export interface Hop {
  provider: string;
  model: string;
  outcome: "ok" | "http_error" | "timeout" | "transport";
  status?: number;
  ms: number;
}

/**
 * The spec §3.4 route log record — the routing and usage fields of a
 * v1.3 RequestTrace (src/observe/trace.ts). Only routing and usage
 * fields: never prompt bodies, completions, tool arguments or keys.
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
