import type { CanonicalError } from "../types/canonical.types";
import { kindFromStatus, makeCanonicalError } from "./canonical-error";

export class ProxyError extends Error {
  /**
   * Extra response headers the error-handler sets before rendering —
   * e.g. `x-babelgate-attempts` on errors after upstream attempts
   * (spec §3.4).
   */
  public responseHeaders?: Record<string, string>;

  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code: string = "PROXY_ERROR",
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  /** Canonical form used to render this error in the client's dialect. */
  toCanonical(): CanonicalError {
    return makeCanonicalError(kindFromStatus(this.statusCode), this.message);
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        code: this.code,
        status: this.statusCode,
        ...(process.env.NODE_ENV !== "production" && this.context
          ? { details: this.context }
          : {}),
      },
    };
  }
}

export class ValidationError extends ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 400, "VALIDATION_ERROR", context);
  }
}

/**
 * 404 — the path exists in the client's API dialect but the proxy does
 * not serve it by design (v1.4 spec §2.2: the stateful Responses
 * retrieval/deletion/compact endpoints). Canonical kind `not_found`.
 */
export class NotFoundError extends ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 404, "NOT_FOUND", context);
  }
}

/**
 * 400 naming one request field the proxy refuses by design (v1.4 spec
 * §2.2: `previous_response_id`, `conversation`, `store: true`, and the
 * owner-decided `additional_tools` responses-lite marker). The
 * canonical error carries the OpenAI-style envelope details — `code`
 * and `param` — as extra fields on the CanonicalError object; dialects
 * whose error envelope has them (responses, openai) render them, the
 * rest see an ordinary invalid_request.
 */
export class UnsupportedParameterError extends ValidationError {
  constructor(
    public readonly param: string,
    message: string,
  ) {
    super(message);
  }

  toCanonical(): CanonicalError {
    return Object.assign(super.toCanonical(), {
      code: "unsupported_parameter",
      param: this.param,
    });
  }
}

export class TransformError extends ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 500, "TRANSFORM_ERROR", context);
  }
}

export class UpstreamError extends ProxyError {
  /**
   * Client-facing rendering computed by proxy.service's upstream mapping
   * (spec §3.3). When set it wins over the default status-derived kind.
   */
  public clientError?: CanonicalError;
  /** Seconds from the upstream Retry-After header (set on 429/503). */
  public retryAfterSeconds?: number;

  constructor(
    message: string,
    public readonly upstreamStatus?: number,
    public readonly upstreamBody?: unknown,
    context?: Record<string, unknown>,
    statusCode: number = 502,
  ) {
    // upstreamBody stays a field (for the §3.3 log summary) but is kept
    // out of `context`: context is serialized into non-production
    // `details` and an upstream body may echo keys or completion text.
    super(message, statusCode, "UPSTREAM_ERROR", {
      ...context,
      upstreamStatus,
    });
  }

  toCanonical(): CanonicalError {
    return this.clientError ?? super.toCanonical();
  }
}

/**
 * 501 — the client asked for something the proxy refuses by design
 * (streaming, unsupported provider methods). Canonical kind
 * `unsupported` via the default toCanonical().
 */
export class NotSupportedError extends ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 501, "NOT_SUPPORTED", context);
  }
}

export class AuthError extends ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 401, "UNAUTHORIZED", context);
  }
}

export class ConfigurationError extends ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 500, "CONFIGURATION_ERROR", context);
  }
}
