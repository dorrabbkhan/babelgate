import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PRESET_NAMES,
  PROVIDER_PRESETS,
  type PresetName,
  type ProviderPreset,
} from "./config/provider-presets";
import catalogTemplate from "./codex-model-catalog.json";
import type { CliArgs } from "./cli";

/**
 * First-run helpers (v1.6 spec §3.3): the `--provider` env mapping,
 * missing-key guidance, the `--preset codex` config.toml + model
 * catalog, and the lines the CLI prints once the server is up. cli.ts
 * keeps argument parsing and orchestration; everything a first run
 * shows or writes lives here so cli.ts stays a thin entry point.
 */

/**
 * The env values `--provider <preset>` wants (conductor's call c):
 * target type and base URL, the *name* of the env var the key is read
 * from (the key itself is never copied between variables),
 * TARGET_PRESET so the provider entry can carry the preset, and the
 * provider's output-token cap when it declares one (E11).
 */
export function providerWanted(provider: PresetName): Record<string, string> {
  const preset = PROVIDER_PRESETS[provider];
  const wanted: Record<string, string> = {
    TARGET_API: preset.type,
    [`${preset.type.toUpperCase()}_API_BASE_URL`]: preset.base_url,
    TARGET_PRESET: provider,
  };
  if (preset.api_key_env !== undefined) {
    wanted.TARGET_API_KEY_ENV = preset.api_key_env;
  }
  if (preset.max_output_tokens !== undefined) {
    wanted.TARGET_MAX_OUTPUT_TOKENS = String(preset.max_output_tokens);
  }
  return wanted;
}

/**
 * The provider preset in effect: an explicit TARGET_PRESET in the
 * user's env wins over --provider (user env always wins), an invalid
 * name falls back to the flag, and neither means no preset.
 */
export function effectiveProviderPreset(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): ProviderPreset | undefined {
  if (
    env.TARGET_PRESET !== undefined &&
    (PRESET_NAMES as readonly string[]).includes(env.TARGET_PRESET)
  ) {
    return PROVIDER_PRESETS[env.TARGET_PRESET as PresetName];
  }
  return args.provider === undefined
    ? undefined
    : PROVIDER_PRESETS[args.provider];
}

/**
 * The missing-key guidance for a preset-driven first run (§3.3): names
 * the env var the key is read from and where to get one. Returns
 * undefined when no preset applies, the preset is keyless or the key
 * is present.
 */
export function missingKeyError(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const name = env.TARGET_PRESET;
  if (
    name === undefined ||
    !(PRESET_NAMES as readonly string[]).includes(name)
  ) {
    return undefined;
  }
  const preset = PROVIDER_PRESETS[name as PresetName];
  const keyEnv = env.TARGET_API_KEY_ENV ?? preset.api_key_env;
  if (keyEnv === undefined || env[keyEnv]) return undefined;
  const where =
    preset.signup_url !== undefined
      ? `Get a key at ${preset.signup_url}`
      : `See ${preset.docs}`;
  return (
    `${keyEnv} is not set. ${where} ` +
    `(${preset.tier} tier per ${name} docs on ${preset.verified}).`
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
  maxOutputTokens?: number,
): string[] {
  const token = proxyApiKey ?? "babelgate";
  if (args.preset === "claude-code") {
    const lines = [
      `export ANTHROPIC_BASE_URL=http://localhost:${port}`,
      `export ANTHROPIC_AUTH_TOKEN=${token}`,
    ];
    // E11: Claude Code defaults to 32000 max output tokens on models it
    // doesn't recognise; when the provider preset caps below that, its
    // env var carries the same limit (v1.6 spec §3.3).
    if (maxOutputTokens !== undefined) {
      lines.push(`export CLAUDE_CODE_MAX_OUTPUT_TOKENS=${maxOutputTokens}`);
    }
    return lines;
  }
  if (args.preset === "codex") {
    return [`export BABELGATE_KEY=${token}`];
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
    `UI         http://localhost:${port}/ui`,
  ];
}

export function usageLines(): string[] {
  return [
    "Usage: babelgate [--preset <claude-code|codex|openai-apps>] [--target <provider>]",
    "                 [--provider <preset>] [--model <name>] [--base-url <url>]",
    "                 [--port <n>] [--config <path>] [--help] [--version]",
    "       babelgate presets",
    "",
    "Config file discovery: --config, then BABELGATE_CONFIG,",
    "then ./babelgate.yaml. Upstream API keys come only from the environment",
    "(OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OLLAMA_API_KEY,",
    "RESPONSES_API_KEY, or the env var TARGET_API_KEY_ENV names).",
  ];
}

/**
 * `--preset codex` (§3.3): the block the user pastes into
 * `~/.codex/config.toml` — the provider block from
 * docs/recipes/codex.md with `base_url` on the actual port, plus
 * `model_catalog_json` pointing at the catalog writeCodexCatalog
 * drops under `~/.babelgate` (Codex needs it so the gate model keeps
 * full metadata — apply_patch, reasoning levels — instead of the
 * unknown-slug fallback, owner decision A).
 */
export function codexConfigToml(
  port: number,
  model: string,
  catalogPath: string,
): string[] {
  return [
    `model = "${model}"`,
    'model_provider = "babelgate"',
    'model_reasoning_effort = "medium"',
    'model_reasoning_summary = "auto"',
    'web_search = "disabled"',
    `model_catalog_json = "${catalogPath}"`,
    "",
    "[model_providers.babelgate]",
    'name = "babelgate"',
    `base_url = "http://localhost:${port}/v1"`,
    'wire_api = "responses"',
    'env_key = "BABELGATE_KEY"',
    "requires_openai_auth = false",
  ];
}

/**
 * Writes `~/.babelgate/codex-model-catalog.json` — the template at
 * `src/codex-model-catalog.json` (kept identical to
 * `examples/codex-model-catalog.json` by a cli.test.ts parity test,
 * because the npm package and the SEA binary cannot read examples/)
 * with the model slug replaced by the routed model so it matches the
 * `model` name in the printed config.toml. Nothing else is written
 * outside `~/.babelgate` (§3.3).
 */
export function writeCodexCatalog(
  model: string,
  homeDir: string = homedir(),
): string {
  const catalog = JSON.parse(JSON.stringify(catalogTemplate)) as {
    models: { slug: string; display_name: string; description: string }[];
  };
  for (const entry of catalog.models) {
    entry.slug = model;
    entry.display_name = model;
    entry.description = `Model entry for ${model} routed through babelgate.`;
  }
  const dir = join(homeDir, ".babelgate");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "codex-model-catalog.json");
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
  return path;
}
