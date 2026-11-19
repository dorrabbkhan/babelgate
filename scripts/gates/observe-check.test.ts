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
  expectNoNote: [],
  expectPassthrough: false,
  expectPreset: undefined,
};

const ROW: ObserveRow = {
  id: "r1",
  startedAt: 1_000,
  provider: "openrouter",
  costUsd: 0.012,
  wouldCostUsd: null,
  cacheReadTokens: null,
  notes: [],
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

  // v1.4 Task 14 (spec §4.5, gates A/B): no row since start may carry
  // the named note — the bridge must never send reasoning across a
  // provider boundary.
  it("--expect-no-note fails when any row has the note", () => {
    const flags = { ...FLAGS, expectNoNote: ["reasoning_dropped"] };
    const noted: ObserveRow = {
      ...ROW,
      notes: [
        {
          stage: "decode",
          adapter: "responses",
          code: "reasoning_dropped",
        },
      ],
    };
    expect(evaluateObservations(flags, [noted], BODIES, 7)).toContain(
      "--expect-no-note reasoning_dropped",
    );
    expect(evaluateObservations(flags, [ROW], BODIES, 7)).toBeNull();
  });

  it("--expect-no-note passes when only other notes are present", () => {
    const flags = { ...FLAGS, expectNoNote: ["reasoning_dropped"] };
    const other: ObserveRow = {
      ...ROW,
      notes: [
        {
          stage: "encode",
          adapter: "gemini",
          code: "reasoning_effort_lowered",
        },
      ],
    };
    expect(evaluateObservations(flags, [other], BODIES, 7)).toBeNull();
  });

  // Fix round 2: a pass-through trace has no canonical stage by
  // design (§3.4, markPassthrough deletes it), so the latest row's
  // body check is the three stages source/target/response.wire —
  // and a canonical stage on such a row is wrong too.
  const PASS_THROUGH_BODIES: InspectorBodies = {
    source: { value: {} },
    target: [{ value: {} }],
    response: { wire: { value: {} } },
  };
  const PASS_THROUGH_ROW: ObserveRow = {
    ...ROW,
    passthrough: true,
    costUsd: 0.001,
  };

  // v1.4 Task 14 (spec §4.5, gate C): every row since start must be a
  // pass-through row — a bridged request in a pass-through gate is a
  // routing bug, not an observation to tolerate.
  it("--expect-passthrough fails on a bridged row", () => {
    const flags = { ...FLAGS, expectPassthrough: true };
    expect(evaluateObservations(flags, [ROW], BODIES, 7)).toContain(
      "--expect-passthrough",
    );
    const relayed = { ...ROW, passthrough: true };
    expect(
      evaluateObservations(flags, [relayed], PASS_THROUGH_BODIES, 7),
    ).toBeNull();
    const mixed = { ...ROW, id: "r2", passthrough: true };
    expect(
      evaluateObservations(flags, [ROW, mixed], BODIES, 7),
    ).toContain("--expect-passthrough");
  });

  it("passes a pass-through latest row with its three stages", () => {
    const flags = { ...FLAGS, expectPassthrough: true, expectCost: true };
    expect(
      evaluateObservations(flags, [PASS_THROUGH_ROW], PASS_THROUGH_BODIES, 7),
    ).toBeNull();
  });

  it("fails a pass-through row whose response has no wire stage", () => {
    const flags = { ...FLAGS, expectPassthrough: true };
    const bodies: InspectorBodies = {
      ...PASS_THROUGH_BODIES,
      response: {},
    };
    expect(
      evaluateObservations(flags, [PASS_THROUGH_ROW], bodies, 7),
    ).toBe(
      "latest request is pass-through but has no three-stage inspector body (source/target/response.wire, no canonical)",
    );
  });

  it("fails a pass-through row that carries a canonical stage", () => {
    const flags = { ...FLAGS, expectPassthrough: true };
    const bodies: InspectorBodies = {
      ...PASS_THROUGH_BODIES,
      canonical: { value: {} },
    };
    expect(
      evaluateObservations(flags, [PASS_THROUGH_ROW], bodies, 7),
    ).toBe(
      "latest request is pass-through but has no three-stage inspector body (source/target/response.wire, no canonical)",
    );
  });

  it("still demands the canonical stage on a bridged latest row", () => {
    const bodies: InspectorBodies = { ...PASS_THROUGH_BODIES };
    expect(evaluateObservations(FLAGS, [ROW], bodies, 7)).toBe(
      "latest request has no four-stage inspector body (source/canonical/target/response)",
    );
  });

  // v1.5 Task 17 (spec §4, gate B): every row since start must name
  // the preset that relayed it — a row without a preset, or with a
  // different one, means routing went somewhere else.
  it("--expect-preset fails on a row with no preset", () => {
    const flags = { ...FLAGS, expectPreset: "ollama-anthropic" };
    expect(
      evaluateObservations(flags, [PASS_THROUGH_ROW], PASS_THROUGH_BODIES, 7),
    ).toContain('--expect-preset ollama-anthropic');
  });

  it("--expect-preset fails on a row with a different preset", () => {
    const flags = { ...FLAGS, expectPreset: "ollama-anthropic" };
    const other: ObserveRow = {
      ...PASS_THROUGH_ROW,
      preset: "glm-anthropic",
    };
    expect(
      evaluateObservations(flags, [other], PASS_THROUGH_BODIES, 7),
    ).toContain('--expect-preset ollama-anthropic');
  });

  it("--expect-preset passes when every row names the preset", () => {
    const flags = { ...FLAGS, expectPreset: "ollama-anthropic" };
    const shimmed: ObserveRow = {
      ...PASS_THROUGH_ROW,
      preset: "ollama-anthropic",
    };
    const second: ObserveRow = {
      ...shimmed,
      id: "r2",
    };
    expect(
      evaluateObservations(flags, [shimmed, second], PASS_THROUGH_BODIES, 7),
    ).toBeNull();
  });
});
