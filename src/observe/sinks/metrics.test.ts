import { describe, it, expect, beforeEach } from "vitest";
import {
  capLabel,
  createMetricsSink,
  resetMetricsSink,
} from "./metrics";
import { newTrace, type RequestTrace } from "../trace";

/**
 * The metrics sink (spec §3.8): one counter increment per finished
 * trace, histograms from its timings, tokens/cost by the winning hop's
 * routed (provider, model), fallback edges, tool-call codes and the
 * label cap. Nothing a client sent ever reaches a label.
 */
function makeTrace(over: Partial<RequestTrace> = {}): RequestTrace {
  return {
    ...newTrace({
      requestId: "r1",
      startedAt: 1_000,
      client: "other",
      sourceApi: "openai",
    }),
    requestedModel: "gpt-4",
    reason: "default",
    hops: [{ provider: "main", model: "m", outcome: "ok", ms: 5 }],
    winner: "main",
    status: "ok",
    httpStatus: 200,
    totalMs: 150,
    ttfbMs: 50,
    inputTokens: 10,
    outputTokens: 8,
    costUsd: 0.005,
    ...over,
  };
}

beforeEach(() => {
  // Fresh label-cap state — the cap is process-wide and each test
  // asserts its own label values.
  resetMetricsSink();
});

describe("metrics sink (spec §3.8)", () => {
  it("counters and histograms move per trace", async () => {
    const sink = createMetricsSink();
    sink.accept(makeTrace());
    sink.accept(
      makeTrace({ requestId: "r2", status: "error", ttfbMs: undefined }),
    );

    const text = await sink.registry.metrics();
    expect(text).toContain(
      'babelgate_requests_total{source="openai",provider="main",model="m",client="other",status="ok"} 1',
    );
    expect(text).toContain(
      'babelgate_requests_total{source="openai",provider="main",model="m",client="other",status="error"} 1',
    );
    expect(text).toContain(
      'babelgate_request_duration_seconds_count{source="openai",provider="main",status="ok"} 1',
    );
    expect(text).toContain(
      'babelgate_request_duration_seconds_sum{source="openai",provider="main",status="ok"} 0.15',
    );
    // The ok trace reports ttfb; the error trace had none.
    expect(text).toContain(
      'babelgate_ttfb_seconds_count{source="openai",provider="main",status="ok"} 1',
    );
    expect(text).toContain(
      'babelgate_ttfb_seconds_sum{source="openai",provider="main",status="ok"} 0.05',
    );
    expect(text).not.toContain('ttfb_seconds_count{source="openai",provider="main",status="error"}');
    // Node process defaults ship with the registry.
    expect(text).toContain("process_cpu_user_seconds_total");
  });

  it("cost and tokens by kind", async () => {
    const sink = createMetricsSink();
    sink.accept(makeTrace({ cacheReadTokens: 4, cacheWriteTokens: 2 }));

    const text = await sink.registry.metrics();
    expect(text).toContain(
      'babelgate_tokens_total{provider="main",model="m",client="other",kind="input"} 10',
    );
    expect(text).toContain(
      'babelgate_tokens_total{provider="main",model="m",client="other",kind="output"} 8',
    );
    expect(text).toContain(
      'babelgate_tokens_total{provider="main",model="m",client="other",kind="cache_read"} 4',
    );
    expect(text).toContain(
      'babelgate_tokens_total{provider="main",model="m",client="other",kind="cache_write"} 2',
    );
    expect(text).toContain(
      'babelgate_cost_usd_total{provider="main",model="m",client="other"} 0.005',
    );
  });

  it("fallback edges, tool-call codes and unpriced rows", async () => {
    const sink = createMetricsSink();
    sink.accept(
      makeTrace({
        hops: [
          { provider: "main", model: "m", outcome: "http_error", status: 503, ms: 5 },
          { provider: "second", model: "f", outcome: "ok", ms: 7 },
        ],
        winner: "second",
        costUsd: null,
        diagnostics: [
          { toolCallId: "t1", name: "fn", code: "invalid_json" },
        ],
        repairs: [{ toolCallId: "t1", steps: ["strip_fence"] }],
      }),
    );

    const text = await sink.registry.metrics();
    expect(text).toContain(
      'babelgate_fallbacks_total{from_provider="main",outcome="ok"} 1',
    );
    expect(text).toContain(
      'babelgate_tool_call_failures_total{provider="second",model="f",code="invalid_json"} 1',
    );
    expect(text).toContain(
      'babelgate_tool_call_repairs_total{provider="second",model="f",code="strip_fence"} 1',
    );
    expect(text).toContain(
      'babelgate_unpriced_requests_total{model="f"} 1',
    );
  });

  it("label cap → other", async () => {
    const sink = createMetricsSink();
    for (let i = 0; i < 101; i++) {
      sink.accept(
        makeTrace({
          requestId: `cap-${i}`,
          hops: [
            {
              provider: "main",
              model: `model-${i}`,
              outcome: "ok",
              ms: 1,
            },
          ],
        }),
      );
    }

    const text = await sink.registry.metrics();
    // The first 100 distinct models keep their names; the 101st
    // collapses into the shared "other" series.
    expect(text).toContain('model="model-99"');
    expect(text).not.toContain('model="model-100"');
    expect(text).toContain('model="other"');

    expect(capLabel("cap-check", "a")).toBe("a");
    for (let i = 1; i < 100; i++) capLabel("cap-check", `v${i}`);
    expect(capLabel("cap-check", "v100")).toBe("other");
    expect(capLabel("cap-check", "a")).toBe("a"); // seen values still pass
  });

  it("model label is the routed model", async () => {
    const sink = createMetricsSink();
    sink.accept(
      makeTrace({
        requestedModel: "gpt-4",
        hops: [
          { provider: "main", model: "llama3", outcome: "ok", ms: 5 },
        ],
      }),
    );

    const text = await sink.registry.metrics();
    expect(text).toContain('model="llama3"');
    expect(text).not.toContain('model="gpt-4"');
  });

  it("aux and sink-error counters", async () => {
    const sink = createMetricsSink();
    sink.incAux("openai", "count_tokens");
    sink.incAux("openai", "models");
    sink.incSinkError("usage-store");

    const text = await sink.registry.metrics();
    expect(text).toContain(
      'babelgate_aux_requests_total{source="openai",kind="count_tokens"} 1',
    );
    expect(text).toContain(
      'babelgate_aux_requests_total{source="openai",kind="models"} 1',
    );
    expect(text).toContain(
      'babelgate_sink_errors_total{sink="usage-store"} 1',
    );
  });
});
