import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import { describe, it, expect, vi } from "vitest";
import { app } from "./app";
import {
  parseCliArgs,
  presetEnv,
  overriddenKeys,
  main,
} from "./cli";
import {
  clientInstructions,
  codexConfigToml,
  endpointLines,
  writeCodexCatalog,
} from "./cli-first-run";
import { resetConfig } from "./config/env-config";
import { PROVIDER_PRESETS } from "./config/provider-presets";
import templateCatalog from "./codex-model-catalog.json";

// --preset codex writes under ~/.babelgate; homedir() is module-level
// ESM so vi.spyOn can't patch it — mock node:os once for the file and
// redirect the home dir through BABELGATE_TEST_HOME instead, so the
// catalog write lands in the test's temp dir on every platform (the
// real home is read-only in the sandbox).
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.BABELGATE_TEST_HOME ?? actual.homedir(),
  };
});

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
      "Gemini     http://localhost:3000",
      "Ollama     http://localhost:3000",
      "UI         http://localhost:3000/ui",
    ]);
  });

  it("endpoint lines include the UI", () => {
    expect(endpointLines(3000)).toContain(
      "UI         http://localhost:3000/ui",
    );
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

  it("--provider sets target env and key env name", () => {
    expect(presetEnv({ provider: "openrouter-free" }, {})).toEqual({
      TARGET_API: "openai",
      OPENAI_API_BASE_URL: "https://openrouter.ai/api",
      TARGET_API_KEY_ENV: "OPENROUTER_API_KEY",
      TARGET_PRESET: "openrouter-free",
    });
  });

  it("--provider with config file is refused", () => {
    expect(() =>
      parseCliArgs(["--config", "gw.yaml", "--provider", "groq"]),
    ).toThrow(/defined by the config file/);
  });

  it("--provider cannot combine with --target or --base-url", () => {
    expect(() =>
      parseCliArgs(["--provider", "groq", "--target", "openai"]),
    ).toThrow(/--provider/);
    expect(() =>
      parseCliArgs(["--provider", "groq", "--base-url", "http://x"]),
    ).toThrow(/--provider/);
  });

  it("--provider with an unknown preset name throws naming the flag", () => {
    expect(() => parseCliArgs(["--provider", "nope"])).toThrow(/--provider/);
  });

  it("user env wins over --provider", () => {
    expect(
      presetEnv(
        { provider: "openrouter-free" },
        {
          TARGET_API: "gemini",
          OPENAI_API_BASE_URL: "https://example.test",
        },
      ),
    ).toEqual({
      TARGET_API_KEY_ENV: "OPENROUTER_API_KEY",
      TARGET_PRESET: "openrouter-free",
    });
  });

  it("gemini-free suggests the proven model for both client presets", () => {
    expect(
      presetEnv({ preset: "claude-code", provider: "gemini-free" }, {}),
    ).toEqual({
      TARGET_API: "gemini",
      GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com",
      TARGET_PRESET: "gemini-free",
      TARGET_API_KEY_ENV: "GEMINI_API_KEY",
      MODEL_MAP: "claude-*=gemini-3.8-flash",
      TARGET_CONTEXT_WINDOW: "32768",
    });
    expect(
      presetEnv({ preset: "codex", provider: "gemini-free" }, {}),
    ).toEqual({
      TARGET_API: "gemini",
      GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com",
      TARGET_PRESET: "gemini-free",
      TARGET_API_KEY_ENV: "GEMINI_API_KEY",
      MODEL_MAP: "*=gemini-3.8-flash",
    });
  });

  it("--preset codex maps the suggested model with a wildcard", () => {
    const preset = PROVIDER_PRESETS.groq;
    preset.suggested = { codex: "qwen/qwen3-coder" };
    try {
      expect(presetEnv({ preset: "codex", provider: "groq" }, {})).toEqual({
        TARGET_API: "openai",
        OPENAI_API_BASE_URL: "https://api.groq.com/openai",
        TARGET_API_KEY_ENV: "GROQ_API_KEY",
        TARGET_PRESET: "groq",
        MODEL_MAP: "*=qwen/qwen3-coder",
      });
      expect(
        presetEnv(
          { preset: "codex", provider: "groq", model: "other" },
          {},
        ),
      ).toMatchObject({ MODEL_MAP: "*=other" });
    } finally {
      delete preset.suggested;
    }
  });

  it("cerebras suggests gpt-oss-120b with the 32k output cap", () => {
    expect(
      presetEnv({ preset: "claude-code", provider: "cerebras" }, {}),
    ).toEqual({
      TARGET_API: "openai",
      OPENAI_API_BASE_URL: "https://api.cerebras.ai",
      TARGET_API_KEY_ENV: "CEREBRAS_API_KEY",
      TARGET_PRESET: "cerebras",
      TARGET_MAX_OUTPUT_TOKENS: "32768",
      MODEL_MAP: "claude-*=gpt-oss-120b",
      TARGET_CONTEXT_WINDOW: "32768",
    });
    expect(
      clientInstructions(
        { preset: "claude-code", provider: "cerebras" },
        3000,
        "k",
        32768,
      ),
    ).toEqual([
      "export ANTHROPIC_BASE_URL=http://localhost:3000",
      "export ANTHROPIC_AUTH_TOKEN=k",
      "export CLAUDE_CODE_MAX_OUTPUT_TOKENS=32768",
    ]);
  });

  it("openrouter-free suggests the proven model for codex", () => {
    expect(
      presetEnv({ preset: "codex", provider: "openrouter-free" }, {}),
    ).toEqual({
      TARGET_API: "openai",
      OPENAI_API_BASE_URL: "https://openrouter.ai/api",
      TARGET_API_KEY_ENV: "OPENROUTER_API_KEY",
      TARGET_PRESET: "openrouter-free",
      MODEL_MAP: "*=nvidia/nemotron-3-ultra-550b-a55b:free",
    });
  });

  it("claude-code preset adds max output tokens when preset sets it", () => {
    const preset = PROVIDER_PRESETS.deepseek;
    preset.max_output_tokens = 8192;
    try {
      expect(
        presetEnv({ preset: "claude-code", provider: "deepseek" }, {}),
      ).toMatchObject({ TARGET_MAX_OUTPUT_TOKENS: "8192" });
      expect(
        clientInstructions(
          { preset: "claude-code", provider: "deepseek" },
          3000,
          "k",
          8192,
        ),
      ).toContain("export CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192");
    } finally {
      delete preset.max_output_tokens;
    }
  });

  it("missing key prints signup url and exits 1", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((line?: unknown) => {
        lines.push(String(line));
      });
    const savedEnv = process.env;
    const savedCode = process.exitCode;
    process.env = { ...savedEnv };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.TARGET_API_KEY_ENV;
    delete process.env.TARGET_PRESET;
    delete process.env.BABELGATE_CONFIG;
    try {
      await main(["--provider", "openrouter-free"]);
      expect(lines.join("\n")).toContain(
        "OPENROUTER_API_KEY is not set. Get a key at " +
          "https://openrouter.ai/keys (free tier per openrouter-free " +
          "docs on 2026-11-22).",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.env = savedEnv;
      process.exitCode = savedCode;
      resetConfig();
    }
  });

  it("port in use prints hint and exits 1", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((line?: unknown) => {
        lines.push(String(line));
      });
    const savedEnv = process.env;
    const savedCode = process.exitCode;
    process.env = {
      ...savedEnv,
      TARGET_API: "openai",
      OPENAI_API_KEY: "test-key",
      OPENAI_API_BASE_URL: "http://127.0.0.1:9",
      USAGE_STORE: "off",
      PORT: String(port),
    };
    delete process.env.TARGET_API_KEY_ENV;
    delete process.env.TARGET_PRESET;
    delete process.env.BABELGATE_CONFIG;
    try {
      await main([]);
      expect(lines.join("\n")).toContain(
        `Port ${port} is in use. Start with --port ${port + 1} ` +
          "(or stop the other process).",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.env = savedEnv;
      process.exitCode = savedCode;
      resetConfig();
      await new Promise<void>((resolve) =>
        blocker.close(() => resolve()),
      );
    }
  });

  it("--preset codex prints toml with port and writes catalog under ~/.babelgate", async () => {
    const home = mkdtempSync(join(tmpdir(), "babelgate-home-"));
    const catalogPath = writeCodexCatalog("qwen/qwen3-coder", home);
    expect(catalogPath).toBe(
      join(home, ".babelgate", "codex-model-catalog.json"),
    );
    const written = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models: { slug: string }[];
    };
    expect(written.models[0]?.slug).toBe("qwen/qwen3-coder");
    // Nothing outside ~/.babelgate (v1.6 spec §3.3).
    expect(readdirSync(home)).toEqual([".babelgate"]);

    const toml = codexConfigToml(3456, "qwen/qwen3-coder", catalogPath).join(
      "\n",
    );
    expect(toml).toContain('base_url = "http://localhost:3456/v1"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('model = "qwen/qwen3-coder"');
    expect(toml).toContain(`model_catalog_json = "${catalogPath}"`);

    // The printed paste block ends with a blank line and an end
    // marker — the routing table prints right after it, and a copy
    // that stops at the marker can't pull route lines into
    // config.toml.
    const printed: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((line?: unknown) => {
        printed.push(String(line));
      });
    const listenSpy = vi.spyOn(app, "listen");
    const savedEnv = process.env;
    const savedCode = process.exitCode;
    process.env = {
      ...savedEnv,
      BABELGATE_TEST_HOME: home,
      TARGET_API: "openai",
      OPENAI_API_KEY: "test-key",
      OPENAI_API_BASE_URL: "http://127.0.0.1:9",
      PORT: "0",
      USAGE_STORE: "off",
    };
    delete process.env.TARGET_API_KEY_ENV;
    delete process.env.TARGET_PRESET;
    delete process.env.BABELGATE_CONFIG;
    delete process.env.MODEL_MAP;
    delete process.env.PROXY_API_KEY;
    let server: Server | undefined;
    try {
      await main(["--preset", "codex", "--model", "qwen/qwen3-coder"]);
      server = listenSpy.mock.results[0]?.value as Server | undefined;
      expect(readdirSync(home)).toEqual([".babelgate"]);
      const end = printed.indexOf("requires_openai_auth = false");
      expect(end).toBeGreaterThan(-1);
      expect(printed[end + 1]).toBe("");
      expect(printed[end + 2]).toBe("--- end of config.toml block ---");
    } finally {
      await new Promise<void>((resolve) => {
        if (server === undefined) resolve();
        else server.close(() => resolve());
      });
      logSpy.mockRestore();
      listenSpy.mockRestore();
      process.env = savedEnv;
      process.exitCode = savedCode;
      resetConfig();
    }
  });

  it("codex catalog template stays in sync with examples/", () => {
    const examples = JSON.parse(
      readFileSync(
        join(__dirname, "..", "examples", "codex-model-catalog.json"),
        "utf8",
      ),
    ) as unknown;
    expect(templateCatalog).toEqual(examples);
  });
});
