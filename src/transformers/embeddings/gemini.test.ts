import { describe, it, expect } from "vitest";
import { geminiEmbeddings } from "./gemini";
import type { EmbeddingRequest } from "../../types/embeddings.types";

const baseRequest: EmbeddingRequest = {
  model: "gemini-embedding-001",
  input: ["hello", "world"],
  encodingFormat: "float",
};

describe("geminiEmbeddings", () => {
  it("posts to /v1beta/models/<model>:batchEmbedContents", () => {
    expect(geminiEmbeddings.requestPath("gemini-embedding-001")).toBe(
      "/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
  });

  it("maps input to one EmbedContentRequest per string", () => {
    const body = geminiEmbeddings.requestBody(baseRequest, undefined) as {
      requests: {
        model: string;
        content: { parts: { text: string }[] };
      }[];
    };
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]!.model).toBe("models/gemini-embedding-001");
    expect(body.requests[0]!.content).toEqual({
      parts: [{ text: "hello" }],
    });
    expect(body.requests[1]!.content).toEqual({
      parts: [{ text: "world" }],
    });
  });

  it("maps dimensions to outputDimensionality", () => {
    const body = geminiEmbeddings.requestBody(
      { ...baseRequest, dimensions: 256 },
      undefined,
    ) as { requests: { outputDimensionality?: number }[] };
    expect(body.requests[0]!.outputDimensionality).toBe(256);
    expect(body.requests[1]!.outputDimensionality).toBe(256);
  });

  it("omits outputDimensionality when dimensions is unset", () => {
    const body = geminiEmbeddings.requestBody(baseRequest, undefined) as {
      requests: Record<string, unknown>[];
    };
    expect(body.requests[0]).not.toHaveProperty("outputDimensionality");
  });

  it("decodes embeddings[].values in order, no usage", () => {
    // Response shape: googleapis generative_service.proto
    // BatchEmbedContentsResponse — {embeddings: ContentEmbedding[]},
    // one per request, in batch order; usageMetadata omitted here.
    const out = geminiEmbeddings.decodeResponse({
      embeddings: [{ values: [0.1, 0.2] }, { values: [0.3] }],
    });
    expect(out).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3],
      ],
      inputTokens: undefined,
    });
  });

  it("maps usageMetadata.promptTokenCount to inputTokens", () => {
    expect(
      geminiEmbeddings.decodeResponse({
        embeddings: [{ values: [1, 2] }],
        usageMetadata: { promptTokenCount: 7 },
      }).inputTokens,
    ).toBe(7);
    expect(
      geminiEmbeddings.decodeResponse({
        embeddings: [{ values: [1, 2] }],
      }).inputTokens,
    ).toBeUndefined();
  });

  it("throws on a malformed reply", () => {
    expect(() => geminiEmbeddings.decodeResponse({})).toThrow();
    expect(() =>
      geminiEmbeddings.decodeResponse({ embeddings: [{}] }),
    ).toThrow();
  });
});
