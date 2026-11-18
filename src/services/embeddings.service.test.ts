import { describe, it, expect } from "vitest";
import {
  decodeEmbeddingBody,
  float32LeBase64,
  openaiEmbeddingReply,
} from "./embeddings.service";
import { ValidationError } from "../utils/errors";

describe("decodeEmbeddingBody", () => {
  it("normalizes a string input to an array", () => {
    expect(
      decodeEmbeddingBody({ model: "m", input: "hello" }),
    ).toEqual({
      model: "m",
      input: ["hello"],
      encodingFormat: "float",
    });
  });

  it("keeps an array input and reads dimensions/encoding_format", () => {
    expect(
      decodeEmbeddingBody({
        model: "m",
        input: ["a", "b"],
        dimensions: 256,
        encoding_format: "base64",
      }),
    ).toEqual({
      model: "m",
      input: ["a", "b"],
      dimensions: 256,
      encodingFormat: "base64",
    });
  });

  it("rejects a missing or empty model", () => {
    expect(() => decodeEmbeddingBody({ input: "x" })).toThrow(
      ValidationError,
    );
    expect(() =>
      decodeEmbeddingBody({ model: "", input: "x" }),
    ).toThrow(ValidationError);
  });

  it("rejects non-string and non-text inputs", () => {
    expect(() =>
      decodeEmbeddingBody({ model: "m", input: 5 }),
    ).toThrow(ValidationError);
    // Tokenized inputs (arrays of integers) are out of the minimal
    // contract — EmbeddingRequest.input is string[].
    expect(() =>
      decodeEmbeddingBody({ model: "m", input: [1, 2, 3] }),
    ).toThrow(ValidationError);
  });

  it("rejects a bad encoding_format and a bad dimensions", () => {
    expect(() =>
      decodeEmbeddingBody({
        model: "m",
        input: "x",
        encoding_format: "utf8",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      decodeEmbeddingBody({ model: "m", input: "x", dimensions: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      decodeEmbeddingBody({ model: "m", input: "x", dimensions: "8" }),
    ).toThrow(ValidationError);
  });
});

describe("float32LeBase64", () => {
  it("encodes little-endian float32 bytes", () => {
    const expected = (v: number[]) => {
      const buf = Buffer.alloc(v.length * 4);
      v.forEach((x, i) => buf.writeFloatLE(x, i * 4));
      return buf.toString("base64");
    };
    expect(float32LeBase64([0.5, -1.25, 3])).toBe(
      expected([0.5, -1.25, 3]),
    );
    expect(float32LeBase64([])).toBe("");
  });
});

describe("openaiEmbeddingReply", () => {
  it("builds the OpenAI embeddings object with the requested model", () => {
    // Reply shape: https://platform.openai.com/docs/api-reference/embeddings/object
    const body = openaiEmbeddingReply(
      {
        model: "client-model",
        vectors: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
        usage: { inputTokens: 11 },
      },
      "float",
    );
    expect(body).toEqual({
      object: "list",
      data: [
        { object: "embedding", index: 0, embedding: [0.1, 0.2] },
        { object: "embedding", index: 1, embedding: [0.3, 0.4] },
      ],
      model: "client-model",
      usage: { prompt_tokens: 11, total_tokens: 11 },
    });
  });

  it("base64-encodes vectors only when asked", () => {
    const body = openaiEmbeddingReply(
      { model: "m", vectors: [[0.5]], usage: { inputTokens: 1 } },
      "base64",
    ) as { data: { embedding: unknown }[] };
    expect(typeof body.data[0]!.embedding).toBe("string");
    expect(body.data[0]!.embedding).toBe(float32LeBase64([0.5]));
  });
});
