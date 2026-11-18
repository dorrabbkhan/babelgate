import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Offline regression test for record-antigravity-cli.sh (v1.5 Task 14
 * fix round): the script is the conductor's live gate, but its
 * mechanics — scratch HOME with the agy settings file, env pass-through,
 * prompt argv, recorder interposition, JSONL capture — are verifiable
 * without a real `agy` or network. The fake AGY_BIN below asserts the
 * API-key-mode settings file exists in the scratch HOME the script
 * builds, then makes one real streamGenerateContent request so the
 * recorder produces a JSONL line. The "upstream" is a local stub
 * standing in for Ollama — no network, no keys.
 */
const FAKE_AGY = `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "agy-fake/0.0.0"
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_ARGV_FILE"
settings="$HOME/.gemini/antigravity-cli/settings.json"
if ! grep -q '"modelProvider": *"gemini"' "$settings" 2>/dev/null; then
  echo "agy-fake: API-key mode not pinned in $settings" >&2
  exit 1
fi
# One real request so the recorder produces a JSONL line.
curl -sS -m 10 -o /dev/null -X POST \\
  "\${GOOGLE_GEMINI_BASE_URL}/v1beta/models/fake-agy-model:streamGenerateContent?alt=sse" \\
  -H "content-type: application/json" \\
  -H "x-goog-api-key: \${GEMINI_API_KEY}" \\
  -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}' \\
  2>/dev/null || true
exit 0
`;

describe("record-antigravity-cli.sh", () => {
  let stub: Server | undefined;
  afterAll(() => stub?.close());

  it(
    "writes agy settings, passes the prompt and records the request",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rec-agy-"));
      const fakeBin = join(dir, "agy");
      const argvFile = join(dir, "argv.log");
      const outJsonl = join(dir, "out.jsonl");
      writeFileSync(fakeBin, FAKE_AGY);
      chmodSync(fakeBin, 0o755);

      // Minimal Ollama upstream: one done NDJSON line.
      stub = createServer((req, res) => {
        req.resume();
        req.once("end", () => {
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
          });
          res.end(
            JSON.stringify({
              model: "qwen3-coder:30b",
              created_at: "2026-11-18T00:00:00.000Z",
              message: { role: "assistant", content: "hi" },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 1,
              eval_count: 1,
            }) + "\n",
          );
        });
      });
      const port: number = await new Promise((resolve, reject) => {
        stub!.once("error", reject);
        stub!.listen(0, "127.0.0.1", () => {
          resolve((stub!.address() as { port: number }).port);
        });
      });

      // Async spawn: the stub upstream above shares this process's
      // event loop, so a blocking spawnSync would leave its requests
      // unanswered until the script exits.
      const res = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          "bash",
          ["scripts/gates/record-antigravity-cli.sh", "ollama"],
          {
            timeout: 110_000,
            env: {
              ...process.env,
              AGY_BIN: fakeBin,
              FAKE_ARGV_FILE: argvFile,
              OLLAMA_API_BASE_URL: `http://127.0.0.1:${port}`,
              RECORD_OUT: outJsonl,
            },
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => (stdout += c));
        child.stderr.on("data", (c: Buffer) => (stderr += c));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });

      expect(
        res.code,
        `script failed: ${res.code}\n${res.stdout}\n${res.stderr}`,
      ).toBe(0);

      const lines = readFileSync(outJsonl, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const post = lines
        .map(
          (l) =>
            JSON.parse(l) as {
              method: string;
              path: string;
              headerNames: string[];
            },
        )
        .find(
          (l) =>
            l.method === "POST" &&
            l.path.includes("streamGenerateContent"),
        );
      expect(post, `no recorded POST in ${lines.join("\n")}`).toBeDefined();
      expect(post!.headerNames).toContain("x-goog-api-key");

      // The prompt reaches the CLI as the -p positional, --yolo intact.
      const argv = readFileSync(argvFile, "utf8").split("\n");
      const pIdx = argv.indexOf("-p");
      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(argv[pIdx + 1]).toBe(
        "Make the failing test pass. Run npm test to check your work.",
      );
      expect(argv).toContain("--yolo");
    },
    120_000,
  );
});
