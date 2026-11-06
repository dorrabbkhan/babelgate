import { describe, it, expect, vi } from "vitest";
import {
  runWithTrace,
  currentTrace,
  recordNote,
  snapshot,
} from "./context";
import { newTrace } from "./trace";
import { logger } from "../utils/logger";

function makeTrace() {
  return newTrace({
    requestId: "r1",
    startedAt: 1_000,
    client: "other",
    sourceApi: "openai",
  });
}

describe("recordNote (spec §3.5)", () => {
  it("notes recorded in scope and logged outside", () => {
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => logger);
    const trace = makeTrace();

    runWithTrace(trace, () => {
      recordNote({
        stage: "decode",
        adapter: "anthropic",
        code: "thinking_dropped",
        path: "thinking",
      });
    });
    expect(trace.notes).toEqual([
      {
        stage: "decode",
        adapter: "anthropic",
        code: "thinking_dropped",
        path: "thinking",
      },
    ]);

    // Outside a scope the note only reaches the debug log — no throw.
    recordNote({ stage: "encode", adapter: "openai", code: "cache_control_dropped" });
    expect(trace.notes).toHaveLength(1);
    expect(debugSpy).toHaveBeenCalledTimes(2);
    debugSpy.mockRestore();
  });
});

describe("snapshot (spec §3.5)", () => {
  it("no-op without a scope or without trace.bodies", () => {
    // No scope at all.
    snapshot("source", { a: 1 });

    const trace = makeTrace();
    runWithTrace(trace, () => {
      // Scope exists but the ring is disabled → bodies stays unset.
      snapshot("source", { a: 1 });
      expect(trace.bodies).toBeUndefined();
    });
  });

  it("writes each stage into trace.bodies", () => {
    const trace = makeTrace();
    trace.bodies = { target: [] };
    runWithTrace(trace, () => {
      snapshot("source", { in: 1 });
      snapshot("canonical", { mid: 2 });
      snapshot("target", { out: 3 });
      snapshot("target", { out: 4 });
      snapshot("response.canonical", { resp: 5 });
      snapshot("response.wire", { raw: 6 });
    });
    expect(trace.bodies).toEqual({
      source: { value: { in: 1 } },
      canonical: { value: { mid: 2 } },
      target: [{ value: { out: 3 } }, { value: { out: 4 } }],
      response: {
        canonical: { value: { resp: 5 } },
        wire: { value: { raw: 6 } },
      },
    });
  });

  it("replaces values over the cap with a truncated string marker", () => {
    const trace = makeTrace();
    trace.bodies = { target: [] };
    const big = { data: "x".repeat(1_100_000) };
    runWithTrace(trace, () => {
      snapshot("canonical", big);
      snapshot("response.wire", "y".repeat(300_000));
    });

    const canonical = trace.bodies!.canonical!;
    expect(canonical.truncated).toBe(true);
    expect(typeof canonical.value).toBe("string");
    expect(
      Buffer.byteLength(canonical.value as string, "utf8"),
    ).toBeLessThanOrEqual(1_048_576);

    const wire = trace.bodies!.response!.wire!;
    expect(wire.truncated).toBe(true);
    expect(typeof wire.value).toBe("string");
    expect(
      Buffer.byteLength(wire.value as string, "utf8"),
    ).toBeLessThanOrEqual(262_144);
  });

  it("values under the cap keep their object form", () => {
    const trace = makeTrace();
    trace.bodies = { target: [] };
    const small = { data: "x".repeat(100) };
    runWithTrace(trace, () => {
      snapshot("source", small);
    });
    expect(trace.bodies!.source).toEqual({ value: small });
  });
});
