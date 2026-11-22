#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Provider } from "./transformers/adapters";
import { getConfig, setConfigPath } from "./config/env-config";
import {
  PRESET_NAMES,
  PROVIDER_PRESETS,
  type PresetName,
} from "./config/provider-presets";
import { resolveConfigPath } from "./config/yaml-config";
import { formatPresetList } from "./cli-presets";
import {
  clientInstructions,
  codexConfigToml,
  effectiveProviderPreset,
  endpointLines,
  missingKeyError,
  providerWanted,
  usageLines,
  writeCodexCatalog,
} from "./cli-first-run";
import { installSqliteWarningFilter } from "./observe/sqlite";
import { formatRoutingTable } from "./routing/table";
import { startServer } from "./index";

export interface CliArgs {
  command?: "presets";
  preset?: "claude-code" | "codex" | "openai-apps";
  provider?: PresetName;
  target?: Provider;
  model?: string;
  baseUrl?: string;
  config?: string;
  port?: number;
  help?: boolean;
  version?: boolean;
}

const PRESETS = ["claude-code", "codex", "openai-apps"] as const;
const PROVIDERS: Provider[] = [
  "openai",
  "gemini",
  "ollama",
  "anthropic",
  "responses",
];

/**
 * Parses CLI arguments. Unknown flags and invalid values throw an error
 * naming the flag; upstream keys only ever come from the environment.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      preset: { type: "string" },
      provider: { type: "string" },
      target: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      config: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
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
  if (values.provider !== undefined) {
    if (!(PRESET_NAMES as readonly string[]).includes(values.provider)) {
      throw new Error(
        `--provider must be one of: ${PRESET_NAMES.join(", ")}`,
      );
    }
    args.provider = values.provider as PresetName;
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
  // --provider fills target, base URL and key env itself — combining
  // it with the flags it replaces would be contradictory input.
  if (
    args.provider !== undefined &&
    (args.target !== undefined || args.baseUrl !== undefined)
  ) {
    throw new Error(
      "--provider cannot be combined with --target or --base-url",
    );
  }
  if (
    args.config !== undefined &&
    (args.target !== undefined ||
      args.model !== undefined ||
      args.baseUrl !== undefined ||
      args.provider !== undefined)
  ) {
    throw new Error(
      "--target, --model, --provider and --base-url are defined by " +
        "the config file",
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
  if (values.version) args.version = true;
  for (const positional of positionals) {
    // `babelgate presets` (v1.6 spec §3.3) is the only subcommand.
    if (positional === "presets" && args.command === undefined) {
      args.command = "presets";
    } else {
      throw new Error(`unexpected argument "${positional}"`);
    }
  }
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
  if (args.provider !== undefined) {
    return PROVIDER_PRESETS[args.provider].type;
  }
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
    // --provider <preset> is an env-path flag like --target (v1.6 spec
    // §3.3): the wanted env values are built by cli-first-run.
    if (args.provider !== undefined) {
      Object.assign(wanted, providerWanted(args.provider));
    }
    if (args.target !== undefined) {
      wanted.TARGET_API = args.target;
    }

    const providerPreset = effectiveProviderPreset(args, env);
    if (args.preset === "claude-code") {
      const model = args.model ?? providerPreset?.suggested?.["claude-code"];
      if (model !== undefined) {
        wanted.MODEL_MAP = `claude-*=${model}`;
      }
      wanted.TARGET_CONTEXT_WINDOW = "32768";
      if (effectiveTarget(args, env) === "ollama") {
        wanted.UPSTREAM_TIMEOUT_MS = "600000";
      }
    }

    if (args.preset === "codex") {
      const model = args.model ?? providerPreset?.suggested?.codex;
      if (model !== undefined) {
        wanted.MODEL_MAP = `*=${model}`;
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

export async function main(argv: string[]): Promise<void> {
  try {
    const args = parseCliArgs(argv);
    if (args.help) {
      for (const line of usageLines()) console.log(line);
      return;
    }
    if (args.version) {
      // require(), not an import: package.json sits outside the
      // tsconfig rootDir, and esbuild inlines the same call for the
      // SEA bundle — one version source for every distribution.
      const pkg = require("../package.json") as { version: string };
      console.log(`babelgate ${pkg.version}`);
      return;
    }
    if (args.command === "presets") {
      for (const line of formatPresetList(PROVIDER_PRESETS)) {
        console.log(line);
      }
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
        args.baseUrl !== undefined ||
        args.provider !== undefined)
    ) {
      throw new Error(
        "--target, --model, --provider and --base-url are defined by " +
          "the config file",
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
    // Missing upstream key on a preset first run: say which env var the
    // key is read from and where to get one, before listening (§3.3).
    if (!configMode) {
      const keyError = missingKeyError(process.env);
      if (keyError !== undefined) {
        console.error(keyError);
        process.exitCode = 1;
        return;
      }
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
    if (!configMode && args.preset === "codex" && !process.env.MODEL_MAP) {
      console.error(
        "babelgate: no --model given and no suggested codex model; the " +
          "config.toml model name is forwarded to the target unchanged",
      );
    }

    setConfigPath(args.config);
    // §3.4: the node:sqlite ExperimentalWarning (that warning only) is
    // filtered before the usage store can load the builtin.
    installSqliteWarningFilter();
    try {
      await startServer();
    } catch (err) {
      // Review Focus 2: a busy port is one line and exit 1, never a
      // stack trace. The listen error carries the port it failed on.
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        const port =
          (err as NodeJS.ErrnoException & { port?: number }).port ??
          (process.env.PORT !== undefined ? Number(process.env.PORT) : 3000);
        console.error(
          `Port ${port} is in use. Start with --port ${port + 1} ` +
            "(or stop the other process).",
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    const config = getConfig();
    const maxOutputTokens =
      process.env.TARGET_MAX_OUTPUT_TOKENS !== undefined
        ? Number(process.env.TARGET_MAX_OUTPUT_TOKENS)
        : undefined;
    if (args.preset === "codex") {
      // §3.3: print the config.toml block on the actual port and write
      // the model catalog under ~/.babelgate — nothing else outside it.
      const model =
        args.model ??
        effectiveProviderPreset(args, process.env)?.suggested?.codex ??
        "babelgate";
      const catalogPath = writeCodexCatalog(model);
      for (const line of clientInstructions(
        args,
        config.port,
        config.proxyApiKey,
        maxOutputTokens,
      )) {
        console.log(line);
      }
      console.log(`Codex model catalog written to ${catalogPath}`);
      console.log("Paste into ~/.codex/config.toml:");
      for (const line of codexConfigToml(config.port, model, catalogPath)) {
        console.log(line);
      }
    } else if (args.preset !== undefined) {
      // The export lines come from the requested preset — there is no
      // configured source format; the request path decides the dialect.
      for (const line of clientInstructions(
        args,
        config.port,
        config.proxyApiKey,
        maxOutputTokens,
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
