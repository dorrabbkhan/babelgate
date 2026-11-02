import { UpstreamError } from "../utils/errors";

/** Upstream statuses that move the request to the next route target. */
const FALLBACK_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/**
 * The hop's outcome for the spec §3.4 route log line, classified from
 * the UpstreamError shapes http-client produces: `upstreamStatus` set →
 * "http_error"; no status with a 504 client code → "timeout"; no status
 * with a 502 client code → "transport". Anything that isn't an
 * UpstreamError never reached the upstream — undefined, not a hop
 * outcome.
 */
export function hopOutcome(
  err: unknown,
): "http_error" | "timeout" | "transport" | undefined {
  if (!(err instanceof UpstreamError)) return undefined;
  if (err.upstreamStatus !== undefined) return "http_error";
  return err.statusCode === 504 ? "timeout" : "transport";
}

/**
 * Fallback-eligible failures, exactly the spec §3.4 list: transport
 * failure; header/connect timeout; upstream 429, 500, 502, 503, 504,
 * 529. Everything else — client-facing 4xx, a non-JSON 2xx body, errors
 * raised before the upstream call (validation, transform) — fails
 * immediately.
 */
export function isFallbackEligible(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false;
  if (err.upstreamStatus === undefined) {
    return err.statusCode === 502 || err.statusCode === 504;
  }
  return FALLBACK_STATUSES.has(err.upstreamStatus);
}
