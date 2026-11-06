import type { RouteLogRecord } from "../routing/route-log";
import type { Provider } from "../transformers";
import type { CanonicalErrorKind } from "../types/canonical.types";

/**
 * The spec §3.1 request trace: one per chat request, created by
 * observeMiddleware, filled in by the services as the request moves
 * through the pipeline and emitted once by finishTrace. Extends the
 * v1.2 route log record; the routing/usage fields are placeholders
 * until finishTrace merges the finish update — the middleware cannot
 * know them yet.
 */

/**
 * §3.4 client identity. The `| string` tail is deliberate: a valid
 * `x-babelgate-client` header may name any client (e.g. "playground",
 * "my-bot").
 */
export type ClientId =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "openai-sdk"
  | "anthropic-sdk"
  | "google-genai"
  | "ollama-sdk"
  | "playground"
  | "other"
  | string;

/** §3.5: one translation note — codes and field paths, never content. */
export interface TranslationNote {
  stage: "decode" | "encode";
  adapter: Provider;
  code: string;
  /** JSON path of the affected field, e.g. "messages[3].content[1]" */
  path?: string;
}

/** §3.7: one diagnosed tool call (Task 9 fills the array). */
export interface ToolCallDiagnostic {
  toolCallId: string;
  name: string;
  code:
    | "invalid_json"
    | "fenced_json"
    | "not_object"
    | "unknown_tool"
    | "missing_required";
  /** The missing property name; never argument text */
  detail?: string;
}

/** §3.7: the repair steps applied to one tool call (Task 9). */
export interface ToolCallRepair {
  toolCallId: string;
  steps: ("strip_fence" | "extract_object" | "trailing_comma")[];
}

/** §3.5: one captured body, capped and marked when truncated. */
export interface BodySnapshot {
  value: unknown;
  truncated?: true;
}

/**
 * §3.5: the body snapshots for one request. Read only by the
 * `body-ring` and `usage-store` sinks — emitTrace strips `bodies`
 * before any other sink sees the trace.
 */
export interface BodySnapshots {
  source?: BodySnapshot;
  canonical?: BodySnapshot;
  target: BodySnapshot[];
  response?: { canonical?: BodySnapshot; wire?: BodySnapshot };
}

export interface RequestTrace extends RouteLogRecord {
  /** epoch ms */
  startedAt: number;
  client: ClientId;
  /** truncated to 200 chars */
  userAgent?: string;
  status: "ok" | "error" | "aborted";
  httpStatus: number;
  /** canonical error kind, never a message body */
  errorType?: CanonicalErrorKind | string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** null = unknown price (never 0) */
  costUsd: number | null;
  wouldCostUsd?: number;
  costEstimated: boolean;
  priceSource?: "override" | "live" | "bundled" | "local";
  maxTokensClamp?: { from?: number; to: number };
  ttfbMs?: number;
  totalMs: number;
  notes: TranslationNote[];
  diagnostics: ToolCallDiagnostic[];
  repairs: ToolCallRepair[];
  /** only while the ring is enabled (Task 6) */
  bodies?: BodySnapshots;
}

/**
 * Seed the trace at middleware time (spec §3.1 `observe.begin`):
 * identity is known; everything the pipeline fills in later starts as
 * an empty placeholder that finishTrace overwrites.
 */
export function newTrace(init: {
  requestId: string;
  startedAt: number;
  client: ClientId;
  userAgent?: string;
  sourceApi: Provider;
}): RequestTrace {
  return {
    requestId: init.requestId,
    sourceApi: init.sourceApi,
    requestedModel: "",
    reason: "",
    hops: [],
    stream: false,
    startedAt: init.startedAt,
    client: init.client,
    ...(init.userAgent !== undefined && { userAgent: init.userAgent }),
    status: "ok",
    httpStatus: 0,
    costUsd: null,
    costEstimated: false,
    totalMs: 0,
    notes: [],
    diagnostics: [],
    repairs: [],
  };
}
