import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  ignoredEnvKeys,
  loadYamlConfig,
  resolveConfigPath,
} from "./yaml-config";
import { ConfigurationError } from "../utils/errors";

const FIXTURES = join(__dirname, "..", "..", "tests", "fixtures", "config");
const fixture = (name: string): string => join(FIXTURES, name);

const FULL_ENV = {
  OPENROUTER_API_KEY: "test-or-key",
  ANTHROPIC_API_KEY: "test-ant-key",
};

describe("loadYamlConfig", () => {
  it("valid full file builds registry and routing", () => {
    const config = loadYamlConfig(fixture("valid-full.yaml"), {
      ...FULL_ENV,
      PORT: "4321",
      PROXY_API_KEY: "proxy-key",
      UPSTREAM_TIMEOUT_MS: "9999",
      UPSTREAM_RETRIES: "3",
      UPSTREAM_STREAM_IDLE_MS: "1234",
    });

    expect(config.port).toBe(4321);
    expect(config.proxyApiKey).toBe("proxy-key");
    expect(config.upstreamTimeoutMs).toBe(9999);
    expect(config.upstreamRetries).toBe(3);
    expect(config.upstreamStreamIdleMs).toBe(1234);

    expect(config.registry.names()).toEqual([
      "ollama",
      "openrouter",
      "anthropic",
    ]);
    expect(config.registry.get("ollama")).toStrictEqual({
      name: "ollama",
      type: "ollama",
      baseUrl: "http://localhost:11434",
      apiKey: undefined,
      apiKeyEnv: undefined,
      contextWindow: undefined,
      timeoutMs: undefined,
      streamIdleMs: undefined,
    });
    expect(config.registry.get("openrouter")).toStrictEqual({
      name: "openrouter",
      type: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-or-key",
      apiKeyEnv: "OPENROUTER_API_KEY",
      contextWindow: undefined,
      timeoutMs: 120000,
      streamIdleMs: undefined,
    });
    expect(config.registry.get("anthropic")).toStrictEqual({
      name: "anthropic",
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "test-ant-key",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      contextWindow: 200000,
      timeoutMs: undefined,
      streamIdleMs: 60000,
    });
    expect(config.routing).toStrictEqual({
      defaultProvider: "ollama",
      aliases: {
        fast: { provider: "openrouter", model: "qwen/qwen3-coder" },
        smart: { provider: "anthropic", model: "claude-sonnet-4-5" },
      },
      rules: [
        {
          match: "claude-*haiku*",
          when: undefined,
          to: { provider: "ollama", model: "qwen2.5-coder:7b" },
          fallback: [],
        },
        {
          match: "claude-*",
          when: { minInputTokens: 60000 },
          to: { provider: "openrouter", model: "qwen/qwen3-coder" },
          fallback: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
        },
        {
          match: "claude-*",
          when: undefined,
          to: { provider: "ollama", model: "qwen3-coder:30b" },
          fallback: [{ provider: "openrouter", model: "qwen/qwen3-coder" }],
        },
      ],
    });
  });

  it("each invalid file names its problem", () => {
    const cases: [file: string, needle: string][] = [
      ["unknown-key.yaml", "extra_section"],
      ["bad-default.yaml", "notaconfigured"],
      ["target-no-provider.yaml", "routes[0].to"],
      ["target-unknown-provider.yaml", "routes[0].to"],
      ["missing-key-env.yaml", "BABELGATE_TEST_UNSET_KEY"],
      ["missing-key-field.yaml", "providers.openai.api_key_env"],
      ["duplicate-alias.yaml", "fast"],
      ["alias-is-provider.yaml", "aliases.ollama"],
      ["bad-provider-name.yaml", "OLLAMA"],
    ];
    for (const [file, needle] of cases) {
      expect(() => loadYamlConfig(fixture(file), {}), file).toThrowError(
        ConfigurationError,
      );
      expect(() => loadYamlConfig(fixture(file), {}), file).toThrowError(
        needle,
      );
    }
  });

  it("awkward yaml files", () => {
    // an empty file and a file with only `default` name `providers`
    for (const file of ["empty.yaml", "only-default.yaml"]) {
      expect(() => loadYamlConfig(fixture(file), {}), file).toThrowError(
        "providers",
      );
    }

    // a duplicate map key names the key
    expect(() =>
      loadYamlConfig(fixture("duplicate-map-key.yaml"), {}),
    ).toThrowError("default");

    // CRLF parses like the LF file
    const crlf = loadYamlConfig(fixture("crlf.yaml"), {});
    const lf = loadYamlConfig(fixture("valid-minimal.yaml"), {});
    expect(crlf.registry.names()).toStrictEqual(lf.registry.names());
    expect(crlf.registry.get("ollama")).toStrictEqual(
      lf.registry.get("ollama"),
    );
    expect(crlf.routing).toStrictEqual(lf.routing);
    expect(crlf.port).toBe(lf.port);

    // api_key_env set to "" is the same missing-key error as unset
    expect(() =>
      loadYamlConfig(fixture("missing-key-env.yaml"), {
        BABELGATE_TEST_UNSET_KEY: "",
      }),
    ).toThrowError("BABELGATE_TEST_UNSET_KEY");
  });

  it("a missing explicit path is a startup error", () => {
    expect(() => loadYamlConfig(fixture("does-not-exist.yaml"), {})).toThrowError(
      "Config file not found",
    );
  });
});

describe("resolveConfigPath", () => {
  const cwdWithFile = join(FIXTURES, "discovery");
  const cwdWithout = join(FIXTURES, "no-such-dir");

  it("discovery order", () => {
    const explicit = fixture("valid-minimal.yaml");
    const fromEnv = fixture("valid-full.yaml");

    expect(
      resolveConfigPath(explicit, { BABELGATE_CONFIG: fromEnv }, cwdWithFile),
    ).toBe(explicit);
    expect(
      resolveConfigPath(undefined, { BABELGATE_CONFIG: fromEnv }, cwdWithFile),
    ).toBe(fromEnv);
    expect(resolveConfigPath(undefined, {}, cwdWithFile)).toBe(
      join(cwdWithFile, "babelgate.yaml"),
    );
    expect(resolveConfigPath(undefined, {}, cwdWithout)).toBeUndefined();

    // explicit or BABELGATE_CONFIG pointing at a missing file → error
    expect(() =>
      resolveConfigPath("missing.yaml", {}, cwdWithout),
    ).toThrowError("Config file not found");
    expect(() =>
      resolveConfigPath(undefined, { BABELGATE_CONFIG: "missing.yaml" }, cwdWithout),
    ).toThrowError("Config file not found");
  });
});

describe("ignoredEnvKeys", () => {
  it("ignored env keys are reported", () => {
    expect(
      ignoredEnvKeys({
        TARGET_API: "ollama",
        OPENAI_API_BASE_URL: "http://y",
        OLLAMA_API_BASE_URL: "http://x",
        MODEL_MAP: "a=b",
        TARGET_CONTEXT_WINDOW: "1",
        SOURCE_API: "openai",
        PORT: "3000",
        PROXY_API_KEY: "k",
        UPSTREAM_TIMEOUT_MS: "1",
        UNRELATED: "x",
      }),
    ).toEqual([
      "TARGET_API",
      "OLLAMA_API_BASE_URL",
      "OPENAI_API_BASE_URL",
      "MODEL_MAP",
      "TARGET_CONTEXT_WINDOW",
      "SOURCE_API",
    ]);
    expect(ignoredEnvKeys({ PORT: "3000" })).toEqual([]);
  });
});
