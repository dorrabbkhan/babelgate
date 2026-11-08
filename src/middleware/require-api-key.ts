import { timingSafeEqual } from "crypto";
import { Request, RequestHandler } from "express";
import { AuthError } from "../utils/errors";

/**
 * Timing-safe string comparison — returns false for length mismatches
 * without leaking length via early exit. Shared with the /ui/api
 * access check (src/ui-api/access.ts).
 */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Every credential a client may have presented (spec §3.4): the
 * `Authorization: Bearer` token (scheme case-insensitive), `x-api-key`,
 * `x-goog-api-key` and the `key` query parameter — covering the OpenAI,
 * Anthropic and Gemini SDKs' native auth styles. Empty values are not
 * candidates. Exported for tests.
 */
export function extractClientKeys(req: Request): string[] {
  const keys: string[] = [];

  const collect = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) {
      keys.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    }
  };

  const authorization = req.headers.authorization;
  for (const value of Array.isArray(authorization)
    ? authorization
    : [authorization]) {
    if (typeof value !== "string") continue;
    const match = /^bearer\s+(.+)$/i.exec(value);
    if (match) collect(match[1]!.trim());
  }

  collect(req.headers["x-api-key"]);
  collect(req.headers["x-goog-api-key"]);
  collect(req.query?.key);

  return keys;
}

/**
 * Client-facing auth for proxied endpoints.
 *
 * Enabled only when PROXY_API_KEY is set — unset means auth disabled
 * (localhost/dev stays frictionless). Accepts the key in any of the
 * provider-native styles (see extractClientKeys) so client SDKs work
 * unchanged. Every candidate is compared with safeEqual; any match
 * wins. These credentials are never forwarded upstream — the upstream
 * gets the proxy's own key.
 *
 * Applied after /health in app.ts so health probes stay open.
 */
export function requireApiKey(apiKey: string | undefined): RequestHandler {
  // Auth disabled — pass everything through
  if (!apiKey) {
    return (_req, _res, next) => next();
  }

  return (req, _res, next) => {
    // Compare every candidate; never return early on a mismatch —
    // any match authenticates.
    let authenticated = false;
    for (const candidate of extractClientKeys(req)) {
      if (safeEqual(candidate, apiKey)) authenticated = true;
    }

    if (!authenticated) {
      return next(
        new AuthError("Invalid or missing API key", { requestId: req.id })
      );
    }

    next();
  };
}
