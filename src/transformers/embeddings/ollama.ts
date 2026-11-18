import type { EmbeddingTargetTransform } from "../../types/embeddings.types";

/**
 * Ollama embeddings target (v1.5 spec §3.6): `/api/embed` takes the
 * whole normalized `input` array in one call; `dimensions` is a
 * documented request field on this endpoint.
 *
 * Shapes: https://docs.ollama.com/api/embed — request
 * `{model, input: string|string[], dimensions?, truncate?,
 *   options?, keep_alive?}` → response
 * `{model, embeddings: number[][], total_duration, load_duration,
 *   prompt_eval_count}`. `prompt_eval_count` is the input-token
 * count this dialect reports.
 */
export const ollamaEmbeddings: EmbeddingTargetTransform = {
  requestPath: () => "/api/embed",

  requestBody(request) {
    return {
      model: request.model,
      input: request.input,
      ...(request.dimensions !== undefined
        ? { dimensions: request.dimensions }
        : {}),
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
    return {
      vectors: embeddings.map((e) => {
        if (
          !Array.isArray(e) ||
          !e.every((v) => typeof v === "number")
        ) {
          throw new Error(
            "malformed embeddings response: embeddings[] is not a number array",
          );
        }
        return e;
      }),
      inputTokens:
        typeof (body as { prompt_eval_count?: unknown })
          ?.prompt_eval_count === "number"
          ? (body as { prompt_eval_count: number }).prompt_eval_count
          : undefined,
    };
  },
};
