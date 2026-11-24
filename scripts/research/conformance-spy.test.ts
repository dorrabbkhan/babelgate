import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  /** Set when the target was started with `hold` — resolve to let
   * the held response end. */
  release?(): void;
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

async function startTarget(
  opts: { hold?: boolean } = {},
): Promise<RunningTarget> {
  const requests: TargetRequest[] = [];
  let release: (() => void) | undefined;
  const gate =
    opts.hold === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : undefined;
  const running: RunningTarget = {
    port: 0,
    requests,
    reply: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    release,
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
      if (gate !== undefined) {
        void gate.then(() => res.end(running.reply.body));
      } else {
        res.end(running.reply.body);
      }
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

  it(
    "spy reports in-flight exchanges until the log line is written",
    async () => {
      target = await startTarget({ hold: true });
      const running = await startSpy({
        target: `http://127.0.0.1:${target.port}`,
        keyHeader: "authorization",
      });
      const inflight = async (): Promise<number> => {
        const res = await fetch(
          `http://127.0.0.1:${running.port}/__inflight`,
        );
        return (
          ((await res.json()) as { inflight?: number }).inflight ?? -1
        );
      };
      expect(await inflight()).toBe(0);
      const pending = fetch(
        `http://127.0.0.1:${running.port}/v1/chat/completions`,
        { method: "POST", body: "{}" },
      );
      // The target holds its response open — the exchange stays in
      // flight and no log line exists yet.
      await vi.waitFor(
        async () => expect(await inflight()).toBe(1),
        { interval: 25, timeout: 5_000 },
      );
      expect(existsSync(running.logPath)).toBe(false);
      target.release!();
      const res = await pending;
      expect(res.status).toBe(200);
      await res.text();
      // Back to 0 once the exchange's line is on disk.
      expect(await inflight()).toBe(0);
      expect(spyLog(running.logPath)).toHaveLength(1);
    },
    30_000,
  );

  it(
    "spy in-flight returns to 0 when the upstream errors",
    async () => {
      // The target accepts then destroys the socket mid-response:
      // the spy records the aborted exchange and frees the slot.
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.socket?.destroy();
        });
      });
      const port = await listen(server);
      target = {
        port,
        requests: [],
        reply: { status: 200, headers: {}, body: "" },
        close: () => server.close(),
      };
      const running = await startSpy({
        target: `http://127.0.0.1:${port}`,
        keyHeader: "authorization",
      });
      const res = await fetch(
        `http://127.0.0.1:${running.port}/v1/chat/completions`,
        { method: "POST", body: "{}" },
      );
      await res.arrayBuffer().catch(() => {});
      await vi.waitFor(
        async () => {
          const r = await fetch(
            `http://127.0.0.1:${running.port}/__inflight`,
          );
          expect(
            ((await r.json()) as { inflight?: number }).inflight,
          ).toBe(0);
        },
        { interval: 25, timeout: 5_000 },
      );
      const entries = spyLog(running.logPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].error).toBeDefined();
    },
    30_000,
  );
});
