import type { RequestHandler } from "express";
import { findSourceRoute, type Provider } from "../transformers/adapters";
import { clientId } from "./client-id";
import { runWithTrace } from "./context";
import { newTrace } from "./trace";

/**
 * `observe.begin` (spec §3.1): mounted after detectSource and auth —
 * pre-route rejections (auth, body parse, 404) are never traced, and
 * only chat requests get a trace, so the scope opens only when the
 * matched source route is the chat route. The trace is emitted once,
 * by finishTrace — including failure and client-abort paths.
 */
export function observeMiddleware(): RequestHandler {
  return (req, res, next) => {
    const sourceApi = res.locals.sourceApi as Provider | undefined;
    if (
      sourceApi === undefined ||
      findSourceRoute(sourceApi, req.method, req.path)?.kind !== "chat"
    ) {
      return next();
    }
    const { client, userAgent } = clientId(req.headers);
    // §3.8: an incoming W3C traceparent is stored on the trace so the
    // OTel sink can parent the server span to the caller's trace.
    const traceparent = req.headers.traceparent;
    const trace = newTrace({
      requestId: String(req.id),
      startedAt: Date.now(),
      client,
      userAgent,
      sourceApi,
      ...(typeof traceparent === "string"
        ? { parentTraceparent: traceparent }
        : {}),
    });
    runWithTrace(trace, () => next());
  };
}
