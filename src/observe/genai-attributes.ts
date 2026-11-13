import type { Provider } from "../transformers";

/**
 * Every attribute name the OTel sink emits (spec §3.8), in one module
 * so the vocabulary has a single home. The GenAI semantic conventions
 * are in Development status with no tagged release; the `gen_ai.*`,
 * `error.type` and `server.address` names are verified against
 * open-telemetry/semantic-conventions-genai `docs/gen-ai/` at commit
 * e6658f14c9d9ea0760825f029cb82e7673f48fab (2026-11-06, the newest
 * commit touching docs/gen-ai on 2026-11-07). `babelgate.*` is our own
 * namespace for facts the conventions do not cover.
 */
export const ATTR = {
  genAiOperationName: "gen_ai.operation.name",
  genAiProviderName: "gen_ai.provider.name",
  genAiRequestModel: "gen_ai.request.model",
  genAiResponseModel: "gen_ai.response.model",
  genAiRequestMaxTokens: "gen_ai.request.max_tokens",
  genAiResponseFinishReasons: "gen_ai.response.finish_reasons",
  genAiUsageInputTokens: "gen_ai.usage.input_tokens",
  genAiUsageOutputTokens: "gen_ai.usage.output_tokens",
  genAiUsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  genAiUsageCacheWriteInputTokens:
    "gen_ai.usage.cache_write.input_tokens",
  errorType: "error.type",
  serverAddress: "server.address",
  babelgateProvider: "babelgate.provider",
  babelgateClient: "babelgate.client",
  babelgateRouteReason: "babelgate.route.reason",
  babelgateCostUsd: "babelgate.cost_usd",
  babelgateFallbackHops: "babelgate.fallback_hops",
} as const;

/**
 * `gen_ai.provider.name` from the provider's type (spec §3.8):
 * OpenAI-compatible providers have type "openai" and so report
 * "openai" — the semconv value describes the API family, never the
 * configured provider name (that is `babelgate.provider`).
 */
export const GENAI_PROVIDER_NAMES: Record<Provider, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "gcp.gemini",
  ollama: "ollama",
  // The Responses API is an OpenAI-family API.
  responses: "openai",
};
