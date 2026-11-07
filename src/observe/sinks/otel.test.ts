import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatusCode, type HrTime } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type {
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { resetConfig } from "../../config/env-config";
import { GENAI_PROVIDER_NAMES } from "../genai-attributes";
import { newTrace, type RequestTrace } from "../trace";
import { createOtelSink } from "./otel";

/**
 * The in-memory exporter: InMemorySpanExporter's own shutdown() resets
 * its span list, so the sink's shutdown flush would erase the evidence
 * — this one records and never forgets.
 */
class RecordingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(
    batch: ReadableSpan[],
    done: (result: ExportResult) => void,
  ): void {
    this.spans.push(...batch);
    done({ code: ExportResultCode.SUCCESS });
  }
  async shutdown(): Promise<void> {}
}

/**
 * The OTel sink (spec §3.8): one SERVER span `babelgate {source}` per
 * trace and one CLIENT span `chat {model}` per hop, built after the
 * fact from trace timestamps. In-memory exporter + shutdown() as the
 * flush; attributes carry only routing/usage facts — content never
 * reaches a span, whatever the capture-content env var says.
 */
function makeTrace(over: Partial<RequestTrace> = {}): RequestTrace {
  return {
    ...newTrace({
      requestId: "r1",
      startedAt: 1_700_000_000_000,
      client: "claude-code",
      sourceApi: "openai",
    }),
    requestedModel: "fast",
    reason: "default",
    hops: [{ provider: "ollama", model: "llama3", outcome: "ok", ms: 40 }],
    winner: "ollama",
    status: "ok",
    httpStatus: 200,
    totalMs: 50,
    inputTokens: 30,
    outputTokens: 12,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    finishReason: "stop",
    costUsd: 0.001,
    ...over,
  };
}

/** HrTime [seconds, nanoseconds] → epoch ms. */
function ms(t: HrTime): number {
  return t[0] * 1000 + t[1] / 1e6;
}

beforeEach(() => {
  // Env-only config: one provider "ollama" the trace's hops resolve to.
  process.env.TARGET_API = "ollama";
  process.env.OLLAMA_API_BASE_URL = "http://ollama.test:11434";
  resetConfig();
});

afterEach(() => {
  delete process.env.TARGET_API;
  delete process.env.OLLAMA_API_BASE_URL;
  delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT;
  resetConfig();
});

describe("otel sink (spec §3.8)", () => {
  it("server span plus a client span per hop", async () => {
    const exporter = new RecordingExporter();
    const sink = await createOtelSink(exporter);

    sink.accept(
      makeTrace({
        hops: [
          { provider: "ollama", model: "llama3", outcome: "timeout", ms: 40 },
          { provider: "ollama", model: "qwen3", outcome: "ok", ms: 60 },
        ],
        winner: "ollama",
        totalMs: 120,
      }),
    );
    await sink.shutdown();

    const spans = exporter.spans;
    expect(spans).toHaveLength(3);

    const server = spans.find((s) => s.kind === SpanKind.SERVER)!;
    const clients = spans.filter((s) => s.kind === SpanKind.CLIENT);
    expect(server.name).toBe("babelgate openai");
    expect(clients).toHaveLength(2);
    expect(clients.map((s) => s.name).sort()).toEqual([
      "chat llama3",
      "chat qwen3",
    ]);

    // Explicit start/end times from the trace and hops: the server
    // covers the whole request; hops run back to back from the start.
    expect(ms(server.startTime)).toBe(1_700_000_000_000);
    expect(ms(server.endTime)).toBe(1_700_000_000_120);
    const h0 = clients.find((s) => s.name === "chat llama3")!;
    const h1 = clients.find((s) => s.name === "chat qwen3")!;
    expect(ms(h0.startTime)).toBe(1_700_000_000_000);
    expect(ms(h0.endTime)).toBe(1_700_000_000_040);
    expect(ms(h1.startTime)).toBe(1_700_000_000_040);
    expect(ms(h1.endTime)).toBe(1_700_000_000_100);

    // Every hop span is a direct child of the server span; the failed
    // hop carries error status and error.type, the winner stays unset.
    for (const c of clients) {
      expect(c.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
      expect(c.parentSpanContext?.traceId).toBe(
        server.spanContext().traceId,
      );
    }
    expect(h0.status.code).toBe(SpanStatusCode.ERROR);
    expect(h0.attributes["error.type"]).toBe("timeout");
    expect(h1.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("genai attributes on the client span", async () => {
    const exporter = new RecordingExporter();
    const sink = await createOtelSink(exporter);

    sink.accept(makeTrace({ maxTokensClamp: { from: 8_000, to: 4_000 } }));
    await sink.shutdown();

    const span = exporter.spans
      .find((s) => s.kind === SpanKind.CLIENT)!;
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "ollama",
      "gen_ai.request.model": "llama3",
      "gen_ai.response.model": "llama3",
      "gen_ai.request.max_tokens": 4_000,
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": 30,
      "gen_ai.usage.output_tokens": 12,
      "gen_ai.usage.cache_read.input_tokens": 5,
      "gen_ai.usage.cache_write.input_tokens": 2,
      "server.address": "ollama.test",
      "babelgate.provider": "ollama",
    });

    const server = exporter.spans
      .find((s) => s.kind === SpanKind.SERVER)!;
    expect(server.attributes).toMatchObject({
      "babelgate.client": "claude-code",
      "babelgate.route.reason": "default",
      "babelgate.provider": "ollama",
      "babelgate.cost_usd": 0.001,
      "babelgate.fallback_hops": 0,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "fast",
      "gen_ai.response.model": "llama3",
      "gen_ai.usage.input_tokens": 30,
      "gen_ai.usage.output_tokens": 12,
    });

    // Every provider type maps to a semconv provider name (spec §3.8);
    // OpenAI-compatible providers report "openai" because their
    // entry.type is "openai".
    expect(GENAI_PROVIDER_NAMES).toEqual({
      openai: "openai",
      anthropic: "anthropic",
      gemini: "gcp.gemini",
      ollama: "ollama",
    });
  });

  it("traceparent becomes the parent", async () => {
    const exporter = new RecordingExporter();
    const sink = await createOtelSink(exporter);

    sink.accept(
      makeTrace({
        parentTraceparent:
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      }),
    );
    await sink.shutdown();

    const server = exporter.spans
      .find((s) => s.kind === SpanKind.SERVER)!;
    expect(server.parentSpanContext).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      isRemote: true,
    });
    // The babelgate spans continue the incoming trace.
    expect(server.spanContext().traceId).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });

  it("no content attributes even with OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=true", async () => {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT = "true";
    const exporter = new RecordingExporter();
    const sink = await createOtelSink(exporter);
    const canary = "CANARY_CONTENT_7f3e1";

    // The canary rides every field that is not mapped to an attribute:
    // even if emitTrace failed to strip bodies, the sink reads only the
    // spec §3.8 field list.
    sink.accept(
      makeTrace({
        userAgent: canary,
        notes: [{ stage: "decode", adapter: "openai", code: canary }],
        bodies: {
          source: { value: { prompt: canary } },
          target: [{ value: { body: canary } }],
          response: { canonical: { value: { text: canary } } },
        },
      }),
    );
    await sink.shutdown();

    for (const span of exporter.spans) {
      const dump = `${span.name} ${JSON.stringify(span.attributes)}`;
      expect(dump).not.toContain(canary);
      expect(
        Object.keys(span.attributes).some(
          (k) => k.startsWith("gen_ai.input") || k.startsWith("gen_ai.output"),
        ),
      ).toBe(false);
    }
  });

  it("otel packages not loaded without endpoint", async () => {
    // Module-load spy: the @opentelemetry packages exist only inside
    // createOtelSink's dynamic import — importing our own modules,
    // without an endpoint or a call, must never pull them in.
    const loaded: string[] = [];
    vi.resetModules();
    vi.doMock("@opentelemetry/api", () => {
      loaded.push("api");
      return {};
    });
    vi.doMock("@opentelemetry/sdk-trace-base", () => {
      loaded.push("sdk-trace-base");
      return {};
    });
    vi.doMock("@opentelemetry/exporter-trace-otlp-http", () => {
      loaded.push("exporter");
      return {};
    });
    vi.doMock("@opentelemetry/resources", () => {
      loaded.push("resources");
      return {};
    });
    try {
      await import("./otel");
      await import("../emit");
      await import("../middleware");
      await import("../trace");
      expect(loaded).toEqual([]);
    } finally {
      vi.doUnmock("@opentelemetry/api");
      vi.doUnmock("@opentelemetry/sdk-trace-base");
      vi.doUnmock("@opentelemetry/exporter-trace-otlp-http");
      vi.doUnmock("@opentelemetry/resources");
      vi.resetModules();
    }
  });
});
