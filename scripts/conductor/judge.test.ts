import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** Seeded diff held in a temp file so the bad lines never sit in fixtures. */
function judgeText(diff: string): JudgeResult {
  const dir = mkdtempSync(join(tmpdir(), "judge-seed-"));
  const diffFile = join(dir, "seed.diff");
  writeFileSync(diffFile, diff);
  return runJudge({
    version: "v1.5",
    task: "0a",
    diffFile,
    plan: PLAN,
    title: "chore(conductor): judge script, waits, usage report",
    reportDir: dir,
  });
}

const seed = (path: string, added: string[]) => `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,2 +1,${2 + added.length} @@
 const a = 1;
${added.map((l) => "+" + l).join("\n")}
 const b = 2;
`;

// Stub gh: counts "--json name --jq length" calls in $GH_STUB_COUNT and
// answers from the $GH_STUB_ANSWERS comma list (repeating the last); any
// other call (the --watch, the final table) succeeds.
const GH_STUB = `#!/usr/bin/env bash
if [[ " \$* " == *" --json name "* && " \$* " == *" --jq length"* ]]; then
  n=\$(cat "\$GH_STUB_COUNT" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "\$GH_STUB_COUNT"
  IFS=, read -ra a <<< "\$GH_STUB_ANSWERS"
  i=\$((n-1)); [ "\$i" -ge "\${#a[@]}" ] && i=\$((\${#a[@]}-1))
  echo "\${a[\$i]}"
  exit 0
fi
echo "checks table"
exit 0
`;

// Stub gh as 2.46 behaves: every `pr checks --json` fails with
// "unknown flag: --json"; `pr view --json statusCheckRollup` still answers;
// `--watch` exits 1 (a red CI); a bare `pr checks` prints one fail row and
// one pass row; `run view` prints a 50-line log. All calls are recorded to
// $GH_STUB_CALLS.
const GH_STUB_FAILING = `#!/usr/bin/env bash
echo "\$*" >> "\$GH_STUB_CALLS"
if [[ " \$* " == *" statusCheckRollup "* ]]; then
  echo 2
  exit 0
fi
if [[ " \$* " == *" --json "* ]]; then
  echo "unknown flag: --json" >&2
  exit 1
fi
if [[ " \$* " == *" --watch "* ]]; then
  exit 1
fi
if [[ " \$1 \$2 " == " pr checks " ]]; then
  printf 'lint\\tfail\\t12s\\thttps://github.com/o/r/actions/runs/1/job/111\\n'
  printf 'check\\tpass\\t1m31s\\thttps://github.com/o/r/actions/runs/2/job/222\\n'
  exit 0
fi
if [[ " \$1 \$2 " == " run view " ]]; then
  seq 1 50
  exit 0
fi
exit 0
`;

function runWaitCi(env: Record<string, string>, stub = GH_STUB) {
  const dir = mkdtempSync(join(tmpdir(), "wait-ci-"));
  writeFileSync(join(dir, "gh"), stub, { mode: 0o755 });
  return {
    dir,
    r: spawnSync("bash", ["scripts/conductor/wait-ci.sh", "123"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_STUB_COUNT: join(dir, "count"),
        GH_STUB_CALLS: join(dir, "calls"),
        ...env,
      },
    }),
  };
}

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

  it("extra file named in decisions by unique basename passes", () => {
    const r = judge("extra-file-basename.diff");
    expect(line(r, "files-block")).toMatch(/^PASS files-block extra files named in decisions\.md$/);
  });

  it("basename shared by two diff files does not count as named", () => {
    const r = judge("extra-file-basename-ambiguous.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "files-block")).toMatch(/^FLAG files-block .*src\/a\/same\.ts.*src\/b\/same\.ts/);
  });

  it("basename inside another path or longer name does not count as named", () => {
    const r = judge("extra-file-basename-other-path.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "files-block")).toMatch(/^FLAG files-block .*src\/x\/one\.adapter\.ts outside Files block/);
  });

  it("adapter importing another flags", () => {
    const r = judge("adapter-import.diff");
    expect(r.exitCode).toBe(1);
    expect(line(r, "adapter-independence")).toMatch(/^FLAG adapter-independence .*anthropic\.adapter/);
  });

  it("baseURL branching flags", () => {
    // the name is built at runtime so this file's own added lines never
    // carry the literal the host check looks for.
    const r = judgeText(
      seed("scripts/conductor/judge.ts", [
        `if (cfg.base${"URL"} === "https://api.example.com") {`,
      ]),
    );
    expect(r.exitCode).toBe(1);
    expect(line(r, "adapter-independence")).toMatch(
      /^FLAG adapter-independence .*host\/url branching.*baseURL/,
    );
  });

  it("provider pair branch flags", () => {
    const r = judgeText(
      seed("scripts/conductor/judge.ts", [
        'if (source === "anthropic" && target === "gemini") {',
      ]),
    );
    expect(r.exitCode).toBe(1);
    expect(line(r, "adapter-independence")).toMatch(
      /^FLAG adapter-independence .*provider-pair branch/,
    );
  });

  it("single provider comparison passes", () => {
    const r = judgeText(
      seed("scripts/conductor/judge.ts", [
        'if (entry.type !== "openai" && entry.type !== "ollama") {',
        '  return source === "responses" && entry.type === "responses";',
        '}',
        'if (entry.type === "ollama") {',
      ]),
    );
    expect(r.stdout).toMatch(/^PASS adapter-independence$/m);
    expect(r.exitCode).toBe(0);
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

  it("wait-ci waits for checks to appear", () => {
    const { dir, r } = runWaitCi({
      WAIT_CI_POLL_S: "0",
      GH_STUB_ANSWERS: "0,0,2",
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "count"), "utf8").trim()).toBe("3");
  });

  it("wait-ci times out with no checks", () => {
    const { r } = runWaitCi({
      WAIT_CI_POLL_S: "0",
      WAIT_CI_MAX_S: "0",
      GH_STUB_ANSWERS: "0",
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("wait-ci: no checks registered after");
  });

  it("wait-ci prints failing jobs from plain gh output", () => {
    const { dir, r } = runWaitCi({ WAIT_CI_POLL_S: "0" }, GH_STUB_FAILING);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/--- failing checks:\nlint\n/);
    // the job-111 block is the last output: the header plus exactly lines
    // 11–50 of the 50-line stub log (tail -40).
    const tail40 = Array.from({ length: 40 }, (_, i) => `${i + 11}`).join("\n");
    expect(r.stdout).toContain("--- job 111: last 40 failed-log lines\n" + tail40 + "\n");
    const calls = readFileSync(join(dir, "calls"), "utf8");
    expect(calls).toContain("run view --job 111 --log-failed");
    expect(calls).not.toContain("--job 222");
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
