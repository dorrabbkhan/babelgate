import { ErrorRequestHandler } from "express";
import { logger } from "../utils/logger";
import { ProxyError, UpstreamError } from "../utils/errors";
import { adapters, type Provider } from "../transformers";
import { makeCanonicalError } from "../utils/canonical-error";
import type { CanonicalError } from "../types/canonical.types";

interface ErrorResponse {
  error: {
    message: string;
    code: string;
    status: number;
    details?: unknown;
  };
}

/**
 * The provider's own error classification (type/code) and message,
 * extracted from an upstream body of whatever shape. Read-only and
 * generic — no provider-specific branches.
 */
function summarizeUpstreamBody(body: unknown): {
  type?: string;
  code?: string;
  message?: string;
} {
  if (!body || typeof body !== "object") return {};
  const err = (body as { error?: unknown }).error;
  // Ollama-style: { error: "<message>" }
  if (typeof err === "string") return { message: err };
  if (!err || typeof err !== "object") return {};
  const e = err as Record<string, unknown>;
  return {
    ...(typeof e.type === "string" && { type: e.type }),
    ...(typeof e.code === "string"
      ? { code: e.code }
      : typeof e.status === "string"
        ? { code: e.status }
        : {}),
    ...(typeof e.message === "string" && { message: e.message }),
  };
}

/**
 * Any error → CanonicalError for dialect rendering (spec §3.3):
 * ProxyError subclasses map via toCanonical(); body-parser errors map by
 * their `type`; anything else is `internal` with a generic message in
 * production.
 */
function toCanonical(err: unknown, isProduction: boolean): CanonicalError {
  if (err instanceof ProxyError) return err.toCanonical();

  const type = (err as { type?: unknown } | null)?.type;
  if (type === "entity.too.large") {
    const limit = (err as { limit?: unknown }).limit;
    return makeCanonicalError(
      "request_too_large",
      `Request body too large (limit: ${limit})`,
    );
  }
  if (type === "entity.parse.failed") {
    return makeCanonicalError("invalid_request", "Malformed JSON body");
  }
  return makeCanonicalError(
    "internal",
    isProduction || !(err instanceof Error)
      ? "Internal Server Error"
      : err.message,
  );
}

/**
 * §3.3 log policy: an upstream failure is logged at warn with the status,
 * the provider's own type/code and at most the first 200 characters of
 * the message — and no message at all for auth failures. The raw
 * upstream body and any body preview are never logged: both can echo
 * keys or completion text.
 */
function logUpstreamError(err: UpstreamError, requestId: unknown): void {
  const summary = summarizeUpstreamBody(err.upstreamBody);
  // An "upstream" client kind on a sub-500 status only arises from the
  // credentials rule — i.e. the upstream rejected the proxy's key, even
  // when it didn't use 401/403 (Gemini's 400 + API_KEY_INVALID).
  const authFailure =
    err.upstreamStatus === 401 ||
    err.upstreamStatus === 403 ||
    (err.clientError?.kind === "upstream" &&
      err.upstreamStatus !== undefined &&
      err.upstreamStatus < 500);

  logger.warn(
    {
      requestId,
      statusCode: err.statusCode,
      upstreamStatus: err.upstreamStatus,
      upstreamType: summary.type,
      upstreamCode: summary.code,
      ...(!authFailure && summary.message
        ? { upstreamMessage: summary.message.slice(0, 200) }
        : {}),
    },
    "Upstream error",
  );
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const isProduction = process.env.NODE_ENV === "production";
  const requestId = req.id;
  const sourceApi = res.locals.sourceApi as Provider | undefined;

  // §3.4: errors after upstream attempts carry x-babelgate-attempts
  // (and any other responseHeaders the pipeline attached) — set them
  // before the dialect rendering below writes the body.
  if (err instanceof ProxyError && err.responseHeaders !== undefined) {
    for (const [name, value] of Object.entries(err.responseHeaders)) {
      res.setHeader(name, value);
    }
  }

  if (err instanceof UpstreamError) {
    logUpstreamError(err, requestId);
  } else if (err instanceof ProxyError) {
    logger.error(
      {
        requestId,
        code: err.code,
        statusCode: err.statusCode,
        context: err.context,
        stack: err.stack,
      },
      err.message,
    );
  } else {
    // Not err wholesale: body-parser errors carry the raw request body
    // (prompt text) on `err.body`, and their message echoes a fragment
    // of it — so entity.* errors log only their type.
    const errType = (err as { type?: unknown } | null)?.type;
    logger.error(
      {
        requestId,
        errType,
        message:
          typeof errType === "string" && errType.startsWith("entity.")
            ? `body-parser error: ${errType}`
            : err instanceof Error
              ? err.message
              : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "Unhandled error",
    );
  }

  // On a provider route every error — including auth and body-parser
  // errors — renders in the client's own dialect.
  if (sourceApi) {
    const canonical = toCanonical(err, isProduction);
    if (canonical.retryAfterSeconds !== undefined) {
      res.set("Retry-After", String(canonical.retryAfterSeconds));
    }
    const body = adapters[sourceApi].fromCanonicalError(
      canonical,
    ) as Record<string, unknown>;

    // Owner decision: the non-JSON-2xx body preview stays in
    // non-production `details` (it can aid debugging) but is never
    // logged — it can be completion text.
    const bodyPreview =
      !isProduction && err instanceof UpstreamError
        ? err.context?.bodyPreview
        : undefined;

    res.status(canonical.status).json(
      bodyPreview !== undefined
        ? { ...body, details: { bodyPreview } }
        : body,
    );
    return;
  }

  // Outside provider routes: today's generic shape.
  if (err && err.type === "entity.too.large") {
    res.status(413).json({
      error: {
        message: `Request body too large (limit: ${err.limit})`,
        code: "PAYLOAD_TOO_LARGE",
        status: 413,
      },
    });
    return;
  }

  if (err instanceof ProxyError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  const response: ErrorResponse = {
    error: {
      message: isProduction ? "Internal Server Error" : err.message,
      code: "INTERNAL_ERROR",
      status: 500,
      ...(!isProduction && { details: { stack: err.stack } }),
    },
  };

  res.status(500).json(response);
};
