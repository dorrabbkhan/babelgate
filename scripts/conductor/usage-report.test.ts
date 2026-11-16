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

  it("placeholder task ids are not attributed", () => {
    // "<N>"/"$1" placeholders expanded into prompts ("v1.4 N", "v1.4-taskN")
    // are not task ids — the id must start with a digit.
    expect(attributeTask(join(DIR, "sess-placeholder.jsonl"))).toBe("unattributed");
    expect(attributeTask(join(DIR, "sess-split.jsonl"))).toBe("v1.5-task0a");
  });

  it("version list filters both versions", () => {
    const sessions = loadSessions(DIR);
    const parsed = JSON.parse(toJson(sessions, { version: "v1.3,v1.4" }));
    expect(parsed.sessions.map((s: { id: string }) => s.id).sort()).toEqual([
      "sess-conduct",
      "sess-taskref",
    ]);
    expect(Object.keys(parsed.summary).sort()).toEqual(["total", "v1.3", "v1.4"]);
    const out = render(sessions, { version: "v1.3,v1.4" });
    expect(out).toContain("v1.3-task7");
    expect(out).toContain("v1.4-task3");
    expect(out).not.toContain("v1.5-task0a");
    expect(out).not.toContain("unattributed");
  });

  it("summary medians", () => {
    const s = JSON.parse(toJson(loadSessions(DIR), {})).summary;
    // Hand-computed from the fixtures:
    //   v1.4 = sess-conduct (2 own opus turns + 1 haiku subagent turn):
    //     $ = 4.244 + 0.422 + 0.00015 = 4.66615, $opus = 4.666;
    //     cache-rd 3.0M, cache-wr 500k, output 3,100; ctx1 = 1,501,000;
    //     ctxμ = (1,501,000 + 2,000,500 + 1,000)/3 = 1,167,500.
    //   v1.3 = sess-taskref (haiku): $ 0.00125, output 500, ctx 10,000.
    //   v1.5 = sess-split (opus, msg deduped to 1 turn): $ 0.0006, ctx 100.
    //   unattributed = sess-unattr (sonnet: $ 0.0116, ctx 51,300) +
    //     sess-placeholder (haiku: $ 0.00025, ctx 2,000) → $ 0.01185,
    //     ctx medians (51,300+2,000)/2 = 26,650.
    //   total: 5 sessions, 4 tasks, 7 turns; $ 4.67985, $opus 4.6666;
    //     $/task~ over {4.66615, 0.01185, 0.00125, 0.0006} →
    //     (0.00125+0.01185)/2 = 0.00655; ctx medians over
    //     {1,501,000, 51,300, 10,000, 2,000, 100} → 10,000.
    expect(Object.keys(s)).toEqual(["unattributed", "v1.3", "v1.4", "v1.5", "total"]);
    expect(s["v1.4"]).toMatchObject({
      sessions: 1,
      tasks: 1,
      turns: 3,
      cacheRead: 3_000_000,
      cacheWrite: 500_000,
      output: 3_100,
      ctxFirstMedian: 1_501_000,
    });
    expect(s["v1.4"].usd).toBeCloseTo(4.66615, 6);
    expect(s["v1.4"].usdOpus).toBeCloseTo(4.666, 6);
    expect(s["v1.4"].usdPerTaskMedian).toBeCloseTo(4.66615, 6);
    expect(s["v1.4"].ctxMeanMedian).toBeCloseTo(1_167_500, 6);
    expect(s.unattributed.usd).toBeCloseTo(0.01185, 6);
    expect(s.unattributed.ctxFirstMedian).toBe(26_650);
    expect(s.total.sessions).toBe(5);
    expect(s.total.tasks).toBe(4);
    expect(s.total.turns).toBe(7);
    expect(s.total.output).toBe(3_910);
    expect(s.total.usd).toBeCloseTo(4.67985, 6);
    expect(s.total.usdOpus).toBeCloseTo(4.6666, 6);
    expect(s.total.usdPerTaskMedian).toBeCloseTo(0.00655, 6);
    expect(s.total.ctxFirstMedian).toBe(10_000);
    expect(s.total.ctxMeanMedian).toBe(10_000);
  });
});
