import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Offline test for scripts/research/conformance-spy.ts — the forward
 * proxy scripts/research/conformance-live.sh puts between a gateway
 * and the live provider (v1.6 spec §3.10, Task 13b fix round 3).
 * Covers the defects the first live confirmation found:
 *
 *  - the spy logged the URL with the `key=` query value in clear when
 *    the key travels as a query parameter (CCR's Gemini calls);
 *  - the spy dropped the target's base path (OpenRouter's `/api`),
 *    so every forwarded call 404'd;
 *  - the verdict needs to know whether the upstream response carried
 *    reasoning — the spy logs a shape-only summary, never the text.
 *
 * A local 127.0.0.1 stub plays the target; no external network. The
 * "real" key is a fake string — the test asserts it never reaches the
 * JSONL log in clear while the target does receive it.
 */
const REPO = join(__dirname, "..", "..");
const SPY_TS = join(REPO, "scripts", "research", "conformance-spy.ts");
const REAL_KEY = "SPYSECRET-REALKEY-9f8e7d6c5b4a";
const FAKE_KEY = "AIzaFAKE123";

interface TargetRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface RunningTarget {
  port: number;
  requests: TargetRequest[];
  /** Set per test — what the stub replies. */
  reply: { status: number; headers: Record<string, string>; body: string };
  close(): void;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

async function startTarget(): Promise<RunningTarget> {
  const requests: TargetRequest[] = [];
  const running: RunningTarget = {
    port: 0,
    requests,
    reply: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    close: () => {},
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(running.reply.status, running.reply.headers);
      res.end(running.reply.body);
    });
  });
  running.port = await listen(server);
  running.close = () => server.close();
  return running;
}

let spy: ChildProcess | undefined;
let target: RunningTarget | undefined;
let dir: string | undefined;

afterEach(async () => {
  spy?.kill("SIGKILL");
  spy = undefined;
  target?.close();
  target = undefined;
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

interface RunningSpy {
  port: number;
  logPath: string;
}

/**
 * Spawn the spy exactly as conformance-live.sh does — same env
 * contract, same interpreter — and wait for its health endpoint.
 */
async function startSpy(opts: {
  target: string;
  keyHeader: string;
}): Promise<RunningSpy> {
  dir = mkdtempSync(join(tmpdir(), "conformance-spy-"));
  const logPath = join(dir, "spy.jsonl");
  const child = spawn(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", SPY_TS],
    {
      cwd: REPO,
      env: {
        ...process.env,
        SPY_TARGET: opts.target,
        SPY_KEY: REAL_KEY,
        SPY_KEY_HEADER: opts.keyHeader,
        SPY_LOG: logPath,
        SPY_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  spy = child;
  // The spy prints the bound port on stdout once listening.
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`spy did not start; stdout: ${out}`)),
      15_000,
    );
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      const m = out.match(/listening (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`spy exited ${code}; stdout: ${out}`));
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { port, logPath };
}

function spyLog(logPath: string): Record<string, unknown>[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("conformance-live spy (v1.6 Task 13b fix round 3)", () => {
  it(
    "logs key= query values as <redacted> but forwards the injected key",
    async () => {
      target = await startTarget();
      const running = await startSpy({
        target: `http://127.0.0.1:${target.port}/api`,
        keyHeader: "x-goog-api-key",
      });
      const res = await fetch(
        `http://127.0.0.1:${running.port}/v1beta/models/mock-gem:generateContent?key=${FAKE_KEY}`,
        { method: "POST", body: "{}" },
      );
      expect(res.status).toBe(200);

      // The forwarded request carried the injected key in place of
      // the fake one — CCR's `?key=` form.
      const fwd = target.requests[0];
      expect(fwd).toBeDefined();
      expect(fwd.url).toContain(`key=${REAL_KEY}`);
      expect(fwd.url).not.toContain(FAKE_KEY);
      expect(fwd.headers["x-goog-api-key"]).toBe(REAL_KEY);

      const logText = readFileSync(running.logPath, "utf8");
      expect(logText).toContain("<redacted>");
      expect(logText).not.toContain(FAKE_KEY);
      expect(logText).not.toContain(REAL_KEY);
      const rec = spyLog(running.logPath)[0];
      expect(rec.url).toContain("key=<redacted>");
      expect(rec.upstreamPath).toContain("key=<redacted>");
    },
    30_000,
  );

  it(
    "forwards under the target's base path",
    async () => {
      target = await startTarget();
      const running = await startSpy({
        target: `http://127.0.0.1:${target.port}/api`,
        keyHeader: "authorization",
      });
      const res = await fetch(
        `http://127.0.0.1:${running.port}/v1/chat/completions`,
        { method: "POST", body: "{}" },
      );
      expect(res.status).toBe(200);
      expect(target.requests[0]?.url).toBe("/api/v1/chat/completions");
      expect(target.requests[0]?.headers.authorization).toBe(
        `Bearer ${REAL_KEY}`,
      );
    },
    30_000,
  );

  it(
    "logs a shape-only response summary saying whether the upstream sent reasoning",
    async () => {
      target = await startTarget();
      target.reply = {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body:
          'data: {"choices":[{"delta":{"reasoning":"thinking hard","role":"assistant"},"index":0,"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Hi"},"index":0,"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
      };
      const running = await startSpy({
        target: `http://127.0.0.1:${target.port}`,
        keyHeader: "authorization",
      });
      const res = await fetch(
        `http://127.0.0.1:${running.port}/v1/chat/completions`,
        { method: "POST", body: "{}" },
      );
      expect(res.status).toBe(200);
      // The SSE body is relayed to the client verbatim.
      expect(await res.text()).toContain("reasoning");

      const rec = spyLog(running.logPath)[0];
      expect(
        (rec.response as { hasReasoning?: boolean } | undefined)
          ?.hasReasoning,
      ).toBe(true);
      // A shape-only summary — never the response text.
      const logText = readFileSync(running.logPath, "utf8");
      expect(logText).not.toContain("thinking hard");
    },
    30_000,
  );
});
