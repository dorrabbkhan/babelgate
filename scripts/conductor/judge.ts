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
  checkDiffStat,
  checkFilesBlock,
  checkFixtures,
  checkOwnerGate,
  checkSecrets,
  checkSkips,
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

const truncate = (s: string, n = 180) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const gh = (args: string[]) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });

export function runJudge(opts: JudgeOpts): JudgeResult {
  if (!opts.task || (!opts.pr && !opts.diffFile))
    return { exitCode: 2, stdout: "", report: "usage error: need --task and --pr or --diff-file" };

  const diffText = opts.diffFile
    ? readFileSync(opts.diffFile, "utf8")
    : gh(["pr", "diff", opts.pr!]);

  let title = opts.title ?? "";
  if (opts.pr && !opts.title)
    title = gh(["pr", "view", opts.pr, "--json", "title", "--jq", ".title"]).trim();

  let planText: string | null = null;
  let planPath = opts.plan;
  if (!planPath && opts.version) {
    const dir = "docs/superpowers/plans";
    const hit = readdirSync(dir)
      .filter((f) => f.includes(`babelgate-${opts.version}-plan`))
      .sort()
      .pop();
    if (hit) planPath = join(dir, hit);
  }
  if (planPath && existsSync(planPath)) planText = readFileSync(planPath, "utf8");

  const dir =
    opts.reportDir ??
    join(homedir(), "babelgate-conductor", `${opts.version ?? "dev"}-task${opts.task}`);

  let claimedText: string | null = null;
  let claimedPath = opts.claimed;
  if (!claimedPath && existsSync(dir)) {
    const hit = readdirSync(dir)
      .filter((f) => f.endsWith(".out.md"))
      .sort()
      .pop();
    if (hit) claimedPath = join(dir, hit);
  }
  if (claimedPath && existsSync(claimedPath)) claimedText = readFileSync(claimedPath, "utf8");

  const files = parseDiff(diffText);
  const checks: Check[] = [
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

  const nFlags = checks.filter((c) => c.status === "FLAG").length;
  const lines = checks.map(
    (c) => `${c.status} ${c.id}${c.reasons.length ? " " + truncate(c.reasons.join("; ")) : ""}`,
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

function main(argv: string[]): number {
  const opts = { task: "" } as JudgeOpts & Record<string, string>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || i + 1 >= argv.length) break;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    opts[key] = argv[++i];
  }
  if (!opts.task || (!opts.pr && !opts.diffFile)) {
    process.stderr.write(
      "usage: judge.ts (--pr <PR> | --diff-file <patch>) --task <N> " +
        "[--version <v>] [--plan <plan.md>] [--claimed <out.md>] [--title <t>] [--report-dir <d>]\n",
    );
    return 2;
  }
  const r = runJudge(opts);
  if (r.stdout) process.stdout.write(r.stdout + "\n");
  return r.exitCode;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
