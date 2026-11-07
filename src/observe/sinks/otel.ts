import type { Attributes, Context, SpanContext } from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { getConfig } from "../../config/env-config";
import type { ProviderEntry } from "../../routing/registry";
import type { Hop } from "../../routing/route-log";
import { ATTR, GENAI_PROVIDER_NAMES } from "../genai-attributes";
import type { TraceSink } from "../emit";
import type { RequestTrace } from "../trace";

/**
 * The OTel sink (spec §3.8): after a trace is finished, one SERVER span
 * `babelgate {source}` and one CLIENT child span `chat {model}` per hop
 * are built with explicit start/end times and exported through a batch
 * span processor. An incoming `traceparent` becomes the server span's
 * parent; nothing is injected upstream.
 *
 * The @opentelemetry packages are loaded with a dynamic import inside
 * createOtelSink only — imported lazily when index.ts sees
 * OTEL_EXPORTER_OTLP_ENDPOINT, so without an endpoint they are never
 * loaded (the imports above are type-only and erase at compile).
 * Content is never exported: only the spec §3.8 field list is read,
 * `bodies` is already stripped by emitTrace, and
 * OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT is ignored on purpose.
 */

export interface OtelSink extends TraceSink {
  /** Flush the batch processor and shut the exporter down. */
  shutdown(): Promise<void>;
}

/** W3C traceparent: `version-traceId-spanId-flags`, lowercase hex. */
const TRACEPARENT =
  /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/;

function parseTraceparent(header: string): SpanContext | undefined {
  const m = TRACEPARENT.exec(header.trim());
  if (m === null || m[1] === "ff") return undefined;
  const [, , traceId, spanId, flags] = m;
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) {
    return undefined;
  }
  return {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & 1,
    isRemote: true,
  };
}

/** The registry entry for a hop's provider name; undefined when unknown. */
function providerEntry(name: string): ProviderEntry | undefined {
  try {
    const registry = getConfig().registry;
    return registry.has(name) ? registry.get(name) : undefined;
  } catch {
    return undefined;
  }
}

function serverAddress(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

/** The last hop that succeeded — the one trace usage belongs to. */
function winnerIndex(trace: RequestTrace): number {
  for (let i = trace.hops.length - 1; i >= 0; i--) {
    if (trace.hops[i]!.outcome === "ok") return i;
  }
  return -1;
}

/** `error.type` for a failed hop: the upstream status or the outcome. */
function hopErrorType(hop: Hop): string {
  if (hop.outcome === "http_error" && hop.status !== undefined) {
    return String(hop.status);
  }
  return hop.outcome;
}

/** Usage/finish facts the trace records for the winning hop only. */
function winnerAttributes(trace: RequestTrace, attrs: Attributes): void {
  if (trace.finishReason !== undefined) {
    attrs[ATTR.genAiResponseFinishReasons] = [trace.finishReason];
  }
  if (trace.maxTokensClamp !== undefined) {
    attrs[ATTR.genAiRequestMaxTokens] = trace.maxTokensClamp.to;
  }
  if (trace.inputTokens !== undefined) {
    attrs[ATTR.genAiUsageInputTokens] = trace.inputTokens;
  }
  if (trace.outputTokens !== undefined) {
    attrs[ATTR.genAiUsageOutputTokens] = trace.outputTokens;
  }
  if (trace.cacheReadTokens !== undefined) {
    attrs[ATTR.genAiUsageCacheReadInputTokens] = trace.cacheReadTokens;
  }
  if (trace.cacheWriteTokens !== undefined) {
    attrs[ATTR.genAiUsageCacheWriteInputTokens] = trace.cacheWriteTokens;
  }
}

function serverAttributes(
  trace: RequestTrace,
  winner: Hop | undefined,
): Attributes {
  const attrs: Attributes = {
    [ATTR.genAiOperationName]: "chat",
    [ATTR.genAiRequestModel]: trace.requestedModel,
    [ATTR.babelgateClient]: trace.client,
    [ATTR.babelgateRouteReason]: trace.reason,
    [ATTR.babelgateFallbackHops]: Math.max(0, trace.hops.length - 1),
  };
  if (winner !== undefined) {
    attrs[ATTR.babelgateProvider] = winner.provider;
    attrs[ATTR.genAiResponseModel] = winner.model;
    const entry = providerEntry(winner.provider);
    if (entry !== undefined) {
      attrs[ATTR.genAiProviderName] = GENAI_PROVIDER_NAMES[entry.type];
    }
    winnerAttributes(trace, attrs);
  }
  if (trace.costUsd !== null) {
    attrs[ATTR.babelgateCostUsd] = trace.costUsd;
  }
  if (trace.status === "error") {
    attrs[ATTR.errorType] = trace.errorType ?? "error";
  }
  return attrs;
}

function hopAttributes(
  trace: RequestTrace,
  hop: Hop,
  isWinner: boolean,
): Attributes {
  const attrs: Attributes = {
    [ATTR.genAiOperationName]: "chat",
    [ATTR.genAiRequestModel]: hop.model,
    [ATTR.babelgateProvider]: hop.provider,
  };
  const entry = providerEntry(hop.provider);
  if (entry !== undefined) {
    attrs[ATTR.genAiProviderName] = GENAI_PROVIDER_NAMES[entry.type];
    const address = serverAddress(entry.baseUrl);
    if (address !== undefined) {
      attrs[ATTR.serverAddress] = address;
    }
  }
  if (hop.outcome !== "ok") {
    attrs[ATTR.errorType] = hopErrorType(hop);
  } else if (isWinner) {
    attrs[ATTR.genAiResponseModel] = hop.model;
    winnerAttributes(trace, attrs);
  }
  return attrs;
}

/**
 * Build the sink. `exporter` defaults to the OTLP/HTTP exporter, which
 * reads the standard `OTEL_EXPORTER_OTLP_*` variables itself; tests
 * pass an InMemorySpanExporter instead.
 */
export async function createOtelSink(
  exporter?: SpanExporter,
): Promise<OtelSink> {
  const api = await import("@opentelemetry/api");
  const sdk = await import("@opentelemetry/sdk-trace-base");
  const resources = await import("@opentelemetry/resources");
  const spanExporter =
    exporter ??
    new (
      await import("@opentelemetry/exporter-trace-otlp-http")
    ).OTLPTraceExporter();

  // envDetector honours OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
  // (merged last so they win); the base sets service.name: "babelgate".
  const resource = resources
    .defaultResource()
    .merge(
      resources.resourceFromAttributes({
        "service.name": "babelgate",
      }),
    )
    .merge(
      resources.detectResources({ detectors: [resources.envDetector] }),
    );

  // §3.1.1: the exporter batches on its own.
  const provider = new sdk.BasicTracerProvider({
    resource,
    spanProcessors: [new sdk.BatchSpanProcessor(spanExporter)],
  });
  const tracer = provider.getTracer("babelgate");

  return {
    name: "otel",

    accept(trace: RequestTrace): void {
      const winner = winnerIndex(trace);
      const parent = parseTraceparent(trace.parentTraceparent ?? "");
      const parentCtx: Context =
        parent === undefined
          ? api.ROOT_CONTEXT
          : api.trace.setSpanContext(api.ROOT_CONTEXT, parent);

      const server = tracer.startSpan(
        `babelgate ${trace.sourceApi}`,
        {
          kind: api.SpanKind.SERVER,
          startTime: trace.startedAt,
          attributes: serverAttributes(
            trace,
            winner >= 0 ? trace.hops[winner] : undefined,
          ),
        },
        parentCtx,
      );
      if (trace.status === "error") {
        server.setStatus({ code: api.SpanStatusCode.ERROR });
      }
      server.end(trace.startedAt + trace.totalMs);

      // Hops run sequentially but carry only a duration: each hop's
      // start is the previous hop's end, anchored at the request start
      // (decode/plan time folds into the first hop's span). For a
      // streamed request the winning hop's `ms` is only
      // time-to-headers (postStream resolves there), while the GenAI
      // client-span convention covers the call until the response is
      // fully received — so that span ends at the request end.
      const hopCtx = api.trace.setSpan(api.ROOT_CONTEXT, server);
      let cursor = trace.startedAt;
      for (const [index, hop] of trace.hops.entries()) {
        const span = tracer.startSpan(
          `chat ${hop.model}`,
          {
            kind: api.SpanKind.CLIENT,
            startTime: cursor,
            attributes: hopAttributes(trace, hop, index === winner),
          },
          hopCtx,
        );
        const end =
          trace.stream && index === winner
            ? trace.startedAt + trace.totalMs
            : cursor + hop.ms;
        if (hop.outcome !== "ok") {
          span.setStatus({ code: api.SpanStatusCode.ERROR });
        }
        span.end(end);
        cursor = end;
      }
    },

    async shutdown(): Promise<void> {
      await provider.shutdown();
    },
  };
}
