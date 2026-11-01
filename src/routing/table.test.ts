import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { formatRoutingTable } from "./table";
import { loadYamlConfig } from "../config/yaml-config";

const FIXTURES = join(__dirname, "..", "..", "tests", "fixtures", "config");

describe("formatRoutingTable", () => {
  it("routing table lists providers, aliases, routes and default without keys", () => {
    const config = loadYamlConfig(join(FIXTURES, "valid-full.yaml"), {
      OPENROUTER_API_KEY: "secret-or-key-123",
      ANTHROPIC_API_KEY: "secret-ant-key-456",
    });

    const lines = formatRoutingTable(config);

    expect(lines).toEqual([
      "provider ollama (type ollama, http://localhost:11434, key none)",
      "provider openrouter (type openai, https://openrouter.ai/api/v1, key env OPENROUTER_API_KEY)",
      "provider anthropic (type anthropic, https://api.anthropic.com, key env ANTHROPIC_API_KEY)",
      "alias fast -> openrouter/qwen/qwen3-coder",
      "alias smart -> anthropic/claude-sonnet-4-5",
      "route 0 claude-*haiku* -> ollama/qwen2.5-coder:7b",
      "route 1 claude-* when min_input_tokens>=60000 -> openrouter/qwen/qwen3-coder fallback anthropic/claude-sonnet-4-5",
      "route 2 claude-* -> ollama/qwen3-coder:30b fallback openrouter/qwen/qwen3-coder",
      "default -> ollama",
    ]);
    expect(lines.join("\n")).not.toContain("secret-or-key-123");
    expect(lines.join("\n")).not.toContain("secret-ant-key-456");
  });
});
