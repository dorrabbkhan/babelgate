import type { GatewayConfig } from "../config/env-config";
import { currentTrace } from "../observe/context";
import { globMatch } from "../routing/rules";
import type { ProviderEntry } from "../routing/registry";
import { livePrice } from "./live-prices";
import bundled from "./prices.json";

/** USD per 1M tokens; cache prices fall back to `input` when absent. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type PriceSource = "override" | "local" | "live" | "bundled";

/**
 * LiteLLM provider prefix for the bundled table, by provider *type*
 * (spec §3.6): only gemini-type providers retry a bare model name as
 * `gemini/<model>`; every other type tries the bare name only.
 */
const LITELLM_PREFIX: Partial<Record<ProviderEntry["type"], string>> = {
  gemini: "gemini/",
};

const bundledModels: Record<string, Price> = bundled.models;

/**
 * §3.6 lookup for the winning hop's (provider, model), first hit wins:
 *   1. override — top-level `prices:` globs matched against
 *      `provider/model` (same glob rules as routes)
 *   2. local — ollama type or `local: true` → $0
 *   3. live — `live_prices: true` providers read the model-list
 *      `pricing` block (OpenRouter schema); any failure → step 4
 *   4. bundled — exact model, then the LiteLLM provider-prefixed key
 *   5. unknown → undefined (costUsd stays null, never 0 — D8)
 */
export async function lookupPrice(
  provider: ProviderEntry,
  model: string,
  config: GatewayConfig,
): Promise<{ price: Price; source: PriceSource } | undefined> {
  for (const [pattern, price] of Object.entries(config.prices ?? {})) {
    if (globMatch(pattern, `${provider.name}/${model}`)) {
      return { price, source: "override" };
    }
  }

  if (provider.type === "ollama" || provider.local === true) {
    return { price: { input: 0, output: 0 }, source: "local" };
  }

  if (provider.livePrices === true) {
    const price = await livePrice(
      provider,
      model,
      config,
      currentTrace()?.requestId ?? "price-lookup",
    );
    if (price !== undefined) return { price, source: "live" };
  }

  const prefix = LITELLM_PREFIX[provider.type] ?? "";
  const price =
    bundledModels[model] ??
    (prefix === "" ? undefined : bundledModels[`${prefix}${model}`]);
  if (price === undefined) return undefined;
  return { price, source: "bundled" };
}
