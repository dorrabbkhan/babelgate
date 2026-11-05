import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import request from "supertest";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import { resetModelListCache } from "../../src/services/models.service";
import {
  registerSink,
  resetSinks,
  type TraceSink,
} from "../../src/observe/emit";
import { createLogSink } from "../../src/observe/sinks/log";
import type { RequestTrace } from "../../src/observe/trace";
import { logger } from "../../src/utils/logger";
import {
  upstreamHandlers,
  capturedRequests,
  capturedRequests2,
  resetCaptured,
  resetOverrides,
  resetStreamCase,
  responseOverrides,
  MOCK_BASE_URLS,
  OPENAI2_BASE_URL,
  DEAD_BASE_URL,
} from "../mocks/upstreams";
import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";

/**
 * The request trace (spec §3.1): one per chat request, emitted exactly
 * once — success, upstream failure and client abort alike. Pre-route
 * rejections and non-chat endpoints are not traced. The log sink is the
 * v1.2 "Request completed" line plus the trace fields.
 */

const server = setupServer(...upstreamHandlers);

const providers = ["openai", "gemini", "ollama", "anthropic"] as const;

/** Temp YAML inside the repo (deleted in afterEach) — not a fixture. */
const TMP_CONFIG = join(__dirname, ".tmp-observe.yaml");

/** Same routing shape as gateway.test.ts: `*` → rule:2, main wins. */
const GATEWAY_YAML = `default: main
providers:
  main:
    type: ollama
    base_url: ${MOCK_BASE_URLS.ollama}
    context_window: 32768
  dead:
    type: ollama
    base_url: ${DEAD_BASE_URL}
  second:
    type: openai
    base_url: ${OPENAI2_BASE_URL}
    api_key_env: OPENAI2_API_KEY
routes:
  - match: dead-*
    to: dead/gone
    fallback: [second/fallback-model]
  - match: slow-*
    to: main/stall
    fallback: [second/fallback-model]
  - match: "*"
    to: main/llama3
    fallback: [second/fallback-model]
`;

/** Every trace emitTrace fans out — the test's own sink. */
const traces: RequestTrace[] = [];
const recorder: TraceSink = {
  name: "recorder",
  accept: (t) => traces.push(t),
};

/** supertest parses streamed bodies as opaque — collect them as text. */
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

async function waitForTraces(n: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (traces.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  for (const p of providers) {
    process.env[`${p.toUpperCase()}_API_BASE_URL`] = MOCK_BASE_URLS[p];
    process.env[`${p.toUpperCase()}_API_KEY`] = "test-key";
  }
  process.env.OPENAI2_API_KEY = "test-key-2";
});

beforeEach(() => {
  process.env.UPSTREAM_RETRIES = "0";
  delete process.env.SOURCE_API;
  process.env.TARGET_API = "ollama";
  resetModelListCache();
  resetConfig();
  resetSinks();
  registerSink(createLogSink());
  registerSink(recorder);
  traces.length = 0;
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  resetStreamCase();
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.BABELGATE_CONFIG;
  rmSync(TMP_CONFIG, { force: true });
  resetConfig();
});

afterAll(() => {
  server.close();
});

describe("request trace (spec §3.1)", () => {
  it("one trace per chat request, json and stream", async () => {
    const json = await request(app)
      .post("/v1/chat/completions")
      .set("user-agent", "claude-cli/2.1.3 (external, cli)")
      .send(openaiFixtures.requests.basic as object);
    expect(json.status, JSON.stringify(json.body)).toBe(200);

    const stream = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    } as object);
    expect(stream.status).toBe(200);

    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({
      requestId: expect.any(String),
      sourceApi: "openai",
      requestedModel: "gpt-4",
      reason: "default",
      winner: "ollama",
      stream: false,
      client: "claude-code",
      userAgent: "claude-cli/2.1.3 (external, cli)",
      status: "ok",
      httpStatus: 200,
      inputTokens: 10,
      outputTokens: 8,
      finishReason: "stop",
      costUsd: null,
    });
    expect(traces[0].hops).toHaveLength(1);
    expect(traces[0].hops[0]).toMatchObject({
      provider: "ollama",
      model: "gpt-4",
      outcome: "ok",
    });
    expect(traces[0].totalMs).toEqual(expect.any(Number));
    expect(traces[0].ttfbMs).toEqual(expect.any(Number));

    expect(traces[1]).toMatchObject({
      sourceApi: "openai",
      requestedModel: "gpt-4",
      winner: "ollama",
      stream: true,
      status: "ok",
      httpStatus: 200,
      finishReason: "stop",
    });
    expect(traces[1].inputTokens).toEqual(expect.any(Number));
    expect(traces[1].ttfbMs).toEqual(expect.any(Number));
  });

  it("failed request still traced", async () => {
    responseOverrides.ollama = { status: 400, body: { error: "bad" } };

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(res.status).toBe(400);

    expect(traces).toHaveLength(1);
    expect(traces[0].winner).toBeUndefined();
    expect(traces[0]).toMatchObject({
      requestedModel: "gpt-4",
      status: "error",
      httpStatus: 400,
      errorType: "invalid_request",
      stream: false,
    });
    expect(traces[0].hops).toEqual([
      {
        provider: "ollama",
        model: "gpt-4",
        outcome: "http_error",
        status: 400,
        ms: expect.any(Number),
      },
    ]);
  });

  // The upstream attempt succeeded, but decoding its reply throws —
  // still exactly one trace, now an error one (Global Constraints:
  // "emitted exactly once, also on failure"). Client behaviour is
  // unchanged from main: the same 502 + canonical "upstream" kind.
  it("decode failure after a successful upstream is traced once", async () => {
    process.env.TARGET_API = "openai";
    resetConfig();
    responseOverrides.openai = {
      status: 200,
      body: {
        id: "chatcmpl-custom",
        object: "chat.completion",
        created: 1,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "custom",
                  custom: { name: "t", input: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(res.status).toBe(502);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      status: "error",
      httpStatus: res.status,
      errorType: res.body.error.code,
      winner: "openai",
    });
  });

  it("fallback hops on the trace", async () => {
    writeFileSync(TMP_CONFIG, GATEWAY_YAML);
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();
    responseOverrides.ollama = { status: 503, body: { error: "down" } };

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests2).toHaveLength(1);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      requestedModel: "gpt-4",
      reason: "rule:2",
      winner: "second",
      status: "ok",
      httpStatus: 200,
    });
    expect(traces[0].hops).toEqual([
      {
        provider: "main",
        model: "llama3",
        outcome: "http_error",
        status: 503,
        ms: expect.any(Number),
      },
      {
        provider: "second",
        model: "fallback-model",
        outcome: "ok",
        ms: expect.any(Number),
      },
    ]);
  });

  // Review Focus 1: Claude Code's Esc mid-stream — the client aborts
  // after the first chunk; exactly one trace, status "aborted", and no
  // second emit when the pipeline's finally also fires.
  it("aborted stream emits one trace", async () => {
    // An upstream stream that delivers one chunk then stays open, so
    // the abort lands mid-stream rather than after completion.
    server.use(
      http.post(`${MOCK_BASE_URLS.ollama}/api/chat`, () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                '{"model":"llama3","created_at":"t","message":{"role":"assistant","content":"hi"},"done":false}\n',
              ),
            );
            // never closes — the client goes away first
          },
        });
        return new HttpResponse(body, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }),
    );

    const listener = app.listen(0);
    try {
      const port = (listener.address() as AddressInfo).port;
      const ac = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...openaiFixtures.requests.basic,
            stream: true,
          }),
          signal: ac.signal,
        },
      );
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      await reader.read(); // first chunk delivered, then Esc
      ac.abort();
      await reader.read().catch(() => {});

      await waitForTraces(1);
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        requestedModel: "gpt-4",
        winner: "ollama",
        stream: true,
        status: "aborted",
        httpStatus: 200,
      });

      // Give any second emit a chance to fire — there is none.
      await new Promise((r) => setTimeout(r, 200));
      expect(traces).toHaveLength(1);
    } finally {
      await new Promise<void>((r) => listener.close(() => r()));
    }
  });

  it("count_tokens and model list are not traced", async () => {
    const count = await request(app)
      .post("/v1beta/models/llama3:countTokens")
      .send(geminiFixtures.requests.basic as object);
    expect(count.status, JSON.stringify(count.body)).toBe(200);

    const models = await request(app).get("/v1/models");
    expect(models.status, JSON.stringify(models.body)).toBe(200);

    expect(traces).toHaveLength(0);
  });

  // Moved from gateway.test.ts (the v1.2 route-log sentinel test) —
  // assertions unchanged.
  it("log line has no prompt text", async () => {
    writeFileSync(TMP_CONFIG, GATEWAY_YAML);
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();
    const infoSpy = vi.spyOn(logger, "info");

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gpt-4",
        messages: [
          { role: "user", content: "repeat SENTINEL-7f3a back" },
        ],
      });
    expect(res.status).toBe(200);
    // The prompt did reach the upstream — only the log must not see it.
    expect(JSON.stringify(capturedRequests.ollama)).toContain(
      "SENTINEL-7f3a",
    );

    const call = infoSpy.mock.calls.find(
      ([fields, msg]) =>
        msg === "Request completed" &&
        (fields as { hops?: unknown }).hops !== undefined,
    );
    expect(call).toBeDefined();
    const record = call![0] as Record<string, unknown>;
    expect(JSON.stringify(record)).not.toContain("SENTINEL-7f3a");
    expect(record).toMatchObject({
      requestId: expect.any(String),
      sourceApi: "openai",
      requestedModel: "gpt-4",
      reason: "rule:2",
      winner: "main",
      stream: false,
      inputTokens: 10,
      outputTokens: 8,
      finishReason: "stop",
    });
    expect(Array.isArray(record.hops)).toBe(true);
    expect(
      (record.hops as { provider?: string; outcome?: string }[])[0],
    ).toMatchObject({ provider: "main", outcome: "ok" });
  });
});
