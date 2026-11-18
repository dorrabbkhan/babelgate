/**
 * Embeddings (v1.5 spec §3.6): the inbound dialect is OpenAI's
 * POST /v1/embeddings only, and these shapes are NOT canonical types —
 * they exist only to carry one embeddings request through routing to a
 * per-target dialect transform. `input` is always normalized to a
 * string array on decode (OpenAI's `input` also accepts a bare string;
 * tokenized array inputs are refused, they are not text).
 */
export interface EmbeddingRequest {
  model: string;
  input: string[];
  dimensions?: number;
  encodingFormat: "float" | "base64";
}

export interface EmbeddingResponse {
  /** The model name the client asked for (§3.5 reply model). */
  model: string;
  vectors: number[][];
  usage: { inputTokens: number };
}

/**
 * One provider-dialect embeddings mapping (v1.5 spec §3.6). Lives in
 * `src/transformers/embeddings/<provider>.ts` — embeddings have no
 * canonical stage, so these are NOT adapters and never join
 * PROVIDER_ROUTES or the `adapters` map.
 */
export interface EmbeddingTargetTransform {
  /** Upstream endpoint path for the routed model. */
  requestPath(model: string): string;
  /**
   * The provider-dialect request body. `sourceBody` is the client's
   * raw body — a same-format target (OpenAI) forwards the fields the
   * shared request shape doesn't carry (`user`, provider extras).
   */
  requestBody(request: EmbeddingRequest, sourceBody: unknown): unknown;
  /**
   * Decode the provider-dialect reply into vectors + the upstream's
   * input-token count, when the dialect reports one (Gemini's
   * batchEmbedContents has no usage — the service estimates).
   */
  decodeResponse(body: unknown): {
    vectors: number[][];
    inputTokens?: number;
  };
}
