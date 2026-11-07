import type { GatewayConfig } from "../config/env-config";
import type { ProviderEntry } from "../routing/registry";
import { getRawModelList } from "../services/models.service";
import { logger } from "../utils/logger";
import type { Price } from "./price-table";

/** OpenRouter's `pricing` block: string USD per token. */
interface LivePricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

const per1M = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number((Number(s) * 1e6).toPrecision(10));
  // OpenRouter serves "-1" for dynamically priced models — a negative
  // price means "no usable price", not a rebate.
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * §3.6 step 3: read a live price off the shared model-list fetch
 * (`getRawModelList`, same 60 s cache as /models). Only providers
 * with `live_prices: true` reach this — the raw list's `data[]` row
 * whose `id` matches the routed model, `pricing` converted from
 * string USD/token to USD per 1M. Any failure — fetch, missing row
 * or unusable numbers (OpenRouter's "-1" dynamic prices count as
 * unusable) — returns undefined so the caller falls back
 * to the bundled table; a debug line is the only trace it leaves.
 */
export async function livePrice(
  entry: ProviderEntry,
  model: string,
  config: GatewayConfig,
  requestId: string,
): Promise<Price | undefined> {
  try {
    const raw = await getRawModelList(entry, config, requestId);
    const data = (raw as { data?: { id?: string; pricing?: LivePricing }[] })
      .data;
    const pricing = data?.find((m) => m.id === model)?.pricing;
    const input = per1M(pricing?.prompt);
    const output = per1M(pricing?.completion);
    const cacheRead = per1M(pricing?.input_cache_read);
    const cacheWrite = per1M(pricing?.input_cache_write);
    if (input === undefined || output === undefined) return undefined;
    return {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    };
  } catch (err) {
    logger.debug(
      { requestId, provider: entry.name, model, err },
      "Live price lookup failed; falling back to bundled prices",
    );
    return undefined;
  }
}
