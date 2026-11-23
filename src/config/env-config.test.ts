import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfig } from "./env-config";

describe("Environment Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    resetConfig();
    process.env = {
      ...originalEnv,
      OPENAI_API_BASE_URL: "https://api.openai.com",
      GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com",
      OLLAMA_API_BASE_URL: "http://localhost:11434",
      ANTHROPIC_API_BASE_URL: "https://api.anthropic.com",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  const unsetEnv = (key: string) => {
    delete process.env[key];
  };

  it("should throw error when required environment variables are not set", () => {
    unsetEnv("SOURCE_API");
    unsetEnv("TARGET_API");

    expect(() => loadConfig()).toThrow(
      "TARGET_API environment variable is required",
    );
  });

  it("SOURCE_API is ignored and reported as deprecated", () => {
    process.env.SOURCE_API = "INVALID_API";
    process.env.TARGET_API = "openai";
    process.env.OPENAI_API_KEY = "test-key";

    const config = loadConfig();
    expect(config.deprecatedEnv).toEqual(["SOURCE_API"]);
  });

  it("should throw error when TARGET_API is not a valid provider", () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "INVALID_API";

    expect(() => loadConfig()).toThrow("TARGET_API must be one of:");
  });

  it("should throw error when API key is not set for non-ollama target", () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "gemini";
    unsetEnv("GEMINI_API_KEY");

    expect(() => loadConfig()).toThrow(
      "GEMINI_API_KEY environment variable is required",
    );
  });

  it("should load config for openai target", () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "openai";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.PORT = "4000";

    const config = loadConfig();

    expect(config.targetApi).toBe("openai");
    expect(config.port).toBe(4000);
    expect(config.targetApiKey).toBe("test-openai-key");
    expect(config.targetBaseUrl).toBe("https://api.openai.com");
  });

  it("should load config for gemini target", () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "gemini";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.PORT = "4000";

    const config = loadConfig();

    expect(config.targetApi).toBe("gemini");
    expect(config.port).toBe(4000);
    expect(config.targetApiKey).toBe("test-gemini-key");
    expect(config.targetBaseUrl).toBe(
      "https://generativelanguage.googleapis.com",
    );
  });

  it("should load config for anthropic target", () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.PORT = "4000";

    const config = loadConfig();

    expect(config.targetApi).toBe("anthropic");
    expect(config.port).toBe(4000);
    expect(config.targetApiKey).toBe("test-anthropic-key");
    expect(config.targetBaseUrl).toBe("https://api.anthropic.com");
  });

  it("should not require API key for ollama target", () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "ollama";
    unsetEnv("OLLAMA_API_KEY");
    process.env.PORT = "4000";

    const config = loadConfig();

    expect(config.targetApi).toBe("ollama");
    expect(config.port).toBe(4000);
    expect(config.targetApiKey).toBeUndefined();
    expect(config.targetBaseUrl).toBe("http://localhost:11434");
  });

  it("TARGET_MAX_OUTPUT_TOKENS lands on the env-only provider (spec §3.3)", () => {
    process.env.TARGET_API = "ollama";
    process.env.TARGET_MAX_OUTPUT_TOKENS = "8000";

    const config = loadConfig();

    expect(config.registry.get("ollama").maxOutputTokens).toBe(8000);
  });

  it("TARGET_MAX_OUTPUT_TOKENS must be a positive integer", () => {
    process.env.TARGET_API = "ollama";
    process.env.TARGET_MAX_OUTPUT_TOKENS = "8k";

    expect(() => loadConfig()).toThrow("TARGET_MAX_OUTPUT_TOKENS");
  });

  it("INSPECTOR_BUFFER defaults to 50, 0 disables (spec §3.11)", () => {
    process.env.TARGET_API = "ollama";

    expect(loadConfig().observe.inspectorBuffer).toBe(50);

    process.env.INSPECTOR_BUFFER = "0";
    expect(loadConfig().observe.inspectorBuffer).toBe(0);
  });

  it("INSPECTOR_BUFFER must be a non-negative integer", () => {
    process.env.TARGET_API = "ollama";
    process.env.INSPECTOR_BUFFER = "-1";

    expect(() => loadConfig()).toThrow("INSPECTOR_BUFFER");
  });

  it("should use default port when PORT is not set", () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "ollama";
    unsetEnv("PORT");

    const config = loadConfig();

    expect(config.port).toBe(3000);
  });

  it("should normalize uppercase provider names", () => {
    process.env.SOURCE_API = "OPENAI";
    process.env.TARGET_API = "GEMINI";
    process.env.GEMINI_API_KEY = "test-key";

    const config = loadConfig();

    expect(config.targetApi).toBe("gemini");
  });

  it("should throw error when target base URL is not set", () => {
    process.env.SOURCE_API = "openai";
    process.env.TARGET_API = "ollama";
    unsetEnv("OLLAMA_API_BASE_URL");

    expect(() => loadConfig()).toThrow(
      "OLLAMA_API_BASE_URL environment variable is required",
    );
  });

  it("TARGET_API_KEY_ENV names the variable the key is read from", () => {
    process.env.TARGET_API = "openai";
    process.env.TARGET_API_KEY_ENV = "OPENROUTER_API_KEY";
    process.env.OPENROUTER_API_KEY = "or-key";
    unsetEnv("OPENAI_API_KEY");

    const config = loadConfig();

    expect(config.targetApiKey).toBe("or-key");
    expect(config.registry.get("openai").apiKeyEnv).toBe(
      "OPENROUTER_API_KEY",
    );
  });

  it("TARGET_API_KEY_ENV names the missing key in the error", () => {
    process.env.TARGET_API = "openai";
    process.env.TARGET_API_KEY_ENV = "OPENROUTER_API_KEY";
    unsetEnv("OPENAI_API_KEY");
    unsetEnv("OPENROUTER_API_KEY");

    expect(() => loadConfig()).toThrow(
      "OPENROUTER_API_KEY environment variable is required",
    );
  });

  it("TARGET_PRESET lands on the provider entry and supplies the key env", () => {
    process.env.TARGET_API = "openai";
    process.env.TARGET_PRESET = "groq";
    process.env.GROQ_API_KEY = "groq-key";
    unsetEnv("TARGET_API_KEY_ENV");
    unsetEnv("OPENAI_API_KEY");

    const config = loadConfig();

    expect(config.targetApiKey).toBe("groq-key");
    expect(config.registry.get("openai").preset).toBe("groq");
  });

  it("TARGET_PRESET supplies the preset's declared gaps", () => {
    // v1.6 Task 8b: the `--provider` env path carries the preset's
    // gaps onto the entry, like the yaml loader's merge.
    process.env.TARGET_API = "openai";
    process.env.TARGET_PRESET = "deepseek";
    process.env.DEEPSEEK_API_KEY = "k";
    unsetEnv("TARGET_API_KEY_ENV");

    const config = loadConfig();

    expect(config.registry.get("openai").gaps).toEqual(["json_schema"]);
  });

  it("a keyless preset needs no api key", () => {
    process.env.TARGET_API = "anthropic";
    process.env.TARGET_PRESET = "ollama-anthropic";
    unsetEnv("TARGET_API_KEY_ENV");
    unsetEnv("ANTHROPIC_API_KEY");

    const config = loadConfig();

    expect(config.registry.get("anthropic").apiKey).toBeUndefined();
    expect(config.registry.get("anthropic").preset).toBe(
      "ollama-anthropic",
    );
  });

  it("an unknown TARGET_PRESET is a config error", () => {
    process.env.TARGET_API = "openai";
    process.env.TARGET_PRESET = "not-a-preset";
    process.env.OPENAI_API_KEY = "test-key";

    expect(() => loadConfig()).toThrow("TARGET_PRESET");
  });
});
