import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Offline test for client-replay-artifacts.sh (v1.5 replay-diagnostics
 * follow-up): the helper stages the run's artifacts into the workflow's
 * upload dir and prints a bounded tail of every FAIL sub-run's log, and
 * must never stage or print the API key. Drives the script with a
 * scratch work dir — no network, no real clients, a fake key.
 */

const SCRIPT = "scripts/gates/client-replay-artifacts.sh";

interface Dirs {
  work: string;
  summary: string;
  artifacts: string;
}

function setup(): Dirs {
  const root = mkdtempSync(join(tmpdir(), "replay-artifacts-"));
  const work = join(root, "work");
  const artifacts = join(root, "artifacts");
  const summary = join(root, "summary.md");
  mkdirSync(work, { recursive: true });
  writeFileSync(summary, "## Weekly client-release replay\n");
  return { work, summary, artifacts };
}

function run(
  dirs: Dirs,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      REPLAY_WORK_DIR: dirs.work,
      REPLAY_SUMMARY: dirs.summary,
      ARTIFACT_DIR: dirs.artifacts,
      OPENROUTER_API_KEY: "",
      CLAUDE_GATE: "PASS",
      CODEX_GATE: "PASS",
      CLAUDE_RECORD: "PASS",
      CODEX_RECORD: "PASS",
      ...env,
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("client-replay-artifacts.sh", () => {
  it("stages the artifacts and tails only the FAIL sub-run logs", () => {
    const dirs = setup();
    const long = `${Array.from({ length: 60 }, (_, i) => `log line ${i + 1}`).join("\n")}\n`;
    writeFileSync(join(dirs.work, "claude-gate.log"), long);
    writeFileSync(join(dirs.work, "codex-gate.log"), "codex gate ok\n");
    writeFileSync(join(dirs.work, "claude-record.log"), "record boom\n");
    writeFileSync(join(dirs.work, "codex-record.log"), "codex record ok\n");
    writeFileSync(join(dirs.work, "claude.jsonl"), '{"a":1}\n');
    writeFileSync(join(dirs.work, "codex.jsonl"), '{"b":2}\n');

    const res = run(dirs, { CLAUDE_GATE: "FAIL", CLAUDE_RECORD: "FAIL" });
    expect(res.status, res.stderr).toBe(0);

    for (const f of [
      "claude.jsonl",
      "codex.jsonl",
      "claude-gate.log",
      "codex-gate.log",
      "claude-record.log",
      "codex-record.log",
      "summary.md",
    ]) {
      expect(existsSync(join(dirs.artifacts, f)), f).toBe(true);
    }

    // FAIL sub-runs get group markers; only the last 40 lines print.
    expect(res.stdout).toContain("::group::claude gate log (tail)");
    expect(res.stdout).toContain("log line 60");
    expect(res.stdout).toContain("log line 21");
    expect(res.stdout).not.toContain("log line 20");
    expect(res.stdout).toContain("::group::claude record log (tail)");
    expect(res.stdout).toContain("record boom");
    // PASS sub-runs print nothing.
    expect(res.stdout).not.toContain("codex gate log (tail)");
    expect(res.stdout).not.toContain("codex record log (tail)");
    expect(res.stdout.match(/::endgroup::/g)).toHaveLength(2);
  });

  it("drops staged files and withholds tails containing the key", () => {
    const dirs = setup();
    const key = "sk-or-fake-test-key-0001";
    writeFileSync(
      join(dirs.work, "claude-gate.log"),
      `upstream error: ${key} rejected\ntail line\n`,
    );
    writeFileSync(join(dirs.work, "claude.jsonl"), `{"auth":"${key}"}\n`);
    writeFileSync(join(dirs.work, "codex.jsonl"), '{"b":2}\n');

    const res = run(dirs, {
      OPENROUTER_API_KEY: key,
      CLAUDE_GATE: "FAIL",
    });

    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(dirs.artifacts, "claude.jsonl"))).toBe(false);
    expect(existsSync(join(dirs.artifacts, "claude-gate.log"))).toBe(false);
    expect(existsSync(join(dirs.artifacts, "codex.jsonl"))).toBe(true);
    expect(res.stderr).toContain("OPENROUTER_API_KEY");
    expect(res.stdout).toContain("::group::claude gate log (tail)");
    expect(res.stdout).toContain("(tail withheld");
    // The key value is never printed.
    expect(res.stdout).not.toContain(key);
    expect(res.stderr).not.toContain(key);
  });

  it("tolerates missing logs and JSONLs", () => {
    const dirs = setup();
    const res = run(dirs, { CODEX_RECORD: "FAIL" });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("::group::codex record log (tail)");
    expect(res.stdout).toContain("(no log at");
    expect(existsSync(join(dirs.artifacts, "summary.md"))).toBe(true);
  });
});
