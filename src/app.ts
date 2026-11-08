import express from "express";
import { requestLogger } from "./middleware/request-logger";
import { detectSourceMiddleware } from "./middleware/detect-source";
import { errorHandler } from "./middleware/error-handler";
import { requireApiKey } from "./middleware/require-api-key";
import { observeMiddleware } from "./observe/middleware";
import { getMetricsSink } from "./observe/sinks/metrics";
import { proxyRouter } from "./routes/proxy";
import { uiApiRouter } from "./ui-api/router";

const app = express();

// 1. Request logger - logs every incoming request
app.use(requestLogger);

// 1a. Source detection - records the request's own format on
// res.locals.sourceApi so the error handler renders errors (auth,
// body-parser, upstream) in the client's dialect (spec §3.2).
app.use(detectSourceMiddleware());

// 2. Body parser - parses application/json. LLM payloads (base64
// images, long context) routinely exceed the 100kb default.
app.use(express.json({ limit: process.env.MAX_BODY_SIZE || "10mb" }));

// 3. Routes
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// 3a-i. /ui/api (spec §3.9) — the inspector API. Mounted before
// requireApiKey: access.ts does its own control (Host allowlist,
// x-babelgate-ui header, key-when-set, loopback-or-flag). UI=off
// answers the same 404 an unmatched route gets.
app.use("/ui/api", uiApiRouter());

// 3a. Client auth — active only when PROXY_API_KEY is set.
// /health above stays open for probes.
app.use(requireApiKey(process.env.PROXY_API_KEY || undefined));

// 3b. /metrics (spec §3.8) — Prometheus text exposition, mounted
// after requireApiKey so it asks for PROXY_API_KEY when one is set.
// METRICS=off → no sink → falls through to the 404 handler.
app.get("/metrics", async (_req, res, next) => {
  const sink = getMetricsSink();
  if (sink === undefined) return next();
  res.set("Content-Type", sink.registry.contentType);
  res.send(await sink.registry.metrics());
});

// 3c. Request trace (spec §3.1) — chat requests get an
// AsyncLocalStorage scope holding their RequestTrace; finishTrace in
// the services emits it once. Mounted after auth so pre-route
// rejections are never traced.
app.use(observeMiddleware());

// 3d. Proxy routes - transforms and forwards LLM API requests
app.use(proxyRouter);

// 4. 404 handler - catch unmatched routes
app.use((_req, res) => {
  res
    .status(404)
    .json({ error: { message: "Not Found", code: "NOT_FOUND", status: 404 } });
});

// 5. Error handler - must be last
app.use(errorHandler);

export { app };
