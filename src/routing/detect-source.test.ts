import { describe, it, expect } from "vitest";
import { detectSource } from "./detect-source";

/**
 * Path-based client-format detection (spec §3.2): every provider's
 * routes answer on one port. `GET /v1/models` is the one ambiguous
 * path — Anthropic SDKs always send `anthropic-version`
 * (@anthropic-ai/sdk client.js:842, unconditional default header) and
 * Claude Code model discovery sends `x-api-key`; either marks the
 * client as anthropic (docs:
 * https://code.claude.com/docs/en/llm-gateway-protocol).
 */

const noHeaders = {};

describe("detectSource", () => {
  it("POST /v1/chat/completions → openai", () => {
    expect(detectSource("POST", "/v1/chat/completions", noHeaders)).toBe(
      "openai",
    );
  });

  it("POST /v1/messages → anthropic", () => {
    expect(detectSource("POST", "/v1/messages", noHeaders)).toBe("anthropic");
  });

  it("POST /v1/messages/count_tokens → anthropic", () => {
    expect(detectSource("POST", "/v1/messages/count_tokens", noHeaders)).toBe(
      "anthropic",
    );
  });

  it("GET /v1beta/models → gemini", () => {
    expect(detectSource("GET", "/v1beta/models", noHeaders)).toBe("gemini");
  });

  it("POST /v1beta/models/<m>:generateContent → gemini", () => {
    expect(
      detectSource("POST", "/v1beta/models/llama3:generateContent", noHeaders),
    ).toBe("gemini");
  });

  it("gemini countTokens path is gemini", () => {
    expect(
      detectSource(
        "POST",
        "/v1beta/models/gemini-2.5-pro:countTokens",
        noHeaders,
      ),
    ).toBe("gemini");
  });

  it("POST /api/chat → ollama", () => {
    expect(detectSource("POST", "/api/chat", noHeaders)).toBe("ollama");
  });

  it("GET /api/tags → ollama", () => {
    expect(detectSource("GET", "/api/tags", noHeaders)).toBe("ollama");
  });

  it("POST /v1/responses is responses", () => {
    expect(detectSource("POST", "/v1/responses", noHeaders)).toBe("responses");
  });

  it("/responses is responses", () => {
    expect(detectSource("POST", "/responses", noHeaders)).toBe("responses");
  });

  it("GET /v1/models stays openai", () => {
    expect(detectSource("GET", "/v1/models", noHeaders)).toBe("openai");
  });

  // §2.2: stateful Responses endpoints are detected as responses (they
  // share the prefix) so proxy.service can answer them in the responses
  // envelope — the adapter never sees them.
  it("GET /v1/responses/<id> is responses", () => {
    expect(detectSource("GET", "/v1/responses/resp_1", noHeaders)).toBe(
      "responses",
    );
  });

  it("DELETE /v1/responses/<id> is responses", () => {
    expect(detectSource("DELETE", "/v1/responses/resp_1", noHeaders)).toBe(
      "responses",
    );
  });

  it("POST /v1/responses/compact is responses", () => {
    expect(detectSource("POST", "/v1/responses/compact", noHeaders)).toBe(
      "responses",
    );
  });

  it("GET /v1/models with anthropic-version → anthropic", () => {
    expect(
      detectSource("GET", "/v1/models", {
        "anthropic-version": "2023-06-01",
      }),
    ).toBe("anthropic");
  });

  it("GET /v1/models without anthropic-version → openai", () => {
    expect(detectSource("GET", "/v1/models", noHeaders)).toBe("openai");
  });

  it("GET /v1/models with x-api-key and Authorization, no anthropic-version → anthropic", () => {
    expect(
      detectSource("GET", "/v1/models", {
        "x-api-key": "sk-ant-…",
        authorization: "Bearer sk-ant-…",
      }),
    ).toBe("anthropic");
  });

  it("GET /v1/models with only x-api-key → anthropic", () => {
    expect(
      detectSource("GET", "/v1/models", { "x-api-key": "sk-ant-…" }),
    ).toBe("anthropic");
  });

  it("GET /v1/models with only Authorization: Bearer → openai", () => {
    expect(
      detectSource("GET", "/v1/models", {
        authorization: "Bearer sk-…",
      }),
    ).toBe("openai");
  });

  it("GET /v1/models with X-Api-Key (mixed case) → anthropic", () => {
    expect(
      detectSource("GET", "/v1/models", { "X-Api-Key": "sk-ant-…" }),
    ).toBe("anthropic");
  });

  // Carried over from resolve-source.test.ts: detection is pure
  // path+method+headers — no config to be broken, so the "never throws"
  // case is dropped.
  it("GET /health → undefined", () => {
    expect(detectSource("GET", "/health", noHeaders)).toBeUndefined();
  });

  it("unknown path → undefined", () => {
    expect(detectSource("POST", "/v1/unknown", noHeaders)).toBeUndefined();
  });

  it("GET /v1/chat/completions → undefined (method mismatch)", () => {
    expect(
      detectSource("GET", "/v1/chat/completions", noHeaders),
    ).toBeUndefined();
  });
});
