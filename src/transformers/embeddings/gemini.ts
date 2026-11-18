import type { EmbeddingTargetTransform } from "../../types/embeddings.types";

/**
 * Gemini embeddings target (v1.5 spec §3.6): one input string becomes
 * one `EmbedContentRequest` in a `batchEmbedContents` call — each
 * request repeats `models/<model>` in its `model` field (the API
 * 400s when it is omitted). `dimensions` maps to
 * `outputDimensionality` on every request.
 *
 * Shapes: https://ai.google.dev/api/embeddings
 * (Method: models.batchEmbedContents) and googleapis
 * `generative_service.proto` — request
 * `{requests: [{model: "models/<m>", content: {parts:[{text}]},
 *   outputDimensionality?}]}` → response
 * `{embeddings: ContentEmbedding[]}` where ContentEmbedding is
 * `{values: number[]}`, in batch order. The reply may carry the
 * optional `usageMetadata.promptTokenCount`
 * (`EmbeddingUsageMetadata`); when it is absent the service
 * estimates the input-token count.
 */
export const geminiEmbeddings: EmbeddingTargetTransform = {
  requestPath: (model) =>
    `/v1beta/models/${model}:batchEmbedContents`,

  requestBody(request) {
    return {
      requests: request.input.map((text) => ({
        model: `models/${request.model}`,
        content: { parts: [{ text }] },
        ...(request.dimensions !== undefined
          ? { outputDimensionality: request.dimensions }
          : {}),
      })),
    };
  },

  decodeResponse(body) {
    const embeddings = (body as { embeddings?: unknown } | null)
      ?.embeddings;
    if (!Array.isArray(embeddings)) {
      throw new Error(
        "malformed embeddings response: embeddings is not an array",
      );
    }
    const promptTokenCount = (
      body as { usageMetadata?: { promptTokenCount?: unknown } } | null
    )?.usageMetadata?.promptTokenCount;
    return {
      vectors: embeddings.map((e) => {
        const values = (e as { values?: unknown })?.values;
        if (
          !Array.isArray(values) ||
          !values.every((v) => typeof v === "number")
        ) {
          throw new Error(
            "malformed embeddings response: embeddings[].values is not a number array",
          );
        }
        return values;
      }),
      inputTokens:
        typeof promptTokenCount === "number"
          ? promptTokenCount
          : undefined,
    };
  },
};
