import { getConfig } from "../config/env-config";
import {
  adapters,
  PROVIDER_ROUTES,
  type Provider,
} from "../transformers";
import { findSourceRoute } from "../transformers/adapters";
import { currentTrace, snapshot } from "../observe/context";
import { traceStarted } from "../observe/emit";
import { getBodyRing } from "../observe/sinks/body-ring";
import { getMetricsSink } from "../observe/sinks/metrics";
import { planRoute } from "../routing/plan-route";
import { estimateInputTokens } from "../utils/token-estimate";
import { canonicalRequestSchema } from "../types/canonical.schema";
import {
  NotFoundError,
  NotSupportedError,
  TransformError,
  UnsupportedParameterError,
  ValidationError,
} from "../utils/errors";
import { logger } from "../utils/logger";
import { proxyChat, type ChatInput } from "./chat.service";
import { proxyChatStream } from "./chat-stream.service";
import { proxyModelList } from "./models.service";

export interface ProxyResult {
  body?: unknown;
  headers?: Record<string, string>;
  stream?: {
    contentType: string;
    chunks: AsyncIterable<string>;
    /**
     * Emits the stream's trace when `chunks` was never iterated — a
     * throw in the route before the `for await` (setHeader /
     * flushHeaders) skips a suspended-start generator's finally
     * entirely (an unstarted async generator's return() does not run
     * the body). `clientStatus` is the status the client actually
     * received; omit it when the client went away first. A no-op once
     * the stream finished on its own — the trace emits at most once.
     */
    finish(clientStatus?: number): Promise<void>;
  };
}

export interface ProxyRequestOptions {
  /**
   * Client format detected from the request path (spec §3.2). The route
   * passes `res.locals.sourceApi`; undefined → proxyRequest returns
   * null → 404.
   */
  source?: Provider;
  /** Incoming query parameters (encoders may branch on them, §3.5) */
  query?: Record<string, string>;
  /** Client disconnect — aborts the upstream request */
  signal?: AbortSignal;
}

/**
 * The "<method>" in a "/v1beta/models/<m>:<method>" path — the text
 * after the last ":" of the percent-decoded path, the same parsing the
 * route's isSupportedPath uses.
 */
function methodFromPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // malformed escapes — fall back to the raw path
  }
  const colon = decoded.lastIndexOf(":");
  return colon === -1 ? decoded : decoded.slice(colon + 1);
}

/**
 * §2.2 stateless contract for the responses dialect — refused before
 * routing, in the responses envelope, on every responses-source path
 * (including sub-paths the route table doesn't claim):
 *
 * - GET /v1/responses/<id>, DELETE /v1/responses/<id>,
 *   POST /v1/responses/compact and any other non-create method → 404.
 * - On POST /v1/responses: `previous_response_id`, `conversation` and
 *   `store: true` are server state → 400 `unsupported_parameter`.
 * - An `additional_tools` input item marks the responses-lite shape,
 *   which is pass-through-only in v1.4 (owner decision, Task 3) →
 *   400 naming the item.
 */
function rejectStatefulResponsesRequest(
  method: string,
  path: string,
  body: unknown,
): void {
  const underResponses =
    path === "/v1/responses" ||
    path === "/responses" ||
    path.startsWith("/v1/responses/") ||
    path.startsWith("/responses/");
  if (!underResponses) return;

  const isCreate =
    method === "POST" && (path === "/v1/responses" || path === "/responses");
  if (!isCreate) {
    throw new NotFoundError(
      `babelgate is stateless: ${method} ${path} is not supported`,
    );
  }

  if (body === null || typeof body !== "object") return;
  const request = body as Record<string, unknown>;

  for (const field of ["previous_response_id", "conversation"] as const) {
    if (request[field] !== undefined) {
      throw new UnsupportedParameterError(
        field,
        `babelgate is stateless: ${field} is not supported`,
      );
    }
  }
  if (request.store === true) {
    throw new UnsupportedParameterError(
      "store",
      "babelgate is stateless: store is not supported",
    );
  }
  // responses-lite markers (owner decision, Task 3): pass-through only
  // in v1.4 — on the bridge each is a 400 naming the unsupported item.
  const liteParam = (param: string): never => {
    throw new UnsupportedParameterError(
      param,
      `${param} is not supported: responses-lite requests are pass-through only in v1.4`,
    );
  };

  if (
    request.reasoning !== null &&
    typeof request.reasoning === "object" &&
    (request.reasoning as Record<string, unknown>).context !== undefined
  ) {
    liteParam("reasoning.context");
  }

  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (item === null || typeof item !== "object") continue;
      const entry = item as { type?: unknown; phase?: unknown; namespace?: unknown };
      if (entry.type === "additional_tools") liteParam("additional_tools");
      if (entry.type === "message" && entry.phase !== undefined) {
        liteParam("phase");
      }
      if (
        (entry.type === "custom_tool_call" ||
          entry.type === "custom_tool_call_output") &&
        entry.namespace !== undefined
      ) {
        liteParam("custom_tool_call");
      }
    }
  }
}

/**
 * Thin entry over the routing layer (spec §3.1):
 *   path match → config → canonical boundary validation →
 *   count_tokens → planRoute → chat/chat-stream/models services.
 *
 * The client format comes from `opts.source` (the detect-source
 * middleware's read of the request path, spec §3.2). Returns null when
 * it is unset or the path doesn't belong to that source provider
 * (route should call next() → 404).
 * Throws ValidationError | UpstreamError | TransformError | ConfigurationError.
 */
export async function proxyRequest(
  path: string,
  method: string,
  body: unknown,
  requestId: string,
  opts?: ProxyRequestOptions,
): Promise<ProxyResult | null> {
  // §2.2: stateful Responses requests are refused before routing —
  // before the provider-path pre-check, since the stateful sub-paths
  // are not in the route table.
  if (opts?.source === "responses") {
    rejectStatefulResponsesRequest(method, path, body);
  }

  // Cheap pre-check: only recognized provider API paths are proxied.
  const isProviderPath = Object.values(PROVIDER_ROUTES)
    .flat()
    .some((r) => r.method === method && path.startsWith(r.pathPrefix));
  if (!isProviderPath) return null;

  const config = getConfig();
  const sourceApi = opts?.source;
  if (!sourceApi) return null;

  // Match the incoming path to a route on the detected source provider
  const route = findSourceRoute(sourceApi, method, path);
  if (!route) return null;

  if (route.kind === "models") {
    getMetricsSink()?.incAux(sourceApi, "models");
    return proxyModelList(sourceApi, route, config, requestId);
  }

  // Gemini paths carry a ":<method>" suffix — anything that isn't a
  // method this route serves is refused before conversion, before any
  // upstream call (spec §3.2, E11).
  if (route.isSupportedPath?.(path) === false) {
    throw new NotSupportedError(`${methodFromPath(path)} is not supported`);
  }

  // §3.5: when the inspector ring is on (INSPECTOR_BUFFER ≠ 0) this
  // request's trace gets a bodies object — every snapshot() below is a
  // no-op unless it exists. The scope itself only exists for chat
  // routes (observeMiddleware), so count_tokens/models never capture.
  const trace = currentTrace();
  if (
    trace !== undefined &&
    trace.bodies === undefined &&
    getBodyRing() !== undefined
  ) {
    trace.bodies = { target: [] };
  }
  snapshot("source", body);

  // Source → Canonical. A count_tokens body may wrap the real chat
  // request (Gemini's `generateContentRequest` form) — the route
  // unwraps it before decode. The adapter may throw on malformed
  // input — that's a client error (400), not a server error (500).
  const decodeBody =
    route.kind === "count_tokens"
      ? (route.countTokensRequest?.(body) ?? body)
      : body;
  let canonical: ReturnType<(typeof adapters)[Provider]["toCanonicalRequest"]>;
  try {
    canonical = adapters[sourceApi].toCanonicalRequest(decodeBody);
  } catch (err) {
    throw new ValidationError(
      `Malformed ${sourceApi} request: ${err instanceof Error ? err.message : "invalid body"}`,
      { requestId },
    );
  }

  // Boundary validation: malformed client request → 400, not 500.
  const parsed = canonicalRequestSchema.safeParse(canonical);
  if (!parsed.success) {
    throw new ValidationError("Malformed request body", {
      requestId,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  snapshot("canonical", parsed.data);

  // The model comes from the source path when the provider puts it there
  // (Gemini), otherwise from the canonical request. An explicitly empty
  // model in the path (e.g. /v1beta/models/:generateContent) is a client
  // error, not something to send upstream.
  const modelFromPath = route.modelFromPath?.(path);
  if (modelFromPath === "") {
    throw new ValidationError(
      `Malformed ${sourceApi} request path: model is empty`,
      { requestId },
    );
  }

  // The chars/4 input estimate is computed once — count_tokens answers
  // with it (§3.5) and routing `when` conditions consume it (§3.3).
  const estimatedInputTokens = estimateInputTokens(parsed.data);

  // §3.5: count_tokens is answered locally — a chars/4 estimate with the
  // estimate header, never an upstream call. The reply shape is the
  // source provider's (Anthropic input_tokens, Gemini totalTokens).
  if (route.kind === "count_tokens") {
    getMetricsSink()?.incAux(sourceApi, "count_tokens");
    logger.info({ requestId, sourceApi }, "count_tokens answered locally");
    return {
      body: route.countTokensBody(estimatedInputTokens),
      headers: { "x-babelgate-token-estimate": "true" },
    };
  }

  // §3.3: resolve the model to an ordered list of targets — env mode
  // produces MODEL_MAP routes then the single default provider.
  const requestedModel = modelFromPath ?? parsed.data.model;
  // §3.9: the /ui/api live feed marks the request in flight from here —
  // the earliest point the requested model is known.
  traceStarted(requestedModel);
  const plan = planRoute({
    requestedModel,
    estimatedInputTokens,
    routing: config.routing,
    providerNames: new Set(config.registry.names()),
  });

  const input: ChatInput = {
    source: sourceApi,
    sourceBody: body,
    canonical: parsed.data,
    requestedModel,
    plan,
    config,
    requestId,
    opts,
  };

  // Streaming (spec §3.2): a `stream` body flag on the JSON-body sources,
  // the dedicated streaming endpoint on Gemini — which carries no body
  // flag, so canonical.stream is set here for the target adapter's
  // own streaming marker (openai stream_options, anthropic/ollama
  // stream:true).
  if (parsed.data.stream === true || route.isStreamPath?.(path) === true) {
    parsed.data.stream = true;
    return proxyChatStream(input);
  }

  return proxyChat(input);
}

export { TransformError };
