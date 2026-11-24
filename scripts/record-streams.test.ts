import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Offline test for RECORD_TWINS_ONLY (v1.6 Task 13b fix round 3): the
 * round-2 conformance replays were recorded with RECORD_TWINS=none,
 * so gemini has committed <case>.sse/.json but no
 * <case>.nonstreaming.json. Twins-only mode must fill in the missing
 * twin without ever calling the stream endpoint and without touching
 * the committed bytes — the default skip would have required
 * RECORD_OVERWRITE, which re-records the stream too.
 *
 * A local 127.0.0.1 stub plays the Gemini API; no external network.
 */
const REPO = join(__dirname, "..");
const SCRIPT = join(REPO, "scripts", "record-streams.ts");
const TWIN_BODY = JSON.stringify({
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ text: "no", thought: false }],
      },
    },
  ],
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

let dir: string | undefined;
let stub: Server | undefined;

afterEach(() => {
  stub?.close();
  stub = undefined;
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("record-streams RECORD_TWINS_ONLY", () => {
  it(
    "records a missing non-streaming twin without touching committed files",
    async () => {
      const hits: string[] = [];
      stub = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(TWIN_BODY);
      });
      const port = await listen(stub);

      dir = mkdtempSync(join(tmpdir(), "record-twins-"));
      const geminiDir = join(dir, "gemini");
      mkdirSync(geminiDir, { recursive: true });
      // The committed round-2 artifacts — bytes must not change.
      const sse = "data: {sse bytes}\n\n";
      const meta = JSON.stringify({ source: "recorded", expectedEvents: [] });
      writeFileSync(join(geminiDir, "thinking.sse"), sse);
      writeFileSync(join(geminiDir, "thinking.json"), meta);

      const result = await new Promise<{
        code: number | null;
        out: string;
      }>((resolvePromise) => {
        const child = spawn(
          process.execPath,
          ["-r", "ts-node/register/transpile-only", SCRIPT],
          {
            cwd: REPO,
            env: {
              ...process.env,
              RECORD_OUT_DIR: dir,
              RECORD_PROVIDERS: "gemini",
              RECORD_CASES: "thinking",
              RECORD_TWINS_ONLY: "1",
              GEMINI_API_KEY: "fake",
              GEMINI_API_BASE_URL: `http://127.0.0.1:${port}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "";
        child.stdout.on("data", (c: Buffer) => (out += c.toString()));
        child.stderr.on("data", (c: Buffer) => (out += c.toString()));
        child.once("close", (code) => resolvePromise({ code, out }));
      });

      expect(result.out).toContain("nonstreaming.json");
      expect(result.code).toBe(0);

      // Committed bytes untouched; the twin carries the recorded body.
      expect(readFileSync(join(geminiDir, "thinking.sse"), "utf8")).toBe(
        sse,
      );
      expect(readFileSync(join(geminiDir, "thinking.json"), "utf8")).toBe(
        meta,
      );
      expect(
        readFileSync(join(geminiDir, "thinking.nonstreaming.json"), "utf8"),
      ).toBe(TWIN_BODY);

      // Only the non-streaming endpoint was called — never the
      // stream endpoint.
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(":generateContent");
      expect(hits[0]).not.toContain(":streamGenerateContent");
    },
    30_000,
  );
});
