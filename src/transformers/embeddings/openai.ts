import type { EmbeddingTargetTransform } from "../../types/embeddings.types";

/**
 * OpenAI-compatible embeddings target (v1.5 spec §3.6): the client
 * already speaks this dialect, so the upstream body is FORWARDED —
 * the routed `model` and the normalized `input` array are rewritten,
 * `encoding_format` is always "float" (babelgate encodes base64 at
 * the edge so every target decodes the same), and fields the shared
 * request shape doesn't carry (`user`, provider extras) pass through
 * untouched.
 *
 * Request/response shapes:
 * https://platform.openai.com/docs/api-reference/embeddings/create and
 * https://platform.openai.com/docs/api-reference/embeddings/object —
 * `{model, input, encoding_format, dimensions, user}` →
 * `{object:"list", data:[{object:"embedding",index,embedding}],
 *   model, usage:{prompt_tokens,total_tokens}}`.
 */
export const openaiEmbeddings: EmbeddingTargetTransform = {
  requestPath: () => "/v1/embeddings",

  requestBody(request, sourceBody) {
    const extra =
      sourceBody !== null && typeof sourceBody === "object"
        ? (sourceBody as Record<string, unknown>)
        : {};
    return {
      ...extra,
      model: request.model,
      input: request.input,
      encoding_format: "float",
      ...(request.dimensions !== undefined
        ? { dimensions: request.dimensions }
        : {}),
    };
  },

  decodeResponse(body) {
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error("malformed embeddings response: data is not an array");
    }
    const vectors = data
      .slice()
      .sort((a, b) => {
        const ai = (a as { index?: unknown })?.index;
        const bi = (b as { index?: unknown })?.index;
        return (
          (typeof ai === "number" ? ai : 0) -
          (typeof bi === "number" ? bi : 0)
        );
      })
      .map((item) => {
        const embedding = (item as { embedding?: unknown })?.embedding;
        if (
          !Array.isArray(embedding) ||
          !embedding.every((v) => typeof v === "number")
        ) {
          throw new Error(
            "malformed embeddings response: data[].embedding is not a number array",
          );
        }
        return embedding;
      });
    const usage = (body as { usage?: { prompt_tokens?: unknown } } | null)
      ?.usage;
    return {
      vectors,
      inputTokens:
        typeof usage?.prompt_tokens === "number"
          ? usage.prompt_tokens
          : undefined,
    };
  },
};
