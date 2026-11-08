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
import request from "supertest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { app } from "../app";
import { resetConfig } from "../config/env-config";
import { resetModelListCache } from "../services/models.service";

/**
 * GET /ui/api/routing and /routing/plan (spec §3.9): providers (name,
 * type, base URL, flags, caps — never keys), aliases, ordered rules,
 * the default provider, and price + source per configured model; the
 * plan dry run resolves a model without an upstream call.
 *
 * The msw catch-all counts upstream hits so the dry-run test can prove
 * none were made; src tests cannot import tests/mocks
 * (tsconfig rootDir).
 */

const OLLAMA_URL = "http://ollama.mock";
const OPENAI_URL = "http://openai.mock";

const upstreamCalls: string[] = [];
const server = setupServer(
  http.all(`${OLLAMA_URL}/*`, ({ request }) => {
    upstreamCalls.push(request.url);
    return new HttpResponse(null, { status: 500 });
  }),
  http.all(`${OPENAI_URL}/*`, ({ request }) => {
    upstreamCalls.push(request.url);
    return new HttpResponse(null, { status: 500 });
  }),
);

const UI = { "x-babelgate-ui": "1" };

/** Temp YAML inside the repo (deleted in afterEach) — not a fixture. */
const TMP_CONFIG = join(__dirname, ".tmp-uiapi.yaml");

const GATEWAY_YAML = `default: main
providers:
  main:
    type: ollama
    base_url: ${OLLAMA_URL}
    max_output_tokens: 2048
  cloud:
    type: openai
    base_url: ${OPENAI_URL}
    api_key_env: FAKE_UI_KEY_ENV
    cache_hints: true
aliases:
  fast: cloud/gpt-4o-mini
routes:
  - match: big-*
    to: cloud/gpt-4
    fallback: [main/llama3]
prices:
  cloud/gpt-4:
    input: 5
    output: 15
`;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

beforeEach(() => {
  process.env.FAKE_UI_KEY_ENV = "sk-fake-DO-NOT-LEAK-12345";
  process.env.USAGE_STORE = "off";
  writeFileSync(TMP_CONFIG, GATEWAY_YAML);
  process.env.BABELGATE_CONFIG = TMP_CONFIG;
  resetModelListCache();
  resetConfig();
  upstreamCalls.length = 0;
});

afterEach(() => {
  server.resetHandlers();
  delete process.env.FAKE_UI_KEY_ENV;
  delete process.env.USAGE_STORE;
  delete process.env.BABELGATE_CONFIG;
  rmSync(TMP_CONFIG, { force: true });
  resetConfig();
});

afterAll(() => {
  server.close();
});

describe("GET /ui/api/routing", () => {
  it("returns providers, aliases, ordered rules, default and prices", async () => {
    const res = await request(app).get("/ui/api/routing").set(UI);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(res.body.providers).toEqual([
      {
        name: "main",
        type: "ollama",
        baseUrl: OLLAMA_URL,
        maxOutputTokens: 2048,
        cacheHints: false,
        livePrices: false,
        repairToolCalls: false,
        local: false,
      },
      {
        name: "cloud",
        type: "openai",
        baseUrl: OPENAI_URL,
        cacheHints: true,
        livePrices: false,
        repairToolCalls: false,
        local: false,
      },
    ]);
    expect(res.body.aliases).toEqual({
      fast: { provider: "cloud", model: "gpt-4o-mini" },
    });
    expect(res.body.rules).toEqual([
      {
        match: "big-*",
        to: { provider: "cloud", model: "gpt-4" },
        fallback: [{ provider: "main", model: "llama3" }],
      },
    ]);
    expect(res.body.defaultProvider).toBe("main");

    const prices = res.body.prices as {
      target: string;
      price?: { input: number; output: number };
      source?: string;
    }[];
    const byTarget = Object.fromEntries(
      prices.map((p) => [p.target, p]),
    );
    expect(byTarget["cloud/gpt-4"]).toMatchObject({
      price: { input: 5, output: 15 },
      source: "override",
    });
    expect(byTarget["main/llama3"]).toMatchObject({
      price: { input: 0, output: 0 },
      source: "local",
    });
    // gpt-4o-mini is in the bundled LiteLLM table.
    expect(byTarget["cloud/gpt-4o-mini"].source).toBe("bundled");
    expect(byTarget["cloud/gpt-4o-mini"].price?.input).toBeGreaterThan(
      0,
    );
  });

  it("routing never contains keys", async () => {
    const res = await request(app).get("/ui/api/routing").set(UI);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("sk-fake-DO-NOT-LEAK-12345");
    expect(text).not.toContain("FAKE_UI_KEY_ENV");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("api_key_env");
  });
});

describe("GET /ui/api/routing/plan", () => {
  it("plan dry run makes no upstream call", async () => {
    const res = await request(app)
      .get("/ui/api/routing/plan?model=big-llm")
      .set(UI);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      targets: [
        { provider: "cloud", model: "gpt-4" },
        { provider: "main", model: "llama3" },
      ],
      reason: "rule:0",
    });
    expect(upstreamCalls).toEqual([]);
  });

  it("resolves an alias and the default", async () => {
    const alias = await request(app)
      .get("/ui/api/routing/plan?model=fast")
      .set(UI);
    expect(alias.body).toEqual({
      targets: [{ provider: "cloud", model: "gpt-4o-mini" }],
      reason: "alias:fast",
    });
    const other = await request(app)
      .get("/ui/api/routing/plan?model=something")
      .set(UI);
    expect(other.body).toEqual({
      targets: [{ provider: "main", model: "something" }],
      reason: "default",
    });
  });

  it("400s without a model", async () => {
    const res = await request(app).get("/ui/api/routing/plan").set(UI);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: expect.any(String) });
  });
});
