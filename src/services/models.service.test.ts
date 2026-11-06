import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  createModelListCache,
  proxyModelList,
  resetModelListCache,
} from "./models.service";
import type { GatewayConfig } from "../config/env-config";
import {
  createRegistry,
  type ProviderEntry,
} from "../routing/registry";
import type { RouteTarget } from "../routing/plan-route";
import { PROVIDER_ROUTES, type Provider } from "../transformers";
import { UpstreamError } from "../utils/errors";

vi.mock("./http-client", () => ({
  postJson: vi.fn(),
  getJson: vi.fn(),
  postStream: vi.fn(),
}));

import { getJson } from "./http-client";

const mockGetJson = vi.mocked(getJson);

/**
 * The merged model list (spec §3.6): aliases first as bare names, the
 * default provider's models bare, then every other provider's models
 * as <provider>/<model>, deduped on first occurrence. Fetch failures
 * omit a provider (x-babelgate-partial) or, when every provider fails,
 * surface the default's error exactly as v1.1.
 */

const OPENAI_MODELS_ROUTE = PROVIDER_ROUTES.openai.find(
  (r) => r.kind === "models",
)!;

const entry = (
  name: string,
  type: Provider,
  baseUrl: string,
): ProviderEntry => ({ name, type, baseUrl });

function gatewayConfig(
  providers: ProviderEntry[],
  defaultProvider: string,
  aliases: Record<string, RouteTarget> = {},
): GatewayConfig {
  return {
    port: 3000,
    upstreamTimeoutMs: 30_000,
    upstreamRetries: 0,
    upstreamStreamIdleMs: 300_000,
    registry: createRegistry(providers),
    routing: { defaultProvider, aliases, rules: [] },
    observe: {
      usageStore: true,
      usageDb: ":memory:",
      retentionDays: 30,
      inspectorBuffer: 50,
      logBodies: false,
      metrics: true,
      ui: true,
      uiAllowRemote: false,
      uiAllowedHosts: [],
    },
  };
}

const OLLAMA_LIST = {
  models: [
    { name: "llama3", model: "llama3" },
    { name: "qwen3", model: "qwen3" },
  ],
};

const OPENAI_LIST = {
  object: "list",
  data: [{ id: "gpt-x" }],
};

const ANTHROPIC_LIST = {
  data: [{ id: "claude-y" }],
};

function mockListsByUrl(bodies: Record<string, unknown>): void {
  mockGetJson.mockImplementation(({ url }) =>
    url in bodies
      ? Promise.resolve({ status: 200, body: bodies[url], durationMs: 1 })
      : Promise.reject(new Error(`unexpected url ${url}`)),
  );
}

const openaiIds = (result: { body?: unknown }): string[] =>
  (result.body as { data: { id: string }[] }).data.map((m) => m.id);

beforeEach(() => {
  resetModelListCache();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("proxyModelList", () => {
  it("order: aliases, default bare, others prefixed", async () => {
    mockListsByUrl({
      "http://main.test/api/tags": OLLAMA_LIST,
      "http://second.test/v1/models": OPENAI_LIST,
      "http://third.test/v1/models": ANTHROPIC_LIST,
    });
    const config = gatewayConfig(
      [
        entry("main", "ollama", "http://main.test"),
        entry("second", "openai", "http://second.test"),
        entry("third", "anthropic", "http://third.test"),
      ],
      "main",
      { fast: { provider: "second", model: "gpt-x" } },
    );

    const result = await proxyModelList(
      "openai",
      OPENAI_MODELS_ROUTE,
      config,
      "r1",
    );

    expect(openaiIds(result)).toEqual([
      "fast",
      "llama3",
      "qwen3",
      "second/gpt-x",
      "third/claude-y",
    ]);
    // Nothing failed → no partial header.
    expect(result.headers).toBeUndefined();
  });

  it("first occurrence wins on a duplicate id", async () => {
    // The alias `fast` wins over the default provider's own `fast`
    // model: the merged id is emitted once, in the alias slot.
    mockListsByUrl({
      "http://main.test/api/tags": {
        models: [
          { name: "fast", model: "fast" },
          { name: "llama3", model: "llama3" },
        ],
      },
    });
    const config = gatewayConfig(
      [entry("main", "ollama", "http://main.test")],
      "main",
      { fast: { provider: "main", model: "llama3" } },
    );

    const result = await proxyModelList(
      "openai",
      OPENAI_MODELS_ROUTE,
      config,
      "r1",
    );

    expect(openaiIds(result)).toEqual(["fast", "llama3"]);
  });

  it("cache hit within 60 s, refetch after", async () => {
    // Injected clock on the factory: an entry fetched at t=0 is fresh
    // at t=59 999 ms and stale — fetched again — at t=60 000 ms.
    let t = 0;
    const cache = createModelListCache(60_000, () => t);
    const list = { models: [{ id: "m" }] };
    cache.set("p", "http://u", list);

    t = 59_999;
    expect(cache.get("p", "http://u")).toBe(list);

    t = 60_000;
    expect(cache.get("p", "http://u")).toBeUndefined();

    // The service consults the shared cache: a second call inside the
    // TTL does not fetch again.
    mockListsByUrl({ "http://main.test/api/tags": OLLAMA_LIST });
    const config = gatewayConfig(
      [entry("main", "ollama", "http://main.test")],
      "main",
    );
    await proxyModelList("openai", OPENAI_MODELS_ROUTE, config, "r1");
    await proxyModelList("openai", OPENAI_MODELS_ROUTE, config, "r2");
    expect(mockGetJson).toHaveBeenCalledTimes(1);
  });

  it("failed fetch is not cached", async () => {
    mockGetJson
      .mockRejectedValueOnce(new UpstreamError("Upstream unreachable"))
      .mockResolvedValue({
        status: 200,
        body: { models: [{ name: "llama3", model: "llama3" }] },
        durationMs: 1,
      });
    const config = gatewayConfig(
      [entry("main", "ollama", "http://main.test")],
      "main",
    );

    await expect(
      proxyModelList("openai", OPENAI_MODELS_ROUTE, config, "r1"),
    ).rejects.toBeInstanceOf(UpstreamError);

    // The failure was not cached: the next call fetches and succeeds.
    const result = await proxyModelList(
      "openai",
      OPENAI_MODELS_ROUTE,
      config,
      "r2",
    );
    expect(mockGetJson).toHaveBeenCalledTimes(2);
    expect(openaiIds(result)).toEqual(["llama3"]);
  });
});
