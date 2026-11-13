import { describe, expect, it } from "vitest";
import {
  evaluateObservations,
  metricTotal,
  type InspectorBodies,
  type ObserveFlags,
  type ObserveRow,
} from "./observe-check";

/**
 * The gates' observability check (spec §4.5): pure-logic cases over
 * the row columns, inspector bodies and metric text the script
 * reads — no network.
 */

const FLAGS: ObserveFlags = {
  client: "claude-code",
  expectCost: false,
  expectCacheRead: false,
  expectProviders: [],
  expectSaved: false,
};

const ROW: ObserveRow = {
  id: "r1",
  startedAt: 1_000,
  provider: "openrouter",
  costUsd: 0.012,
  wouldCostUsd: null,
  cacheReadTokens: null,
};

const BODIES: InspectorBodies = {
  source: { value: {} },
  canonical: { value: {} },
  target: [{ value: {} }],
  response: { wire: { value: {} } },
};

const METRICS = `# HELP babelgate_requests_total requests
# TYPE babelgate_requests_total counter
babelgate_requests_total{source="anthropic",provider="openrouter",model="m",client="claude-code",status="ok"} 7
babelgate_requests_total{source="anthropic",provider="openrouter",model="m",client="gemini-cli",status="ok"} 2
# HELP other_metric unrelated
other_metric 4
`;

describe("metricTotal", () => {
  it("sums labelled samples and skips comments", () => {
    expect(metricTotal(METRICS, "babelgate_requests_total")).toBe(9);
  });
  it("sums a bare unlabelled sample", () => {
    expect(metricTotal("babelgate_requests_total 3\n", "babelgate_requests_total")).toBe(3);
  });
  it("zero when the name is absent", () => {
    expect(metricTotal(METRICS, "babelgate_missing_total")).toBe(0);
  });
});

describe("evaluateObservations", () => {
  it("passes a fully observed run", () => {
    expect(evaluateObservations(FLAGS, [ROW], BODIES, 7)).toBeNull();
  });

  it("names the missing client row", () => {
    expect(evaluateObservations(FLAGS, [], null, 7)).toContain(
      'client "claude-code"',
    );
  });

  it("names the missing inspector stages", () => {
    expect(
      evaluateObservations(FLAGS, [ROW], null, 7),
    ).toContain("four-stage");
    expect(
      evaluateObservations(FLAGS, [ROW], { target: [] }, 7),
    ).toContain("four-stage");
  });

  it("names the unmoved counter", () => {
    expect(evaluateObservations(FLAGS, [ROW], BODIES, 0)).toContain(
      "babelgate_requests_total",
    );
  });

  it("--expect-cost fails when no row is priced", () => {
    const flags = { ...FLAGS, expectCost: true };
    const unpriced = { ...ROW, costUsd: null };
    expect(evaluateObservations(flags, [unpriced], BODIES, 7)).toContain(
      "--expect-cost",
    );
    expect(evaluateObservations(flags, [ROW], BODIES, 7)).toBeNull();
  });

  it("--expect-cache-read needs a cache-read row", () => {
    const flags = { ...FLAGS, expectCacheRead: true };
    expect(evaluateObservations(flags, [ROW], BODIES, 7)).toContain(
      "--expect-cache-read",
    );
    const cached = { ...ROW, cacheReadTokens: 4_096 };
    expect(evaluateObservations(flags, [cached], BODIES, 7)).toBeNull();
  });

  it("--expect-providers needs each named provider", () => {
    const flags = { ...FLAGS, expectProviders: ["ollama", "openrouter"] };
    expect(evaluateObservations(flags, [ROW], BODIES, 7)).toContain(
      '"ollama"',
    );
    const local = { ...ROW, id: "r2", provider: "ollama" };
    expect(evaluateObservations(flags, [ROW, local], BODIES, 7)).toBeNull();
  });

  it("--expect-saved needs a would-have-cost row", () => {
    const flags = { ...FLAGS, expectSaved: true };
    expect(evaluateObservations(flags, [ROW], BODIES, 7)).toContain(
      "--expect-saved",
    );
    const saved = { ...ROW, wouldCostUsd: 0.5 };
    expect(evaluateObservations(flags, [saved], BODIES, 7)).toBeNull();
  });
});
