import { describe, it, expect } from "vitest";
import { clientId } from "./client-id";

/**
 * spec §3.4: `x-babelgate-client` override first (lowercase id ≤ 40),
 * then User-Agent patterns in order, then "other". The UA is kept on
 * the trace truncated to 200 chars. Gemini CLI's pattern is the one
 * Task 1 recorded (docs/decisions.md): `GeminiCLI-tui/<v>/<model>
 * (<os>; <arch>; terminal)`.
 */
describe("clientId (spec §3.4)", () => {
  it.each<[string, string]>([
    ["claude-cli/2.1.3 (external, cli)", "claude-code"],
    ["codex_cli_rs/0.40.0 (Ubuntu 24.04; x86_64)", "codex"],
    [
      "GeminiCLI-tui/0.66.0/gemini-3.1-pro-preview (linux; x64; terminal)",
      "gemini-cli",
    ],
    ["OpenAI/JS 7.30.1", "openai-sdk"],
    ["OpenAI/Python 1.54.3", "openai-sdk"],
    ["Anthropic/JS 0.132.1", "anthropic-sdk"],
    ["google-genai-sdk/1.0.0 gl-node/22.13.0", "google-genai"],
    ["ollama-js/0.6.4", "ollama-sdk"],
    ["ollama-python/0.4.7", "ollama-sdk"],
    ["curl/8", "other"],
  ])("user-agent %j → %s", (userAgent, expected) => {
    expect(clientId({ "user-agent": userAgent }).client).toBe(expected);
  });

  it("no user-agent → other, no userAgent on the result", () => {
    expect(clientId({})).toEqual({ client: "other" });
  });

  it("x-babelgate-client overrides the UA patterns", () => {
    expect(
      clientId({
        "x-babelgate-client": "my-bot",
        "user-agent": "claude-cli/2.1.3 (external, cli)",
      }).client,
    ).toBe("my-bot");
  });

  it("x-babelgate-client: playground → playground", () => {
    expect(clientId({ "x-babelgate-client": "playground" }).client).toBe(
      "playground",
    );
  });

  it("an invalid x-babelgate-client falls through to the UA", () => {
    expect(
      clientId({
        "x-babelgate-client": "Bad Name!",
        "user-agent": "claude-cli/2.1.3 (external, cli)",
      }).client,
    ).toBe("claude-code");
    // An override that fails the id regex with no UA → other.
    expect(
      clientId({ "x-babelgate-client": "Bad Name!" }).client,
    ).toBe("other");
  });

  it("the user agent is kept truncated to 200 chars", () => {
    const long = `claude-cli/2.1.3 ${"x".repeat(500)}`;
    const result = clientId({ "user-agent": long });
    expect(result.client).toBe("claude-code");
    expect(result.userAgent).toHaveLength(200);
    expect(result.userAgent).toBe(long.slice(0, 200));
  });
});
