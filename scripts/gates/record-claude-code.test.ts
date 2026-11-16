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
 * Offline regression test for record-claude-code.sh (v1.5 Task 1 fix
 * round): `--allowedTools` is variadic (`<tools...>`) and the real CLI
 * reads a trailing positional after it as another tool name, exiting
 * "Input must be provided either through stdin or as a prompt argument"
 * — the first real run recorded only the HEAD /api/hello probes. The
 * fake CLAUDE_BIN below mimics that parse: it fails when no prompt
 * positional survives, so a swallowed prompt fails `npm test`, not just
 * a live run. Runs the `media` mode end-to-end (recorder + generated
 * PDF/PNG) against a local stub upstream — no network.
 */

const FAKE_CLAUDE = `#!/usr/bin/env bash
# Fake claude: -p is a boolean flag and the prompt is the positional
# argument; --allowedTools <tools...> is variadic and consumes every
# non-flag argument after it (commander.js semantics — the parse the
# real CLI applies).
if [ "\${1:-}" = "--version" ]; then
  echo "claude-fake/0.0.0"
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_ARGV_FILE"
positionals=()
while [ $# -gt 0 ]; do
  case "$1" in
    --allowedTools)
      shift
      while [ $# -gt 0 ] && [ "\${1#-}" = "$1" ]; do shift; done
      ;;
    --permission-prompts|--setting-sources)
      shift
      [ $# -gt 0 ] && shift
      ;;
    -*)
      shift
      ;;
    *)
      positionals+=("$1")
      shift
      ;;
  esac
done
if [ "\${#positionals[@]}" -eq 0 ]; then
  echo "Error: Input must be provided either through stdin or as a prompt argument when using --print" >&2
  exit 1
fi
# One real request so the recorder produces a JSONL line.
curl -sS -m 10 -o /dev/null -X POST "\${ANTHROPIC_BASE_URL}/v1/messages" \\
  -H "content-type: application/json" \\
  -d '{"model":"fake","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' \\
  2>/dev/null || true
exit 0
`;

describe("record-claude-code.sh argv contract", () => {
  let stub: Server | undefined;
  afterAll(() => stub?.close());

  it(
    "passes the prompt as a positional --allowedTools cannot swallow",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rec-claude-"));
      const fakeBin = join(dir, "claude");
      const argvFile = join(dir, "argv.log");
      const outJsonl = join(dir, "out.jsonl");
      writeFileSync(fakeBin, FAKE_CLAUDE);
      chmodSync(fakeBin, 0o755);

      stub = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
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
          [
            "scripts/gates/record-claude-code.sh",
            "media",
            "--upstream",
            `http://127.0.0.1:${port}`,
          ],
          {
            timeout: 85_000,
            env: {
              ...process.env,
              CLAUDE_BIN: fakeBin,
              FAKE_ARGV_FILE: argvFile,
              OPENROUTER_API_KEY: "dummy",
              RECORD_OUT: outJsonl,
              CLAUDE_TIMEOUT_S: "60",
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
        .map((l) => JSON.parse(l) as { method: string; path: string; status: number })
        .find((l) => l.method === "POST" && l.path === "/v1/messages");
      expect(post?.status).toBe(200);

      const argv = readFileSync(argvFile, "utf8").split("\n");
      const promptIdx = argv.findIndex((a) =>
        a.startsWith("Read the image at "),
      );
      const toolsIdx = argv.indexOf("--allowedTools");
      expect(promptIdx).toBeGreaterThanOrEqual(0);
      expect(promptIdx).toBeLessThan(toolsIdx);
    },
    90_000,
  );
});
