import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { livePrice } from "./live-prices";
import type { GatewayConfig } from "../config/env-config";
import {
  createRegistry,
  type ProviderEntry,
} from "../routing/registry";
import { resetModelListCache } from "../services/models.service";

vi.mock("../services/http-client", () => ({
  postJson: vi.fn(),
  getJson: vi.fn(),
  postStream: vi.fn(),
}));

import { getJson } from "../services/http-client";

const mockGetJson = vi.mocked(getJson);

/**
 * §3.6 step 3: providers with `live_prices: true` read the OpenRouter
 * `pricing` block (string USD per token: prompt, completion,
 * input_cache_read, input_cache_write) off the shared model-list
 * fetch — same 60 s cache as /models, raw body decoded on read.
 */
const entry: ProviderEntry = {
  name: "openrouter",
  type: "openai",
  baseUrl: "http://openrouter.test",
  livePrices: true,
};

const config = {
  port: 3000,
  upstreamTimeoutMs: 30_000,
  upstreamRetries: 0,
  upstreamStreamIdleMs: 300_000,
  registry: createRegistry([entry]),
  routing: { defaultProvider: "openrouter", aliases: {}, rules: [] },
  observe: {
    usageStore: false,
    usageDb: ":memory:",
    retentionDays: 30,
    inspectorBuffer: 0,
    logBodies: false,
    metrics: false,
    ui: false,
    uiAllowRemote: false,
    uiAllowedHosts: [],
  },
} satisfies GatewayConfig;

beforeEach(() => {
  resetModelListCache();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("livePrice (spec §3.6)", () => {
  it("converts string USD/token to USD per 1M", async () => {
    mockGetJson.mockResolvedValue({
      status: 200,
      body: {
        data: [
          {
            id: "qwen/qwen3-coder",
            pricing: {
              prompt: "0.00000022",
              completion: "0.00000095",
              input_cache_read: "0.00000002",
              input_cache_write: "0.00000026",
            },
          },
        ],
      },
      durationMs: 1,
    });
    const price = await livePrice(
      entry,
      "qwen/qwen3-coder",
      config,
      "r1",
    );
    expect(price).toEqual({
      input: 0.22,
      output: 0.95,
      cacheRead: 0.02,
      cacheWrite: 0.26,
    });
  });

  it("model absent from the list or without pricing → undefined", async () => {
    mockGetJson.mockResolvedValue({
      status: 200,
      body: { data: [{ id: "other-model" }] },
      durationMs: 1,
    });
    await expect(
      livePrice(entry, "qwen/qwen3-coder", config, "r1"),
    ).resolves.toBeUndefined();
  });

  // OpenRouter's "-1" (dynamic/custom pricing, e.g. openrouter/auto)
  // is "no usable price", not a negative cost.
  it("negative live price falls back", async () => {
    mockGetJson.mockResolvedValue({
      status: 200,
      body: {
        data: [
          { id: "m", pricing: { prompt: "-1", completion: "-1" } },
        ],
      },
      durationMs: 1,
    });
    await expect(
      livePrice(entry, "m", config, "r1"),
    ).resolves.toBeUndefined();

    // A negative cache price is absent, so cacheRead falls back to
    // `input` at compute time — it is not priced at -$1M.
    resetModelListCache();
    mockGetJson.mockResolvedValue({
      status: 200,
      body: {
        data: [
          {
            id: "m",
            pricing: {
              prompt: "0.000001",
              completion: "0.000002",
              input_cache_read: "-1",
            },
          },
        ],
      },
      durationMs: 1,
    });
    await expect(livePrice(entry, "m", config, "r1")).resolves.toEqual({
      input: 1,
      output: 2,
    });
  });

  it("shares the model-list 60 s cache — no second fetch", async () => {
    mockGetJson.mockResolvedValue({
      status: 200,
      body: {
        data: [
          {
            id: "m",
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      },
      durationMs: 1,
    });
    await livePrice(entry, "m", config, "r1");
    await livePrice(entry, "m", config, "r2");
    expect(mockGetJson).toHaveBeenCalledTimes(1);
  });
});
