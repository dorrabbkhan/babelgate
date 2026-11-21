import { extname, join } from "node:path";
import express, { type RequestHandler } from "express";
import type { GatewayConfig } from "../config/env-config";
import { isLoopbackAddress, REMOTE_HINT, uiError } from "./access";

/**
 * Content-Type by extension for the in-memory asset source — the same
 * mapping express.static applies through send's mime lookup, for the
 * file types a vite build emits.
 */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * An in-memory source for the /ui bundle — production wiring passes
 * `node:sea`'s getAsset when isSea() (v1.6 spec §3.2); keys are
 * "ui/<relative path>".
 */
export interface UiAssets {
  get(path: string): Buffer | undefined;
}

/**
 * The `/ui` static mount (spec §3.9): `dist/ui` with a fallback to
 * index.html so a direct load of any client-side route still boots the
 * app — or, when `assets` is given (the SEA binary), the same paths and
 * the same fallback from the embedded bundle. In order:
 *   1. `/api` paths fall through — the `app.use("/ui/api", …)` mount
 *      already access-checked them, and an unmatched API path gets the
 *      app's JSON 404, never index.html.
 *   2. UI=off → next() → the same 404 as an unmatched route.
 *   3. No PROXY_API_KEY and not UI_ALLOW_REMOTE → the socket must be
 *      loopback, else 403 with the hint (same rule as /ui/api, minus
 *      the Host/header checks the spec applies to /ui/api only).
 *   4. Assets carry no data, so a configured PROXY_API_KEY is not
 *      required to fetch them — the data lives behind /ui/api.
 */
export function uiStatic(
  config: GatewayConfig,
  uiDir = join(__dirname, "../ui"),
  assets?: UiAssets,
): RequestHandler {
  const serveUi = express.static(uiDir);
  return (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      return next();
    }
    if (!config.observe.ui) return next();
    if (
      config.proxyApiKey === undefined &&
      !config.observe.uiAllowRemote &&
      !isLoopbackAddress(req.socket.remoteAddress)
    ) {
      return uiError(res, 403, "FORBIDDEN", REMOTE_HINT);
    }
    if (assets === undefined) {
      return serveUi(req, res, () => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        // root-relative: send()'s dotfiles check must see only the
        // filename — an absolute path under a dotted install root
        // (~/.nvm, ~/.npm/_npx, ~/.local) would 404 every fallback.
        res.sendFile("index.html", { root: uiDir }, (err) => {
          if (err) next();
        });
      });
    }
    // SEA assets: same paths, same index.html fallback. A miss can only
    // fall back — the blob holds no path a crafted req.path could reach.
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const rel = req.path.replace(/^\/+/, "") || "index.html";
    let key = `ui/${rel}`;
    let body = assets.get(key);
    if (body === undefined && key !== "ui/index.html") {
      key = "ui/index.html";
      body = assets.get(key);
    }
    if (body === undefined) return next();
    res.set(
      "Content-Type",
      ASSET_CONTENT_TYPES[extname(key)] ?? "application/octet-stream",
    );
    res.set("Cache-Control", "public, max-age=0");
    res.send(body);
  };
}
