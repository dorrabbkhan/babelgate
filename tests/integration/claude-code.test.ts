import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setupServer } from "msw/node";
import request from "supertest";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import { estimateInputTokens } from "../../src/utils/token-estimate";
import { toCanonicalRequest } from "../../src/transformers/adapters/anthropic.adapter";
import {
  upstreamHandlers,
  capturedRequests,
  resetCaptured,
  resetOverrides,
  resetStreamCase,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";
import anthropicFixtures from "../fixtures/anthropic.json";

/**
 * Claude Code essentials (spec §3.5): count_tokens answered locally,
 * MODEL_MAP rewriting, TARGET_CONTEXT_WINDOW → num_ctx, Anthropic
 * request headers accepted, and the message_start input-token
 * estimate.
 */
const server = setupServer(...upstreamHandlers);

const providers = ["openai", "gemini", "ollama", "anthropic"] as const;

function setPair(source: string, target: string): void {
  process.env.SOURCE_API = source;
  process.env.TARGET_API = target;
  resetConfig();
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  for (const p of providers) {
    process.env[`${p.toUpperCase()}_API_BASE_URL`] = MOCK_BASE_URLS[p];
    process.env[`${p.toUpperCase()}_API_KEY`] = "test-key";
  }
});

beforeEach(() => {
  process.env.UPSTREAM_RETRIES = "0";
  setPair("anthropic", "ollama");
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  resetStreamCase();
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.MODEL_MAP;
  delete process.env.TARGET_CONTEXT_WINDOW;
  delete process.env.BABELGATE_CONFIG;
  resetConfig();
});

afterAll(() => {
  server.close();
});

/** supertest parses SSE as an opaque body — collect it as text. */
function postStream(path: string, body: unknown): request.Test {
  return request(app)
    .post(path)
    .send(body)
    .buffer(true)
    .parse((res, cb) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => cb(null, text));
    });
}

/** Pull one event-typed SSE frame's JSON payload out of a stream body. */
function sseEvent(body: string, event: string): Record<string, unknown> {
  const m = body.match(
    new RegExp(`event: ${event}\\ndata: (\\{.*\\})`),
  );
  expect(m, `expected an "event: ${event}" frame`).not.toBeNull();
  return JSON.parse(m![1]) as Record<string, unknown>;
}

describe("Claude Code essentials (spec §3.5)", () => {
  it("/v1/messages?beta=true streams with MODEL_MAP applied", async () => {
    process.env.MODEL_MAP = "claude-*=qwen3-coder:30b";
    setPair("anthropic", "ollama");

    const res = await postStream("/v1/messages?beta=true", {
      ...(anthropicFixtures.requests.basic as Record<string, unknown>),
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    // The upstream received the mapped model…
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests.ollama[0]).toMatchObject({
      model: "qwen3-coder:30b",
      stream: true,
    });

    // …while the client sees the model it asked for in message_start.
    const start = sseEvent(res.body as string, "message_start");
    expect((start.message as { model?: string }).model).toBe(
      "claude-3-opus-20240229",
    );
  });

  it("MODEL_MAP non-streaming reply carries the requested model", async () => {
    process.env.MODEL_MAP = "claude-*=qwen3-coder:30b";
    setPair("anthropic", "ollama");

    const res = await request(app)
      .post("/v1/messages")
      .send(anthropicFixtures.requests.basic);

    expect(res.status).toBe(200);
    expect(capturedRequests.ollama[0]).toMatchObject({
      model: "qwen3-coder:30b",
    });
    expect(res.body.model).toBe("claude-3-opus-20240229");
  });

  it("count_tokens answers locally with the estimate header", async () => {
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .send(anthropicFixtures.requests.basic);

    expect(res.status).toBe(200);
    expect(res.headers["x-babelgate-token-estimate"]).toBe("true");
    expect(res.body).toEqual({
      input_tokens: estimateInputTokens(
        toCanonicalRequest(
          anthropicFixtures.requests.basic as Parameters<
            typeof toCanonicalRequest
          >[0],
        ),
      ),
    });

    // Answered locally — no upstream request was made.
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it("count_tokens accepts a body without max_tokens", async () => {
    // Claude Code sends count_tokens without max_tokens (it isn't
    // creating a message) — model, messages, system and tools.
    const body = {
      model: "claude-sonnet-4-20250514",
      system: "You are Claude Code, Anthropic's official CLI.",
      messages: [{ role: "user", content: "count my tokens" }],
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    };

    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.headers["x-babelgate-token-estimate"]).toBe("true");
    expect(res.body).toEqual({
      input_tokens: estimateInputTokens(
        toCanonicalRequest(
          body as Parameters<typeof toCanonicalRequest>[0],
        ),
      ),
    });
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it("count_tokens malformed body → 400 in the Anthropic dialect", async () => {
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .send({ model: "claude-sonnet-4-20250514", messages: "not-an-array" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it("count_tokens is answered whatever the configured target", async () => {
    setPair("openai", "ollama");

    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .send({ model: "m", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.headers["x-babelgate-token-estimate"]).toBe("true");
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it("TARGET_CONTEXT_WINDOW sets Ollama num_ctx", async () => {
    process.env.TARGET_CONTEXT_WINDOW = "32768";
    setPair("anthropic", "ollama");

    const res = await request(app)
      .post("/v1/messages")
      .send(anthropicFixtures.requests.basic);

    expect(res.status).toBe(200);
    expect(capturedRequests.ollama[0]).toMatchObject({
      options: { num_ctx: 32768 },
    });
  });

  it("anthropic-beta header is accepted", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .set("anthropic-version", "2023-06-01")
      .set("anthropic-beta", "prompt-caching-2024-07-31")
      .send(anthropicFixtures.requests.basic);

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("message");
  });

  it("anthropic → ollama stream:true message_start carries the estimate", async () => {
    const res = await postStream("/v1/messages", {
      ...(anthropicFixtures.requests.basic as Record<string, unknown>),
      stream: true,
    });

    expect(res.status).toBe(200);

    // message_start carries the local estimate (Claude Code reads it
    // for its context display); the real counts still arrive in the
    // closing message_delta.
    const start = sseEvent(res.body as string, "message_start");
    const usage = (start.message as { usage?: { input_tokens?: number } })
      .usage;
    expect(usage?.input_tokens).toBe(
      estimateInputTokens(
        toCanonicalRequest(
          {
            ...(anthropicFixtures.requests.basic as Record<string, unknown>),
            stream: true,
          } as Parameters<typeof toCanonicalRequest>[0],
        ),
      ),
    );
    expect(usage?.input_tokens).toBeGreaterThan(0);

    const delta = sseEvent(res.body as string, "message_delta");
    const realUsage = delta.usage as { output_tokens?: number };
    expect(realUsage).toBeDefined();
    expect(typeof realUsage.output_tokens).toBe("number");
  });
});

// Task 17a: Claude Code's moving breakpoint on the newest tool_result
// must reach a cache_hints upstream — before this task the anthropic
// decoder dropped it (cache_control_dropped) and the agent loop never
// read the cache.
describe("cache hints on tool results (Task 17a)", () => {
  const TMP_CONFIG = join(__dirname, ".tmp-cache-hints.yaml");
  const CACHE_HINTS_YAML = `default: openrouter
providers:
  openrouter:
    type: openai
    base_url: ${MOCK_BASE_URLS.openai}
    api_key_env: OPENAI_API_KEY
    cache_hints: true
routes:
  - match: "*"
    to: openrouter/anthropic-claude
`;

  afterEach(() => {
    rmSync(TMP_CONFIG, { force: true });
  });

  const SYSTEM = [
    {
      type: "text",
      text: "You are Claude Code, a careful coding assistant.",
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: "Follow the repository's conventions exactly.",
      cache_control: { type: "ephemeral" },
    },
  ];
  const TOOLS = [
    {
      name: "read_file",
      description: "Read a file from disk.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      cache_control: { type: "ephemeral" },
    },
  ];
  const TURN_1 = [
    { role: "user", content: "Read package.json." },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "package.json" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: '{"name":"babelgate"}',
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ];
  // Turn 2 moves the breakpoint to the newest tool_result — the older
  // one loses its cache_control exactly as Claude Code sends it.
  const TURN_1_UNHINTED = TURN_1.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return m;
    return {
      ...m,
      content: content.map((b) => {
        const { cache_control: _cc, ...rest } = b as Record<
          string,
          unknown
        >;
        return rest;
      }),
    };
  });
  const TURN_2 = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_2",
          name: "read_file",
          input: { path: "src/app.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_2",
          content: [
            { type: "text", text: "export const app = express();" },
            {
              type: "text",
              text: "// end of file",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    },
  ];

  function claudeCodeBody(messages: unknown[]): object {
    return {
      model: "claude-code",
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    };
  }

  it("anthropic → openai(cache_hints): the tool-result marker reaches the upstream body", async () => {
    writeFileSync(TMP_CONFIG, CACHE_HINTS_YAML);
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();

    const first = await request(app)
      .post("/v1/messages")
      .set("anthropic-version", "2023-06-01")
      .send(claudeCodeBody(TURN_1));
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await request(app)
      .post("/v1/messages")
      .set("anthropic-version", "2023-06-01")
      .send(claudeCodeBody([...TURN_1_UNHINTED, ...TURN_2]));
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    expect(capturedRequests.openai).toHaveLength(2);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const body1 = capturedRequests.openai[0] as any;
    const body2 = capturedRequests.openai[1] as any;

    // The surviving system marker: one cache_control on a text part
    // covering the whole system prompt.
    expect(body2.messages[0]).toEqual({
      role: "system",
      content: [
        {
          type: "text",
          text: "You are Claude Code, a careful coding assistant.\n\nFollow the repository's conventions exactly.",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    // The hinted tool definition keeps its breakpoint.
    expect(body2.tools[0].cache_control).toEqual({ type: "ephemeral" });
    // The moving breakpoint: the newest tool message carries it on a
    // text content part.
    const toolMsg2 = body2.messages[body2.messages.length - 1];
    expect(toolMsg2).toEqual({
      role: "tool",
      tool_call_id: "call_2",
      content: [
        {
          type: "text",
          text: "export const app = express();\n// end of file",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    // Request 1's moving marker was on tool message call_1.
    const toolMsg1 = body1.messages[body1.messages.length - 1];
    expect(toolMsg1).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: [
        {
          type: "text",
          text: '{"name":"babelgate"}',
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    // Byte-stable prefix: everything before the moved marker is
    // deep-equal across the two turns (tools included), and the older
    // tool result's TEXT is unchanged — only its marker moved.
    expect(body2.messages.slice(0, body1.messages.length - 1)).toEqual(
      body1.messages.slice(0, -1),
    );
    expect(body2.messages[body1.messages.length - 1]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"name":"babelgate"}',
    });
    expect(body2.tools).toEqual(body1.tools);
  });
});
