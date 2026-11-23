import { z } from "zod";
import type { Provider } from "../transformers";
import {
  GAPS,
  PRESET_NAMES,
  PROVIDER_PRESETS,
  type Gap,
  type PresetName,
} from "./provider-presets";

/**
 * One entry in a babelgate.yaml `providers` map (spec §3.5).
 * `api_key_env` holds an environment variable name — never a key.
 * `type`/`base_url` are required unless `preset` provides them
 * (spec §3.3); every explicit key overrides the preset's value.
 */
export interface GatewayFileProvider {
  type?: Provider;
  base_url?: string;
  api_key_env?: string;
  preset?: PresetName;
  gaps?: Gap[];
  context_window?: number;
  max_output_tokens?: number;
  cache_hints?: boolean;
  live_prices?: boolean;
  local?: boolean;
  repair_tool_calls?: boolean;
  reasoning_passback?: boolean;
  reasoning?: boolean;
  passthrough?: boolean;
  circuit_breaker?: GatewayFileBreaker | false;
  timeout_ms?: number;
  stream_idle_ms?: number;
}

/**
 * The YAML `circuit_breaker:` tuning object (v1.6 spec §3.5): every
 * key optional, absent keys take the spec defaults (3 failures,
 * 30 s cool-down doubling to 5 min). `circuit_breaker: false`
 * disables the provider's breaker entirely.
 */
export interface GatewayFileBreaker {
  failures?: number;
  cooldown_ms?: number;
  max_cooldown_ms?: number;
}

/** One entry in a babelgate.yaml `routes` list (spec §3.5). */
export interface GatewayFileRoute {
  match: string;
  when?: { min_input_tokens?: number };
  to: string;
  fallback?: string[];
}

/**
 * The YAML `media:` section (v1.5 spec §3.2.2); `MEDIA_FETCH` /
 * `MEDIA_ALLOW_PRIVATE` win at load.
 */
export interface GatewayFileMedia {
  fetch?: boolean;
  allow_private?: boolean;
}

/** The YAML `observe:` section (spec §3.11); env vars win at load. */
export interface GatewayFileObserve {
  usage_store?: boolean;
  usage_db?: string;
  retention_days?: number;
  inspector_buffer?: number;
  log_bodies?: boolean;
  would_cost_reference?: string;
}

/**
 * One `prices:` override row (spec §3.6): USD per 1M tokens, keyed by
 * a `provider/model` glob under the top-level `prices:` map.
 */
export interface GatewayFilePrice {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

/**
 * The YAML `cache:` section (v1.6 spec §3.5): the opt-in exact-match
 * response cache — off by default; `CACHE` wins over `enabled` at
 * load. `ttl_ms`/`max_entries`/`ignore_temperature` take the spec
 * defaults (5 min, 500 entries, temperature honoured).
 */
export interface GatewayFileCache {
  enabled?: boolean;
  ttl_ms?: number;
  max_entries?: number;
  ignore_temperature?: boolean;
}

/** A parsed babelgate.yaml file, before targets are resolved (spec §3.5). */
export interface GatewayFile {
  default: string;
  providers: Record<string, GatewayFileProvider>;
  aliases?: Record<string, string>;
  routes?: GatewayFileRoute[];
  observe?: GatewayFileObserve;
  media?: GatewayFileMedia;
  cache?: GatewayFileCache;
  prices?: Record<string, GatewayFilePrice>;
}

const PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]*$/;

const providerEntrySchema = z
  .strictObject({
    // v1.5 spec §3.3, widened by v1.6 spec §3.3: `preset` fills
    // type/base_url/api_key_env/gaps for a known endpoint (shim,
    // free or cheap tier); every explicit key overrides it.
    preset: z.enum(PRESET_NAMES).optional(),
    type: z
      .enum(["openai", "anthropic", "gemini", "ollama", "responses"])
      .optional(),
    base_url: z.string().min(1).optional(),
    api_key_env: z.string().optional(),
    gaps: z.array(z.enum(GAPS)).optional(),
    context_window: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    cache_hints: z.boolean().optional(),
    live_prices: z.boolean().optional(),
    local: z.boolean().optional(),
    repair_tool_calls: z.boolean().optional(),
    reasoning_passback: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    // v1.5 spec §3.3: same-format pass-through opt-in. Only anthropic
    // and openai entries have a relay (responses entries pass through
    // automatically; a `tier: "shim"` preset implies it — v1.6 §3.3;
    // free/cheap presets never do).
    passthrough: z.boolean().optional(),
    // v1.6 spec §3.5: passive circuit breaker — `false` disables it,
    // an object tunes failures/cool-downs per provider.
    circuit_breaker: z
      .union([
        z.literal(false),
        z.strictObject({
          failures: z.number().int().positive().optional(),
          cooldown_ms: z.number().int().positive().optional(),
          max_cooldown_ms: z.number().int().positive().optional(),
        }),
      ])
      .optional(),
    timeout_ms: z.number().int().positive().optional(),
    stream_idle_ms: z.number().int().positive().optional(),
  })
  .superRefine((entry, ctx) => {
    const preset =
      entry.preset === undefined
        ? undefined
        : PROVIDER_PRESETS[entry.preset];
    const type = entry.type ?? preset?.type;
    const apiKeyEnv = entry.api_key_env ?? preset?.api_key_env;
    if (type === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: 'required unless "preset" is set',
      });
    }
    if (entry.base_url === undefined && preset === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["base_url"],
        message: 'required unless "preset" is set',
      });
    }
    // A preset with no `api_key_env` declares a keyless endpoint.
    if (
      type !== "ollama" &&
      apiKeyEnv === undefined &&
      (preset === undefined || preset.api_key_env !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["api_key_env"],
        message:
          'required unless type is "ollama" or the preset declares a keyless endpoint',
      });
    }
    if (
      entry.passthrough !== undefined &&
      type !== "anthropic" &&
      type !== "openai"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["passthrough"],
        message:
          'only valid on "anthropic" or "openai" providers ("responses" providers pass through automatically)',
      });
    }
    if (entry.gaps !== undefined && type !== "anthropic" && type !== "openai") {
      ctx.addIssue({
        code: "custom",
        path: ["gaps"],
        message: 'only valid on "anthropic" or "openai" providers',
      });
    }
  });

/**
 * babelgate.yaml schema (spec §3.5): strict objects at every level, so
 * unknown keys are startup errors. Semantic checks (default is a
 * provider, targets resolve, key env vars are set) happen in
 * loadYamlConfig — they need the registry and the environment.
 */
export const gatewayFileSchema: z.ZodType<GatewayFile> = z.strictObject({
  default: z.string(),
  providers: z
    .record(z.string().regex(PROVIDER_NAME), providerEntrySchema)
    .refine((map) => Object.keys(map).length >= 1, {
      message: "at least one provider is required",
    }),
  aliases: z.record(z.string(), z.string()).optional(),
  routes: z
    .array(
      z.strictObject({
        match: z.string().min(1),
        when: z
          .strictObject({
            min_input_tokens: z.number().int().positive().optional(),
          })
          .optional(),
        to: z.string(),
        fallback: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  observe: z
    .strictObject({
      usage_store: z.boolean().optional(),
      usage_db: z.string().min(1).optional(),
      retention_days: z.number().int().positive().optional(),
      inspector_buffer: z.number().int().nonnegative().optional(),
      log_bodies: z.boolean().optional(),
      would_cost_reference: z.string().min(1).optional(),
    })
    .optional(),
  media: z
    .strictObject({
      fetch: z.boolean().optional(),
      allow_private: z.boolean().optional(),
    })
    .optional(),
  // v1.6 spec §3.5: the opt-in response cache, off by default.
  cache: z
    .strictObject({
      enabled: z.boolean().optional(),
      ttl_ms: z.number().int().positive().optional(),
      max_entries: z.number().int().positive().optional(),
      ignore_temperature: z.boolean().optional(),
    })
    .optional(),
  prices: z
    .record(
      z.string().min(1),
      z.strictObject({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cache_read: z.number().nonnegative().optional(),
        cache_write: z.number().nonnegative().optional(),
      }),
    )
    .optional(),
});
