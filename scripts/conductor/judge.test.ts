import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, runJudge, type JudgeResult } from "./judge";

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

  it("env-config timeout default change flags fixtures", () => {
    const r = judge("env-config-timeout.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "fixtures")).toMatch(/^FLAG fixtures .*env-config\.ts/);
  });

  it("toStrictEqual to toEqual flags", () => {
    const r = judge("strict-to-equal.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "assertions")).toMatch(/^FLAG assertions .*toStrictEqual.*toEqual/);
  });

  it("removed field in expected object flags", () => {
    const r = judge("removed-field.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "assertions")).toMatch(/^FLAG assertions .*field.*removed/);
  });

  it("logger.info of body flags secrets", () => {
    const r = judge("logger-body.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "secrets")).toMatch(/^FLAG secrets .*x\.ts:2/);
  });

  it("console.error of body flags secrets", () => {
    const r = judge("console-error-body.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "secrets")).toMatch(/^FLAG secrets .*x\.ts:2/);
  });

  it("skip equivalents flag", () => {
    const r = judge("skip-equivalents.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "skips")).toMatch(/^FLAG skips /);
    for (const s of ["xit(", "it.each([1, 2]).skip(", "it.runIf(false)(", "it.fails("])
      expect(r.report).toContain(s);
  });

  it("empty diff flags, never passes", () => {
    const r = judge("empty.diff");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("FLAG diff empty or unparseable diff (0 files)");
    for (const id of [
      "fixtures",
      "assertions",
      "skips",
      "files-block",
      "adapter-independence",
      "canonical-pair",
      "secrets",
      "diff-stat",
      "owner-gate",
    ])
      expect(line(r, id)).toMatch(/^FLAG .* could not run/);
    // a modified diff entry with zero hunks and no mode change is uninspectable
    const nh = judge("no-hunks.diff");
    expect(nh.exitCode).toBe(1);
    expect(line(nh, "secrets")).toMatch(/^FLAG secrets .*could not inspect .*no hunks/);
  });

  it("diff fetch failure flags", () => {
    const r = runJudge(
      {
        pr: "999999",
        version: "v1.5",
        task: "0a",
        plan: PLAN,
        title: "chore(conductor): judge script, waits, usage report",
        reportDir: mkdtempSync(join(tmpdir(), "judge-test-")),
      },
      {
        fetchDiff: () => {
          throw new Error("HTTP 406: diff too large\nresponse body");
        },
      },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("FLAG diff could not fetch PR diff: HTTP 406: diff too large");
    expect(line(r, "fixtures")).toMatch(/^FLAG fixtures could not run/);
    expect(r.stdout).toMatch(/^JUDGE: FLAG \(\d+\)$/m);
  });

  it("missing args exit 2", () => {
    expect(main(["--pr", "1"])).toBe(2); // no --task
    expect(main(["--bogus", "x", "--task", "0a"])).toBe(2); // unknown flag
    expect(main(["--task", "0a", "--diff-file"])).toBe(2); // flag without value
  });

  it("judge.sh and wait-ci.sh argc guards exit 2", () => {
    for (const s of ["judge.sh", "wait-ci.sh"]) {
      const r = spawnSync("bash", [`scripts/conductor/${s}`], { encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage:");
    }
  });

  it("diff stat uses task and fix outputs, not review", () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-claim-"));
    const stat = (files: string[]) =>
      "session output\n\n" + files.map((f) => ` ${f} | 3 +++`).join("\n") + "\n\nPR_URL: x\n";
    writeFileSync(
      join(dir, "task-20260101-000000.out.md"),
      stat(["scripts/conductor/judge.ts", "scripts/conductor/devin.sh"]),
    );
    writeFileSync(join(dir, "fix-20260101-010000.out.md"), stat(["docs/decisions.md"]));
    writeFileSync(
      join(dir, "review-20260101-020000.out.md"),
      stat(["scripts/conductor/wait-ci.sh"]),
    );
    const r = judge("union-stat.diff", { reportDir: dir });
    expect(r.exitCode).toBe(1);
    // wait-ci.sh is claimed only by the review output, which never counts.
    expect(line(r, "diff-stat")).toMatch(
      /^FLAG diff-stat in diff but not claimed by any session: scripts\/conductor\/wait-ci\.sh$/,
    );
  });
});
