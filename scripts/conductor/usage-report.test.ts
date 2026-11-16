import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  loadSessions,
  sessionCost,
  totalCost,
  firstTurnContext,
  attributeTask,
  render,
  toJson,
} from "./usage-report";

/**
 * usage-report.ts (spec §3.0.5, E9–E11): synthetic session logs under
 * fixtures/usage/ — never real ~/.claude logs (they contain prompt bodies).
 * The report prints aggregates only.
 */
const DIR = join(__dirname, "fixtures", "usage");

describe("usage-report.ts (spec §3.0.5)", () => {
  it("attributes a session to its task", () => {
    expect(attributeTask(join(DIR, "sess-conduct.jsonl"))).toBe("v1.4-task3");
    expect(attributeTask(join(DIR, "sess-taskref.jsonl"))).toBe("v1.3-task7");
    expect(attributeTask(join(DIR, "sess-unattr.jsonl"))).toBe("unattributed");
  });

  it("prices a session", () => {
    const [s] = loadSessions(DIR).filter((x) => x.id === "sess-conduct");
    // turn 1 opus: 1k in, 1M cache-read, 500k cache-write, 2k out
    //   = 0.004 + 0.20 + 4.00 + 0.04 = 4.244
    // turn 2 opus: 500 in, 2M cache-read, 0 cache-write, 1k out
    //   = 0.002 + 0.40 + 0.02 = 0.422
    expect(sessionCost(s)).toBeCloseTo(4.666, 6);
    expect(s.turns.length).toBe(2);
  });

  it("first-turn context is the first assistant turn's input+cache", () => {
    const [s] = loadSessions(DIR).filter((x) => x.id === "sess-conduct");
    expect(firstTurnContext(s)).toBe(1_501_000); // 1000 + 1M + 500k
  });

  it("prints aggregates only — no prompt or tool text", () => {
    const out = render(loadSessions(DIR), {});
    expect(out).not.toContain("PROMPT_SENTINEL_A");
    expect(out).not.toContain("file_path");
    expect(out).toContain("v1.4-task3");
  });

  it("one message split across lines counts once", () => {
    const [s] = loadSessions(DIR).filter((x) => x.id === "sess-split");
    // msg_A is split over 3 lines (thinking/text/tool_use), each repeating
    // the same usage — count it once, the tool_use once.
    expect(s.turns.length).toBe(1);
    expect(s.turns[0].input).toBe(100);
    expect(s.turns[0].output).toBe(10);
    expect(sessionCost(s)).toBeCloseTo(0.0006, 6); // (100×4 + 10×20)/1e6
    expect(s.tools.get("bash")).toBe(1);
    expect([...s.tools.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("subagent turns count toward the parent session", () => {
    const [s] = loadSessions(DIR).filter((x) => x.id === "sess-conduct");
    expect(s.turns.length).toBe(2);
    expect(s.subagentTurns.length).toBe(1);
    expect(s.subagentTurns[0].modelKey).toBe("haiku-5-5");
    // 4.666 + (1000×0.10 + 100×0.50)/1e6 — priced by the sidechain's own model
    expect(totalCost(s)).toBeCloseTo(4.66615, 6);
    expect(totalCost(s, true)).toBeCloseTo(4.666, 6); // opus-only excludes it
  });

  it("json output honours --version", () => {
    const parsed = JSON.parse(toJson(loadSessions(DIR), { version: "v1.4" }));
    expect(parsed.sessions.map((s: { task: string }) => s.task)).toEqual(["v1.4-task3"]);
    expect(Object.keys(parsed.tasks)).toEqual(["v1.4-task3"]);
  });
});
