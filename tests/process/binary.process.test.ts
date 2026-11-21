import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  babelgateGateway,
  babelgateYaml,
  gatewayCommand,
  stopChild,
} from "./gateways/babelgate";
import { freePort, waitHealthy, type RunningGateway } from "./harness";
import {
  startMockUpstream,
  type MockRoute,
  type RunningMockUpstream,
} from "./mock-upstream";

const REPO = join(__dirname, "..", "..");
const TMP = join(REPO, "tmp", "process");
const pkg = JSON.parse(
  readFileSync(join(REPO, "package.json"), "utf8"),
) as { version: string };

/**
 * Every gateway HOME in this suite gets a space in the path (Review
 * Focus 5: "home with a space resolves") — mkdtemp keeps the suffix,
 * so the directory is always unique under the gitignored tmp/.
 */
function workDir(prefix = "babelgate home-"): string {
  mkdirSync(TMP, { recursive: true });
  return mkdtempSync(join(TMP, prefix));
}

interface Stack {
  gw: RunningGateway;
  upstream: RunningMockUpstream;
  workDir: string;
}

async function withGateway(
  routes: MockRoute[],
  fn: (stack: Stack) => Promise<void>,
): Promise<void> {
  const upstream = await startMockUpstream(routes);
  const dir = workDir();
  const gw = await babelgateGateway.start({
    upstream: upstream.url,
    port: await freePort(),
    workDir: dir,
  });
  try {
    await fn({ gw, upstream, workDir: dir });
  } finally {
    await gw.stop();
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const openaiJson = (bodyFile: string): MockRoute => ({
  method: "POST",
  path: "/v1/chat/completions",
  reply: {
    status: 200,
    headers: { "content-type": "application/json" },
    bodyFile,
  },
});

function anthropicSend(gw: RunningGateway, body: object) {
  return fetch(`${gw.anthropicBase}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

describe("babelgate binary", () => {
  it("--version prints package version", () => {
    const { cmd, args } = gatewayCommand();
    const out = execFileSync(cmd, [...args, "--version"], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe(`babelgate ${pkg.version}`);
  });

  it("anthropic client to openai upstream: text, stream, tool call", async () => {
    const tools = [
      {
        name: "get_weather",
        description: "Get the weather",
        input_schema: {
          type: "object",
          properties: { location: { type: "string" } },
        },
      },
    ];
    const message = (extra: object) => ({
      model: "openai/gpt-x",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    });

    // text — a recorded non-streaming Chat Completions reply
    await withGateway([openaiJson("openai/text.json")], async (s) => {
      const res = await anthropicSend(s.gw, message({ tools }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        type: string;
        content: { type: string; text?: string }[];
      };
      expect(body.type).toBe("message");
      expect(body.content[0]).toMatchObject({
        type: "text",
        text: "Hello! How can I help you?",
      });
      // the upstream saw the OpenAI encode of the same request
      expect(s.upstream.requests[0]?.url).toBe("/v1/chat/completions");
      expect(s.upstream.requests[0]?.body).toContain('"gpt-x"');
    });

    // stream — the recorded OpenAI SSE text stream
    await withGateway(
      [
        {
          method: "POST",
          path: "/v1/chat/completions",
          reply: {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            bodyFile: "openai/text.sse",
          },
        },
      ],
      async (s) => {
        const res = await anthropicSend(
          s.gw,
          message({ stream: true, tools }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain(
          "text/event-stream",
        );
        const sse = await res.text();
        expect(sse).toContain("content_block_delta");
        expect(sse).toContain("Hello");
      },
    );

    // tool call — a recorded Chat Completions tool_calls reply
    await withGateway([openaiJson("openai/tool_call.json")], async (s) => {
      const res = await anthropicSend(s.gw, message({ tools }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        content: { type: string; name?: string }[];
      };
      expect(body.content[0]).toMatchObject({
        type: "tool_use",
        name: "get_weather",
      });
    });
  });

  it("responses client to gemini upstream: stream with tool call", async () => {
    await withGateway(
      [
        {
          method: "POST",
          path: /:streamGenerateContent/,
          reply: {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            bodyFile: "gemini/tool_call.sse",
          },
        },
      ],
      async (s) => {
        const res = await fetch(`${s.gw.responsesBase}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gemini/gemini-2.0-flash",
            stream: true,
            input: "divide 100 by 2",
            tools: [
              {
                type: "function",
                name: "customDivide",
                description: "Divide two numbers",
                parameters: {
                  type: "object",
                  properties: {
                    numerator: { type: "number" },
                    denominator: { type: "number" },
                  },
                },
              },
            ],
          }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain(
          "text/event-stream",
        );
        const sse = await res.text();
        expect(sse).toContain("customDivide");
        expect(sse).toContain("function_call");
        expect(s.upstream.requests[0]?.url).toContain(
          ":streamGenerateContent",
        );
      },
    );
  });

  it("openai client to ollama upstream", async () => {
    await withGateway(
      [
        {
          method: "POST",
          path: "/api/chat",
          reply: {
            status: 200,
            headers: { "content-type": "application/json" },
            bodyFile: "ollama/text.nonstreaming.json",
          },
        },
      ],
      async (s) => {
        const res = await fetch(`${s.gw.openaiBase}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "ollama/qwen2.5:0.5b",
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        expect(body.choices[0]?.message.content).toBe(
          "Hello! How can I assist you today?",
        );
        expect(s.upstream.requests[0]?.url).toBe("/api/chat");
        expect(s.upstream.requests[0]?.body).toContain("qwen2.5:0.5b");
      },
    );
  });

  it("/ui loads index and an asset", async () => {
    await withGateway([], async (s) => {
      const base = s.gw.anthropicBase;
      const index = await fetch(`${base}/ui/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      const html = await index.text();
      // a hashed bundle URL out of the built index.html (base /ui/)
      const match = html.match(/(?:src|href)="([^"]+\.(?:js|css))"/);
      expect(match).not.toBeNull();
      const assetUrl = new URL(match![1], `${base}/ui/`).href;
      const asset = await fetch(assetUrl);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toMatch(
        /javascript|css/,
      );
    });
  });

  it("/metrics responds", async () => {
    await withGateway([], async (s) => {
      const res = await fetch(`${s.gw.anthropicBase}/metrics`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("babelgate");
    });
  });

  it("usage row written under HOME/.babelgate", async () => {
    await withGateway([openaiJson("openai/text.json")], async (s) => {
      const res = await fetch(`${s.gw.openaiBase}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-x",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      // SIGTERM flushes the queued rows once on shutdown.
      await s.gw.stop();
      const dbPath = join(s.workDir, ".babelgate", "usage.db");
      expect(existsSync(dbPath)).toBe(true);
      const { DatabaseSync: Db } = require("node:sqlite") as {
        DatabaseSync: typeof DatabaseSync;
      };
      const db = new Db(dbPath);
      try {
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM requests")
          .get() as { n: number };
        expect(row.n).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });

  it("binary writes nothing to cwd", async () => {
    // cwd is a read-only directory; HOME (the data root) stays writable.
    const cwd = mkdtempSync(join(TMP, "ro-cwd-"));
    const home = workDir();
    const upstream = await startMockUpstream([
      openaiJson("openai/text.json"),
    ]);
    const port = await freePort();
    writeFileSync(join(home, "babelgate.yaml"), babelgateYaml(upstream.url));
    chmodSync(cwd, 0o555);
    const { cmd, args } = gatewayCommand();
    const child = spawn(
      cmd,
      [...args, "--config", join(home, "babelgate.yaml")],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          PORT: String(port),
          BABELGATE_MOCK_KEY: "mock-key",
          NODE_ENV: "production",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await waitHealthy(`http://127.0.0.1:${port}`, 20_000);
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "openai/gpt-x",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      expect(res.status).toBe(200);
    } finally {
      await stopChild(child);
      await upstream.close();
      chmodSync(cwd, 0o755);
      rmSync(home, { recursive: true, force: true });
    }
    try {
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("home with a space resolves", async () => {
    expect(TMP).not.toContain(" ");
    await withGateway([openaiJson("openai/text.json")], async (s) => {
      expect(s.workDir).toContain(" ");
      const res = await fetch(`${s.gw.anthropicBase}/health`);
      expect(res.status).toBe(200);
      await s.gw.stop();
      // the usage DB landed under the spaced HOME, not the real one
      expect(
        existsSync(join(s.workDir, ".babelgate", "usage.db")),
      ).toBe(true);
    });
  });
});
