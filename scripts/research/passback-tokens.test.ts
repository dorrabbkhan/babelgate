import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPassbackCheck } from "./passback-tokens";

/**
 * Offline test for scripts/research/passback-tokens.ts (v1.6 Task
 * 13d) — the "does the live model actually use sent-back reasoning"
 * probe. A 127.0.0.1 stub plays OpenRouter: it answers every
 * /v1/chat/completions POST with a fixed provider name and
 * prompt_tokens, plus a marker string in the completion text. The
 * script's output lines must carry status, provider and
 * prompt_tokens only — never body text and never the key.
 */

const API_KEY = "sk-or-TESTKEY-9f8e7d6c5b4a3210";
const BODY_MARKER = "COMPLETION_SECRET_MARKER_4x9";
const LOG_MARKER = "REASONING_SECRET_MARKER_7z2";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

interface CapturedRequest {
  url: string;
  authorization?: string;
  body: Record<string, unknown>;
}

let server: Server | undefined;
let requests: CapturedRequest[] = [];
let dir: string | undefined;

async function startStub(): Promise<string> {
  requests = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // recorded as {} — the assertions below still see the request
      }
      requests.push({
        url: req.url ?? "",
        authorization:
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : undefined,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          provider: "StubProvider",
          usage: { prompt_tokens: 411, completion_tokens: 16 },
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: BODY_MARKER },
              finish_reason: "length",
            },
          ],
        }),
      );
    });
  });
  const port = await listen(server);
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  server?.close();
  server = undefined;
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** A two-exchange spy log in the shape conformance-spy.ts writes;
 * turn 2's body carries `reasoning_content` on the assistant
 * message, as a babelgate-preset live run logs it. */
function writeSpyLog(): string {
  dir = mkdtempSync(join(tmpdir(), "passback-tokens-"));
  const turn1 = {
    method: "POST",
    url: "/v1/chat/completions",
    headers: {},
    body: JSON.stringify({
      model: "deepseek/deepseek-v4.1-flash",
      stream: true,
      messages: [{ role: "user", content: "What is the weather in Paris?" }],
    }),
    upstreamStatus: 200,
    response: { hasReasoning: true },
  };
  const turn2 = {
    method: "POST",
    url: "/v1/chat/completions",
    headers: {},
    body: JSON.stringify({
      model: "deepseek/deepseek-v4.1-flash",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 512,
      reasoning_effort: "low",
      tools: [
        {
          type: "function",
          function: { name: "get_weather", arguments: "" },
        },
      ],
      messages: [
        { role: "user", content: "What is the weather in Paris?" },
        {
          role: "assistant",
          content: "",
          reasoning_content: LOG_MARKER,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          content: "15 degrees Celsius, partly cloudy",
          tool_call_id: "call_1",
        },
      ],
    }),
    upstreamStatus: 200,
    response: { hasReasoning: true },
  };
  const path = join(dir, "spy.jsonl");
  writeFileSync(path, JSON.stringify(turn1) + "\n" + JSON.stringify(turn2) + "\n");
  return path;
}

describe("passback-tokens (v1.6 Task 13d)", () => {
  it("passback-tokens prints shapes only", async () => {
    const target = await startStub();
    const spyLog = writeSpyLog();
    const lines = await runPassbackCheck({
      spyLogPath: spyLog,
      target,
      apiKey: API_KEY,
    });

    expect(lines).toEqual([
      "variant=none status=200 provider=StubProvider prompt_tokens=411",
      "variant=reasoning_content status=200 provider=StubProvider prompt_tokens=411",
      "variant=reasoning status=200 provider=StubProvider prompt_tokens=411",
    ]);

    // Shapes only: no completion text, no reasoning text, no key.
    const out = lines.join("\n");
    expect(out).not.toContain(BODY_MARKER);
    expect(out).not.toContain(LOG_MARKER);
    expect(out).not.toContain(API_KEY);

    // The stub saw one request per variant, non-streaming with
    // max_tokens 16, the reasoning field per variant on the
    // assistant message, and the key only on the wire.
    expect(requests).toHaveLength(3);
    for (const req of requests) {
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.authorization).toBe(`Bearer ${API_KEY}`);
      expect(req.body.stream).toBe(false);
      expect(req.body.max_tokens).toBe(16);
    }
    const assistantOf = (i: number) =>
      ((requests[i].body.messages as Record<string, unknown>[]).find(
        (m) => m.role === "assistant",
      ) ?? {}) as Record<string, unknown>;
    expect(assistantOf(0)).not.toHaveProperty("reasoning_content");
    expect(assistantOf(0)).not.toHaveProperty("reasoning");
    expect(assistantOf(1).reasoning_content).toBe(LOG_MARKER);
    expect(assistantOf(2).reasoning).toBe(LOG_MARKER);
    expect(assistantOf(2)).not.toHaveProperty("reasoning_content");
  });
});
