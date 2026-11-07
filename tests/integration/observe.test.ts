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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { response } from "express";
import request from "supertest";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import { resetModelListCache } from "../../src/services/models.service";
import {
  adapters,
  PROVIDER_ROUTES,
  type Provider,
} from "../../src/transformers";
import {
  registerSink,
  resetSinks,
  type TraceSink,
} from "../../src/observe/emit";
import { createLogSink } from "../../src/observe/sinks/log";
import { createBodyRing } from "../../src/observe/sinks/body-ring";
import {
  createUsageStore,
  getUsageStore,
  resetUsageStore,
} from "../../src/observe/sinks/usage-store";
import {
  getMetricsSink,
  resetMetricsSink,
} from "../../src/observe/sinks/metrics";
import * as sqlite from "../../src/observe/sqlite";
import { openDatabase } from "../../src/observe/sqlite";
import type {
  BodySnapshots,
  RequestTrace,
} from "../../src/observe/trace";
import { logger } from "../../src/utils/logger";
import {
  upstreamHandlers,
  capturedRequests,
  capturedRequests2,
  resetCaptured,
  resetOverrides,
  resetStreamCase,
  responseOverrides,
  responseOverrides2,
  MOCK_BASE_URLS,
  OPENAI2_BASE_URL,
  DEAD_BASE_URL,
} from "../mocks/upstreams";
import bundledPrices from "../../src/cost/prices.json";
import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import anthropicFixtures from "../fixtures/anthropic.json";
import ollamaFixtures from "../fixtures/ollama.json";

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
  resetMetricsSink();
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
  delete process.env.INSPECTOR_BUFFER;
  delete process.env.METRICS;
  delete process.env.USAGE_DB;
  delete process.env.USAGE_STORE;
  resetUsageStore();
  rmSync(TMP_CONFIG, { force: true });
  vi.restoreAllMocks();
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

    await waitForTraces(2);
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
      // Task 8: an ollama winner is local — $0, never "unknown".
      costUsd: 0,
      priceSource: "local",
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

    await waitForTraces(1);
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

    await waitForTraces(1);
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

    await waitForTraces(1);
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

  // The source stream encoder is built before the attempt loop: a
  // throw there reached planRoute but used to emit no trace at all.
  // Client behaviour is unchanged from main — the same 500
  // TRANSFORM_ERROR rendering (literal status verified on main).
  it("stream encoder failure is traced once", async () => {
    const spy = vi
      .spyOn(adapters.openai, "createStreamEncoder")
      .mockImplementationOnce(() => {
        throw new Error("boom");
      });
    try {
      const res = await request(app)
        .post("/v1/chat/completions")
        .send({ ...openaiFixtures.requests.basic, stream: true } as object);
      expect(res.status).toBe(500);

      await waitForTraces(1);
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        status: "error",
        httpStatus: res.status,
        stream: true,
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(traces).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  // A stream the route returned but never iterated (a throw between
  // proxyRequest and the for-await — here a stubbed flushHeaders)
  // never runs the generator's finally, so the route calls
  // stream.finish(clientStatus). Client behaviour is unchanged from
  // main — the same 500 the error handler renders for that request.
  it("stream that is never iterated is traced once", async () => {
    const spy = vi
      .spyOn(response, "flushHeaders")
      .mockImplementationOnce(() => {
        throw new Error("boom");
      });
    try {
      const res = await request(app)
        .post("/v1/chat/completions")
        .send({ ...openaiFixtures.requests.basic, stream: true } as object);
      expect(res.status).toBe(500);

      await waitForTraces(1);
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        status: "error",
        httpStatus: res.status,
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(traces).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  // Guard: every kind:"chat" entry in the source route tables must
  // open a trace — iterate the tables rather than hard-coding so a new
  // route can't slip through. The client paths are the route's own
  // requestPath/streamRequestPath (for these four providers the
  // client and upstream path shapes coincide; only Gemini's carries
  // the model).
  it("every chat source route opens a trace", async () => {
    const basic: Record<Provider, Record<string, unknown>> = {
      openai: openaiFixtures.requests.basic,
      anthropic: anthropicFixtures.requests.basic,
      ollama: ollamaFixtures.requests.basic,
      gemini: geminiFixtures.requests.basic,
    };

    for (const [provider, routes] of Object.entries(PROVIDER_ROUTES)) {
      const sourceApi = provider as Provider;
      const fixture = basic[sourceApi];
      const model =
        typeof fixture.model === "string" ? fixture.model : "gemini-pro";
      for (const route of routes) {
        if (route.kind !== "chat") continue;
        const cases: { path: string; body: unknown; stream: boolean }[] =
          route.streamRequestPath !== undefined
            ? [
                // The stream variant is the dedicated endpoint, the
                // same basic body on each (Gemini carries no flag).
                {
                  path: route.requestPath(model),
                  body: fixture,
                  stream: false,
                },
                {
                  path: route.streamRequestPath(model),
                  body: fixture,
                  stream: true,
                },
              ]
            : [
                // No separate stream path — streaming is a body flag
                // (explicit: absent means stream:true for Ollama).
                {
                  path: route.requestPath(model),
                  body: { ...fixture, stream: false },
                  stream: false,
                },
                {
                  path: route.requestPath(model),
                  body: { ...fixture, stream: true },
                  stream: true,
                },
              ];

        for (const { path, body, stream } of cases) {
          const before = traces.length;
          const res = stream
            ? await postStream(path, body)
            : await request(app).post(path).send(body as object);
          expect(
            res.status,
            `${sourceApi} ${path}: ${JSON.stringify(res.body)}`,
          ).toBe(200);
          await waitForTraces(before + 1);
          expect(traces.length).toBe(before + 1);
          expect(traces[before]).toMatchObject({
            sourceApi,
            status: "ok",
            stream,
          });
        }
      }
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

describe("body snapshots and the inspector ring (spec §3.5)", () => {
  // A body-ring sink sees the trace unstripped (spec §3.1.1) — the
  // recorder above only ever gets the bodies-less copy.
  it("four stages captured", async () => {
    const ring = createBodyRing(50);
    registerSink(ring);

    const json = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(json.status).toBe(200);

    const stream = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    } as object);
    expect(stream.status).toBe(200);

    await waitForTraces(2);

    const jsonBodies = ring.get(traces[0].requestId);
    expect(jsonBodies).toBeDefined();
    expect(jsonBodies?.source?.value).toMatchObject({ model: "gpt-4" });
    expect(jsonBodies?.canonical?.value).toMatchObject({
      model: "gpt-4",
    });
    expect(jsonBodies?.target).toHaveLength(1);
    expect(jsonBodies?.target[0].value).toMatchObject({ model: "gpt-4" });
    expect(jsonBodies?.response?.canonical?.value).toMatchObject({
      model: "gpt-4",
    });
    expect(jsonBodies?.response?.wire?.value).toMatchObject({
      done: true,
    });
    for (const snap of [
      jsonBodies?.source,
      jsonBodies?.canonical,
      jsonBodies?.target[0],
      jsonBodies?.response?.canonical,
      jsonBodies?.response?.wire,
    ]) {
      expect(snap?.truncated).toBeUndefined();
    }

    const streamBodies = ring.get(traces[1].requestId);
    expect(streamBodies).toBeDefined();
    expect(streamBodies?.source?.value).toMatchObject({ model: "gpt-4" });
    expect(streamBodies?.canonical?.value).toMatchObject({
      model: "gpt-4",
      stream: true,
    });
    expect(streamBodies?.target).toHaveLength(1);
    expect(streamBodies?.response?.canonical?.value).toMatchObject({
      model: "gpt-4",
    });
    // A stream's wire snapshot is the upstream bytes as text.
    const wire = streamBodies?.response?.wire;
    expect(typeof wire?.value).toBe("string");
    expect(wire?.value as string).toContain('"done":true');
    expect(wire?.truncated).toBeUndefined();
  });

  it("a fallback hop adds a second target snapshot", async () => {
    writeFileSync(TMP_CONFIG, GATEWAY_YAML);
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();
    const ring = createBodyRing(50);
    registerSink(ring);
    responseOverrides.ollama = { status: 503, body: { error: "down" } };

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await waitForTraces(1);

    const bodies = ring.get(traces[0].requestId);
    expect(bodies?.target).toHaveLength(2);
    // First hop's body is the ollama dialect, the winner's is openai.
    expect(bodies?.target[0].value).toMatchObject({ model: "llama3" });
    expect(bodies?.target[1].value).toMatchObject({
      model: "fallback-model",
    });
  });

  it("INSPECTOR_BUFFER=0 captures nothing", async () => {
    process.env.INSPECTOR_BUFFER = "0";
    resetConfig();
    // A sink named like a body sink receives the trace unstripped —
    // bodies must simply be absent.
    const seen: (BodySnapshots | undefined)[] = [];
    registerSink({
      name: "body-ring",
      accept: (t) => seen.push(t.bodies),
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(res.status).toBe(200);
    await waitForTraces(1);

    expect(seen).toEqual([undefined]);
  });

  // "0 disables snapshotting entirely" (spec §3.5): with the ring off
  // a streamed request carries no bodies, the tap does no work, and
  // the client stream is identical to the ring-on stream.
  it("INSPECTOR_BUFFER=0 does no capture work on streams", async () => {
    const ring = createBodyRing(50);
    registerSink(ring);

    const on = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    } as object);
    expect(on.status).toBe(200);
    await waitForTraces(1);
    // The tap really ran — the ring holds a wire snapshot.
    expect(
      ring.get(traces[0].requestId)?.response?.wire,
    ).toBeDefined();

    process.env.INSPECTOR_BUFFER = "0";
    resetConfig();
    const seen: (BodySnapshots | undefined)[] = [];
    registerSink({
      name: "body-ring",
      accept: (t) => seen.push(t.bodies),
    });

    const off = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    } as object);
    expect(off.status).toBe(200);
    await waitForTraces(2);

    expect(seen).toEqual([undefined]);
    // Mask per-request volatility (chunk id, created timestamp) —
    // every other byte must match the ring-on stream.
    const mask = (s: string) =>
      s
        .replace(/"id":"[^"]*"/g, '"id":""')
        .replace(/"created":\d+/g, '"created":0');
    expect(mask(off.body as string)).toBe(mask(on.body as string));
  });

  // Review Focus 3: a request carrying a ~8.7 MB base64 image leaves
  // ≤1 MB snapshots marked truncated; a >256 KB upstream stream leaves
  // a ≤256 KB wire snapshot — and the client gets the stream whole.
  it("large bodies are truncated in the ring", async () => {
    const ring = createBodyRing(50);
    registerSink(ring);

    const image =
      "data:image/png;base64," +
      Buffer.alloc(6_500_000).toString("base64");
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await waitForTraces(1);

    const bodies = ring.get(traces[0].requestId);
    for (const snap of [
      bodies?.source,
      bodies?.canonical,
      bodies?.target[0],
    ]) {
      expect(snap?.truncated).toBe(true);
      expect(typeof snap?.value).toBe("string");
      expect(
        Buffer.byteLength(snap!.value as string, "utf8"),
      ).toBeLessThanOrEqual(1_048_576);
    }

    // ~360 KB of NDJSON upstream — the tap holds 256 KB of it.
    const chunk = (i: number) =>
      JSON.stringify({
        model: "llama3",
        created_at: "t",
        message: {
          role: "assistant",
          content: `CHUNK-${i}-` + "x".repeat(60_000),
        },
        done: false,
      });
    const lines = [0, 1, 2, 3, 4, 5].map(chunk);
    lines.push(
      JSON.stringify({
        model: "llama3",
        created_at: "t",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 5,
        eval_count: 5,
      }),
    );
    server.use(
      http.post(`${MOCK_BASE_URLS.ollama}/api/chat`, () =>
        HttpResponse.text(lines.join("\n") + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        }),
      ),
    );

    const before = traces.length;
    const stream = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    } as object);
    expect(stream.status).toBe(200);
    // The tap changed nothing the client sees — the tail arrived.
    expect(stream.body).toContain("CHUNK-5-");
    expect(stream.body).toContain("[DONE]");
    await waitForTraces(before + 1);

    const wire = ring.get(traces[before].requestId)?.response?.wire;
    expect(wire?.truncated).toBe(true);
    expect(typeof wire?.value).toBe("string");
    expect(
      Buffer.byteLength(wire!.value as string, "utf8"),
    ).toBeLessThanOrEqual(262_144);
  });
});

describe("cost on the trace (spec §3.6)", () => {
  /** Prices wiring for these tests: `prices:` overrides + a ref provider. */
  const PRICES_YAML = `default: local
providers:
  local:
    type: ollama
    base_url: ${MOCK_BASE_URLS.ollama}
  openrouter:
    type: openai
    base_url: ${OPENAI2_BASE_URL}
    api_key_env: OPENAI2_API_KEY
  ref:
    type: openai
    base_url: ${MOCK_BASE_URLS.openai}
    api_key_env: OPENAI_API_KEY
aliases:
  fast: local/qwen3-coder:30b
routes:
  - match: flaky
    to: local/qwen3-coder:30b
    fallback: [openrouter/qwen/qwen3-coder]
  - match: "*"
    to: local/llama3
observe:
  would_cost_reference: ref/gpt-4o
prices:
  openrouter/qwen/*: {input: 1, output: 2}
`;

  it("unknown price is null, never 0", async () => {
    // An openai-type winner whose model is in no price source —
    // override list empty, no live_prices, not in the bundled table.
    process.env.TARGET_API = "openai";
    resetConfig();

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        ...openaiFixtures.requests.basic,
        model: "definitely-not-a-real-model-9f3a",
      } as object);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await waitForTraces(1);

    expect(traces[0].costUsd).toBeNull();
    expect(traces[0].priceSource).toBeUndefined();
  });

  // Review Focus 4: the alias "fast", explicit
  // "openrouter/qwen/qwen3-coder" syntax, a fallback hop winning and
  // the ":" model id — every request is priced at the WINNING hop's
  // (provider, model), never the requested string.
  it("prices the winning hop", async () => {
    writeFileSync(TMP_CONFIG, PRICES_YAML);
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();

    // Alias → ollama's colon model wins: priced local, never "fast".
    const alias = await request(app)
      .post("/v1/chat/completions")
      .send({ ...openaiFixtures.requests.basic, model: "fast" } as object);
    expect(alias.status, JSON.stringify(alias.body)).toBe(200);

    // Rule target 503s → the openrouter fallback wins and prices
    // itself through the prices: glob.
    responseOverrides.ollama = { status: 503, body: { error: "down" } };
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ ...openaiFixtures.requests.basic, model: "flaky" } as object);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Explicit provider/model syntax resolves to the same winner.
    const explicit = await request(app)
      .post("/v1/chat/completions")
      .send({
        ...openaiFixtures.requests.basic,
        model: "openrouter/qwen/qwen3-coder",
      } as object);
    expect(explicit.status, JSON.stringify(explicit.body)).toBe(200);

    await waitForTraces(3);
    expect(traces).toHaveLength(3);

    expect(traces[0]).toMatchObject({
      requestedModel: "fast",
      reason: "alias:fast",
      winner: "local",
      costUsd: 0,
      priceSource: "local",
    });
    expect(traces[0].hops[0]).toMatchObject({
      provider: "local",
      model: "qwen3-coder:30b",
      outcome: "ok",
    });

    // The mocks serve 10 in / 8 out: (10×1 + 8×2) USD per 1M.
    const expected = (10 * 1 + 8 * 2) / 1e6;
    for (const [i, requested] of [
      [1, "flaky"],
      [2, "openrouter/qwen/qwen3-coder"],
    ] as const) {
      expect(traces[i]).toMatchObject({
        requestedModel: requested,
        winner: "openrouter",
        priceSource: "override",
      });
      expect(traces[i].costUsd).toBeCloseTo(expected, 12);
      expect(traces[i].hops.at(-1)).toMatchObject({
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        outcome: "ok",
      });
    }
  });

  it("would-have-cost on local rows", async () => {
    writeFileSync(TMP_CONFIG, PRICES_YAML);
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await waitForTraces(1);

    const t = traces[0];
    // local ollama row: real cost $0, but the same tokens priced at
    // ref/gpt-4o's bundled price land in wouldCostUsd.
    expect(t).toMatchObject({
      winner: "local",
      costUsd: 0,
      priceSource: "local",
    });
    const ref = bundledPrices.models["gpt-4o"];
    expect(ref).toBeDefined();
    expect(t.wouldCostUsd).toBeCloseTo(
      (10 * ref.input + 8 * ref.output) / 1e6,
      12,
    );
  });

  // Global Constraints: a cold live-price model list can take the
  // whole upstream timeout, and no sink work may delay the response.
  // The mocked /models below is 1.5 s slow; both requests answer in
  // <1 s, and the traces arrive — priced — once the background lookup
  // settles.
  it("live price fetch never delays the response", async () => {
    writeFileSync(
      TMP_CONFIG,
      `default: live
providers:
  live:
    type: openai
    base_url: ${OPENAI2_BASE_URL}
    api_key_env: OPENAI2_API_KEY
    live_prices: true
routes:
  - match: "*"
    to: live/priced-model
`,
    );
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();

    server.use(
      http.get(`${OPENAI2_BASE_URL}/v1/models`, async () => {
        await new Promise((r) => setTimeout(r, 1500));
        return HttpResponse.json({
          data: [
            {
              id: "priced-model",
              pricing: {
                prompt: "0.000001",
                completion: "0.000002",
              },
            },
          ],
        });
      }),
      http.post(
        `${OPENAI2_BASE_URL}/v1/chat/completions`,
        async ({ request }) => {
          const body = (await request.json()) as { stream?: boolean };
          if (body.stream === true) {
            // An OpenAI-dialect stream whose final usage chunk serves
            // the same 10 in / 8 out as the non-stream mock.
            return HttpResponse.text(
              [
                'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"priced-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
                "",
                'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"priced-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
                "",
                'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"priced-model","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}',
                "",
                "data: [DONE]",
                "",
              ].join("\n"),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return HttpResponse.json(openaiFixtures.responses.basic);
        },
      ),
    );

    const jsonStart = Date.now();
    const res = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Date.now() - jsonStart).toBeLessThan(1000);

    const streamStart = Date.now();
    const streamRes = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    } as object);
    expect(streamRes.status).toBe(200);
    expect(Date.now() - streamStart).toBeLessThan(1000);

    // Exactly one trace per request — emitted once the still-running
    // background price lookup settles: live-priced $1/$2 per 1M on
    // the mock's 10 in / 8 out usage.
    await waitForTraces(2, 5000);
    expect(traces).toHaveLength(2);
    const expected = (10 * 1 + 8 * 2) / 1e6;
    for (const stream of [false, true] as const) {
      const trace = traces.find((t) => t.stream === stream);
      expect(trace).toMatchObject({
        winner: "live",
        stream,
        priceSource: "live",
        inputTokens: 10,
        outputTokens: 8,
      });
      expect(trace!.costUsd).toBeCloseTo(expected, 12);
    }
  });
});

describe("usage store resilience (spec §3.4, Review Focus 2)", () => {
  it("unusable db never breaks serving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-usage-it-"));
    try {
      // (a) A path whose parent is a regular file — mkdir fails; the
      // sink logs one warning naming the path and the fix, disables
      // itself, and requests still answer.
      writeFileSync(join(dir, "a-file"), "x");
      process.env.USAGE_DB = join(dir, "a-file", "usage.db");
      resetConfig();
      const warnSpy = vi.spyOn(logger, "warn");
      expect(getUsageStore()).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          usageDb: join(dir, "a-file", "usage.db"),
        }),
        expect.stringContaining("USAGE_STORE"),
      );

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(openaiFixtures.requests.basic as object);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // (b) A file that is not SQLite at the path — same outcome.
      warnSpy.mockClear();
      resetUsageStore();
      const textDb = join(dir, "text.db");
      writeFileSync(textDb, "this is not sqlite");
      process.env.USAGE_DB = textDb;
      resetConfig();
      expect(getUsageStore()).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      const res2 = await request(app)
        .post("/v1/chat/completions")
        .send(openaiFixtures.requests.basic as object);
      expect(res2.status, JSON.stringify(res2.body)).toBe(200);

      // (c) A second connection holding an exclusive lock — the store
      // stays registered, the flush waits out the 200 ms busy timeout
      // and drops the batch with a warning; the request still answers.
      const locked = join(dir, "locked.db");
      const store = createUsageStore({ path: locked, logBodies: false });
      registerSink(store);
      const holder = openDatabase(locked);
      holder.exec("BEGIN EXCLUSIVE");

      warnSpy.mockClear();
      const res3 = await request(app)
        .post("/v1/chat/completions")
        .send(openaiFixtures.requests.basic as object);
      expect(res3.status, JSON.stringify(res3.body)).toBe(200);
      await waitForTraces(1);
      store.flush();
      expect(store.listRequests({ limit: 10 }).rows).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ usageDb: locked }),
        expect.stringContaining("batch dropped"),
      );
      holder.exec("ROLLBACK");
      holder.close();
      store.close();
    } finally {
      delete process.env.USAGE_DB;
      resetUsageStore();
      resetConfig();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tool-call diagnostics and repair (spec §3.7)", () => {
  /**
   * `fix` repairs tool-call arguments; `plain` (default) only
   * diagnoses. Both are openai-type mocks.
   */
  const REPAIR_YAML = `default: plain
providers:
  plain:
    type: openai
    base_url: ${MOCK_BASE_URLS.openai}
    api_key_env: OPENAI_API_KEY
  fix:
    type: openai
    base_url: ${OPENAI2_BASE_URL}
    api_key_env: OPENAI2_API_KEY
    repair_tool_calls: true
routes:
  - match: fix-*
    to: fix/m
  - match: "*"
    to: plain/m
`;

  const WEATHER_TOOL = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  };

  const FENCED_ARGS = '```json\n{"city": "SENTINEL-9z"}\n```';

  function openaiToolReply(args: string): unknown {
    return {
      id: "chatcmpl-tc",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: args,
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    };
  }

  const requestBody = (
    model: string,
    stream = false,
  ): Record<string, unknown> => ({
    model,
    stream,
    messages: [{ role: "user", content: "weather?" }],
    tools: [WEATHER_TOOL],
  });

  beforeEach(() => {
    writeFileSync(TMP_CONFIG, REPAIR_YAML);
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();
  });

  it("repair on: client receives fixed arguments; trace records repair", async () => {
    responseOverrides2.body = openaiToolReply(FENCED_ARGS);

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(requestBody("fix-x"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body.choices[0].message.tool_calls[0].function.arguments,
    ).toBe('{"city": "SENTINEL-9z"}');

    await waitForTraces(1);
    // Diagnostics describe the original (fenced) arguments.
    expect(traces[0].diagnostics).toEqual([
      { toolCallId: "call_1", name: "get_weather", code: "fenced_json" },
    ]);
    expect(traces[0].repairs).toEqual([
      { toolCallId: "call_1", steps: ["strip_fence"] },
    ]);
  });

  it("ring keeps original arguments when repair is on", async () => {
    const ring = createBodyRing(50);
    registerSink(ring);
    // The ring's canonical snapshot stores the response object — dig
    // out the first tool call's arguments.
    const ringArgs = (requestId: string): string | undefined =>
      (
        ring.get(requestId)?.response?.canonical?.value as
          | {
              message?: {
                toolCalls?: { function: { arguments: string } }[];
              };
            }
          | undefined
      )?.message?.toolCalls?.[0]?.function.arguments;

    // Non-stream: the client gets the repaired string…
    responseOverrides2.body = openaiToolReply(FENCED_ARGS);
    const res = await request(app)
      .post("/v1/chat/completions")
      .send(requestBody("fix-x"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body.choices[0].message.tool_calls[0].function.arguments,
    ).toBe('{"city": "SENTINEL-9z"}');

    // …while the ring's response.canonical keeps the fenced original.
    await waitForTraces(1);
    expect(ringArgs(traces[0].requestId)).toBe(FENCED_ARGS);

    // Stream: same contract — the merged repaired delta reaches the
    // client, the ring's reassembled response keeps the original.
    server.use(
      http.post(`${OPENAI2_BASE_URL}/v1/chat/completions`, () =>
        HttpResponse.text(
          [
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
            "",
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"```json\\n{\\"city\\": \\"SENTINEL-9z\\"}"}}]},"finish_reason":null}]}',
            "",
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\n```"}}]},"finish_reason":null}]}',
            "",
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const stream = await postStream(
      "/v1/chat/completions",
      requestBody("fix-x", true),
    );
    expect(stream.status).toBe(200);
    // The held deltas were released as ONE repaired delta — the exact
    // repaired string, no fenced text.
    expect(stream.body as string).toContain(
      '"arguments":"{\\"city\\": \\"SENTINEL-9z\\"}"',
    );
    expect(stream.body as string).not.toContain("```");

    await waitForTraces(2);
    expect(ringArgs(traces[1].requestId)).toBe(FENCED_ARGS);
  });

  it("repair off: client receives original; trace records fenced_json", async () => {
    responseOverrides.openai = { body: openaiToolReply(FENCED_ARGS) };

    const res = await request(app)
      .post("/v1/chat/completions")
      .send(requestBody("other"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body.choices[0].message.tool_calls[0].function.arguments,
    ).toBe(FENCED_ARGS);

    await waitForTraces(1);
    expect(traces[0].diagnostics).toEqual([
      { toolCallId: "call_1", name: "get_weather", code: "fenced_json" },
    ]);
    expect(traces[0].repairs).toEqual([]);
  });

  it("repair off leaves the stream byte-identical", async () => {
    // OpenAI-dialect upstream stream: fenced arguments split into two
    // deltas. With no repair flag the transform is not inserted —
    // both deltas reach the client exactly as the upstream sent them.
    server.use(
      http.post(`${MOCK_BASE_URLS.openai}/v1/chat/completions`, () =>
        HttpResponse.text(
          [
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
            "",
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"```json\\n{\\"city\\": \\"x\\""}}]},"finish_reason":null}]}',
            "",
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}\\n```"}}]},"finish_reason":null}]}',
            "",
            'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const res = await postStream(
      "/v1/chat/completions",
      requestBody("s", true),
    );
    expect(res.status).toBe(200);
    // The WHOLE client body, byte for byte: deltas in upstream order,
    // none merged, none added. The encoder generates `created` from
    // Date.now(), so that one field is masked to 0 before comparing;
    // `id` is the upstream chunk's ("c"), not generated.
    const EXPECTED =
      [
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"s","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}',
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"s","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"logprobs":null,"finish_reason":null}]}',
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"s","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"```json\\n{\\"city\\": \\"x\\""}}]},"logprobs":null,"finish_reason":null}]}',
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"s","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}\\n```"}}]},"logprobs":null,"finish_reason":null}]}',
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"s","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    expect((res.body as string).replace(/"created":\d+/g, '"created":0')).toBe(
      EXPECTED,
    );

    await waitForTraces(1);
    // Diagnostics still run — on the reassembled ORIGINAL arguments.
    expect(traces[0].diagnostics).toEqual([
      { toolCallId: "call_1", name: "get_weather", code: "fenced_json" },
    ]);
    expect(traces[0].repairs).toEqual([]);
  });
});

describe("/metrics (spec §3.8)", () => {
  it("/metrics requires key when set", async () => {
    // PROXY_API_KEY is read when the app module is built — fresh
    // module graph, as in gateway.test.ts.
    vi.stubEnv("PROXY_API_KEY", "metrics-key");
    vi.resetModules();
    const { app: authed } = await import("../../src/app");
    try {
      const noKey = await request(authed).get("/metrics");
      expect(noKey.status).toBe(401);

      const ok = await request(authed)
        .get("/metrics")
        .set("authorization", "Bearer metrics-key");
      expect(ok.status).toBe(200);
      expect(ok.headers["content-type"]).toContain("text/plain");
      expect(ok.text).toContain("babelgate_requests_total");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("METRICS=off answers 404", async () => {
    process.env.METRICS = "off";
    resetConfig();

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(404);
  });

  it("no prompt text in /metrics", async () => {
    // The sink is created lazily — register it so this request's
    // trace reaches it.
    getMetricsSink();
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gpt-4",
        messages: [
          { role: "user", content: "repeat SENTINEL-metrics-4 back" },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The prompt did reach the upstream — only /metrics must not see it.
    expect(JSON.stringify(capturedRequests.ollama)).toContain(
      "SENTINEL-metrics-4",
    );
    await waitForTraces(1);

    const m = await request(app).get("/metrics");
    expect(m.status).toBe(200);
    expect(m.text).toContain(
      'babelgate_requests_total{source="openai",provider="ollama",model="gpt-4"',
    );
    expect(m.text).toContain('status="ok"');
    expect(m.text).not.toContain("SENTINEL-metrics-4");
  });

  it("aux requests are counted", async () => {
    const count = await request(app)
      .post("/v1beta/models/llama3:countTokens")
      .send(geminiFixtures.requests.basic as object);
    expect(count.status, JSON.stringify(count.body)).toBe(200);

    const models = await request(app).get("/v1/models");
    expect(models.status, JSON.stringify(models.body)).toBe(200);

    const m = await request(app).get("/metrics");
    expect(m.status).toBe(200);
    expect(m.text).toContain(
      'babelgate_aux_requests_total{source="gemini",kind="count_tokens"} 1',
    );
    expect(m.text).toContain(
      'babelgate_aux_requests_total{source="openai",kind="models"} 1',
    );
  });

  // Review Focus 2 (owner decision, v1.3 Task 10): a dropped usage
  // store flush happens on the store's 250 ms timer — it never reaches
  // emitTrace, so the store reports it to the sink-error counter
  // itself.
  it("usage-store failures count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-usage-metrics-"));
    try {
      // A transaction already open on the store's own connection
      // makes flush()'s BEGIN fail (as in Task 7's "flush never
      // throws") — the batch drops and the failure is counted.
      const openSpy = vi.spyOn(sqlite, "openDatabase");
      const store = createUsageStore({
        path: join(dir, "usage.db"),
        logBodies: false,
      });
      const db = openSpy.mock.results[0]!
        .value as ReturnType<typeof openDatabase>;
      registerSink(store);
      db.exec("BEGIN");

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(openaiFixtures.requests.basic as object);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await waitForTraces(1);

      expect(() => store.flush()).not.toThrow();

      const m = await request(app).get("/metrics");
      expect(m.status).toBe(200);
      expect(m.text).toContain(
        'babelgate_sink_errors_total{sink="usage-store"} 1',
      );

      try {
        db.exec("ROLLBACK");
      } catch {
        // flush's catch already rolled the transaction back
      }
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
