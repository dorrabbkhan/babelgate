import type { CanonicalUsage } from "../types/canonical.types";
import type { Price } from "./price-table";

/** USD and whether any part of the figure was estimated (spec §3.6). */
export interface ComputedCost {
  usd: number;
  estimated: boolean;
}

const MILLION = 1_000_000;

/**
 * §3.6 cost formula, all prices USD per 1M tokens:
 *   (input − cacheRead − cacheWrite) × in
 *   + cacheRead × readPrice + cacheWrite × writePrice + output × out.
 * A cache-token count without its own price is billed at the input
 * price and marks the result estimated.
 */
export function computeCost(
  usage: CanonicalUsage,
  price: Price,
): ComputedCost {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const estimated =
    (read > 0 && price.cacheRead === undefined) ||
    (write > 0 && price.cacheWrite === undefined);
  const usd =
    ((usage.inputTokens - read - write) * price.input +
      read * (price.cacheRead ?? price.input) +
      write * (price.cacheWrite ?? price.input) +
      usage.outputTokens * price.output) /
    MILLION;
  return { usd, estimated };
}
