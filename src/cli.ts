#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Provider } from "./transformers/adapters";
import { getConfig, setConfigPath } from "./config/env-config";
import { resolveConfigPath } from "./config/yaml-config";
import { formatRoutingTable } from "./routing/table";
import { startServer } from "./index";

export interface CliArgs {
  preset?: "claude-code" | "openai-apps";
  target?: Provider;
  model?: string;
  baseUrl?: string;
  config?: string;
  port?: number;
  help?: boolean;
}

const PRESETS = ["claude-code", "openai-apps"] as const;
const PROVIDERS: Provider[] = ["openai", "gemini", "ollama", "anthropic"];

/**
 * Parses CLI arguments. Unknown flags and invalid values throw an error
 * naming the flag; upstream keys only ever come from the environment.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      preset: { type: "string" },
      target: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      config: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean" },
    },
  });

  const args: CliArgs = {};
  if (values.preset !== undefined) {
    if (!(PRESETS as readonly string[]).includes(values.preset)) {
      throw new Error(
        `--preset must be one of: ${PRESETS.join(", ")}`,
      );
    }
    args.preset = values.preset as CliArgs["preset"];
  }
  if (values.target !== undefined) {
    if (!PROVIDERS.includes(values.target as Provider)) {
      throw new Error(`--target must be one of: ${PROVIDERS.join(", ")}`);
    }
    args.target = values.target as Provider;
  }
  if (values.model !== undefined) args.model = values.model;
  if (values["base-url"] !== undefined) args.baseUrl = values["base-url"];
  if (values.config !== undefined) args.config = values.config;
  if (
    args.config !== undefined &&
    (args.target !== undefined ||
      args.model !== undefined ||
      args.baseUrl !== undefined)
  ) {
    throw new Error(
      "--target, --model and --base-url are defined by the config file",
    );
  }
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("--port must be an integer between 1 and 65535");
    }
    args.port = port;
  }
  if (values.help) args.help = true;
  return args;
}

/**
 * The provider the proxy will target: `--target` when given, else a valid
 * TARGET_API already in the env. Used wherever a preset/flag value depends
 * on which target is effective.
 */
function effectiveTarget(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): Provider | undefined {
  if (args.target !== undefined) return args.target;
  return PROVIDERS.includes(env.TARGET_API as Provider)
    ? (env.TARGET_API as Provider)
    : undefined;
}

/**
 * Every env value the flags/preset would set, before "user env wins" is
 * applied. `env` is still consulted to resolve the effective target for
 * --base-url and the ollama timeout.
 */
function wantedEnv(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  configMode = false,
): Record<string, string> {
  const wanted: Record<string, string> = {};

  // With a config file loaded, routing is defined by the file (spec §3.7):
  // no flag or preset may set TARGET_API, MODEL_MAP, *_API_BASE_URL or
  // TARGET_CONTEXT_WINDOW — only PORT still applies (§3.5).
  if (!configMode) {
    if (args.target !== undefined) {
      wanted.TARGET_API = args.target;
    }

    if (args.preset === "claude-code") {
      if (args.model !== undefined) {
        wanted.MODEL_MAP = `claude-*=${args.model}`;
      }
      wanted.TARGET_CONTEXT_WINDOW = "32768";
      if (effectiveTarget(args, env) === "ollama") {
        wanted.UPSTREAM_TIMEOUT_MS = "600000";
      }
    }

    if (args.baseUrl !== undefined) {
      const target = effectiveTarget(args, env);
      if (target === undefined) {
        throw new Error(
          "--base-url requires --target or TARGET_API in the environment",
        );
      }
      wanted[`${target.toUpperCase()}_API_BASE_URL`] = args.baseUrl;
    }
  }

  if (args.port !== undefined) {
    wanted.PORT = String(args.port);
  }

  return wanted;
}

/**
 * Environment values implied by the flags. Keys the user's own env already
 * sets (a non-empty value) are not returned — user env always wins and
 * presets are only ever env values, never changes to config defaults.
 * `configMode` (a config file was resolved) suppresses every routing env
 * var; only `--port` still maps to PORT.
 */
export function presetEnv(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  configMode = false,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(wantedEnv(args, env, configMode)).filter(
      ([key]) => !env[key],
    ),
  );
}

/**
 * Names of the preset/flag env keys that lost to values already set in
 * `env` — everything the flags/preset wanted that presetEnv(args, env)
 * dropped. Names only, never values.
 */
export function overriddenKeys(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  configMode = false,
): string[] {
  const applied = presetEnv(args, env, configMode);
  return Object.keys(wantedEnv(args, env, configMode)).filter(
    (key) => !(key in applied),
  );
}

/**
 * The `export …` lines the user pastes into their shell to point the client
 * app at this proxy. PROXY_API_KEY is the proxy's own client-facing key, not
 * an upstream key.
 */
export function clientInstructions(
  args: CliArgs,
  port: number,
  proxyApiKey?: string,
): string[] {
  const token = proxyApiKey ?? "babelgate";
  if (args.preset === "claude-code") {
    return [
      `export ANTHROPIC_BASE_URL=http://localhost:${port}`,
      `export ANTHROPIC_AUTH_TOKEN=${token}`,
    ];
  }
  if (args.preset === "openai-apps") {
    return [
      `export OPENAI_BASE_URL=http://localhost:${port}/v1`,
      `export OPENAI_API_KEY=${token}`,
    ];
  }
  return [];
}

/**
 * The endpoints block printed at startup when no preset is given
 * (spec §3.7): one URL per client dialect, column-aligned.
 */
export function endpointLines(port: number): string[] {
  return [
    `OpenAI     http://localhost:${port}/v1`,
    `Anthropic  http://localhost:${port}`,
    `Gemini     http://localhost:${port}`,
    `Ollama     http://localhost:${port}`,
  ];
}

function usageLines(): string[] {
  return [
    "Usage: babelgate [--preset <claude-code|openai-apps>] [--target <provider>]",
    "                 [--model <name>] [--base-url <url>] [--port <n>]",
    "                 [--config <path>] [--help]",
    "",
    "Config file discovery: --config, then BABELGATE_CONFIG,",
    "then ./babelgate.yaml. Upstream API keys come only from the environment",
    "(OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OLLAMA_API_KEY).",
  ];
}

export async function main(argv: string[]): Promise<void> {
  try {
    const args = parseCliArgs(argv);
    if (args.help) {
      for (const line of usageLines()) console.log(line);
      return;
    }

    // A config file resolves via --config, BABELGATE_CONFIG or
    // ./babelgate.yaml (spec §3.5); with one loaded, the routing flags
    // are errors (spec §3.7) — the parseCliArgs check only covers an
    // explicit --config.
    const configPath = resolveConfigPath(
      args.config,
      process.env,
      process.cwd(),
    );
    const configMode = configPath !== undefined;
    if (
      configMode &&
      (args.target !== undefined ||
        args.model !== undefined ||
        args.baseUrl !== undefined)
    ) {
      throw new Error(
        "--target, --model and --base-url are defined by the config file",
      );
    }

    const envValues = presetEnv(args, process.env, configMode);
    const overridden = overriddenKeys(args, process.env, configMode);
    for (const [key, value] of Object.entries(envValues)) {
      process.env[key] = value;
    }

    if (overridden.length > 0) {
      console.error(
        `babelgate: your environment overrides ${overridden.join(", ")} ` +
          "(flags and presets never replace values you set)",
      );
    }
    if (
      !configMode &&
      args.preset === "claude-code" &&
      args.model === undefined &&
      !process.env.MODEL_MAP
    ) {
      console.error(
        "babelgate: no --model given; claude-* model names are forwarded " +
          "to the target unchanged",
      );
    }

    setConfigPath(args.config);
    await startServer();
    const config = getConfig();
    if (args.preset !== undefined) {
      // The export lines come from the requested preset — there is no
      // configured source format; the request path decides the dialect.
      for (const line of clientInstructions(
        args,
        config.port,
        config.proxyApiKey,
      )) {
        console.log(line);
      }
    } else {
      for (const line of endpointLines(config.port)) {
        console.log(line);
      }
    }
    for (const line of formatRoutingTable(config)) {
      console.log(line);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main(process.argv.slice(2));
}
