import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadYamlConfig } from "./yaml-config";
import type { GatewayConfig } from "./env-config";
import {
  PRESET_NAMES,
  PROVIDER_PRESETS,
  providerPresetSchema,
  type PresetName,
} from "./provider-presets";

/**
 * Preset tiers (v1.6 spec §3.3): `passthrough` is implied by shim
 * presets only, and every preset ships `docs`/`verified` evidence.
 */
function yamlConfig(
  doc: string,
  env: NodeJS.ProcessEnv = {},
): GatewayConfig {
  const dir = mkdtempSync(join(tmpdir(), "presets-"));
  try {
    const path = join(dir, "babelgate.yaml");
    writeFileSync(path, doc);
    return loadYamlConfig(path, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const presetEnv = (name: PresetName): NodeJS.ProcessEnv => {
  const env = PROVIDER_PRESETS[name].api_key_env;
  return env === undefined ? {} : { [env]: "k" };
};

describe("provider preset tiers (v1.6 spec §3.3)", () => {
  it("shim presets keep passthrough", () => {
    const shims = PRESET_NAMES.filter(
      (name) => PROVIDER_PRESETS[name].tier === "shim",
    );
    expect(shims.length).toBe(5);
    for (const name of shims) {
      const config = yamlConfig(
        `default: shim\nproviders:\n  shim:\n    preset: ${name}\n`,
        presetEnv(name),
      );
      const entry = config.registry.get("shim");
      expect(entry.passthrough, name).toBe(true);
      expect(entry.preset, name).toBe(name);
    }
  });

  it("free preset does not imply passthrough", () => {
    const nonShim = PRESET_NAMES.filter(
      (name) => PROVIDER_PRESETS[name].tier !== "shim",
    );
    expect(nonShim.length).toBeGreaterThan(0);
    for (const name of nonShim) {
      const config = yamlConfig(
        `default: p\nproviders:\n  p:\n    preset: ${name}\n`,
        presetEnv(name),
      );
      expect(
        config.registry.get("p").passthrough,
        name,
      ).toBeUndefined();
    }
  });

  it("openrouter-free preset fills type, base_url and key env", () => {
    const config = yamlConfig(
      `default: or\nproviders:\n  or:\n    preset: openrouter-free\n`,
      { OPENROUTER_API_KEY: "test-or-key" },
    );
    const entry = config.registry.get("or");
    expect(entry.type).toBe("openai");
    // babelgate appends /v1/chat/completions — the preset base is
    // https://openrouter.ai/api, NOT .../api/v1 (live.helpers.ts).
    expect(entry.baseUrl).toBe("https://openrouter.ai/api");
    expect(entry.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(entry.apiKey).toBe("test-or-key");
    expect(entry.preset).toBe("openrouter-free");
  });

  it("preset without docs or verified fails schema", () => {
    const base = PROVIDER_PRESETS["openrouter-free"];
    expect(
      providerPresetSchema.safeParse({ ...base, docs: undefined }).success,
    ).toBe(false);
    expect(
      providerPresetSchema.safeParse({ ...base, verified: undefined })
        .success,
    ).toBe(false);
    expect(
      providerPresetSchema.safeParse({ ...base, verified: "Nov 2026" })
        .success,
    ).toBe(false);
    expect(
      providerPresetSchema.safeParse({ ...base, tier: "trial" }).success,
    ).toBe(false);
    expect(providerPresetSchema.safeParse(base).success).toBe(true);
    for (const name of PRESET_NAMES) {
      expect(
        providerPresetSchema.safeParse(PROVIDER_PRESETS[name]).success,
        name,
      ).toBe(true);
    }
  });

  it("gemini-free suggests the proven edit-task model", () => {
    expect(PROVIDER_PRESETS["gemini-free"].suggested).toEqual({
      "claude-code": "gemini-3.8-flash",
      codex: "gemini-3.8-flash",
    });
  });

  it("presets without a live pass carry no suggestion", () => {
    for (const name of ["groq"] as const) {
      expect(
        PROVIDER_PRESETS[name].suggested,
        name,
      ).toBeUndefined();
    }
  });

  it("deepseek preset declares the json_schema gap", () => {
    // v1.6 Task 8b: DeepSeek documents only {type:"json_object"} for
    // response_format (https://api-docs.deepseek.com/guides/json_mode).
    expect(PROVIDER_PRESETS.deepseek.gaps).toContain("json_schema");
  });

  it("openrouter-free preset turns reasoning passback on", () => {
    // v1.6 Task 13c: OpenRouter documents `reasoning_content` as an
    // alias of `reasoning` — the preset declares what the provider
    // accepts, so the entry carries passback with no explicit key.
    const config = yamlConfig(
      `default: or\nproviders:\n  or:\n    preset: openrouter-free\n`,
      { OPENROUTER_API_KEY: "k" },
    );
    const entry = config.registry.get("or");
    expect(entry.reasoningPassback).toBe(true);
    expect(entry.preset).toBe("openrouter-free");
  });

  it("deepseek preset turns reasoning passback on", () => {
    // v1.6 Task 13c: DeepSeek's thinking-mode guide requires
    // `reasoning_content` back on every turn of a tools request.
    const config = yamlConfig(
      `default: ds\nproviders:\n  ds:\n    preset: deepseek\n`,
      { DEEPSEEK_API_KEY: "k" },
    );
    const entry = config.registry.get("ds");
    expect(entry.reasoningPassback).toBe(true);
    expect(entry.preset).toBe("deepseek");
  });

  it("explicit reasoning_passback false wins over the preset", () => {
    const config = yamlConfig(
      `default: or\nproviders:\n  or:\n    preset: openrouter-free\n    reasoning_passback: false\n`,
      { OPENROUTER_API_KEY: "k" },
    );
    expect(config.registry.get("or").reasoningPassback).toBe(false);
  });

  it("entry without a preset keeps passback off", () => {
    const config = yamlConfig(
      `default: o\nproviders:\n  o:\n    type: openai\n    base_url: https://api.openai.com\n    api_key_env: OPENAI_API_KEY\n`,
      { OPENAI_API_KEY: "k" },
    );
    expect(config.registry.get("o").reasoningPassback).toBeUndefined();
  });

  it("live-proven presets carry their edit-task model", () => {
    expect(PROVIDER_PRESETS["openrouter-free"].suggested).toEqual({
      "claude-code": "nvidia/nemotron-3-ultra-550b-a55b:free",
      codex: "nvidia/nemotron-3-ultra-550b-a55b:free",
    });
    expect(PROVIDER_PRESETS["nvidia-nim"].suggested).toEqual({
      "claude-code": "nvidia/nemotron-3-ultra-550b-a55b",
      codex: "nvidia/nemotron-3-ultra-550b-a55b",
    });
    expect(PROVIDER_PRESETS.cerebras.suggested).toEqual({
      "claude-code": "gpt-oss-120b",
      codex: "gpt-oss-120b",
    });
    expect(PROVIDER_PRESETS.deepseek.suggested).toEqual({
      "claude-code": "deepseek-flash",
      codex: "deepseek-flash",
    });
    expect(PROVIDER_PRESETS.deepseek.gaps).toEqual(["json_schema"]);
    expect(PROVIDER_PRESETS.cerebras.max_output_tokens).toBe(32768);
    for (const name of PRESET_NAMES) {
      if (name === "cerebras") continue;
      expect(
        PROVIDER_PRESETS[name].max_output_tokens,
        name,
      ).toBeUndefined();
    }
  });
});
