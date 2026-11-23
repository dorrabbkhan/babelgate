import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { createRegistry, type ProviderEntry } from "../routing/registry";
import type {
  RouteRule,
  RouteTarget,
  RoutingConfig,
} from "../routing/plan-route";
import { parseTarget } from "../routing/rules";
import { ConfigurationError } from "../utils/errors";
import {
  circuitBreakerDisabled,
  parseMedia,
  parseObserve,
  type GatewayConfig,
} from "./env-config";
import {
  BREAKER_DEFAULTS,
  createBreakers,
  type BreakerConfig,
} from "../routing/circuit-breaker";
import { gatewayFileSchema } from "./gateway.schema";
import { PROVIDER_PRESETS } from "./provider-presets";

/**
 * Discovery order (spec §3.5): explicit --config path, then
 * BABELGATE_CONFIG, then ./babelgate.yaml, then env-only mode. A named
 * path that does not exist is a startup error; a missing
 * ./babelgate.yaml just means env mode.
 */
export function resolveConfigPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | undefined {
  const named = explicit ?? env.BABELGATE_CONFIG;
  if (named !== undefined) {
    const resolved = resolve(cwd, named);
    if (!existsSync(resolved)) {
      throw new ConfigurationError(`Config file not found: ${resolved}`);
    }
    return resolved;
  }
  const local = join(cwd, "babelgate.yaml");
  return existsSync(local) ? local : undefined;
}

/**
 * Env vars that apply in env-only mode and are ignored when a YAML
 * file is loaded (spec §3.5): TARGET_API, every *_API_BASE_URL,
 * MODEL_MAP, TARGET_CONTEXT_WINDOW, TARGET_MAX_OUTPUT_TOKENS and
 * SOURCE_API — the ones that are set, in that order. Names only,
 * never values.
 */
export function ignoredEnvKeys(env: NodeJS.ProcessEnv): string[] {
  const baseUrlKeys = Object.keys(env)
    .filter((key) => key.endsWith("_API_BASE_URL"))
    .sort();
  return [
    ...(env.TARGET_API !== undefined ? ["TARGET_API"] : []),
    ...baseUrlKeys,
    ...(env.MODEL_MAP !== undefined ? ["MODEL_MAP"] : []),
    ...(env.TARGET_CONTEXT_WINDOW !== undefined
      ? ["TARGET_CONTEXT_WINDOW"]
      : []),
    ...(env.TARGET_MAX_OUTPUT_TOKENS !== undefined
      ? ["TARGET_MAX_OUTPUT_TOKENS"]
      : []),
    ...(env.SOURCE_API !== undefined ? ["SOURCE_API"] : []),
  ];
}

/** ["routes", 1, "to"] → "routes[1].to"; the root is "". */
function formatIssuePath(segments: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += out === "" ? String(segment) : `.${String(segment)}`;
    }
  }
  return out;
}

function requireTarget(
  text: string,
  providerNames: ReadonlySet<string>,
  file: string,
  at: string,
): RouteTarget {
  const target = parseTarget(text, providerNames);
  if (target === undefined) {
    throw new ConfigurationError(
      `${file}: ${at} "${text}" is not <provider>/<model> for a configured provider`,
    );
  }
  return target;
}

/**
 * Loads a babelgate.yaml into a GatewayConfig (spec §3.5). Scalars
 * (PORT, PROXY_API_KEY, UPSTREAM_*) come from `env` exactly as in env
 * mode; `api_key_env` names are resolved against `env` and the values
 * become `apiKey` — only the env var names may appear in errors.
 */
export function loadYamlConfig(
  path: string,
  env: NodeJS.ProcessEnv,
): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigurationError(`Config file not found: ${path}`);
  }

  const doc = parseDocument(text, { uniqueKeys: true });
  const parseError = doc.errors[0];
  if (parseError !== undefined) {
    throw new ConfigurationError(`${path}: ${parseError.message}`);
  }

  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined) {
    throw new ConfigurationError(
      `${path}: the config file is empty — 'providers' is required`,
    );
  }

  const parsed = gatewayFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => {
        const at = formatIssuePath(issue.path);
        return at === "" ? issue.message : `${at}: ${issue.message}`;
      })
      .join("; ");
    throw new ConfigurationError(`${path}: ${detail}`);
  }
  const file = parsed.data;

  const providerNames = new Set(Object.keys(file.providers));
  if (!providerNames.has(file.default)) {
    throw new ConfigurationError(
      `${path}: default "${file.default}" is not a configured provider`,
    );
  }

  const entries: ProviderEntry[] = Object.entries(file.providers).map(
    ([name, provider]) => {
      // §3.3: a shim preset fills the keys it declares; every
      // explicit key on the entry overrides the preset's value. The
      // schema guarantees type/base_url exist after the merge.
      const preset =
        provider.preset === undefined
          ? undefined
          : PROVIDER_PRESETS[provider.preset];
      const type = provider.type ?? preset?.type;
      const baseUrl = provider.base_url ?? preset?.base_url;
      const apiKeyEnv = provider.api_key_env ?? preset?.api_key_env;
      if (type === undefined || baseUrl === undefined) {
        throw new ConfigurationError(
          `${path}: providers.${name} needs "type" and "base_url" or a "preset"`,
        );
      }
      let apiKey: string | undefined;
      if (apiKeyEnv !== undefined) {
        const value = env[apiKeyEnv];
        if (value === undefined || value === "") {
          throw new ConfigurationError(
            `${path}: providers.${name}.api_key_env names ${apiKeyEnv}, which is unset or empty`,
          );
        }
        apiKey = value;
      }
      return {
        name,
        type,
        baseUrl: baseUrl.replace(/\/$/, ""),
        apiKey,
        apiKeyEnv,
        contextWindow: provider.context_window,
        ...(provider.max_output_tokens === undefined
          ? {}
          : { maxOutputTokens: provider.max_output_tokens }),
        ...(provider.cache_hints === undefined
          ? {}
          : { cacheHints: provider.cache_hints }),
        ...(provider.live_prices === undefined
          ? {}
          : { livePrices: provider.live_prices }),
        ...(provider.local === undefined
          ? {}
          : { local: provider.local }),
        ...(provider.repair_tool_calls === undefined
          ? {}
          : { repairToolCalls: provider.repair_tool_calls }),
        ...(provider.reasoning_passback === undefined
          ? {}
          : { reasoningPassback: provider.reasoning_passback }),
        ...(provider.reasoning === undefined
          ? {}
          : { reasoning: provider.reasoning }),
        // §3.3 (D6): explicit `passthrough:` opt-in; a preset implies
        // it when the key is absent — v1.6 §3.3: only on
        // `tier: "shim"` presets (the five Anthropic-endpoint shims);
        // free/cheap presets ride the canonical path.
        ...(provider.passthrough === undefined
          ? preset === undefined || preset.tier !== "shim"
            ? {}
            : { passthrough: true }
          : { passthrough: provider.passthrough }),
        ...(preset === undefined ? {} : { preset: provider.preset }),
        // `gaps:` on the entry replaces the preset's whole list.
        ...(provider.gaps === undefined
          ? preset === undefined
            ? {}
            : { gaps: [...preset.gaps] }
          : { gaps: provider.gaps }),
        timeoutMs: provider.timeout_ms,
        streamIdleMs: provider.stream_idle_ms,
      };
    },
  );

  const aliases: Record<string, RouteTarget> = {};
  for (const [name, text] of Object.entries(file.aliases ?? {})) {
    if (providerNames.has(name)) {
      throw new ConfigurationError(
        `${path}: aliases.${name} — "${name}" is also a provider name`,
      );
    }
    aliases[name] = requireTarget(
      text,
      providerNames,
      path,
      `aliases.${name}`,
    );
  }

  const rules: RouteRule[] = (file.routes ?? []).map((route, index) => ({
    match: route.match,
    when:
      route.when !== undefined
        ? { minInputTokens: route.when.min_input_tokens }
        : undefined,
    to: requireTarget(route.to, providerNames, path, `routes[${index}].to`),
    fallback: (route.fallback ?? []).map((text, i) =>
      requireTarget(
        text,
        providerNames,
        path,
        `routes[${index}].fallback[${i}]`,
      ),
    ),
  }));

  const routing: RoutingConfig = {
    defaultProvider: file.default,
    aliases,
    rules,
  };

  // §3.5: per-provider `circuit_breaker:` keys — `false` disables,
  // an object overrides the spec defaults per key; a provider with
  // no key gets the defaults inside createBreakers.
  const breakerCfg: Record<string, BreakerConfig | false> = {};
  for (const [name, provider] of Object.entries(file.providers)) {
    const cb = provider.circuit_breaker;
    if (cb === undefined) continue;
    breakerCfg[name] =
      cb === false
        ? false
        : {
            failures: cb.failures ?? BREAKER_DEFAULTS.failures,
            cooldownMs: cb.cooldown_ms ?? BREAKER_DEFAULTS.cooldownMs,
            maxCooldownMs:
              cb.max_cooldown_ms ?? BREAKER_DEFAULTS.maxCooldownMs,
          };
  }

  // §3.6: `provider/model`-glob → USD/1M overrides; snake_case keys in
  // the file become camelCase PriceOverride fields.
  const prices: GatewayConfig["prices"] =
    file.prices === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(file.prices).map(([glob, p]) => [
            glob,
            {
              input: p.input,
              output: p.output,
              ...(p.cache_read !== undefined
                ? { cacheRead: p.cache_read }
                : {}),
              ...(p.cache_write !== undefined
                ? { cacheWrite: p.cache_write }
                : {}),
            },
          ]),
        );

  return {
    port: env.PORT ? parseInt(env.PORT, 10) : 3000,
    proxyApiKey: env.PROXY_API_KEY || undefined,
    upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS
      ? parseInt(env.UPSTREAM_TIMEOUT_MS, 10)
      : 30_000,
    upstreamRetries: env.UPSTREAM_RETRIES
      ? parseInt(env.UPSTREAM_RETRIES, 10)
      : 1,
    upstreamStreamIdleMs: env.UPSTREAM_STREAM_IDLE_MS
      ? parseInt(env.UPSTREAM_STREAM_IDLE_MS, 10)
      : 300_000,
    registry: createRegistry(entries),
    routing,
    // §3.11: the observe: section's keys, with env vars winning over
    // the keys that have an env counterpart.
    observe: parseObserve(env, file.observe),
    // §3.2.2: media: keys — MEDIA_FETCH / MEDIA_ALLOW_PRIVATE win.
    media: parseMedia(env, file.media),
    prices,
    // §3.5: CIRCUIT_BREAKER=off removes the breakers entirely.
    ...(circuitBreakerDisabled(env)
      ? {}
      : { breakers: createBreakers(breakerCfg) }),
  };
}
