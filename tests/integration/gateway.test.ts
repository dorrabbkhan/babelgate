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
import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import request from "supertest";
import { app } from "../../src/app";
import { loadConfig, resetConfig } from "../../src/config/env-config";
import { presetEnv } from "../../src/cli";
import { adapters } from "../../src/transformers";
import { makeCanonicalError } from "../../src/utils/canonical-error";
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
import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import ollamaFixtures from "../fixtures/ollama.json";
import anthropicFixtures from "../fixtures/anthropic.json";

/**
 * One port, every client format (spec §3.2, §3.8): env-only mode with a
 * single ollama target and no SOURCE_API — the request path alone
 * decides the client dialect, including error replies.
 */

const server = setupServer(...upstreamHandlers);

const providers = ["openai", "gemini", "ollama", "anthropic"] as const;

/** Temp YAML inside the repo (deleted in afterEach) — not a fixture. */
const TMP_CONFIG = join(__dirname, ".tmp-gateway.yaml");

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
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  resetStreamCase();
  delete process.env.UPSTREAM_RETRIES;
  delete process.env.MODEL_MAP;
  delete process.env.TARGET_CONTEXT_WINDOW;
  delete process.env.UPSTREAM_TIMEOUT_MS;
  delete process.env.BABELGATE_CONFIG;
  rmSync(TMP_CONFIG, { force: true });
  resetConfig();
});

afterAll(() => {
  server.close();
});

describe("gateway: every format on one port (spec §3.2)", () => {
  it("OpenAI, Anthropic, Gemini and Ollama chat requests all proxy to the ollama target", async () => {
    const openai = await request(app)
      .post("/v1/chat/completions")
      .send(openaiFixtures.requests.basic as object);
    expect(openai.status, JSON.stringify(openai.body)).toBe(200);
    expect(openai.body.object).toBe("chat.completion");

    const anthropic = await request(app)
      .post("/v1/messages")
      .send(anthropicFixtures.requests.basic as object);
    expect(anthropic.status, JSON.stringify(anthropic.body)).toBe(200);
    expect(anthropic.body.type).toBe("message");
    expect(anthropic.body.role).toBe("assistant");

    const gemini = await request(app)
      .post("/v1beta/models/llama3:generateContent")
      .send(geminiFixtures.requests.basic as object);
    expect(gemini.status, JSON.stringify(gemini.body)).toBe(200);
    expect(Array.isArray(gemini.body.candidates)).toBe(true);

    // Ollama's /api/chat streams NDJSON unless stream:false is sent.
    const ollama = await request(app)
      .post("/api/chat")
      .send({ ...ollamaFixtures.requests.basic, stream: false } as object);
    expect(ollama.status, JSON.stringify(ollama.body)).toBe(200);
    expect(ollama.body.message).toBeDefined();
    expect(ollama.body.done).toBe(true);

    // Every request reached the same ollama upstream in its dialect.
    expect(capturedRequests.ollama).toHaveLength(4);
    for (const body of capturedRequests.ollama) {
      expect((body as { messages?: unknown[] }).messages).toBeDefined();
    }
    expect(capturedRequests.openai).toHaveLength(0);
    expect(capturedRequests.anthropic).toHaveLength(0);
    expect(capturedRequests.gemini).toHaveLength(0);
  });

  it("claude code model discovery gets the anthropic list", async () => {
    // Claude Code ≥ 2.1.248 sends x-api-key + Authorization on
    // GET /v1/models?limit=1000 and no anthropic-version
    // (docs: code.claude.com/docs/en/llm-gateway-protocol).
    const res = await request(app)
      .get("/v1/models?limit=1000")
      .set("x-api-key", "test-key")
      .set("authorization", "Bearer test-key");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as { data?: { type?: string }[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data![0]!.type).toBe("model");
  });

  it("auth errors render in the detected dialect", async () => {
    // PROXY_API_KEY is read when the app module is built — fresh module
    // graph per errors.test.ts's authedApp.
    vi.stubEnv("PROXY_API_KEY", "client-key");
    vi.resetModules();
    const { app: authed } = await import("../../src/app");
    const { resetConfig: freshReset } = await import(
      "../../src/config/env-config"
    );
    freshReset();
    try {
      const res = await request(authed)
        .post("/v1/messages")
        .send(anthropicFixtures.requests.basic as object);

      expect(res.status, JSON.stringify(res.body)).toBe(401);
      expect(res.body).toEqual(
        adapters.anthropic.fromCanonicalError(
          makeCanonicalError(
            "authentication",
            "Invalid or missing API key",
          ),
        ),
      );
      expect(capturedRequests.ollama).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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

/**
 * Model → target resolution end to end (spec §3.3): MODEL_MAP rules,
 * explicit `provider/model` names in the Gemini path, and the preset
 * envs building the v1.1-equivalent routing table.
 */
describe("gateway: routing rules (spec §3.3)", () => {
  it("MODEL_MAP still rewrites the upstream model; reply keeps the requested name", async () => {
    process.env.MODEL_MAP = "claude-*=qwen3-coder:30b";
    resetConfig();

    const res = await request(app)
      .post("/v1/messages")
      .send(anthropicFixtures.requests.basic as object);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests.ollama[0]).toMatchObject({
      model: "qwen3-coder:30b",
    });
    expect(res.body.model).toBe("claude-3-opus-20240229");
  });

  // Review Focus 4: a percent-encoded `provider/model` in the Gemini
  // path resolves exactly like a body model — `ollama/qwen3` targets
  // the ollama provider with upstream model `qwen3`; the reply keeps
  // the requested name `ollama/qwen3` (modelVersion on the wire).
  it("gemini path model resolves like a body model", async () => {
    const res = await request(app)
      .post("/v1beta/models/ollama%2Fqwen3:generateContent")
      .send(geminiFixtures.requests.basic as object);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests.ollama[0]).toMatchObject({ model: "qwen3" });
    expect(res.body.modelVersion).toBe("ollama/qwen3");
  });

  // Same resolution through the streaming flow: every streamed element
  // carries modelVersion = the name the client asked for.
  it("gemini path model resolves like a body model — streamed", async () => {
    const res = await postStream(
      "/v1beta/models/ollama%2Fqwen3:streamGenerateContent",
      geminiFixtures.requests.basic as object,
    );

    expect(res.status).toBe(200);
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests.ollama[0]).toMatchObject({ model: "qwen3" });

    // No alt=sse → the streamed JSON array form; every element carries
    // modelVersion = the name the client asked for.
    const elements = JSON.parse(res.body as string) as {
      modelVersion?: string;
    }[];
    expect(elements.length).toBeGreaterThan(0);
    for (const el of elements) {
      expect(el.modelVersion).toBe("ollama/qwen3");
    }
  });

  it("preset envs build the v1.1-equivalent routing", () => {
    // The claude-code preset env (spec §4.2 golden test): one provider
    // named after TARGET_API carrying TARGET_CONTEXT_WINDOW, a
    // claude-* rule from MODEL_MAP, no provider timeout override — the
    // preset's UPSTREAM_TIMEOUT_MS applies globally instead.
    const env = presetEnv(
      { preset: "claude-code", target: "ollama", model: "m" },
      {},
    );
    Object.assign(process.env, env);
    resetConfig();

    const config = loadConfig();
    expect(config.registry.names()).toEqual(["ollama"]);
    const entry = config.registry.get("ollama");
    expect(entry).toMatchObject({
      name: "ollama",
      type: "ollama",
      baseUrl: MOCK_BASE_URLS.ollama,
      contextWindow: 32768,
    });
    expect(entry.timeoutMs).toBeUndefined();
    expect(config.upstreamTimeoutMs).toBe(600000);
    expect(config.routing).toEqual({
      defaultProvider: "ollama",
      aliases: {},
      rules: [
        {
          match: "claude-*",
          to: { provider: "ollama", model: "m" },
          fallback: [],
        },
      ],
    });

    // The openai-apps preset env is just TARGET_API → one provider, no
    // rules.
    Object.assign(
      process.env,
      presetEnv({ preset: "openai-apps", target: "openai" }, {}),
    );
    delete process.env.MODEL_MAP;
    delete process.env.TARGET_CONTEXT_WINDOW;
    delete process.env.UPSTREAM_TIMEOUT_MS;
    resetConfig();

    const openaiConfig = loadConfig();
    expect(openaiConfig.registry.names()).toEqual(["openai"]);
    expect(openaiConfig.routing).toEqual({
      defaultProvider: "openai",
      aliases: {},
      rules: [],
    });
  });
});

/**
 * Fallbacks, routing headers and the route log line (spec §3.4): a
 * three-provider YAML config — an Ollama primary carrying a context
 * window, a dead provider on a closed port, a slow Ollama with a 50ms
 * header timeout — and a second OpenAI-type host as every route's
 * fallback target.
 */
const GATEWAY_YAML = `default: main
providers:
  main:
    type: ollama
    base_url: ${MOCK_BASE_URLS.ollama}
    context_window: 32768
  slow:
    type: ollama
    base_url: ${MOCK_BASE_URLS.ollama}
    timeout_ms: 50
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
    to: slow/stall
    fallback: [second/fallback-model]
  - match: "*"
    to: main/llama3
    fallback: [second/fallback-model]
`;

describe("gateway: fallbacks and routing headers (spec §3.4)", () => {
  beforeEach(() => {
    writeFileSync(TMP_CONFIG, GATEWAY_YAML);
    process.env.BABELGATE_CONFIG = TMP_CONFIG;
    resetConfig();
  });

  const openaiChat = (body: object) =>
    request(app).post("/v1/chat/completions").send(body);

  it("503 → fallback succeeds", async () => {
    responseOverrides.ollama = { status: 503, body: { error: "down" } };

    const res = await openaiChat(
      openaiFixtures.requests.basic as object,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.headers["x-babelgate-provider"]).toBe("second");
    expect(res.headers["x-babelgate-model"]).toBe("fallback-model");
    expect(res.headers["x-babelgate-attempts"]).toBe("2");
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests2).toHaveLength(1);
  });

  it("429 → fallback succeeds", async () => {
    responseOverrides.ollama = { status: 429, body: { error: "slow" } };

    const res = await openaiChat(
      openaiFixtures.requests.basic as object,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.headers["x-babelgate-provider"]).toBe("second");
    expect(res.headers["x-babelgate-attempts"]).toBe("2");
    expect(capturedRequests2).toHaveLength(1);
  });

  it("header timeout → fallback succeeds", async () => {
    // The Ollama host never answers; the `slow` provider's 50ms
    // timeout_ms fires first and the fallback takes over.
    server.use(
      http.post(`${MOCK_BASE_URLS.ollama}/api/chat`, async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
    );

    const res = await openaiChat({
      ...openaiFixtures.requests.basic,
      model: "slow-x",
    } as object);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["x-babelgate-provider"]).toBe("second");
    expect(res.headers["x-babelgate-attempts"]).toBe("2");
    expect(capturedRequests2).toHaveLength(1);
  });

  it("closed port → fallback succeeds", async () => {
    const res = await openaiChat({
      ...openaiFixtures.requests.basic,
      model: "dead-x",
    } as object);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["x-babelgate-provider"]).toBe("second");
    expect(res.headers["x-babelgate-attempts"]).toBe("2");
    expect(capturedRequests2).toHaveLength(1);
  });

  it("400 → no fallback", async () => {
    responseOverrides.ollama = { status: 400, body: { error: "bad" } };

    const res = await openaiChat(
      openaiFixtures.requests.basic as object,
    );

    expect(res.status).toBe(400);
    expect(res.headers["x-babelgate-attempts"]).toBe("1");
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests2).toHaveLength(0);
  });

  it("401 → no fallback", async () => {
    responseOverrides.ollama = {
      status: 401,
      body: { error: "unauthorized" },
    };

    const res = await openaiChat(
      openaiFixtures.requests.basic as object,
    );

    // The upstream rejected the proxy's credentials — the §3.3
    // credentials rule renders that as 502 "upstream", never 401 (a
    // 401 would wrongly blame the client's own key).
    expect(res.status).toBe(502);
    expect(res.headers["x-babelgate-attempts"]).toBe("1");
    expect(capturedRequests2).toHaveLength(0);
  });

  it("stream non-2xx → fallback", async () => {
    responseOverrides.ollama = { status: 503, body: { error: "down" } };

    const res = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["x-babelgate-provider"]).toBe("second");
    expect(res.headers["x-babelgate-attempts"]).toBe("2");
    expect(res.body as string).toContain("data:");
    expect(capturedRequests2).toHaveLength(1);
  });

  it("stream after 2xx headers then upstream death → in-stream error, one attempt", async () => {
    // Headers arrive (target committed), one NDJSON line lands, then
    // the connection dies: the client gets an in-stream error, and no
    // second target is tried.
    server.use(
      http.post(`${MOCK_BASE_URLS.ollama}/api/chat`, async ({ request }) => {
        capturedRequests.ollama.push(await request.json());
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                '{"model":"llama3","created_at":"t","message":{"role":"assistant","content":"hi"},"done":false}\n',
              ),
            );
            c.error(new Error("socket hangup"));
          },
        });
        return new HttpResponse(body, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }),
    );

    const res = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers["x-babelgate-provider"]).toBe("main");
    expect(res.headers["x-babelgate-attempts"]).toBe("1");
    expect(res.body as string).toContain('"error"');
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests2).toHaveLength(0);
  });

  it("all fail → last error in the client's dialect with x-babelgate-attempts: 2", async () => {
    responseOverrides.ollama = { status: 503, body: { error: "down" } };
    responseOverrides2.status = 400;
    responseOverrides2.body = {
      error: { message: "bad request", type: "invalid_request_error" },
    };

    const res = await openaiChat(
      openaiFixtures.requests.basic as object,
    );

    // The second (OpenAI) target's 400 is the last error — rendered in
    // the client's OpenAI dialect, carrying the attempt count.
    expect(res.status).toBe(400);
    expect(res.headers["x-babelgate-attempts"]).toBe("2");
    expect(
      (res.body as { error?: unknown }).error,
      JSON.stringify(res.body),
    ).toBeDefined();
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests2).toHaveLength(1);
  });

  it("x-babelgate-* headers on JSON and stream replies", async () => {
    const json = await openaiChat(
      openaiFixtures.requests.basic as object,
    );
    expect(json.status).toBe(200);
    expect(json.headers["x-babelgate-provider"]).toBe("main");
    expect(json.headers["x-babelgate-model"]).toBe("llama3");
    expect(json.headers["x-babelgate-attempts"]).toBe("1");

    const stream = await postStream("/v1/chat/completions", {
      ...openaiFixtures.requests.basic,
      stream: true,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers["x-babelgate-provider"]).toBe("main");
    expect(stream.headers["x-babelgate-model"]).toBe("llama3");
    expect(stream.headers["x-babelgate-attempts"]).toBe("1");
  });

  // Review Focus 3: every attempt encodes from the original canonical
  // request — the primary's context_window never reaches the OpenAI
  // fallback body, and a later request to the primary still sends
  // num_ctx 32768.
  it("each attempt encodes from the original canonical", async () => {
    responseOverrides.ollama = { status: 503, body: { error: "down" } };

    const first = await openaiChat(
      openaiFixtures.requests.basic as object,
    );
    expect(first.status).toBe(200);
    expect(capturedRequests.ollama).toHaveLength(1);
    expect(capturedRequests.ollama[0]).toMatchObject({
      model: "llama3",
      options: { num_ctx: 32768 },
    });
    expect(capturedRequests2).toHaveLength(1);
    expect(capturedRequests2[0]).toMatchObject({
      model: "fallback-model",
    });
    expect(capturedRequests2[0]).not.toHaveProperty("num_ctx");

    const second = await openaiChat(
      openaiFixtures.requests.basic as object,
    );
    expect(second.status).toBe(200);
    expect(capturedRequests.ollama).toHaveLength(2);
    expect(capturedRequests.ollama[1]).toMatchObject({
      model: "llama3",
      options: { num_ctx: 32768 },
    });
  });

  it("route log line has no prompt text", async () => {
    const infoSpy = vi.spyOn(logger, "info");

    const res = await openaiChat({
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
