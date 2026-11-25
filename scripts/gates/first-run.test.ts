import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatPresetList } from "../../src/cli-presets";
import { PROVIDER_PRESETS } from "../../src/config/provider-presets";

/**
 * Offline coverage for first-run.sh (v1.6 Task 17, spec §4 gate F):
 * the --dry-run plan print for both clients, the docker re-exec
 * command it would run, argument validation, and the privacy rule —
 * a sentinel key value must never appear in output. The host-mode
 * block runs the script itself against stub `claude`/`babelgate`
 * binaries to cover the missing-key path and the shared-clock
 * setup_seconds. Real install / babelgate / client runs are the
 * conductor's live steps.
 */

const SCRIPT = "scripts/gates/first-run.sh";
const SENTINEL = "first-run-test-sentinel-value-9f4c";

function firstRun(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; out: string } {
  const res = spawnSync("bash", [SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      // A sentinel stands in for a provider key: the script may name
      // the variable but must never echo a value.
      OPENROUTER_API_KEY: SENTINEL,
      HOME: process.env.HOME,
      ...env,
    },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("first-run.sh --dry-run", () => {
  it("prints the claude-code plan and exits 0", () => {
    const r = firstRun([
      "--dry-run",
      "npm install -g babelgate",
      "openrouter-free",
      "claude-code",
    ]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("FIRST_RUN_DRY_RUN");
    expect(r.out).toContain("npm install -g babelgate");
    expect(r.out).toContain("--preset claude-code --provider openrouter-free");
    expect(r.out).toContain("claude -p");
    expect(r.out).toContain("npm test");
    expect(r.out).toContain(
      "FIRST_RUN setup_seconds=<n> client=claude-code preset=openrouter-free result=<PASS|FAIL>",
    );
    expect(r.out).not.toContain(SENTINEL);
  });

  it("prints the codex plan and exits 0", () => {
    const r = firstRun([
      "--dry-run",
      "sh install/install.sh",
      "gemini-free",
      "codex",
    ]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("config.toml");
    expect(r.out).toContain("--preset codex --provider gemini-free");
    expect(r.out).toContain("codex exec --skip-git-repo-check");
    expect(r.out).not.toContain(SENTINEL);
  });

  it("FIRST_RUN_DRY_RUN=1 enables dry-run without the flag", () => {
    const r = firstRun(
      ["npm i -g .", "deepseek", "codex"],
      { FIRST_RUN_DRY_RUN: "1" },
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("FIRST_RUN_DRY_RUN");
  });

  it("--docker prints the container re-exec, keys by name only", () => {
    const r = firstRun([
      "--dry-run",
      "--docker",
      "npm i -g babelgate",
      "openrouter-free",
      "codex",
    ]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("docker run --rm");
    expect(r.out).toContain("node:24");
    expect(r.out).toContain("@openai/codex");
    // The key is forwarded by name; its value never appears.
    expect(r.out).toContain("-e OPENROUTER_API_KEY");
    expect(r.out).not.toContain(SENTINEL);
    expect(r.out).not.toContain("-e OPENROUTER_API_KEY=");
  });
});

describe("first-run.sh argument validation", () => {
  it("missing arguments exit 2 with usage", () => {
    const r = firstRun([]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("usage:");
  });

  it("unknown client exits 2", () => {
    const r = firstRun(["npm i -g babelgate", "openrouter-free", "emacs"]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("usage:");
  });

  it("extra positional exits 2", () => {
    const r = firstRun(["i", "p", "codex", "extra"]);
    expect(r.status).toBe(2);
  });

  it("unknown flag exits 2", () => {
    const r = firstRun(["--bogus", "i", "p", "codex"]);
    expect(r.status).toBe(2);
  });
});

describe("first-run.sh shell hygiene", () => {
  it("parses cleanly under bash -n", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  // shellcheck when the environment provides it (CI/conductor);
  // conditional inclusion, not a skip API.
  const shellcheck = spawnSync("bash", ["-c", "command -v shellcheck"], {
    encoding: "utf8",
  });
  if (shellcheck.status === 0) {
    it("is shellcheck-clean", () => {
      const r = spawnSync("shellcheck", [SCRIPT], { encoding: "utf8" });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    });
  }
});

/**
 * Host-mode coverage of the preset key check (fix round 1): a temp
 * bin dir holds a stub `claude` (exits 0 — only `command -v` needs
 * it) and a stub `babelgate` whose `presets` prints the real
 * formatPresetList rows — the shipped line shape, not a hand-typed
 * copy — so the `key env NAME` extraction is exercised both on a
 * row with suggested models (openrouter-free) and on one with
 * `suggested -` (groq). The child env carries no *_API_KEY vars,
 * so the check fails before any proxy start; the `sleep 2` install
 * step proves setup_seconds reads a clock shared across processes
 * (hrtime.bigint), where per-process performance.now() always
 * reported 0.
 */
const stubBin = (() => {
  const dir = mkdtempSync(join(tmpdir(), "first-run-bin-"));
  writeFileSync(join(dir, "claude"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(
    join(dir, "babelgate"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "presets" ]; then
cat <<'BABELGATE_PRESETS'
${formatPresetList(PROVIDER_PRESETS).join("\n")}
BABELGATE_PRESETS
fi
exit 0
`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  chmodSync(join(dir, "babelgate"), 0o755);
  return dir;
})();

function firstRunHost(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync("bash", [SCRIPT, ...args], {
    env: {
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME,
      // The child env is exactly this object, so the preset's key
      // env var is unset by construction — never a stub value.
    },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("first-run.sh host-mode preset key check", () => {
  it("missing OPENROUTER_API_KEY fails before the proxy start, timed on the shared clock", () => {
    const r = firstRunHost(["sleep 2", "openrouter-free", "claude-code"]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stderr).toContain(
      "FIRST_RUN FAIL: OPENROUTER_API_KEY is not set (preset openrouter-free reads its key from it)",
    );
    const lines = r.stdout.trim().split("\n");
    expect(lines[lines.length - 1]).toMatch(
      /^FIRST_RUN setup_seconds=(2|3) client=claude-code preset=openrouter-free result=FAIL$/,
    );
  }, 20_000);

  it("groq (a 'suggested -' row) reads GROQ_API_KEY the same way", () => {
    const r = firstRunHost(["sleep 2", "groq", "claude-code"]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stderr).toContain(
      "FIRST_RUN FAIL: GROQ_API_KEY is not set (preset groq reads its key from it)",
    );
    const lines = r.stdout.trim().split("\n");
    expect(lines[lines.length - 1]).toMatch(
      /^FIRST_RUN setup_seconds=(2|3) client=claude-code preset=groq result=FAIL$/,
    );
  }, 20_000);
});
