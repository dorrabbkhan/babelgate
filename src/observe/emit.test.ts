import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  emitTrace,
  finishTrace,
  registerSink,
  resetSinks,
} from "./emit";
import { newTrace, type RequestTrace } from "./trace";
import { runWithTrace } from "./context";
import { logger } from "../utils/logger";
import { resetConfig } from "../config/env-config";

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
    hops: [
      { provider: "main", model: "m", outcome: "ok", ms: 5 },
    ],
    status: "ok",
    httpStatus: 200,
    totalMs: 10,
    ...over,
  };
}

beforeEach(() => {
  resetSinks();
});

describe("emitTrace (spec §3.1.1)", () => {
  it("throwing sink does not stop others", () => {
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => logger);
    registerSink({
      name: "bad",
      accept: () => {
        throw new Error("boom");
      },
    });
    const seen: RequestTrace[] = [];
    registerSink({ name: "recorder", accept: (t) => seen.push(t) });

    emitTrace(makeTrace());

    expect(seen).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("bodies reach only ring and store", () => {
    const got: Record<string, RequestTrace | undefined> = {};
    for (const name of ["body-ring", "usage-store", "metrics", "log"]) {
      registerSink({ name, accept: (t) => (got[name] = t) });
    }

    const trace = makeTrace();
    trace.bodies = { target: [{ value: { secret: "bodies" } }] };
    emitTrace(trace);

    expect(got["body-ring"]!.bodies).toBeDefined();
    expect(got["usage-store"]!.bodies).toBeDefined();
    // Every other sink sees the stripped copy, built once — never the
    // trace object itself, so it cannot mutate its way to the bodies.
    expect("bodies" in got["metrics"]!).toBe(false);
    expect(got["metrics"]).not.toBe(trace);
    expect(got["metrics"]).toBe(got["log"]);
  });

  it("warns once per minute per sink", () => {
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => logger);
    registerSink({
      name: "flaky",
      accept: () => {
        throw new Error("boom");
      },
    });
    registerSink({
      name: "flaky-too",
      accept: () => {
        throw new Error("boom");
      },
    });

    let now = 10_000;
    const clock = () => now;

    emitTrace(makeTrace(), clock); // one warn per sink
    emitTrace(makeTrace(), clock); // suppressed — same minute
    expect(warnSpy).toHaveBeenCalledTimes(2);

    now += 59_999;
    emitTrace(makeTrace(), clock); // still within the minute
    expect(warnSpy).toHaveBeenCalledTimes(2);

    now += 1;
    emitTrace(makeTrace(), clock); // next minute → warn again
    expect(warnSpy).toHaveBeenCalledTimes(4);
    warnSpy.mockRestore();
  });
});

describe("finishTrace (spec §3.1)", () => {
  const finish = {
    reason: "default",
    requestedModel: "gpt-4",
    hops: [
      { provider: "main", model: "m", outcome: "ok" as const, ms: 5 },
    ],
    winner: "main",
    stream: false,
    status: "ok" as const,
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 8,
    finishReason: "stop",
  };

  it("merges the update and emits once", async () => {
    const seen: RequestTrace[] = [];
    registerSink({ name: "recorder", accept: (t) => seen.push(t) });
    const trace = newTrace({
      requestId: "r1",
      startedAt: Date.now() - 25,
      client: "other",
      sourceApi: "openai",
    });

    runWithTrace(trace, () => {
      finishTrace(finish);
      finishTrace(finish); // second call is a no-op
    });

    // Emit happens in the background, once pricing settles.
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({
      requestId: "r1",
      requestedModel: "gpt-4",
      reason: "default",
      winner: "main",
      status: "ok",
      httpStatus: 200,
      inputTokens: 10,
      outputTokens: 8,
      finishReason: "stop",
    });
    expect(seen[0].totalMs).toBeGreaterThanOrEqual(25);
  });

  it("outside a trace scope it is a no-op", async () => {
    const seen: RequestTrace[] = [];
    registerSink({ name: "recorder", accept: (t) => seen.push(t) });
    finishTrace(finish);
    expect(seen).toHaveLength(0);
  });

  // §3.6: finishTrace prices the winning hop — here an ollama winner
  // is local $0, and a missing config never breaks the emit.
  it("sets cost fields from the winning hop", async () => {
    process.env.TARGET_API = "ollama";
    process.env.OLLAMA_API_BASE_URL = "http://ollama.test";
    resetConfig();
    try {
      const seen: RequestTrace[] = [];
      registerSink({ name: "recorder", accept: (t) => seen.push(t) });
      const trace = newTrace({
        requestId: "r1",
        startedAt: Date.now(),
        client: "other",
        sourceApi: "openai",
      });

      runWithTrace(trace, () =>
        finishTrace({
          ...finish,
          hops: [
            {
              provider: "ollama",
              model: "llama3",
              outcome: "ok",
              ms: 5,
            },
          ],
          winner: "ollama",
        }),
      );

      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toMatchObject({
        costUsd: 0,
        priceSource: "local",
        costEstimated: false,
      });
    } finally {
      delete process.env.TARGET_API;
      delete process.env.OLLAMA_API_BASE_URL;
      resetConfig();
    }
  });
});
