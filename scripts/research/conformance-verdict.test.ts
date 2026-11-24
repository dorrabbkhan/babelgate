import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  liveOutcome,
  readSpyLog,
  readVerdict,
  renderOutcome,
  type LiveRunVerdict,
  type SpyExchange,
} from "./conformance-verdict";

/**
 * Offline test for conformance-verdict.ts — the CONFIRMED vs
 * INCONCLUSIVE decision conformance-live.sh prints after a live run
 * (v1.6 spec §3.10, Task 13b fix round 3). The cases replay the
 * outcomes the first live confirmation produced, with recorded
 * spy-log lines and the scenario-verdict files the test writes in
 * live mode:
 *
 *  - CONFIRMED only for a doc-cited rule failure on a clean run —
 *    every spy exchange 2xx, every client turn 2xx, verdict `fail`
 *    under a rule that names a doc;
 *  - a gateway non-2xx turn (the babelgate *->gemini 504 on a slow
 *    Gemini), a vitest timeout (ccr multi-turn-reasoning), an
 *    upstream 429, no upstream call (free-claude-code), a crash
 *    before the verdict, and a non-doc failure are all INCONCLUSIVE.
 */

/** Spy-log exchange, same shape conformance-spy.ts writes. */
const exchange = (upstreamStatus: number): SpyExchange => ({
  method: "POST",
  url: "/v1/chat/completions",
  upstreamStatus,
  response: { hasReasoning: true },
});

const ruleFail = (over: Partial<LiveRunVerdict> = {}): LiveRunVerdict => ({
  gateway: "ccr",
  scenario: "thinking-after-tool:anthropic->openai",
  result: "fail",
  pass: false,
  reason:
    "turn 2 upstream request carries no reasoning field per the " +
    "target's wire rules",
  ruleDoc: "https://openrouter.ai/docs/use-cases/reasoning-tokens",
  clientStatuses: [200, 200],
  ...over,
});

describe("conformance-verdict (v1.6 Task 13b fix round 3)", () => {
  it("CONFIRMED only for a doc-cited rule failure on all-2xx exchanges", () => {
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput:
        "AssertionError: turn 2 upstream request carries no reasoning " +
        "field per the target's wire rules",
      spy: [exchange(200), exchange(200)],
      verdict: ruleFail(),
    });
    expect(outcome.kind).toBe("confirmed");
    const line = renderOutcome(
      "ccr",
      "thinking-after-tool:anthropic->openai",
      outcome,
    );
    expect(line).toContain("CONFIRMED FAILURE (live)");
    expect(line).toContain("openrouter.ai");
  });

  it("INCONCLUSIVE on a gateway non-2xx turn even when upstream is all 2xx", () => {
    // babelgate thinking-after-tool:anthropic->gemini live: Gemini was
    // slow, the gateway returned 504 on turn 2 — the first run printed
    // CONFIRMED here, which was wrong: no doc-cited wire rule broke.
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput: "AssertionError: turn 2 status 504",
      spy: [exchange(200), exchange(200)],
      verdict: ruleFail({
        reason: "turn 2 status 504",
        ruleDoc: "https://docs.anthropic.com/en/api/messages-streaming",
        clientStatuses: [200, 504],
      }),
    });
    expect(outcome.kind).toBe("inconclusive");
    if (outcome.kind === "inconclusive") {
      expect(outcome.cause).toContain("504");
      expect(outcome.cause).toContain("turn 2");
    }
  });

  it("INCONCLUSIVE on a vitest timeout regardless of spy state", () => {
    // ccr multi-turn-reasoning:anthropic->openai live: "Test timed out
    // in 60000ms" — the run never reached a verdict.
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput: " FAIL  Test timed out in 60000ms.",
      spy: [exchange(200)],
      verdict: undefined,
    });
    expect(outcome.kind).toBe("inconclusive");
    if (outcome.kind === "inconclusive") {
      expect(outcome.cause).toContain("timed out");
    }
  });

  it("INCONCLUSIVE on an upstream non-2xx exchange", () => {
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput: "AssertionError: turn 1 status 429",
      spy: [exchange(429)],
      verdict: ruleFail({
        reason: "turn 1 status 429",
        clientStatuses: [429],
      }),
    });
    expect(outcome.kind).toBe("inconclusive");
    if (outcome.kind === "inconclusive") {
      expect(outcome.cause).toContain("non-2xx");
      expect(outcome.cause).toContain("429");
    }
  });

  it("INCONCLUSIVE when the gateway made no upstream call", () => {
    // free-claude-code live: gateway returned 503 on turn 1, the spy
    // log is empty — the same cells reach the mock, so the cause is
    // undiagnosed; it is never a failure.
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput: "AssertionError: turn 1 status 503",
      spy: [],
      verdict: ruleFail({
        reason: "turn 1 status 503",
        clientStatuses: [503],
      }),
    });
    expect(outcome.kind).toBe("inconclusive");
    if (outcome.kind === "inconclusive") {
      expect(outcome.cause).toContain("no upstream call");
      expect(outcome.cause).toContain("503");
    }
  });

  it("INCONCLUSIVE when the test died before the verdict was recorded", () => {
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput: "TypeError: fetch failed",
      spy: [exchange(200)],
      verdict: undefined,
    });
    expect(outcome.kind).toBe("inconclusive");
    if (outcome.kind === "inconclusive") {
      expect(outcome.cause).toContain("verdict");
    }
  });

  it("INCONCLUSIVE when the failing rule cites no provider doc", () => {
    // babelgate asserts on observation rules too — a live failure
    // there is a difference, not a doc-cited failure.
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput: "AssertionError: turn 2 upstream request dropped",
      spy: [exchange(200), exchange(200)],
      verdict: ruleFail({
        gateway: "babelgate",
        result: "fail",
        ruleDoc: undefined,
      }),
    });
    expect(outcome.kind).toBe("inconclusive");
    if (outcome.kind === "inconclusive") {
      expect(outcome.cause).toContain("no provider doc");
    }
  });

  it("PASS only when vitest itself passed", () => {
    const outcome = liveOutcome({
      vitestStatus: 0,
      vitestOutput: "1 passed",
      spy: [exchange(200), exchange(200)],
      verdict: ruleFail({ result: "pass", pass: true }),
    });
    expect(outcome.kind).toBe("pass");
    expect(
      renderOutcome(
        "babelgate",
        "thinking-after-tool:anthropic->openai",
        outcome,
      ),
    ).toContain("PASS (live)");
  });

  it("differs verdict prints DIFFERS, not PASS", () => {
    // Task 13f: a `differs` verdict is an observation — vitest exits
    // 0 on it, so reading the exit code first printed PASS (live) on
    // babelgate-default multi-turn-reasoning:{anthropic,responses}.
    const outcome = liveOutcome({
      vitestStatus: 0,
      vitestOutput: "1 passed",
      spy: [exchange(200), exchange(200)],
      verdict: ruleFail({
        result: "differs",
        reason:
          "turn 2 upstream request dropped the reasoning block",
        ruleDoc: undefined,
      }),
    });
    expect(outcome.kind).toBe("differs");
    const line = renderOutcome(
      "babelgate-default",
      "multi-turn-reasoning:anthropic->openai",
      outcome,
    );
    expect(line).toContain("DIFFERS (observed)");
    expect(line).toContain(
      "turn 2 upstream request dropped the reasoning block",
    );
    expect(line).not.toContain("PASS");
  });

  it("pass verdict still prints PASS", () => {
    const outcome = liveOutcome({
      vitestStatus: 0,
      vitestOutput: "1 passed",
      spy: [exchange(200), exchange(200)],
      verdict: ruleFail({ result: "pass", pass: true }),
    });
    expect(outcome.kind).toBe("pass");
    expect(
      renderOutcome(
        "babelgate",
        "thinking-after-tool:anthropic->openai",
        outcome,
      ),
    ).toBe(
      "conformance-live: babelgate " +
        "thinking-after-tool:anthropic->openai PASS (live)",
    );
  });

  it("a vitest pass with no verdict file still prints PASS", () => {
    const outcome = liveOutcome({
      vitestStatus: 0,
      vitestOutput: "1 passed",
      spy: [exchange(200)],
      verdict: undefined,
    });
    expect(outcome.kind).toBe("pass");
  });

  it("confirmed failure rule unchanged", () => {
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput:
        "AssertionError: turn 2 upstream request carries no " +
        "reasoning field per the target's wire rules",
      spy: [exchange(200), exchange(200)],
      verdict: ruleFail(),
    });
    expect(outcome.kind).toBe("confirmed");
    expect(
      renderOutcome(
        "ccr",
        "thinking-after-tool:anthropic->openai",
        outcome,
      ),
    ).toBe(
      "conformance-live: ccr thinking-after-tool:anthropic->openai " +
        "CONFIRMED FAILURE (live) — turn 2 upstream request carries " +
        "no reasoning field per the target's wire rules " +
        "(rule: https://openrouter.ai/docs/use-cases/reasoning-tokens)",
    );
  });

  it("not supported verdict prints NOT SUPPORTED", () => {
    // FCC's *->gemini cells end without a scenario run — the test
    // records `not supported` in the verdict file; that is not a
    // live PASS.
    const outcome = liveOutcome({
      vitestStatus: 0,
      vitestOutput: "1 passed",
      spy: [],
      verdict: {
        gateway: "free-claude-code",
        scenario: "multi-turn-reasoning:anthropic->gemini",
        result: "not supported",
        pass: true,
        reason:
          "not supported (per https://github.com/Alishahryar1/" +
          "free-claude-code — gemini upstream is a fixed Google " +
          "OpenAI-compatible endpoint)",
      },
    });
    expect(outcome.kind).toBe("notSupported");
    expect(
      renderOutcome(
        "free-claude-code",
        "multi-turn-reasoning:anthropic->gemini",
        outcome,
      ),
    ).toContain("NOT SUPPORTED");
  });

  it("inconclusive verdict prints INCONCLUSIVE with its cause", () => {
    // Task 13f: the spy still had an exchange in flight when the
    // turn's wait timed out — the run cannot be judged, never a
    // failure.
    const outcome = liveOutcome({
      vitestStatus: 0,
      vitestOutput: "1 passed",
      spy: [exchange(200)],
      verdict: {
        gateway: "babelgate-preset",
        scenario: "multi-turn-reasoning:responses->openai",
        result: "inconclusive",
        pass: false,
        reason: "turn 2: spy still had an exchange in flight",
        clientStatuses: [200, 200],
      },
    });
    expect(outcome.kind).toBe("inconclusive");
    if (outcome.kind === "inconclusive") {
      expect(outcome.cause).toContain(
        "spy still had an exchange in flight",
      );
    }
    const line = renderOutcome(
      "babelgate-preset",
      "multi-turn-reasoning:responses->openai",
      outcome,
    );
    expect(line).toContain("INCONCLUSIVE");
    expect(line).toContain("spy still had an exchange in flight");
    expect(line).not.toContain("FAILURE");
  });

  it("a malformed spy-log line can never confirm", () => {
    const outcome = liveOutcome({
      vitestStatus: 1,
      vitestOutput: "AssertionError: rule broke",
      spy: [exchange(200), { error: "malformed spy-log line" }],
      verdict: ruleFail(),
    });
    expect(outcome.kind).toBe("inconclusive");
  });
});

describe("conformance-verdict file reading", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("parses the spy JSONL and reads the verdict only for its own run", () => {
    dir = mkdtempSync(join(tmpdir(), "conformance-verdict-"));
    const spyPath = join(dir, "spy.jsonl");
    writeFileSync(
      spyPath,
      '{"method":"POST","url":"/v1/chat/completions",' +
        '"upstreamStatus":200,"response":{"hasReasoning":true}}\n' +
        "not json\n",
    );
    const entries = readSpyLog(spyPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].upstreamStatus).toBe(200);
    expect(entries[1].error).toBe("malformed spy-log line");
    expect(readSpyLog(join(dir, "absent.jsonl"))).toEqual([]);

    const verdictPath = join(dir, "verdict.json");
    writeFileSync(verdictPath, JSON.stringify(ruleFail()) + "\n");
    expect(
      readVerdict(verdictPath, "ccr", "thinking-after-tool:anthropic->openai")
        ?.result,
    ).toBe("fail");
    // A stale file from a different gateway or scenario is not a verdict.
    expect(
      readVerdict(verdictPath, "babelgate", "thinking-after-tool:anthropic->openai"),
    ).toBeUndefined();
    expect(readVerdict(verdictPath, "ccr", "other-scenario")).toBeUndefined();
    expect(readVerdict(join(dir, "absent.json"), "ccr", "x")).toBeUndefined();
  });
});
