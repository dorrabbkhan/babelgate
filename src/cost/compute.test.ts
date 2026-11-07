import { describe, it, expect } from "vitest";
import { computeCost } from "./compute";
import type { CanonicalUsage } from "../types/canonical.types";

/**
 * The §3.6 formula: (input − cacheRead − cacheWrite) × in +
 * cacheRead × readPrice + cacheWrite × writePrice + output × out,
 * all USD per 1M tokens. A missing cache price falls back to the
 * input price and marks the cost estimated.
 */
describe("computeCost (spec §3.6)", () => {
  it("formula with cache", () => {
    const usage: CanonicalUsage = {
      inputTokens: 1_000_000,
      cacheReadTokens: 400_000,
      cacheWriteTokens: 100_000,
      outputTokens: 200_000,
      totalTokens: 1_200_000,
    };
    const cost = computeCost(usage, {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    // 500k×3 + 400k×0.3 + 100k×3.75 + 200k×15, per 1M.
    expect(cost.usd).toBeCloseTo(4.995, 10);
    expect(cost.estimated).toBe(false);
  });

  it("missing cache price uses input and marks estimated", () => {
    const usage: CanonicalUsage = {
      inputTokens: 1_000_000,
      cacheReadTokens: 400_000,
      outputTokens: 100_000,
      totalTokens: 1_100_000,
    };
    const cost = computeCost(usage, { input: 2, output: 10 });
    // 600k×2 + 400k×2 (cache read priced as input) + 100k×10.
    expect(cost.usd).toBeCloseTo(1.2 + 0.8 + 1.0, 10);
    expect(cost.estimated).toBe(true);
  });

  it("no cache tokens and full prices is not estimated", () => {
    const usage: CanonicalUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    };
    const cost = computeCost(usage, { input: 2, output: 10 });
    expect(cost.usd).toBeCloseTo(0.002 + 0.005, 10);
    expect(cost.estimated).toBe(false);
  });
});
