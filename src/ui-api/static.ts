import { join } from "node:path";
import express, { type RequestHandler } from "express";
import type { GatewayConfig } from "../config/env-config";
import { isLoopbackAddress, REMOTE_HINT, uiError } from "./access";

/**
 * The `/ui` static mount (spec §3.9): `dist/ui` with a fallback to
 * index.html so a direct load of any client-side route still boots the
 * app. In order:
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
    serveUi(req, res, () => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      // root-relative: send()'s dotfiles check must see only the
      // filename — an absolute path under a dotted install root
      // (~/.nvm, ~/.npm/_npx, ~/.local) would 404 every fallback.
      res.sendFile("index.html", { root: uiDir }, (err) => {
        if (err) next();
      });
    });
  };
}
