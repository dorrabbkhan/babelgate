/**
 * Typed fetchers for the /ui/api routes (spec §3.9, Task 12). Every
 * request carries `x-babelgate-ui: 1` (the custom header the access
 * layer requires — a web page cannot forge it without a preflight the
 * server never approves) and, when the user has entered one, the
 * PROXY_API_KEY as a Bearer token from auth.ts. Bodies never travel
 * over /live — the feed carries only `started` metadata and finished
 * RequestRows.
 */
import { getKey } from "./auth";

export class UiApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "UiApiError";
  }
}

/** One tried route target, as the row's `hops` array carries it. */
export interface Hop {
  provider: string;
  model: string;
  outcome: "ok" | "http_error" | "timeout" | "transport";
  status?: number;
  ms: number;
}

export interface TranslationNote {
  stage: "decode" | "encode";
  adapter: string;
  code: string;
  path?: string;
}

export interface ToolCallDiagnostic {
  toolCallId: string;
  name: string;
  code:
    | "invalid_json"
    | "fenced_json"
    | "not_object"
    | "unknown_tool"
    | "missing_required";
  detail?: string;
}

export interface ToolCallRepair {
  toolCallId: string;
  steps: ("strip_fence" | "extract_object" | "trailing_comma")[];
}

/** `GET /requests` row (src/observe/sinks/usage-queries.ts RequestRow). */
export interface RequestRow {
  id: string;
  startedAt: number;
  client: string;
  userAgent: string | null;
  sourceApi: string;
  requestedModel: string;
  routeReason: string;
  provider: string | null;
  model: string | null;
  stream: boolean;
  status: string;
  httpStatus: number;
  errorType: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  wouldCostUsd: number | null;
  costEstimated: boolean;
  priceSource: string | null;
  ttfbMs: number | null;
  totalMs: number;
  finishReason: string | null;
  hops: Hop[];
  notes: TranslationNote[];
  diagnostics: ToolCallDiagnostic[];
  repairs: ToolCallRepair[];
}

export interface BodySnapshot {
  value: unknown;
  truncated?: true;
}

/** §3.5 body snapshots — present only while the ring or LOG_BODIES holds them. */
export interface Bodies {
  source?: BodySnapshot;
  canonical?: BodySnapshot;
  target: BodySnapshot[];
  response?: { canonical?: BodySnapshot; wire?: BodySnapshot };
}

/** `GET /requests/:id` envelope. */
export interface RequestDetail {
  row: RequestRow;
  bodies: Bodies | null;
  reason?: "not_retained";
}

/** `GET /live` `started` event — never bodies. */
export interface LiveStarted {
  id: string;
  client: string;
  sourceApi: string;
  requestedModel: string;
  startedAt: number;
}

export interface UsageGroup {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  wouldCostUsd: number;
  unpriced: number;
  errors: number;
  fallbacks: number;
  cacheHitRatio: number | null;
}

export interface RoutingProvider {
  name: string;
  type: string;
  baseUrl: string;
  maxOutputTokens?: number;
  cacheHints: boolean;
  livePrices: boolean;
  repairToolCalls: boolean;
  local: boolean;
}

export interface RouteTarget {
  provider: string;
  model: string;
}

export interface RoutingRule {
  match: string;
  to: RouteTarget;
  fallback: RouteTarget[];
  when?: Record<string, unknown>;
}

/** USD per 1M tokens (src/cost/price-table.ts `Price`). */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** src/cost/price-table.ts `PriceSource`. */
export type PriceSource = "override" | "local" | "live" | "bundled";

export interface RoutingInfo {
  providers: RoutingProvider[];
  aliases: Record<string, RouteTarget>;
  rules: RoutingRule[];
  defaultProvider: string;
  prices: { target: string; price?: Price; source?: PriceSource }[];
}

export interface RoutePlan {
  targets: RouteTarget[];
  reason: string;
}

const API_BASE = "/ui/api";

export async function uiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-babelgate-ui", "1");
  const key = getKey();
  if (key !== null && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${key}`);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let code = "ERROR";
    let message = res.statusText;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body — keep status text
    }
    throw new UiApiError(res.status, code, message);
  }
  return res;
}

export interface ListParams {
  client?: string;
  model?: string;
  provider?: string;
  status?: string;
  limit?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

export async function listRequests(
  params: ListParams = {},
  cursor?: string,
): Promise<{ rows: RequestRow[]; nextCursor?: string }> {
  const res = await uiFetch(
    `/requests${query({ ...params, cursor })}`,
  );
  return (await res.json()) as { rows: RequestRow[]; nextCursor?: string };
}

export async function getRequest(id: string): Promise<RequestDetail> {
  const res = await uiFetch(`/requests/${encodeURIComponent(id)}`);
  return (await res.json()) as RequestDetail;
}

export async function getUsage(params: {
  from?: number;
  to?: number;
  group?: "day" | "model" | "provider" | "client";
}): Promise<{ groups: UsageGroup[] }> {
  const res = await uiFetch(`/usage${query({ ...params })}`);
  return (await res.json()) as { groups: UsageGroup[] };
}

export async function getRouting(): Promise<RoutingInfo> {
  const res = await uiFetch("/routing");
  return (await res.json()) as RoutingInfo;
}

export async function planRoute(model: string): Promise<RoutePlan> {
  const res = await uiFetch(`/routing/plan${query({ model })}`);
  return (await res.json()) as RoutePlan;
}

export interface LiveHandlers {
  onStarted?: (event: LiveStarted) => void;
  onFinished?: (row: RequestRow) => void;
  /** Access-denied or repeated transport failure — the screen decides. */
  onError?: (err: unknown) => void;
}

export function parseSseChunk(
  buffer: string,
  emit: (event: string, data: string) => void,
): string {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length > 0) emit(event, data.join("\n"));
  }
  return rest;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * `/live` over fetch — EventSource cannot send `x-babelgate-ui`, so the
 * stream is read and parsed here. Reconnects with exponential backoff
 * (0.5 s → 30 s cap); a 401/403 stops retrying and reports via
 * onError (a key may fix it — reconnecting wouldn't).
 */
export function streamLive(handlers: LiveHandlers): { close(): void } {
  const controller = new AbortController();
  let closed = false;

  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!closed) {
      try {
        const res = await uiFetch("/live", {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        attempt = 0;
        const reader = res.body?.getReader();
        if (reader === undefined) return;
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = parseSseChunk(buffer, (event, data) => {
            try {
              const parsed = JSON.parse(data) as unknown;
              if (event === "started")
                handlers.onStarted?.(parsed as LiveStarted);
              else if (event === "finished")
                handlers.onFinished?.(parsed as RequestRow);
            } catch {
              // malformed frame — drop it, keep the stream
            }
          });
        }
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        if (err instanceof UiApiError && (err.status === 401 || err.status === 403)) {
          handlers.onError?.(err);
          return;
        }
      }
      if (closed) return;
      await sleep(
        Math.min(30_000, 500 * 2 ** attempt),
        controller.signal,
      );
      attempt++;
    }
  };

  void run();
  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}

// The /playground SSE client lives in ./playground-api (one-shot POST
// stream, unlike the /live reconnect loop above).
