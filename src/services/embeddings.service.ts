import type { IncomingHttpHeaders } from "node:http";
import { getConfig } from "../config/env-config";
import type { Provider } from "../transformers";
import { clientId } from "../observe/client-id";
import {
  currentTrace,
  recordNote,
  runWithAttempt,
  runWithTrace,
  snapshot,
} from "../observe/context";
import { finishTrace, traceStarted } from "../observe/emit";
import { getBodyRing } from "../observe/sinks/body-ring";
import { newTrace } from "../observe/trace";
import { planRoute } from "../routing/plan-route";
import { authHeaders } from "../routing/registry";
import type { Hop } from "../routing/route-log";
import { openaiEmbeddings } from "../transformers/embeddings/openai";
import { geminiEmbeddings } from "../transformers/embeddings/gemini";
import { ollamaEmbeddings } from "../transformers/embeddings/ollama";
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingTargetTransform,
} from "../types/embeddings.types";
import {
  NotSupportedError,
  UpstreamError,
  ValidationError,
} from "../utils/errors";
import {
  attemptTargets,
  errorTraceFields,
  toClientFacing,
} from "./attempt-targets";
import { postJson } from "./http-client";
import type { ProxyResult } from "./proxy.service";

/**
 * POST /v1/embeddings (v1.5 spec §3.6): OpenAI-dialect inbound only,
 * no canonical stage. The client's body decodes to a shared
 * EmbeddingRequest; each attempt runs the target provider's
 * per-dialect transform (an entry type with no embeddings endpoint
 * refuses with a 501 BEFORE the upstream call — the error handler
 * renders it in the OpenAI envelope the source detected). Routing,
 * aliases and fallbacks are exactly chat's: planRoute + the shared
 * attemptTargets loop. The request trace is created here rather than
 * by observeMiddleware — the embeddings paths have no
 * PROVIDER_ROUTES entry, so the middleware's chat-route check does
 * not scope them.
 */
const EMBEDDING_TARGETS: Partial<
  Record<Provider, EmbeddingTargetTransform>
> = {
  openai: openaiEmbeddings,
  gemini: geminiEmbeddings,
  ollama: ollamaEmbeddings,
};

export interface EmbeddingsInput {
  /** The client's raw request body (OpenAI embeddings dialect). */
  sourceBody: unknown;
  /** Request headers — client identity and traceparent for the trace. */
  headers: IncomingHttpHeaders;
  requestId: string;
  signal?: AbortSignal;
}

/**
 * OpenAI embeddings body → EmbeddingRequest (the minimal contract of
 * spec §3.6): `input` normalizes to a string array — a bare string
 * wraps, anything else (including OpenAI's tokenized integer-array
 * form) is a 400; `encoding_format` defaults to "float"; `dimensions`
 * must be a positive integer when present.
 */
export function decodeEmbeddingBody(body: unknown): EmbeddingRequest {
  const req = (
    body !== null && typeof body === "object" ? body : {}
  ) as Record<string, unknown>;

  const model = req.model;
  if (typeof model !== "string" || model === "") {
    throw new ValidationError(
      'Malformed embeddings request: "model" must be a non-empty string',
    );
  }

  let input: string[];
  if (typeof req.input === "string") {
    input = [req.input];
  } else if (
    Array.isArray(req.input) &&
    req.input.every((i) => typeof i === "string")
  ) {
    input = req.input;
  } else {
    throw new ValidationError(
      'Malformed embeddings request: "input" must be a string or an array of strings',
    );
  }

  let dimensions: number | undefined;
  if (req.dimensions !== undefined) {
    if (
      typeof req.dimensions !== "number" ||
      !Number.isInteger(req.dimensions) ||
      req.dimensions <= 0
    ) {
      throw new ValidationError(
        'Malformed embeddings request: "dimensions" must be a positive integer',
      );
    }
    dimensions = req.dimensions;
  }

  let encodingFormat: EmbeddingRequest["encodingFormat"] = "float";
  if (req.encoding_format !== undefined) {
    if (
      req.encoding_format !== "float" &&
      req.encoding_format !== "base64"
    ) {
      throw new ValidationError(
        'Malformed embeddings request: "encoding_format" must be "float" or "base64"',
      );
    }
    encodingFormat = req.encoding_format;
  }

  return {
    model,
    input,
    ...(dimensions !== undefined && { dimensions }),
    encodingFormat,
  };
}

/**
 * `encoding_format: "base64"`: OpenAI defines the encoding as base64
 * over little-endian float32 bytes
 * (https://platform.openai.com/docs/api-reference/embeddings/create);
 * babelgate encodes it at the edge for every target.
 */
export function float32LeBase64(vector: number[]): string {
  const buf = Buffer.alloc(vector.length * 4);
  vector.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString("base64");
}

/**
 * The client reply — the OpenAI embeddings object shape
 * (https://platform.openai.com/docs/api-reference/embeddings/object):
 * `{object:"list", data:[{object:"embedding",index,embedding}],
 *   model, usage:{prompt_tokens,total_tokens}}`. Embeddings have no
 * output tokens — usage carries the input count in both fields, as
 * OpenAI's own embeddings replies do.
 */
export function openaiEmbeddingReply(
  response: EmbeddingResponse,
  format: EmbeddingRequest["encodingFormat"],
): unknown {
  return {
    object: "list",
    data: response.vectors.map((v, i) => ({
      object: "embedding",
      index: i,
      embedding: format === "base64" ? float32LeBase64(v) : v,
    })),
    model: response.model,
    usage: {
      prompt_tokens: response.usage.inputTokens,
      total_tokens: response.usage.inputTokens,
    },
  };
}

/** Everything proxyEmbeddings does, inside its trace scope. */
async function run(input: EmbeddingsInput): Promise<ProxyResult> {
  const config = getConfig();
  const trace = currentTrace();

  // §3.5: the inspector ring gets the same source/target/wire
  // snapshots a chat request leaves.
  if (
    trace !== undefined &&
    trace.bodies === undefined &&
    getBodyRing() !== undefined
  ) {
    trace.bodies = { target: [] };
  }
  snapshot("source", input.sourceBody);

  // A malformed body is a client 400 — before routing, before any
  // trace finish (the chat pipeline traces only upstream-bound
  // requests).
  const request = decodeEmbeddingBody(input.sourceBody);

  // chars/4 per input string — routing `when` conditions read it, and
  // it backs the usage block when the target dialect reports none
  // (Gemini's batchEmbedContents).
  const estimatedInputTokens = request.input.reduce(
    (sum, text) => sum + Math.ceil(text.length / 4),
    0,
  );

  // §3.9: the live feed marks the request in flight once the model
  // is known.
  traceStarted(request.model);
  const plan = planRoute({
    requestedModel: request.model,
    estimatedInputTokens,
    routing: config.routing,
    providerNames: new Set(config.registry.names()),
  });

  const hops: Hop[] = [];
  try {
    const result = await attemptTargets(
      plan,
      config.registry,
      (entry, target) =>
        runWithAttempt(
          {
            providerName: target.provider,
            upstreamModel: target.model,
          },
          async () => {
            const transform = EMBEDDING_TARGETS[entry.type];
            if (transform === undefined) {
              // §3.6: a provider with no embeddings endpoint is a
              // design refusal — the OpenAI envelope carries the 501.
              throw new NotSupportedError(
                `embeddings are not supported on ${entry.type} providers`,
              );
            }
            const targetBody = transform.requestBody(
              { ...request, model: target.model },
              input.sourceBody,
            );
            snapshot("target", targetBody);
            const upstream = await postJson({
              url: `${entry.baseUrl}${transform.requestPath(target.model)}`,
              headers: authHeaders(entry),
              body: targetBody,
              timeoutMs: entry.timeoutMs ?? config.upstreamTimeoutMs,
              retries: config.upstreamRetries,
              requestId: input.requestId,
            }).catch((err) => {
              throw err instanceof UpstreamError
                ? toClientFacing(err, entry.type)
                : err;
            });

            if (upstream.status < 200 || upstream.status >= 300) {
              const err = new UpstreamError(
                `Upstream ${entry.type} returned ${upstream.status}`,
                upstream.status,
                upstream.body,
              );
              err.retryAfterSeconds = upstream.retryAfterSeconds;
              throw toClientFacing(err, entry.type);
            }

            return upstream;
          },
        ),
      { requestId: input.requestId, signal: input.signal, hops },
    );

    // §3.5: the upstream JSON lands in the ring even when decoding
    // it below throws.
    snapshot("response.wire", result.value.body);

    // The attempt loop proved the winner's transform exists.
    const decoded = EMBEDDING_TARGETS[result.entry.type]!.decodeResponse(
      result.value.body,
    );

    let inputTokens = decoded.inputTokens;
    let costEstimated = false;
    if (inputTokens === undefined) {
      inputTokens = estimatedInputTokens;
      costEstimated = true;
      recordNote(
        {
          stage: "encode",
          adapter: result.entry.type,
          code: "usage_estimated",
        },
        `Estimating input tokens (${result.entry.type} embeddings replies carry no usage)`,
      );
    }

    const response: EmbeddingResponse = {
      model: request.model,
      vectors: decoded.vectors,
      usage: { inputTokens },
    };
    const body = openaiEmbeddingReply(response, request.encodingFormat);
    snapshot("response.canonical", response);

    finishTrace({
      reason: plan.reason,
      requestedModel: request.model,
      hops: result.hops,
      winner: result.target.provider,
      stream: false,
      status: "ok",
      httpStatus: 200,
      inputTokens,
      // Embeddings are billed on input alone — 0 output tokens so the
      // trace still prices (priceTrace needs both fields present).
      outputTokens: 0,
      ...(costEstimated && { costEstimated: true }),
      ttfbMs:
        trace === undefined ? undefined : Date.now() - trace.startedAt,
    });

    return {
      body,
      headers: {
        "x-babelgate-provider": result.target.provider,
        "x-babelgate-model": result.target.model,
        "x-babelgate-attempts": String(result.hops.length),
      },
    };
  } catch (err) {
    finishTrace({
      reason: plan.reason,
      requestedModel: request.model,
      hops,
      stream: false,
      ...errorTraceFields(err, input.signal?.aborted === true),
    });
    throw err;
  }
}

/**
 * The /v1/embeddings entry point — creates the request trace (the
 * observe middleware scopes only chat routes, and the embeddings
 * paths have no route-table entry) and runs the plan.
 */
export async function proxyEmbeddings(
  input: EmbeddingsInput,
): Promise<ProxyResult> {
  const { client, userAgent } = clientId(input.headers);
  const traceparent = input.headers["traceparent"];
  const trace = newTrace({
    requestId: input.requestId,
    startedAt: Date.now(),
    client,
    ...(userAgent !== undefined && { userAgent }),
    sourceApi: "openai",
    ...(typeof traceparent === "string"
      ? { parentTraceparent: traceparent }
      : {}),
  });
  return runWithTrace(trace, () => run(input));
}
