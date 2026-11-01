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
import type { GatewayConfig } from "./env-config";
import { gatewayFileSchema } from "./gateway.schema";

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
 * MODEL_MAP, TARGET_CONTEXT_WINDOW and SOURCE_API — the ones that are
 * set, in that order. Names only, never values.
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
      let apiKey: string | undefined;
      if (provider.api_key_env !== undefined) {
        const value = env[provider.api_key_env];
        if (value === undefined || value === "") {
          throw new ConfigurationError(
            `${path}: providers.${name}.api_key_env names ${provider.api_key_env}, which is unset or empty`,
          );
        }
        apiKey = value;
      }
      return {
        name,
        type: provider.type,
        baseUrl: provider.base_url.replace(/\/$/, ""),
        apiKey,
        apiKeyEnv: provider.api_key_env,
        contextWindow: provider.context_window,
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
  };
}
