/**
 * judge.ts — the mechanical half of CLAUDE.md "Judgment rules" (spec §3.0.1).
 *
 *   scripts/conductor/judge.sh <PR> <version> <task>
 *   npx ts-node scripts/conductor/judge.ts --pr <PR> --version <v> --task <N>
 *   npx ts-node scripts/conductor/judge.ts --task <N> [--version <v>]
 *       --diff-file <patch> --plan <plan.md> [--claimed out.md] [--title t]
 *       [--report-dir <dir>]
 *
 * Stdout (≤ 60 lines): one `PASS|FLAG|N/A <check-id> <reason> [file:line]`
 * per check, then `JUDGE: PASS` or `JUDGE: FLAG (<n>)`. Full detail goes to
 * <report-dir>/judge-<stamp>.md (default ~/babelgate-conductor/<v>-task<N>).
 * Exit 0 = all pass, 1 = any FLAG, 2 = usage error.
 *
 * A check that cannot run on part of the diff — binary file, rename-only
 * entry, truncated hunk — FLAGs naming the file. Never a silent PASS.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "./diff-parse";
import {
  checkAdapterIndependence,
  checkAssertions,
  checkCanonicalPair,
  checkDiff,
  checkDiffStat,
  checkFilesBlock,
  checkFixtures,
  checkOwnerGate,
  checkSecrets,
  checkSkips,
  CONTENT_CHECK_IDS,
  type Check,
} from "./judge-checks";

export interface JudgeOpts {
  pr?: string;
  version?: string;
  task: string;
  diffFile?: string;
  plan?: string;
  claimed?: string;
  title?: string;
  reportDir?: string;
}

export interface JudgeResult {
  exitCode: number;
  stdout: string;
  report: string;
  reportPath?: string;
}

/** Fetch seams so tests can exercise the failure paths offline. */
export interface JudgeDeps {
  fetchDiff?: (pr: string) => string;
  fetchTitle?: (pr: string) => string;
}

// One stdout line per check: whole reasons only, never cut mid-path. What
// doesn't fit is counted; the report file lists every reason.
const summarize = (reasons: string[], n = 300) => {
  let out = reasons[0].length > n ? reasons[0].slice(0, n - 1) + "…" : reasons[0];
  let i = 1;
  for (; i < reasons.length && out.length + 2 + reasons[i].length <= n; i++) out += "; " + reasons[i];
  return i < reasons.length ? `${out}; (+${reasons.length - i} more in the report)` : out;
};
const firstLine = (e: unknown) =>
  String(e instanceof Error ? e.message : e).split("\n")[0];

const gh = (args: string[]) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });

// `gh pr diff` fails on huge PRs (HTTP 406 "diff too large"): fall back to
// fetching the head oid and diffing locally against the base branch.
function ghPrDiff(pr: string): string {
  try {
    return gh(["pr", "diff", pr]);
  } catch (e) {
    try {
      const meta = JSON.parse(
        gh(["pr", "view", pr, "--json", "baseRefName,headRefOid"]),
      ) as { baseRefName: string; headRefOid: string };
      execFileSync("git", ["fetch", "origin", meta.baseRefName, meta.headRefOid]);
      return execFileSync(
        "git",
        ["diff", `origin/${meta.baseRefName}...${meta.headRefOid}`],
        { encoding: "utf8", maxBuffer: 64 << 20 },
      );
    } catch (e2) {
      throw new Error(`${firstLine(e)}; local-diff fallback failed: ${firstLine(e2)}`);
    }
  }
}

const ghPrTitle = (pr: string) =>
  gh(["pr", "view", pr, "--json", "title", "--jq", ".title"]);

const couldNotRun = (why: string): Check[] =>
  CONTENT_CHECK_IDS.map((id) => ({
    id,
    status: "FLAG" as const,
    reasons: [`could not run: ${why}`],
  }));

export function runJudge(opts: JudgeOpts, deps: JudgeDeps = {}): JudgeResult {
  if (!opts.task || (!opts.pr && !opts.diffFile))
    return { exitCode: 2, stdout: "", report: "usage error: need --task and --pr or --diff-file" };

  let diffText: string | null = null;
  let diffErr: string | null = null;
  if (opts.diffFile) {
    diffText = readFileSync(opts.diffFile, "utf8");
  } else {
    try {
      diffText = (deps.fetchDiff ?? ghPrDiff)(opts.pr!);
    } catch (e) {
      diffErr = firstLine(e);
    }
  }
  const files = diffText === null ? [] : parseDiff(diffText);

  const dir =
    opts.reportDir ??
    join(homedir(), "babelgate-conductor", `${opts.version ?? "dev"}-task${opts.task}`);

  let checks: Check[];
  if (diffErr !== null) {
    checks = [
      { id: "diff", status: "FLAG", reasons: [`could not fetch PR diff: ${diffErr}`] },
      ...couldNotRun("could not fetch PR diff"),
    ];
  } else if (files.length === 0) {
    checks = [checkDiff(files), ...couldNotRun("empty or unparseable diff")];
  } else {
    let title = opts.title ?? "";
    let titleErr = false;
    if (opts.pr && !opts.title)
      try {
        title = (deps.fetchTitle ?? ghPrTitle)(opts.pr).trim();
      } catch {
        titleErr = true;
      }

    let planText: string | null = null;
    let planPath = opts.plan;
    if (!planPath && opts.version) {
      const planDir = "docs/superpowers/plans";
      const hit = readdirSync(planDir)
        .filter((f) => f.includes(`babelgate-${opts.version}-plan`))
        .sort()
        .pop();
      if (hit) planPath = join(planDir, hit);
    }
    if (planPath && existsSync(planPath)) planText = readFileSync(planPath, "utf8");

    // The claimed stat is the union of every task-*/fix-* session output in
    // the report dir — never review-* and never just the alphabetically last.
    let claimedText: string | null = null;
    let claimedPath = opts.claimed;
    if (!claimedPath && existsSync(dir)) {
      const outs = readdirSync(dir)
        .filter((f) => /^(task|fix)-.*\.out\.md$/.test(f))
        .sort();
      if (outs.length)
        claimedText = outs.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    }
    if (claimedPath && existsSync(claimedPath)) claimedText = readFileSync(claimedPath, "utf8");

    checks = [
      checkDiff(files),
      checkFixtures(files),
      checkAssertions(files),
      checkSkips(files),
      checkFilesBlock(files, planText, opts.task),
      checkAdapterIndependence(files),
      checkCanonicalPair(files, planText, opts.task),
      checkSecrets(files),
      checkDiffStat(files, claimedText),
      checkOwnerGate(files, title),
    ];
    if (titleErr) {
      const og = checks.find((c) => c.id === "owner-gate")!;
      og.status = "FLAG";
      og.reasons.unshift("could not read title");
    }
  }

  const nFlags = checks.filter((c) => c.status === "FLAG").length;
  const lines = checks.map(
    (c) => `${c.status} ${c.id}${c.reasons.length ? " " + summarize(c.reasons) : ""}`,
  );
  lines.push(nFlags ? `JUDGE: FLAG (${nFlags})` : "JUDGE: PASS");
  const stdout = lines.slice(0, 60).join("\n");

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+$/, "");
  const report = [
    `# judge — ${opts.pr ? `PR #${opts.pr}` : (opts.diffFile ?? "diff")} task ${opts.task} ${stamp}`,
    "",
    `files: ${files.length} · ${files.map((f) => f.path).join(", ")}`,
    "",
    ...checks.flatMap((c) => [
      `## ${c.status} ${c.id}`,
      ...(c.reasons.length ? c.reasons.map((r) => `- ${r}`) : ["- (no detail)"]),
      "",
    ]),
    nFlags ? `JUDGE: FLAG (${nFlags})` : "JUDGE: PASS",
  ].join("\n");

  let reportPath: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    reportPath = join(dir, `judge-${stamp}.md`);
    writeFileSync(reportPath, report);
  } catch (e) {
    process.stderr.write(`judge: could not write report to ${dir}: ${e}\n`);
  }

  return { exitCode: nFlags ? 1 : 0, stdout, report, reportPath };
}

const KNOWN_OPTS = new Set([
  "pr",
  "version",
  "task",
  "diffFile",
  "plan",
  "claimed",
  "title",
  "reportDir",
]);
const USAGE =
  "usage: judge.ts (--pr <PR> | --diff-file <patch>) --task <N> " +
  "[--version <v>] [--plan <plan.md>] [--claimed <out.md>] [--title <t>] [--report-dir <d>]\n";

export function main(argv: string[]): number {
  const opts = { task: "" } as JudgeOpts & Record<string, string>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.startsWith("--")
      ? a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      : "";
    if (!KNOWN_OPTS.has(key) || i + 1 >= argv.length) {
      process.stderr.write(USAGE);
      return 2;
    }
    opts[key] = argv[++i];
  }
  if (!opts.task || (!opts.pr && !opts.diffFile)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const r = runJudge(opts);
  if (r.stdout) process.stdout.write(r.stdout + "\n");
  return r.exitCode;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
