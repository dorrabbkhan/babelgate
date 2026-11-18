import { describe, it, expect } from "vitest";
import { openaiEmbeddings } from "./openai";
import type { EmbeddingRequest } from "../../types/embeddings.types";

const baseRequest: EmbeddingRequest = {
  model: "text-embedding-3-small",
  input: ["hello", "world"],
  encodingFormat: "float",
};

describe("openaiEmbeddings", () => {
  it("posts to /v1/embeddings", () => {
    expect(openaiEmbeddings.requestPath("any-model")).toBe(
      "/v1/embeddings",
    );
  });

  it("forwards the client body with model and normalized input rewritten", () => {
    const body = openaiEmbeddings.requestBody(
      { ...baseRequest, dimensions: 256 },
      {
        model: "client-model",
        input: "hello",
        dimensions: 256,
        user: "alice",
      },
    );
    expect(body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello", "world"],
      encoding_format: "float",
      dimensions: 256,
      user: "alice",
    });
  });

  it("requests float vectors upstream even when the client asked base64", () => {
    // babelgate encodes base64 at the edge (spec §3.6) — the upstream
    // always serves numbers so every target decodes the same way.
    const body = openaiEmbeddings.requestBody(
      { ...baseRequest, encodingFormat: "base64" },
      { model: "client-model", input: ["hello"], encoding_format: "base64" },
    );
    expect((body as { encoding_format: string }).encoding_format).toBe(
      "float",
    );
  });

  it("decodes data[] vectors and prompt_tokens", () => {
    // Response shape: https://platform.openai.com/docs/api-reference/embeddings/object
    const out = openaiEmbeddings.decodeResponse({
      object: "list",
      data: [
        { object: "embedding", index: 0, embedding: [0.1, 0.2] },
        { object: "embedding", index: 1, embedding: [0.3, 0.4] },
      ],
      model: "upstream-model",
      usage: { prompt_tokens: 11, total_tokens: 11 },
    });
    expect(out).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      inputTokens: 11,
    });
  });

  it("orders vectors by their index field", () => {
    const out = openaiEmbeddings.decodeResponse({
      data: [
        { object: "embedding", index: 1, embedding: [9] },
        { object: "embedding", index: 0, embedding: [7] },
      ],
      usage: { prompt_tokens: 1 },
    });
    expect(out.vectors).toEqual([[7], [9]]);
  });

  it("throws on a malformed reply", () => {
    expect(() => openaiEmbeddings.decodeResponse({})).toThrow();
    expect(() =>
      openaiEmbeddings.decodeResponse({ data: [{ embedding: "abc" }] }),
    ).toThrow();
  });
});
