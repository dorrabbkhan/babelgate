import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { GatewayConfig } from "../config/env-config";

/**
 * /ui/api access control (spec §3.9, D2), in order:
 *   1. UI=off → 404 (byte-identical to an unmatched route — a probe
 *      cannot tell the UI exists).
 *   2. Host is not loopback (`localhost`, `127.0.0.1`, `[::1]`, any
 *      port) and not in UI_ALLOWED_HOSTS → 403 (DNS rebinding).
 *   3. `x-babelgate-ui: 1` missing → 403. The custom header forces a
 *      CORS preflight, which is never approved — no
 *      access-control-allow-* header is ever sent — so a web page
 *      cannot drive the playground.
 *   4. PROXY_API_KEY set → Bearer or `x-api-key` must match
 *      (constant-time, as requireApiKey); the socket may be remote.
 *   5. No key → the socket must be loopback unless UI_ALLOW_REMOTE,
 *      else 403 with the hint text.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const REMOTE_HINT =
  "The UI answers only this machine. Set PROXY_API_KEY, or UI_ALLOW_REMOTE=true, to open it to the network.";

/** The one error shape every /ui/api route answers with. */
export function uiError(
  res: Response,
  status: 400 | 403 | 404,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

/** Host header → hostname, lowercased, port and brackets handled. */
function hostnameOf(host: string | undefined): string {
  if (host === undefined) return "";
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

function hostAllowed(req: Request, allowedHosts: string[]): boolean {
  const host = (req.headers.host ?? "").trim().toLowerCase();
  const hostname = hostnameOf(req.headers.host);
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  return allowedHosts.some(
    (entry) =>
      entry.toLowerCase() === hostname || entry.toLowerCase() === host,
  );
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (addr === undefined) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || a.startsWith("127.");
}

/** Constant-time compare without leaking length via early exit. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * The credentials /ui/api accepts (spec §3.9): an `Authorization:
 * Bearer` token and `x-api-key` — a subset of the proxy's candidates;
 * `?key=` is deliberately not one (a key in a URL lands in logs).
 */
function presentedKeys(req: Request): string[] {
  const keys: string[] = [];
  const authorization = req.headers.authorization;
  for (const value of Array.isArray(authorization)
    ? authorization
    : [authorization]) {
    const match =
      typeof value === "string" ? /^bearer\s+(.+)$/i.exec(value) : null;
    if (match?.[1] !== undefined && match[1].trim() !== "") {
      keys.push(match[1].trim());
    }
  }
  const apiKey = req.headers["x-api-key"];
  for (const value of Array.isArray(apiKey) ? apiKey : [apiKey]) {
    if (typeof value === "string" && value !== "") keys.push(value);
  }
  return keys;
}

export function uiAccess(config: GatewayConfig): RequestHandler {
  return (req, res, next) => {
    if (!config.observe.ui) {
      // Identical to the app's 404 handler — the disabled UI is
      // indistinguishable from a route that does not exist.
      res.status(404).json({
        error: { message: "Not Found", code: "NOT_FOUND", status: 404 },
      });
      return;
    }
    if (!hostAllowed(req, config.observe.uiAllowedHosts)) {
      return uiError(res, 403, "FORBIDDEN", "Host is not allowed");
    }
    if (req.headers["x-babelgate-ui"] !== "1") {
      return uiError(
        res,
        403,
        "FORBIDDEN",
        "x-babelgate-ui: 1 header required",
      );
    }
    const key = config.proxyApiKey;
    if (key !== undefined) {
      if (!presentedKeys(req).some((k) => safeEqual(k, key))) {
        return uiError(
          res,
          403,
          "FORBIDDEN",
          "Invalid or missing API key",
        );
      }
      return next();
    }
    if (
      !config.observe.uiAllowRemote &&
      !isLoopbackAddress(req.socket.remoteAddress)
    ) {
      return uiError(res, 403, "FORBIDDEN", REMOTE_HINT);
    }
    next();
  };
}
