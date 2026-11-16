import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJudge, type JudgeResult } from "./judge";

/**
 * judge.ts — the mechanical half of CLAUDE.md "Judgment rules" (spec §3.0.1).
 * One seeded diff per case under fixtures/judge/; --diff-file/--plan/--claimed
 * run fully offline (no gh calls).
 */
const PLAN = "docs/superpowers/plans/2026-11-16-babelgate-v1.5-plan.md";
const FIX = join(__dirname, "fixtures", "judge");

function judge(diff: string, extra: Partial<Parameters<typeof runJudge>[0]> = {}): JudgeResult {
  return runJudge({
    version: "v1.5",
    task: "0a",
    diffFile: join(FIX, diff),
    plan: PLAN,
    title: "chore(conductor): judge script, waits, usage report",
    reportDir: mkdtempSync(join(tmpdir(), "judge-test-")),
    ...extra,
  });
}

const line = (r: JudgeResult, id: string) =>
  r.stdout.split("\n").find((l) => l.includes(` ${id} `));

describe("judge.ts (spec §3.0.1)", () => {
  it("fixture change flags", () => {
    const r = judge("fixture-change.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "fixtures")).toMatch(/^FLAG fixtures .*chat\.request\.json/);
  });

  it("removed expect flags", () => {
    const r = judge("removed-expect.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "assertions")).toMatch(/^FLAG assertions .*expect/);
  });

  it("exact matcher weakened flags", () => {
    const r = judge("weakened-matcher.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "assertions")).toMatch(/^FLAG assertions .*toMatchObject/);
  });

  it("added .only flags", () => {
    const r = judge("added-only.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "skips")).toMatch(/^FLAG skips .*only/);
  });

  it("file outside Files block without decisions entry flags", () => {
    const r = judge("extra-file.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "files-block")).toMatch(/^FLAG files-block .*src\/extra\.ts/);
  });

  it("file outside Files block with decisions entry passes", () => {
    const r = judge("extra-file-decisions.diff");
    expect(line(r, "files-block")).toMatch(/^PASS files-block/);
  });

  it("adapter importing another flags", () => {
    const r = judge("adapter-import.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "adapter-independence")).toMatch(/^FLAG adapter-independence .*anthropic\.adapter/);
  });

  it("canonical types without schema flags", () => {
    const r = judge("canonical-pair.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "canonical-pair")).toMatch(/^FLAG canonical-pair .*canonical\.schema\.ts/);
  });

  it("api key literal flags", () => {
    const r = judge("api-key.diff");
    expect(r.exitCode).toBe(1);
    // the flag names file:line but never echoes the key itself
    expect(line(r, "secrets")).toMatch(/^FLAG secrets .*key\/token.*judge\.ts:2/);
    expect(line(r, "secrets")).not.toContain("sk-ant");
  });

  it("diff stat mismatch with claimed files flags", () => {
    const r = judge("clean.diff", { claimed: join(FIX, "claimed-mismatch.out.md") });
    expect(r.exitCode).toBe(1);
    expect(line(r, "diff-stat")).toMatch(/^FLAG diff-stat .*other\.ts/);
  });

  it("[OWNER GATE] title or workflow file flags owner-gate", () => {
    const byTitle = judge("clean.diff", {
      claimed: join(FIX, "claimed-clean.out.md"),
      title: "[OWNER GATE] chore(conductor): x",
    });
    expect(line(byTitle, "owner-gate")).toMatch(/^FLAG owner-gate/);
    const byFile = judge("owner-gate.diff");
    expect(line(byFile, "owner-gate")).toMatch(/^FLAG owner-gate .*workflows\/pr\.yml/);
    expect(byFile.exitCode).toBe(1);
  });

  it("clean task diff passes all", () => {
    const r = judge("clean.diff", { claimed: join(FIX, "claimed-clean.out.md") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("JUDGE: PASS");
    expect(r.stdout.split("\n").filter(Boolean).length).toBeLessThanOrEqual(60);
  });

  it("unparseable diff flags, never passes", () => {
    const r = judge("unparseable.diff");
    expect(r.exitCode).toBe(1);
    // binary + rename-only + truncated hunk: every check that could not run
    // must say so — never a silent PASS.
    expect(line(r, "secrets")).toMatch(/^FLAG secrets .*could not inspect/);
    expect(line(r, "assertions")).toMatch(/^FLAG assertions .*could not inspect .*new\.test\.ts/);
    expect(line(r, "adapter-independence")).toMatch(/^FLAG adapter-independence .*could not inspect/);
    expect(r.stdout).toMatch(/^JUDGE: FLAG \(\d+\)$/m);
  });
});
