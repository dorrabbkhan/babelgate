import { homedir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import type { Provider } from "../transformers";
import { parseModelMap, type ModelMapRule } from "../utils/model-map";
import {
  createRegistry,
  type ProviderRegistry,
} from "../routing/registry";
import type { RoutingConfig } from "../routing/plan-route";
import {
  ignoredEnvKeys,
  loadYamlConfig,
  resolveConfigPath,
} from "./yaml-config";
import { ConfigurationError } from "../utils/errors";
import { logger } from "../utils/logger";

dotenv.config({ quiet: true });

const VALID_PROVIDERS: Provider[] = [
  "openai",
  "gemini",
  "ollama",
  "anthropic",
  "responses",
];

/**
 * One `prices:` override row (spec §3.6): USD per 1M tokens, matched
 * against `provider/model` by glob (same rules as routes).
 */
export interface PriceOverride {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Gateway-shaped config (spec §3.1): scalars plus the provider registry
 * and routing table the services consume. There is no configured
 * source format — the request path decides the client dialect
 * (spec §3.2).
 */
export interface GatewayConfig {
  port: number;
  /** Client-facing auth key — unset means auth disabled */
  proxyApiKey?: string;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  /** Longest gap allowed between chunks mid-stream (spec §3.2) */
  upstreamStreamIdleMs: number;
  registry: ProviderRegistry;
  routing: RoutingConfig;
  observe: ObserveConfig;
  /** Top-level `prices:` overrides (spec §3.6); YAML only. */
  prices?: Record<string, PriceOverride>;
}

/**
 * Observe-layer settings (spec §3.11). Env vars win over the YAML
 * `observe:` keys that have an env counterpart; `wouldCostReference`,
 * `metrics`, `ui`, `uiAllowRemote` and `uiAllowedHosts` are consumed by
 * later tasks (8, 10, 12).
 */
export interface ObserveConfig {
  /** `USAGE_STORE` / `observe.usage_store` — SQLite usage store, default on */
  usageStore: boolean;
  /** `USAGE_DB` / `observe.usage_db` — default `~/.babelgate/usage.db` */
  usageDb: string;
  /** `USAGE_RETENTION_DAYS` / `observe.retention_days` — default 30 */
  retentionDays: number;
  /**
   * Inspector ring size — the last N chat traces keep their body
   * snapshots (spec §3.5, D3). `INSPECTOR_BUFFER` /
   * `observe.inspector_buffer`, default 50; 0 disables snapshotting.
   */
  inspectorBuffer: number;
  /**
   * `LOG_BODIES` / `observe.log_bodies` — persist body snapshots to the
   * usage DB's `bodies` table (D3), default false.
   */
  logBodies: boolean;
  /**
   * `observe.would_cost_reference` (YAML only) — `provider/model` a
   * `local` provider's rows are priced against (Task 8).
   */
  wouldCostReference?: string;
  /** `METRICS` — `/metrics` endpoint (Task 10), default on */
  metrics: boolean;
  /** `UI` — `/ui` endpoints (Task 12), default on */
  ui: boolean;
  /** `UI_ALLOW_REMOTE` — let non-loopback clients reach `/ui`, default false */
  uiAllowRemote: boolean;
  /** `UI_ALLOWED_HOSTS` — comma-separated host allowlist, default empty */
  uiAllowedHosts: string[];
}

/**
 * v1.1's single-target fields, kept so env-config callers and tests are
 * untouched. Env-only mode is always an EnvConfig; GatewayConfig is the
 * view the services see.
 */
export interface EnvConfig extends GatewayConfig {
  targetApi: Provider;
  targetApiKey?: string;
  targetBaseUrl: string;
  /** Ordered glob=model rules applied to the canonical model (§3.5) */
  modelMap: ModelMapRule[];
  /** Minimum context window the target should allocate (Ollama num_ctx) */
  targetContextWindow?: number;
  /**
   * Environment variables that were set but are ignored (spec §3.2):
   * `["SOURCE_API"]` when set, else `[]`. getConfig() warns once.
   */
  deprecatedEnv: string[];
}

function isValidProvider(value: string): value is Provider {
  return VALID_PROVIDERS.includes(value.toLowerCase() as Provider);
}

function normalizeProvider(value: string): Provider {
  return value.toLowerCase() as Provider;
}

/**
 * Loads configuration from environment variables
 */
export function loadConfig(): EnvConfig {
  if (!process.env.TARGET_API) {
    throw new Error("TARGET_API environment variable is required");
  }

  const targetApi = process.env.TARGET_API;

  if (!isValidProvider(targetApi)) {
    throw new Error(`TARGET_API must be one of: ${VALID_PROVIDERS.join(", ")}`);
  }

  const normalizedTarget = normalizeProvider(targetApi);

  // Get API key based on target
  const apiKeyEnvVars: Record<Provider, string> = {
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
    ollama: "OLLAMA_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    responses: "RESPONSES_API_KEY",
  };

  const targetApiKey = process.env[apiKeyEnvVars[normalizedTarget]];

  // Ollama doesn't require an API key
  if (!targetApiKey && normalizedTarget !== "ollama") {
    throw new Error(
      `${apiKeyEnvVars[normalizedTarget]} environment variable is required for target API ${targetApi}`,
    );
  }

  // Upstream base URL follows the {PROVIDER}_API_BASE_URL convention
  const baseUrlEnvVar = `${normalizedTarget.toUpperCase()}_API_BASE_URL`;
  const targetBaseUrl = process.env[baseUrlEnvVar];
  if (!targetBaseUrl) {
    throw new Error(
      `${baseUrlEnvVar} environment variable is required for target API ${targetApi}`,
    );
  }

  const modelMap = parseModelMap(process.env.MODEL_MAP);
  const targetContextWindow = parseTargetContextWindow();
  const targetMaxOutputTokens = parseTargetMaxOutputTokens();

  // Env-only mode (spec §3.5): one provider named after TARGET_API,
  // itself the default; MODEL_MAP entries become ordered routes to it.
  const registry = createRegistry([
    {
      name: normalizedTarget,
      type: normalizedTarget,
      baseUrl: targetBaseUrl.replace(/\/$/, ""),
      apiKey: targetApiKey,
      apiKeyEnv:
        targetApiKey !== undefined
          ? apiKeyEnvVars[normalizedTarget]
          : undefined,
      contextWindow: targetContextWindow,
      ...(targetMaxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: targetMaxOutputTokens }),
    },
  ]);
  const routing: RoutingConfig = {
    defaultProvider: normalizedTarget,
    aliases: {},
    rules: modelMap.map((rule) => ({
      match: rule.pattern,
      to: { provider: normalizedTarget, model: rule.model },
      fallback: [],
    })),
  };

  return {
    targetApi: normalizedTarget,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    targetApiKey,
    targetBaseUrl: targetBaseUrl.replace(/\/$/, ""),
    upstreamTimeoutMs: process.env.UPSTREAM_TIMEOUT_MS
      ? parseInt(process.env.UPSTREAM_TIMEOUT_MS, 10)
      : 30_000,
    upstreamRetries: process.env.UPSTREAM_RETRIES
      ? parseInt(process.env.UPSTREAM_RETRIES, 10)
      : 1,
    upstreamStreamIdleMs: process.env.UPSTREAM_STREAM_IDLE_MS
      ? parseInt(process.env.UPSTREAM_STREAM_IDLE_MS, 10)
      : 300_000,
    proxyApiKey: process.env.PROXY_API_KEY || undefined,
    modelMap,
    targetContextWindow,
    registry,
    routing,
    observe: parseObserve(process.env),
    deprecatedEnv:
      process.env.SOURCE_API !== undefined ? ["SOURCE_API"] : [],
  };
}

function parseTargetContextWindow(): number | undefined {
  const raw = process.env.TARGET_CONTEXT_WINDOW;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(
      "TARGET_CONTEXT_WINDOW must be a positive integer",
    );
  }
  return value;
}

function parseTargetMaxOutputTokens(): number | undefined {
  const raw = process.env.TARGET_MAX_OUTPUT_TOKENS;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(
      "TARGET_MAX_OUTPUT_TOKENS must be a positive integer",
    );
  }
  return value;
}

/**
 * `INSPECTOR_BUFFER` (spec §3.11): a non-negative integer, default 50;
 * 0 disables the inspector ring. Applies in YAML mode too — shared by
 * loadConfig and loadYamlConfig (env wins, spec §3.11).
 */
export function parseInspectorBuffer(env: NodeJS.ProcessEnv): number {
  const raw = env.INSPECTOR_BUFFER;
  if (raw === undefined || raw === "") return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(
      "INSPECTOR_BUFFER must be a non-negative integer",
    );
  }
  return value;
}

/** The YAML `observe:` section's keys (gateway.schema.ts). */
export interface ObserveYaml {
  usage_store?: boolean;
  usage_db?: string;
  retention_days?: number;
  inspector_buffer?: number;
  log_bodies?: boolean;
  would_cost_reference?: string;
}

function parseBoolEnv(
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["on", "true", "1"].includes(value)) return true;
  if (["off", "false", "0"].includes(value)) return false;
  throw new ConfigurationError(`${name} must be on/off or true/false`);
}

function parsePositiveIntEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * `~` and `~/…` in a `usage_db` path expand to the user's home —
 * SQLite does not understand `~`.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Build the `observe` block (spec §3.11): env vars win over the YAML
 * `observe:` keys that have an env counterpart (env-only mode passes
 * no `yaml`). Shared by loadConfig and loadYamlConfig.
 */
export function parseObserve(
  env: NodeJS.ProcessEnv,
  yaml: ObserveYaml = {},
): ObserveConfig {
  return {
    usageStore: parseBoolEnv(
      "USAGE_STORE",
      env.USAGE_STORE,
      yaml.usage_store ?? true,
    ),
    usageDb: expandHome(
      env.USAGE_DB || yaml.usage_db || "~/.babelgate/usage.db",
    ),
    retentionDays: parsePositiveIntEnv(
      "USAGE_RETENTION_DAYS",
      env.USAGE_RETENTION_DAYS,
      yaml.retention_days ?? 30,
    ),
    inspectorBuffer:
      env.INSPECTOR_BUFFER !== undefined
        ? parseInspectorBuffer(env)
        : (yaml.inspector_buffer ?? 50),
    logBodies: parseBoolEnv(
      "LOG_BODIES",
      env.LOG_BODIES,
      yaml.log_bodies ?? false,
    ),
    ...(yaml.would_cost_reference !== undefined
      ? { wouldCostReference: yaml.would_cost_reference }
      : {}),
    metrics: parseBoolEnv("METRICS", env.METRICS, true),
    ui: parseBoolEnv("UI", env.UI, true),
    uiAllowRemote: parseBoolEnv(
      "UI_ALLOW_REMOTE",
      env.UI_ALLOW_REMOTE,
      false,
    ),
    uiAllowedHosts: (env.UI_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== ""),
  };
}

/**
 * Get the current configuration (lazy-loaded)
 */
let _config: GatewayConfig | null = null;
let _configPath: string | undefined;

/**
 * Explicit config-file path for getConfig()'s discovery — set by the
 * CLI's --config before getConfig() runs (spec §3.5). Cleared by
 * resetConfig().
 */
export function setConfigPath(path: string | undefined): void {
  _configPath = path;
}

export function getConfig(): GatewayConfig {
  if (!_config) {
    const yamlPath = resolveConfigPath(
      _configPath,
      process.env,
      process.cwd(),
    );
    if (yamlPath !== undefined) {
      _config = loadYamlConfig(yamlPath, process.env);
      const ignored = ignoredEnvKeys(process.env);
      if (ignored.length > 0) {
        logger.warn(
          `Ignoring env vars set but defined by the config file: ${ignored.join(", ")}`,
        );
      }
    } else {
      const envConfig = loadConfig();
      if (envConfig.deprecatedEnv.length > 0) {
        logger.warn(
          "SOURCE_API is deprecated and ignored: the request path decides the client format. It will be removed in 2.0.",
        );
      }
      _config = envConfig;
    }
  }
  return _config;
}

/**
 * Reset config (for testing)
 */
export function resetConfig(): void {
  _config = null;
  _configPath = undefined;
}
