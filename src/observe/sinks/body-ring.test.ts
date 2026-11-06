import { describe, it, expect } from "vitest";
import { createBodyRing } from "./body-ring";
import { newTrace, type RequestTrace } from "../trace";

function makeTrace(
  requestId: string,
  bodies?: RequestTrace["bodies"],
): RequestTrace {
  const trace = newTrace({
    requestId,
    startedAt: 1_000,
    client: "other",
    sourceApi: "openai",
  });
  trace.bodies = bodies;
  return trace;
}

const BODIES = { target: [] };

describe("body ring (spec §3.5, D3)", () => {
  it("stores a trace's bodies by requestId", () => {
    const ring = createBodyRing(50);
    ring.accept(makeTrace("r1", BODIES));
    expect(ring.get("r1")).toBe(BODIES);
    expect(ring.get("missing")).toBeUndefined();
  });

  it("ignores traces that carry no bodies", () => {
    const ring = createBodyRing(50);
    ring.accept(makeTrace("r1"));
    expect(ring.get("r1")).toBeUndefined();
  });

  it("ring keeps the last N", () => {
    const ring = createBodyRing(3);
    for (let i = 1; i <= 5; i++) {
      ring.accept(makeTrace(`r${i}`, { target: [{ value: i }] }));
    }
    expect(ring.get("r1")).toBeUndefined();
    expect(ring.get("r2")).toBeUndefined();
    expect(ring.get("r3")).toEqual({ target: [{ value: 3 }] });
    expect(ring.get("r4")).toEqual({ target: [{ value: 4 }] });
    expect(ring.get("r5")).toEqual({ target: [{ value: 5 }] });
  });
});
