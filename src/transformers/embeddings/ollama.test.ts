import { describe, it, expect } from "vitest";
import { ollamaEmbeddings } from "./ollama";
import type { EmbeddingRequest } from "../../types/embeddings.types";

const baseRequest: EmbeddingRequest = {
  model: "embeddinggemma",
  input: ["hello", "world"],
  encodingFormat: "float",
};

describe("ollamaEmbeddings", () => {
  it("posts to /api/embed", () => {
    expect(ollamaEmbeddings.requestPath("any-model")).toBe("/api/embed");
  });

  it("maps model, input array and dimensions", () => {
    // Request shape: https://docs.ollama.com/api/embed — `input` takes
    // a string or an array; `dimensions` is a documented field.
    const body = ollamaEmbeddings.requestBody(
      { ...baseRequest, dimensions: 128 },
      undefined,
    );
    expect(body).toEqual({
      model: "embeddinggemma",
      input: ["hello", "world"],
      dimensions: 128,
    });
  });

  it("omits dimensions when unset", () => {
    const body = ollamaEmbeddings.requestBody(baseRequest, undefined);
    expect(body).toEqual({
      model: "embeddinggemma",
      input: ["hello", "world"],
    });
  });

  it("decodes embeddings and prompt_eval_count", () => {
    // Response shape: https://docs.ollama.com/api/embed —
    // {model, embeddings: [[...]], prompt_eval_count}.
    const out = ollamaEmbeddings.decodeResponse({
      model: "embeddinggemma",
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      total_duration: 14143917,
      load_duration: 1019500,
      prompt_eval_count: 8,
    });
    expect(out).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      inputTokens: 8,
    });
  });

  it("throws on a malformed reply", () => {
    expect(() => ollamaEmbeddings.decodeResponse({})).toThrow();
    expect(() =>
      ollamaEmbeddings.decodeResponse({ embeddings: ["abc"] }),
    ).toThrow();
  });
});
