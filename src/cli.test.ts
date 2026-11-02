import { describe, it, expect, vi } from "vitest";
import {
  parseCliArgs,
  presetEnv,
  overriddenKeys,
  clientInstructions,
  endpointLines,
  main,
} from "./cli";

describe("cli", () => {
  it("claude-code + ollama preset env", () => {
    const env = presetEnv(
      { preset: "claude-code", target: "ollama", model: "qwen2.5:0.5b" },
      {},
    );

    expect(env).toEqual({
      TARGET_API: "ollama",
      MODEL_MAP: "claude-*=qwen2.5:0.5b",
      TARGET_CONTEXT_WINDOW: "32768",
      UPSTREAM_TIMEOUT_MS: "600000",
    });
  });

  it("user env wins over preset", () => {
    const env = presetEnv(
      { preset: "claude-code", target: "ollama", model: "qwen2.5:0.5b" },
      {
        SOURCE_API: "openai",
        TARGET_API: "openai",
        MODEL_MAP: "claude-*=my-model",
        UPSTREAM_TIMEOUT_MS: "1234",
      },
    );

    expect(env).toEqual({ TARGET_CONTEXT_WINDOW: "32768" });
  });

  it("claude-code ollama timeout from env TARGET_API", () => {
    const env = presetEnv(
      { preset: "claude-code", model: "m" },
      { TARGET_API: "ollama" },
    );

    expect(env).toEqual({
      MODEL_MAP: "claude-*=m",
      TARGET_CONTEXT_WINDOW: "32768",
      UPSTREAM_TIMEOUT_MS: "600000",
    });
  });

  it("claude-code instructions", () => {
    expect(clientInstructions({ preset: "claude-code" }, 3000, "k")).toEqual([
      "export ANTHROPIC_BASE_URL=http://localhost:3000",
      "export ANTHROPIC_AUTH_TOKEN=k",
    ]);
    expect(clientInstructions({ preset: "claude-code" }, 3000)).toEqual([
      "export ANTHROPIC_BASE_URL=http://localhost:3000",
      "export ANTHROPIC_AUTH_TOKEN=babelgate",
    ]);
  });

  it("reports env keys that override the preset", () => {
    expect(
      overriddenKeys(
        { preset: "claude-code", target: "ollama", model: "qwen2.5:0.5b" },
        {
          SOURCE_API: "openai",
          TARGET_API: "openai",
          MODEL_MAP: "claude-*=my-model",
          UPSTREAM_TIMEOUT_MS: "1234",
        },
      ),
    ).toEqual(["TARGET_API", "MODEL_MAP", "UPSTREAM_TIMEOUT_MS"]);
  });

  it("openai-apps instructions", () => {
    expect(
      clientInstructions({ preset: "openai-apps" }, 3000, "proxy-secret"),
    ).toEqual([
      "export OPENAI_BASE_URL=http://localhost:3000/v1",
      "export OPENAI_API_KEY=proxy-secret",
    ]);
    expect(clientInstructions({ preset: "openai-apps" }, 8080)).toEqual([
      "export OPENAI_BASE_URL=http://localhost:8080/v1",
      "export OPENAI_API_KEY=babelgate",
    ]);
  });

  it("--base-url sets the target base URL", () => {
    expect(
      presetEnv(
        { target: "openai", baseUrl: "https://openrouter.ai/api/v1" },
        {},
      ),
    ).toEqual({
      TARGET_API: "openai",
      OPENAI_API_BASE_URL: "https://openrouter.ai/api/v1",
    });
  });

  it("unknown flag throws naming it", () => {
    expect(() => parseCliArgs(["--bogus", "x"])).toThrow(/--bogus/);
    expect(() => parseCliArgs(["--preset", "nope"])).toThrow(/--preset/);
    expect(() => parseCliArgs(["--target", "nope"])).toThrow(/--target/);
    expect(() => parseCliArgs(["--port", "abc"])).toThrow(/--port/);
  });

  it("no flag accepts an API key", () => {
    expect(() => parseCliArgs(["--api-key", "x"])).toThrow(/--api-key/);
    expect(() => parseCliArgs(["--openai-api-key", "x"])).toThrow(
      /--openai-api-key/,
    );
  });

  it("--config is parsed", () => {
    expect(parseCliArgs(["--config", "gw.yaml"])).toEqual({
      config: "gw.yaml",
    });
    expect(
      parseCliArgs(["--config", "gw.yaml", "--preset", "claude-code"]),
    ).toEqual({ config: "gw.yaml", preset: "claude-code" });
    expect(
      parseCliArgs(["--config", "gw.yaml", "--port", "4000"]),
    ).toEqual({ config: "gw.yaml", port: 4000 });
  });

  it("--config with --target, --model or --base-url throws", () => {
    expect(() =>
      parseCliArgs(["--config", "gw.yaml", "--target", "ollama"]),
    ).toThrow(/defined by the config file/);
    expect(() =>
      parseCliArgs(["--config", "gw.yaml", "--model", "m"]),
    ).toThrow(/defined by the config file/);
    expect(() =>
      parseCliArgs(["--config", "gw.yaml", "--base-url", "http://x"]),
    ).toThrow(/defined by the config file/);
  });

  it("endpoint lines", () => {
    expect(endpointLines(3000)).toEqual([
      "OpenAI     http://localhost:3000/v1",
      "Anthropic  http://localhost:3000",
      "Gemini     http://localhost:3000/v1beta",
      "Ollama     http://localhost:3000",
    ]);
  });

  it("--help mentions --config and BABELGATE_CONFIG", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((line?: unknown) => {
        lines.push(String(line));
      });
    try {
      await main(["--help"]);
    } finally {
      spy.mockRestore();
    }
    const help = lines.join("\n");
    expect(help).toContain("--config");
    expect(help).toContain("BABELGATE_CONFIG");
    expect(help).toContain("./babelgate.yaml");
  });

  it("config mode + claude-code preset sets no routing env", () => {
    expect(presetEnv({ preset: "claude-code" }, {}, true)).toEqual({});
    expect(presetEnv({ preset: "claude-code", port: 4000 }, {}, true)).toEqual(
      { PORT: "4000" },
    );
    expect(
      overriddenKeys({ preset: "claude-code" }, { PORT: "1" }, true),
    ).toEqual([]);
  });
});
