import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  loadSessions,
  sessionCost,
  firstTurnContext,
  attributeTask,
  render,
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
});
