import { describe, it, expect } from "vitest";
import { newTrace } from "./trace";

/** spec §3.1: newTrace seeds the fields known at middleware time;
 * routing/usage fields are placeholders until finishTrace merges them. */
describe("newTrace (spec §3.1)", () => {
  it("carries identity fields and empty collections", () => {
    const trace = newTrace({
      requestId: "r1",
      startedAt: 1700000000000,
      client: "claude-code",
      userAgent: "claude-cli/2.1.3 (external, cli)",
      sourceApi: "anthropic",
    });
    expect(trace).toMatchObject({
      requestId: "r1",
      startedAt: 1700000000000,
      client: "claude-code",
      userAgent: "claude-cli/2.1.3 (external, cli)",
      sourceApi: "anthropic",
      costUsd: null,
      costEstimated: false,
    });
    expect(trace.hops).toEqual([]);
    expect(trace.notes).toEqual([]);
    expect(trace.diagnostics).toEqual([]);
    expect(trace.repairs).toEqual([]);
    expect(trace.bodies).toBeUndefined();
  });
});
