import type { Provider } from "../transformers";
import { ConfigurationError } from "../utils/errors";

/**
 * One configured upstream provider (spec §3.1). `baseUrl` never carries
 * a trailing "/". `apiKeyEnv` names the environment variable the key
 * came from — the name may be logged; `apiKey` itself never is.
 */
export interface ProviderEntry {
  name: string;
  type: Provider;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  /** Output-token cap applied by canonicalForTarget (spec §3.3) */
  maxOutputTokens?: number;
  /**
   * Honour cache hints for an OpenAI-compatible upstream (spec §3.2):
   * canonicalForTarget strips every `cache` hint unless this is set
   * (Anthropic always keeps them).
   */
  cacheHints?: boolean;
  timeoutMs?: number;
  streamIdleMs?: number;
}

/**
 * Name → ProviderEntry lookup. Insertion order is the config order and
 * is what names() returns.
 */
export interface ProviderRegistry {
  /** Throws ConfigurationError on an unregistered name. */
  get(name: string): ProviderEntry;
  has(name: string): boolean;
  /** Registered names in insertion order. */
  names(): string[];
}

/** A duplicate provider name is a startup error, never a silent win. */
export function createRegistry(entries: ProviderEntry[]): ProviderRegistry {
  const byName = new Map<string, ProviderEntry>();
  for (const entry of entries) {
    if (byName.has(entry.name)) {
      throw new ConfigurationError(
        `Duplicate provider name: ${entry.name}`,
      );
    }
    byName.set(entry.name, entry);
  }
  return {
    get(name) {
      const entry = byName.get(name);
      if (entry === undefined) {
        throw new ConfigurationError(`Unknown provider: ${name}`);
      }
      return entry;
    },
    has: (name) => byName.has(name),
    names: () => [...byName.keys()],
  };
}

/**
 * Provider-specific auth headers — the body of proxy.service's former
 * buildAuthHeaders, now keyed on the provider entry.
 */
export function authHeaders(entry: ProviderEntry): Record<string, string> {
  if (!entry.apiKey) return {};

  switch (entry.type) {
    case "openai":
      return { Authorization: `Bearer ${entry.apiKey}` };
    case "anthropic":
      return {
        "x-api-key": entry.apiKey,
        "anthropic-version": "2023-06-01",
      };
    case "gemini":
      return { "x-goog-api-key": entry.apiKey };
    case "ollama":
      return {};
  }
}
