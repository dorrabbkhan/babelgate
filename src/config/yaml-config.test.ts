import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

  it("max_output_tokens lands on the entry or is a startup error (spec §3.3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "babelgate-cap-"));
    try {
      const good = join(dir, "good.yaml");
      writeFileSync(
        good,
        [
          "default: ollama",
          "providers:",
          "  ollama:",
          "    type: ollama",
          "    base_url: http://localhost:11434",
          "    max_output_tokens: 8000",
          "",
        ].join("\n"),
      );
      const config = loadYamlConfig(good, {});
      expect(config.registry.get("ollama").maxOutputTokens).toBe(8000);

      for (const [name, value] of [
        ["zero", "0"],
        ["string", '"8k"'],
      ] as const) {
        const bad = join(dir, `${name}.yaml`);
        writeFileSync(
          bad,
          [
            "default: ollama",
            "providers:",
            "  ollama:",
            "    type: ollama",
            "    base_url: http://localhost:11434",
            `    max_output_tokens: ${value}`,
            "",
          ].join("\n"),
        );
        expect(() => loadYamlConfig(bad, {}), name).toThrowError(
          ConfigurationError,
        );
        expect(() => loadYamlConfig(bad, {}), name).toThrowError(
          "max_output_tokens",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache_hints lands on the entry or is a startup error (spec §3.2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "babelgate-hints-"));
    try {
      const good = join(dir, "good.yaml");
      writeFileSync(
        good,
        [
          "default: ollama",
          "providers:",
          "  ollama:",
          "    type: ollama",
          "    base_url: http://localhost:11434",
          "  openrouter:",
          "    type: openai",
          "    base_url: https://openrouter.test",
          "    api_key_env: BABELGATE_TEST_KEY",
          "    cache_hints: true",
          "",
        ].join("\n"),
      );
      const config = loadYamlConfig(good, {
        BABELGATE_TEST_KEY: "k",
      });
      expect(config.registry.get("openrouter").cacheHints).toBe(true);
      expect(config.registry.get("ollama").cacheHints).toBeUndefined();

      const bad = join(dir, "bad.yaml");
      writeFileSync(
        bad,
        [
          "default: ollama",
          "providers:",
          "  ollama:",
          "    type: ollama",
          "    base_url: http://localhost:11434",
          '    cache_hints: "yes"',
          "",
        ].join("\n"),
      );
      expect(() => loadYamlConfig(bad, {})).toThrowError(
        ConfigurationError,
      );
      expect(() => loadYamlConfig(bad, {})).toThrowError("cache_hints");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("live_prices, local and top-level prices: parse (spec §3.6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "babelgate-prices-"));
    try {
      const good = join(dir, "good.yaml");
      writeFileSync(
        good,
        [
          "default: ollama",
          "providers:",
          "  ollama:",
          "    type: ollama",
          "    base_url: http://localhost:11434",
          "  openrouter:",
          "    type: openai",
          "    base_url: https://openrouter.test",
          "    api_key_env: BABELGATE_TEST_KEY",
          "    live_prices: true",
          "  homebox:",
          "    type: openai",
          "    base_url: http://homebox.test",
          "    api_key_env: BABELGATE_TEST_KEY",
          "    local: true",
          "prices:",
          "  openrouter/qwen/*: {input: 0.22, output: 0.95}",
          "  'homebox/*': {input: 0, output: 0, cache_read: 0.1}",
          "",
        ].join("\n"),
      );
      const config = loadYamlConfig(good, { BABELGATE_TEST_KEY: "k" });
      expect(config.registry.get("openrouter").livePrices).toBe(true);
      expect(config.registry.get("homebox").local).toBe(true);
      expect(config.registry.get("ollama").livePrices).toBeUndefined();
      expect(config.registry.get("ollama").local).toBeUndefined();
      expect(config.prices).toEqual({
        "openrouter/qwen/*": { input: 0.22, output: 0.95 },
        "homebox/*": { input: 0, output: 0, cacheRead: 0.1 },
      });

      // Bad shapes are startup errors naming the key.
      for (const [name, lines, needle] of [
        [
          "prices value not an object",
          ["prices:", "  'a/b': 3"],
          "prices",
        ],
        [
          "prices missing input",
          ["prices:", "  'a/b': {output: 1}"],
          "input",
        ],
        [
          "live_prices not a bool",
          [
            "  broken:",
            "    type: ollama",
            "    base_url: http://x",
            '    live_prices: "yes"',
          ],
          "live_prices",
        ],
      ] as const) {
        const bad = join(dir, `${name}.yaml`);
        writeFileSync(
          bad,
          [
            "default: ollama",
            "providers:",
            "  ollama:",
            "    type: ollama",
            "    base_url: http://localhost:11434",
            ...lines,
            "",
          ].join("\n"),
        );
        expect(() => loadYamlConfig(bad, {}), name).toThrowError(
          ConfigurationError,
        );
        expect(() => loadYamlConfig(bad, {}), name).toThrowError(needle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("observe: keys map to ObserveConfig and env wins (spec §3.11)", () => {
    const dir = mkdtempSync(join(tmpdir(), "babelgate-observe-"));
    try {
      let n = 0;
      const yaml = (observe: string[]) => {
        const file = join(dir, `cfg-${n++}.yaml`);
        writeFileSync(
          file,
          [
            "default: ollama",
            "providers:",
            "  ollama:",
            "    type: ollama",
            "    base_url: http://localhost:11434",
            ...observe,
            "",
          ].join("\n"),
        );
        return file;
      };

      const full = yaml([
        "observe:",
        "  usage_store: false",
        `  usage_db: ${join(dir, "custom.db")}`,
        "  retention_days: 7",
        "  inspector_buffer: 10",
        "  log_bodies: true",
        "  would_cost_reference: openrouter/qwen",
      ]);
      const config = loadYamlConfig(full, {});
      expect(config.observe).toStrictEqual({
        usageStore: false,
        usageDb: join(dir, "custom.db"),
        retentionDays: 7,
        inspectorBuffer: 10,
        logBodies: true,
        wouldCostReference: "openrouter/qwen",
        metrics: true,
        ui: true,
        uiAllowRemote: false,
        uiAllowedHosts: [],
      });

      // No observe: section → the §3.11 defaults (usage_db's ~ expands).
      const defaults = loadYamlConfig(yaml([]), {});
      expect(defaults.observe).toStrictEqual({
        usageStore: true,
        usageDb: join(homedir(), ".babelgate", "usage.db"),
        retentionDays: 30,
        inspectorBuffer: 50,
        logBodies: false,
        metrics: true,
        ui: true,
        uiAllowRemote: false,
        uiAllowedHosts: [],
      });
      expect("wouldCostReference" in defaults.observe).toBe(false);

      // Env wins over every observe: key it names.
      const env = loadYamlConfig(full, {
        USAGE_STORE: "on",
        USAGE_DB: join(dir, "env.db"),
        USAGE_RETENTION_DAYS: "90",
        INSPECTOR_BUFFER: "0",
        LOG_BODIES: "false",
      });
      expect(env.observe).toMatchObject({
        usageStore: true,
        usageDb: join(dir, "env.db"),
        retentionDays: 90,
        inspectorBuffer: 0,
        logBodies: false,
        // no env counterpart — the YAML value stands
        wouldCostReference: "openrouter/qwen",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("observe: unknown keys and bad values are startup errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "babelgate-observe-bad-"));
    try {
      const yaml = (observe: readonly string[]) => {
        const file = join(dir, "cfg.yaml");
        writeFileSync(
          file,
          [
            "default: ollama",
            "providers:",
            "  ollama:",
            "    type: ollama",
            "    base_url: http://localhost:11434",
            "observe:",
            ...observe,
            "",
          ].join("\n"),
        );
        return file;
      };

      for (const [name, lines, needle] of [
        ["unknown key", ["  mystery: true"], "mystery"],
        ["usage_store not a bool", ["  usage_store: maybe"], "usage_store"],
        ["retention_days not positive", ["  retention_days: 0"], "retention_days"],
        ["inspector_buffer negative", ["  inspector_buffer: -1"], "inspector_buffer"],
      ] as const) {
        expect(() => loadYamlConfig(yaml(lines), {}), name).toThrowError(
          ConfigurationError,
        );
        expect(() => loadYamlConfig(yaml(lines), {}), name).toThrowError(
          needle,
        );
      }

      // Invalid env values error naming the env var.
      const good = join(dir, "good.yaml");
      writeFileSync(
        good,
        [
          "default: ollama",
          "providers:",
          "  ollama:",
          "    type: ollama",
          "    base_url: http://localhost:11434",
          "",
        ].join("\n"),
      );
      expect(() =>
        loadYamlConfig(good, { USAGE_RETENTION_DAYS: "abc" }),
      ).toThrowError("USAGE_RETENTION_DAYS");
      expect(() =>
        loadYamlConfig(good, { USAGE_STORE: "banana" }),
      ).toThrowError("USAGE_STORE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("TARGET_MAX_OUTPUT_TOKENS is env-only and reported when a file loads", () => {
    expect(ignoredEnvKeys({ TARGET_MAX_OUTPUT_TOKENS: "8000" })).toEqual([
      "TARGET_MAX_OUTPUT_TOKENS",
    ]);
  });
});
