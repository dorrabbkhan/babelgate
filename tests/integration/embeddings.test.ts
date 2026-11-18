import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupServer } from "msw/node";
import request from "supertest";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import {
  registerSink,
  resetSinks,
  type TraceSink,
} from "../../src/observe/emit";
import { createLogSink } from "../../src/observe/sinks/log";
import type { RequestTrace } from "../../src/observe/trace";
import {
  upstreamHandlers,
  capturedRequests,
  capturedRequests2,
  responseOverrides,
  resetCaptured,
  resetOverrides,
  resetEmbedUsage,
  embedUsage,
  MOCK_BASE_URLS,
  OPENAI2_BASE_URL,
  DEAD_BASE_URL,
  EMBED_VECTOR,
  EMBED_PROMPT_TOKENS,
} from "../mocks/upstreams";

/**
 * POST /v1/embeddings (v1.5 spec §3.6): OpenAI-dialect inbound only —
 * model-name routing, aliases and fallbacks apply exactly as chat;
 * usage and cost are recorded on the request trace.
 */

const server = setupServer(...upstreamHandlers);

const providers = [
  "openai",
  "gemini",
  "ollama",
  "anthropic",
  "responses",
] as const;

/** Temp YAML inside the repo (deleted in afterEach) — not a fixture. */
const TMP_CONFIG = join(__dirname, ".tmp-embeddings.yaml");

/** Every trace emitTrace fans out — the test's own sink. */
const traces: RequestTrace[] = [];
const recorder: TraceSink = {
  name: "recorder",
  accept: (t) => traces.push(t),
};

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
  resetEmbedUsage();
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.BABELGATE_CONFIG;
  rmSync(TMP_CONFIG, { force: true });
  resetConfig();
});

afterAll(() => {
  server.close();
});

describe("embeddings (spec §3.6)", () => {
  it("string input normalized to array", async () => {
    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "m", input: "hello" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The ollama upstream saw a string ARRAY, not the client's bare
    // string.
    expect(capturedRequests.ollama).toHaveLength(1);
    const upstream = capturedRequests.ollama[0] as { input: string[] };
    expect(upstream.input).toEqual(["hello"]);

    // Reply is the OpenAI embeddings shape.
    expect(res.body.object).toBe("list");
    expect(res.body.model).toBe("m");
    expect(res.body.data).toEqual([
      { object: "embedding", index: 0, embedding: EMBED_VECTOR },
    ]);
    expect(res.body.usage).toEqual({
      prompt_tokens: EMBED_PROMPT_TOKENS,
      total_tokens: EMBED_PROMPT_TOKENS,
    });
  });

  it("gemini target maps dimensions", async () => {
    process.env.TARGET_API = "gemini";
    resetConfig();

    const res = await request(app)
      .post("/v1/embeddings")
      .send({
        model: "gemini-embedding-001",
        input: ["a", "b"],
        dimensions: 256,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The mock only answers an embeddings shape on the
    // :batchEmbedContents path — a 200 already proves it; assert the
    // per-request mapping too (each request re-peats `models/<m>`).
    expect(capturedRequests.gemini).toHaveLength(1);
    const upstream = capturedRequests.gemini[0] as {
      requests: {
        model: string;
        outputDimensionality?: number;
        content: { parts: { text: string }[] };
      }[];
    };
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[0]).toMatchObject({
      model: "models/gemini-embedding-001",
      outputDimensionality: 256,
      content: { parts: [{ text: "a" }] },
    });
    expect(upstream.requests[1]!.outputDimensionality).toBe(256);

    // This mock reply carries no usageMetadata — the client still
    // gets an OpenAI usage block (the chars/4 estimate).
    expect(res.body.data).toHaveLength(2);
    expect(res.body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it("gemini usageMetadata.promptTokenCount is the usage", async () => {
    process.env.TARGET_API = "gemini";
    embedUsage.gemini = 7;
    resetConfig();

    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "gemini-embedding-001", input: ["a", "b"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The upstream-reported count flows straight through — no
    // chars/4 estimate, no costEstimated on the trace.
    expect(res.body.usage).toEqual({
      prompt_tokens: 7,
      total_tokens: 7,
    });

    await waitForTraces(1);
    expect(traces[0]).toMatchObject({
      winner: "gemini",
      inputTokens: 7,
      costEstimated: false,
    });
  });

  it("gemini reply without usageMetadata estimates usage", async () => {
    process.env.TARGET_API = "gemini";
    resetConfig();

    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "gemini-embedding-001", input: ["a", "b"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // chars/4 per input: "a" + "b" → 1 + 1 = 2.
    expect(res.body.usage).toEqual({
      prompt_tokens: 2,
      total_tokens: 2,
    });

    await waitForTraces(1);
    expect(traces[0]).toMatchObject({
      winner: "gemini",
      inputTokens: 2,
      costEstimated: true,
    });
  });

  it("ollama target maps", async () => {
    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "m", input: ["a", "b"], dimensions: 128 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // /api/embed is a dedicated mock handler — a 200 proves the path.
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests.ollama[0]).toEqual({
      model: "m",
      input: ["a", "b"],
      dimensions: 128,
    });
    expect(res.body.data).toHaveLength(2);
  });

  it("anthropic target 501 in openai envelope", async () => {
    process.env.TARGET_API = "anthropic";
    resetConfig();

    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "claude-3", input: "x" });
    expect(res.status, JSON.stringify(res.body)).toBe(501);
    expect(res.body).toEqual({
      error: {
        message: expect.any(String),
        type: "invalid_request_error",
        param: null,
        code: "unsupported",
      },
    });
    // The refusal happens before the upstream call.
    expect(capturedRequests.anthropic).toHaveLength(0);
  });

  it("responses target 501 in openai envelope", async () => {
    process.env.TARGET_API = "responses";
    resetConfig();

    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "m", input: "x" });
    expect(res.status, JSON.stringify(res.body)).toBe(501);
    expect(res.body.error.type).toBe("invalid_request_error");
    expect(res.body.error.code).toBe("unsupported");
    expect(capturedRequests.responses).toHaveLength(0);
  });

  it("base64 encoding matches float32 LE", async () => {
    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "m", input: "x", encoding_format: "base64" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Babelgate encodes: base64 of little-endian float32 bytes of the
    // vector the upstream served.
    const expected = Buffer.alloc(EMBED_VECTOR.length * 4);
    EMBED_VECTOR.forEach((v, i) => expected.writeFloatLE(v, i * 4));
    expect(res.body.data[0].embedding).toBe(expected.toString("base64"));
  });

  it("alias and fallback route embeddings", async () => {
    writeFileSync(
      TMP_CONFIG,
      `default: dead
providers:
  dead:
    type: openai
    base_url: ${DEAD_BASE_URL}
    api_key_env: OPENAI_API_KEY
  second:
    type: openai
    base_url: ${OPENAI2_BASE_URL}
    api_key_env: OPENAI2_API_KEY
aliases:
  emb-fast: second/aliased-model
routes:
  - match: "emb-*"
    to: dead/gone
    fallback: [second/fallback-model]
`,
    );
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();

    // Alias: /embeddings (no /v1 prefix) resolves to second/aliased-model.
    const alias = await request(app)
      .post("/embeddings")
      .send({ model: "emb-fast", input: "x" });
    expect(alias.status, JSON.stringify(alias.body)).toBe(200);
    expect(
      (capturedRequests2[0] as { model: string }).model,
    ).toBe("aliased-model");
    expect(alias.body.model).toBe("emb-fast");

    // Rule match: dead primary (closed port) → fallback serves.
    const fallback = await request(app)
      .post("/v1/embeddings")
      .send({ model: "emb-x", input: "x" });
    expect(fallback.status, JSON.stringify(fallback.body)).toBe(200);
    expect(fallback.headers["x-babelgate-provider"]).toBe("second");
    expect(fallback.headers["x-babelgate-model"]).toBe("fallback-model");
    expect(fallback.headers["x-babelgate-attempts"]).toBe("2");
    expect(
      (capturedRequests2[1] as { model: string }).model,
    ).toBe("fallback-model");
    // The reply carries the client's model name, not the routed one.
    expect(fallback.body.model).toBe("emb-x");
  });

  it("usage recorded", async () => {
    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "m", input: ["a", "b"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await waitForTraces(1);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      sourceApi: "openai",
      requestedModel: "m",
      reason: "default",
      winner: "ollama",
      status: "ok",
      httpStatus: 200,
      stream: false,
      inputTokens: EMBED_PROMPT_TOKENS,
      outputTokens: 0,
      // ollama entries price at $0 (local source) — cost is recorded.
      costUsd: 0,
      priceSource: "local",
    });
    expect(traces[0]!.hops).toEqual([
      expect.objectContaining({
        provider: "ollama",
        model: "m",
        outcome: "ok",
      }),
    ]);
  });
});
