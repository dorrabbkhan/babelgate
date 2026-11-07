import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPriceTable } from "./update-prices";

/**
 * The LiteLLM → prices.json transform (spec §3.6): chat-mode models
 * only, USD/token → USD per 1M tokens, cache prices kept when present.
 */
const sample = JSON.parse(
  readFileSync(
    join(__dirname, "..", "tests", "fixtures", "prices", "litellm-sample.json"),
    "utf8",
  ),
) as Record<string, unknown>;

describe("buildPriceTable (spec §3.6)", () => {
  it("5-model sample → the expected models map; non-chat dropped", () => {
    const table = buildPriceTable(sample, {
      url: "https://raw.githubusercontent.com/BerriAI/litellm/abc123/model_prices_and_context_window.json",
      commit: "abc123",
      fetchedAt: "2026-11-07T00:00:00.000Z",
    });
    expect(table.source).toEqual({
      url: "https://raw.githubusercontent.com/BerriAI/litellm/abc123/model_prices_and_context_window.json",
      commit: "abc123",
      fetchedAt: "2026-11-07T00:00:00.000Z",
    });
    expect(table.models).toEqual({
      "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
      "claude-sonnet-4-5": {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
      "gemini/gemini-2.5-pro": { input: 1.25, output: 10 },
      "openrouter/qwen/qwen3-coder": { input: 0.22, output: 0.95 },
    });
    expect(table.models["dall-e-3"]).toBeUndefined();
    expect(table.models["sample_spec"]).toBeUndefined();
  });
});
