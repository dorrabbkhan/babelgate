import { UpstreamError } from "../utils/errors";
import { parseRetryAfter } from "../utils/canonical-error";
import { logger } from "../utils/logger";

export interface UpstreamRequestOptions {
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  requestId?: string;
}

export interface UpstreamResponse {
  status: number;
  body: unknown;
  durationMs: number;
  contentType?: string;
  /**
   * Raw upstream response headers, lower-cased — pass-through relays
   * the end-to-end subset (services/passthrough.ts owns the policy).
   */
  headers?: Record<string, string>;
  /** Whole seconds from the upstream Retry-After header, when present */
  retryAfterSeconds?: number;
}

/** Retry only these upstream statuses — upstream rejected before processing */
const RETRYABLE_STATUSES = new Set([429, 503]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 1;
const BASE_BACKOFF_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: ~250ms, ~500ms, ... */
function backoffMs(attempt: number): number {
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * base * 0.5);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

/**
 * Send a JSON request to an upstream provider with timeout + conservative
 * retry. postJson/getJson are thin wrappers.
 *
 * Retry policy: LLM POSTs aren't idempotent — retrying a request the
 * upstream may have already processed can double-bill tokens. So we only
 * retry transport failures (connection refused, DNS, socket reset) and
 * 429/503 where the upstream rejected before processing. Never retry other
 * statuses or timeouts (a partial generation may have run). GETs are
 * idempotent but follow the same policy for simplicity.
 */
export async function requestJson(
  method: "GET" | "POST",
  opts: UpstreamRequestOptions,
): Promise<UpstreamResponse> {
  const {
    url,
    headers,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    requestId,
  } = opts;

  const maxAttempts = retries + 1;
  let lastError: UpstreamError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
          ...(requestId ? { "x-request-id": requestId } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const durationMs = Date.now() - start;
      const contentType = res.headers.get("content-type") ?? "unknown";
      const retryAfterSeconds = parseRetryAfter(
        res.headers.get("retry-after"),
      );
      const text = await res.text();
      let parsed: unknown = null;
      let parseFailed = false;
      try {
        parsed = JSON.parse(text);
      } catch {
        parseFailed = true;
      }

      logger.info(
        {
          requestId,
          url,
          attempt: attempt + 1,
          durationMs,
          status: res.status,
        },
        "Upstream request",
      );

      // Retryable rejection (429/503): upstream declined before processing
      if (RETRYABLE_STATUSES.has(res.status)) {
        if (attempt < maxAttempts - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        const error = new UpstreamError(
          `Upstream rejected request after ${maxAttempts} attempts`,
          res.status,
          parsed,
          { requestId, url, attempts: maxAttempts },
        );
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
      }

      // A 2xx that isn't valid JSON is an upstream failure (e.g. Ollama
      // answering with NDJSON), not a successful empty response.
      if (res.ok && parseFailed) {
        throw new UpstreamError(
          `Upstream returned a non-JSON response (content-type: ${contentType})`,
          res.status,
          undefined,
          {
            requestId,
            url,
            // the error-handler never logs err.context; the body preview
            // (completion text for NDJSON) surfaces only in
            // non-production response details
            ...(process.env.NODE_ENV !== "production"
              ? { bodyPreview: text.slice(0, 200) }
              : {}),
          },
        );
      }

      return {
        status: res.status,
        body: parseFailed ? null : parsed,
        durationMs,
        contentType,
        headers: Object.fromEntries(res.headers.entries()),
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      };
    } catch (err) {
      // Our own UpstreamErrors (non-JSON 2xx, retries exhausted) propagate.
      if (err instanceof UpstreamError) throw err;

      const durationMs = Date.now() - start;

      // Timeout: never retry — upstream may have partially processed
      if (isAbortError(err)) {
        throw new UpstreamError(
          `Upstream timed out after ${timeoutMs}ms`,
          undefined,
          undefined,
          { requestId, url, durationMs },
          504,
        );
      }

      // Transport failure: safe to retry — upstream likely never saw it
      lastError = new UpstreamError(
        `Upstream unreachable: ${err instanceof Error ? err.message : "connection failed"}`,
        undefined,
        undefined,
        { requestId, url, attempt: attempt + 1, durationMs },
      );

      if (attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }

  throw lastError ?? new UpstreamError("Upstream request failed");
}

export function postJson(
  opts: UpstreamRequestOptions,
): Promise<UpstreamResponse> {
  return requestJson("POST", opts);
}

export function getJson(
  opts: UpstreamRequestOptions,
): Promise<UpstreamResponse> {
  return requestJson("GET", opts);
}

export interface UpstreamStreamResponse {
  status: number;
  body: ReadableStream<Uint8Array>;
  durationMs: number;
  /** `content-type` header value — pass-through relays it to the client. */
  contentType?: string;
  /**
   * Raw upstream response headers, lower-cased — pass-through relays
   * the end-to-end subset (services/passthrough.ts owns the policy).
   */
  headers?: Record<string, string>;
}

/**
 * POST that resolves as soon as response headers arrive, leaving the body
 * as a ReadableStream for the streaming pipeline (spec §3.2).
 *
 * Non-2xx: the body is read as JSON (null when it isn't) and the same
 * UpstreamError the JSON path produces is thrown — proxy.service maps it
 * to the client's dialect identically. `timeoutMs` covers connect +
 * headers only; inter-chunk gaps are the pipeline's idle timeout.
 * Retries match requestJson (transport failures, 429/503) and can only
 * ever happen before headers — the stream body is never retried.
 * `signal` aborts the upstream request (client disconnect).
 */
export async function postStream(
  opts: UpstreamRequestOptions & { signal?: AbortSignal },
): Promise<UpstreamStreamResponse> {
  const {
    url,
    headers,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    requestId,
    signal,
  } = opts;

  const maxAttempts = retries + 1;
  let lastError: UpstreamError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const start = Date.now();
    try {
      // timeoutMs bounds connect + response headers only (spec §3.2):
      // a header-phase AbortController whose timer is cleared the
      // moment fetch resolves, so nothing bounds the body except the
      // pipeline's idle timeout. The caller's signal stays armed — it
      // is what aborts the body on client disconnect.
      const headerPhase = new AbortController();
      const headerTimer = setTimeout(
        () => headerPhase.abort(),
        timeoutMs,
      );
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
          ...(requestId ? { "x-request-id": requestId } : {}),
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, headerPhase.signal])
          : headerPhase.signal,
      }).finally(() => clearTimeout(headerTimer));

      const durationMs = Date.now() - start;
      const retryAfterSeconds = parseRetryAfter(
        res.headers.get("retry-after"),
      );

      logger.info(
        {
          requestId,
          url,
          attempt: attempt + 1,
          durationMs,
          status: res.status,
        },
        "Upstream request",
      );

      if (!res.ok) {
        // The client gets a normal JSON error in its own dialect — read
        // the body like requestJson does, then throw the same error.
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // body stays null — adapters' toCanonicalError handles that
        }
        if (
          RETRYABLE_STATUSES.has(res.status) &&
          attempt < maxAttempts - 1
        ) {
          await sleep(backoffMs(attempt));
          continue;
        }
        const error = new UpstreamError(
          `Upstream returned ${res.status}`,
          res.status,
          parsed,
          { requestId, url },
        );
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
      }

      if (!res.body) {
        throw new UpstreamError(
          "Upstream returned no response body",
          res.status,
          undefined,
          { requestId, url },
        );
      }

      return {
        status: res.status,
        body: res.body,
        durationMs,
        contentType: res.headers.get("content-type") ?? undefined,
        headers: Object.fromEntries(res.headers.entries()),
      };
    } catch (err) {
      if (err instanceof UpstreamError) throw err;

      const durationMs = Date.now() - start;

      // Aborted by the caller (client disconnect): not a timeout, not
      // retryable — propagate as-is so the route can tell.
      if (signal?.aborted) throw err;

      if (isAbortError(err)) {
        throw new UpstreamError(
          `Upstream timed out after ${timeoutMs}ms`,
          undefined,
          undefined,
          { requestId, url, durationMs },
          504,
        );
      }

      lastError = new UpstreamError(
        `Upstream unreachable: ${err instanceof Error ? err.message : "connection failed"}`,
        undefined,
        undefined,
        { requestId, url, attempt: attempt + 1, durationMs },
      );

      if (attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }

  throw lastError ?? new UpstreamError("Upstream request failed");
}
