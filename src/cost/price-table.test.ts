import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookupPrice } from "./price-table";
import bundled from "./prices.json";
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
 * §3.6 lookup order for the winning hop's (provider, model):
 * override (top-level `prices:` globs) → local ($0) → live
 * (model-list `pricing`, when live_prices) → bundled prices.json →
 * unknown is undefined, never $0.
 */
function config(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 3000,
    upstreamTimeoutMs: 30_000,
    upstreamRetries: 0,
    upstreamStreamIdleMs: 300_000,
    registry: createRegistry([]),
    routing: { defaultProvider: "main", aliases: {}, rules: [] },
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
    ...over,
  };
}

const entry = (over: Partial<ProviderEntry>): ProviderEntry => ({
  name: "openrouter",
  type: "openai",
  baseUrl: "http://openrouter.test",
  ...over,
});

beforeEach(() => {
  resetModelListCache();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("lookupPrice (spec §3.6)", () => {
  it("override beats everything", async () => {
    const price = { input: 1, output: 2 };
    const hit = await lookupPrice(
      entry({ type: "ollama" }), // would be $0 local — override wins
      "qwen/qwen3-coder",
      config({ prices: { "openrouter/qwen/*": price } }),
    );
    expect(hit).toEqual({ price, source: "override" });
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it("ollama is local $0", async () => {
    const hit = await lookupPrice(
      entry({ name: "main", type: "ollama" }),
      "llama3",
      config(),
    );
    expect(hit).toEqual({
      price: { input: 0, output: 0 },
      source: "local",
    });
  });

  it("local: true is $0", async () => {
    const hit = await lookupPrice(
      entry({ local: true }),
      "gpt-4o",
      config(),
    );
    expect(hit).toEqual({
      price: { input: 0, output: 0 },
      source: "local",
    });
  });

  it("live price used when flagged", async () => {
    mockGetJson.mockResolvedValue({
      status: 200,
      body: {
        data: [
          {
            id: "qwen/qwen3-coder",
            pricing: {
              prompt: "0.0000002",
              completion: "0.0000008",
            },
          },
        ],
      },
      durationMs: 1,
    });
    const hit = await lookupPrice(
      entry({ livePrices: true }),
      "qwen/qwen3-coder",
      config(),
    );
    expect(hit).toEqual({
      price: { input: 0.2, output: 0.8 },
      source: "live",
    });
    expect(mockGetJson).toHaveBeenCalledTimes(1);
  });

  it("live failure falls back to bundled", async () => {
    mockGetJson.mockRejectedValue(new Error("down"));
    const hit = await lookupPrice(
      entry({ livePrices: true }),
      "gpt-4o",
      config(),
    );
    expect(hit).toEqual({
      price: bundled.models["gpt-4o"],
      source: "bundled",
    });
  });

  it("bundled exact then prefixed", async () => {
    const exact = await lookupPrice(
      entry({ name: "openai" }),
      "gpt-4o",
      config(),
    );
    expect(exact).toEqual({
      price: bundled.models["gpt-4o"],
      source: "bundled",
    });
    expect(mockGetJson).not.toHaveBeenCalled();

    // A gemini-type provider retries as the LiteLLM "gemini/" prefix.
    const prefixed = await lookupPrice(
      entry({ name: "g", type: "gemini" }),
      "gemini-2.5-pro",
      config(),
    );
    expect(prefixed).toEqual({
      price: bundled.models["gemini/gemini-2.5-pro"],
      source: "bundled",
    });
  });

  it("unknown model → undefined", async () => {
    const hit = await lookupPrice(
      entry({ name: "openai" }),
      "definitely-not-a-real-model-9f3a",
      config(),
    );
    expect(hit).toBeUndefined();
  });
});
