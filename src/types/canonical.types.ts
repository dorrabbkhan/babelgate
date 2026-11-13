/**
 * Canonical LLM API Types
 *
 * Provider-agnostic format that serves as the intermediate representation
 * for transforming between different LLM API formats.
 */

// ============ REQUEST ============

export interface CanonicalRequest {
  /** Model identifier (provider-specific, passed through) */
  model: string;
  /** Conversation messages */
  messages: CanonicalMessage[];
  /** System prompt (extracted from messages for providers that need it separate).
   *  An array carries per-part cache hints; parts are text-only (schema-enforced). */
  systemPrompt?: string | CanonicalContentPart[];
  /** Generation configuration */
  config?: CanonicalConfig;
  /** Tool/function definitions */
  tools?: CanonicalTool[];
  /** How the model may use the offered tools */
  toolChoice?: CanonicalToolChoice;
  /** Enable streaming response */
  stream?: boolean;
}

export interface CanonicalMessage {
  /** Message role */
  role: "system" | "user" | "assistant" | "tool";
  /** Message content - string or multimodal parts */
  content: string | CanonicalContentPart[];
  /** Tool calls made by assistant */
  toolCalls?: CanonicalToolCall[];
  /** ID of tool call this message is responding to */
  toolCallId?: string;
  /** Marks a failed tool result (Anthropic is_error); role "tool" only */
  isError?: boolean;
  /** Prompt-cache breakpoint hint (Anthropic cache_control); role
   *  "tool" only — other roles carry hints on their content parts. */
  cache?: CanonicalCacheHint;
  /** Optional name for the message author */
  name?: string;
}

export interface CanonicalContentPart {
  /** Content type */
  type: "text" | "image";
  /** Text content (when type is 'text') */
  text?: string;
  /** Image content (when type is 'image') */
  image?: CanonicalImage;
  /** Prompt-cache breakpoint hint (Anthropic cache_control) */
  cache?: CanonicalCacheHint;
}

/** Prompt-cache breakpoint hint; ttl defaults to the provider's (5m for Anthropic). */
export interface CanonicalCacheHint {
  ttl?: "5m" | "1h";
}

export interface CanonicalImage {
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface CanonicalConfig {
  /** Sampling temperature (0-2) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Nucleus sampling threshold */
  topP?: number;
  /** Top-k sampling */
  topK?: number;
  /** Sequences that stop generation */
  stopSequences?: string[];
  /** Number of completions to generate */
  candidateCount?: number;
  /** Random seed for reproducibility */
  seed?: number;
  /** Frequency penalty (-2 to 2) */
  frequencyPenalty?: number;
  /** Presence penalty (-2 to 2) */
  presencePenalty?: number;
  /** Minimum context window the target should allocate (Ollama num_ctx) */
  contextWindow?: number;
}

// ============ TOOLS ============

export interface CanonicalTool {
  /** Tool type (currently only 'function' is widely supported) */
  type: "function";
  /** Function definition */
  function: CanonicalFunction;
  /** Prompt-cache breakpoint hint (Anthropic cache_control) */
  cache?: CanonicalCacheHint;
}

export interface CanonicalFunction {
  /** Function name */
  name: string;
  /** Function description */
  description?: string;
  /** JSON Schema for parameters */
  parameters?: Record<string, unknown>;
}

export interface CanonicalToolCall {
  /** Unique ID for this tool call */
  id: string;
  /** Tool type */
  type: "function";
  /** Function call details */
  function: {
    /** Function name */
    name: string;
    /** JSON-encoded arguments */
    arguments: string;
  };
}

export type CanonicalToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

// ============ RESPONSE ============

export interface CanonicalResponse {
  /** Unique response ID */
  id: string;
  /** Model that generated the response */
  model: string;
  /** Generated message */
  message: CanonicalMessage;
  /** Reason generation stopped */
  finishReason: CanonicalFinishReason;
  /** Token usage statistics */
  usage?: CanonicalUsage;
  /** Response creation timestamp (Unix seconds) */
  created?: number;
}

export type CanonicalFinishReason =
  | "stop"
  | "length"
  | "tool_call"
  | "content_filter"
  | "error"
  | "unknown";

export interface CanonicalUsage {
  /** ALL input tokens, cached included (OTel convention) */
  inputTokens: number;
  /** Tokens in the response */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Input tokens read from cache; emitted only when present and non-zero */
  cacheReadTokens?: number;
  /** Input tokens written to cache; emitted only when present and non-zero */
  cacheWriteTokens?: number;
}

// ============ STREAMING ============

/**
 * One typed event in a canonical stream (spec §3.1).
 * Rules every decoder guarantees and every encoder may rely on:
 * 1. Exactly one message_start first; message_end or error last, nothing after.
 * 2. tool_call_start(i) before any tool_call_delta(i) / tool_call_end(i);
 *    index starts at 0 and increases by one per call.
 * 3. Concatenated argumentsDelta of call i is that call's arguments as a
 *    JSON string, exactly as the provider sent them.
 * 4. usage appears at most once, before message_end.
 * 5. Events of different blocks may interleave; encoders key tool state by
 *    index and never assume a call's events are contiguous.
 */
export type CanonicalStreamEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argumentsDelta: string }
  | { type: "tool_call_end"; index: number }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "message_end"; finishReason: CanonicalFinishReason }
  | { type: "error"; error: CanonicalError };

/**
 * Stateful provider-bytes → canonical-events converter; one per request.
 * Pure: no I/O, no clock, no randomness (IDs come from an injected
 * IdGenerator) so tests are deterministic.
 */
export interface StreamDecoder {
  /** Feed one network chunk; returns the events it completed. */
  feed(chunk: Uint8Array | string): CanonicalStreamEvent[];
  /** Flush at EOF; emits `error` if the stream ended early. */
  end(): CanonicalStreamEvent[];
}

/** Stateful canonical-events → provider-bytes converter; one per request. */
export interface StreamEncoder {
  /** Wire content type the route should send (e.g. text/event-stream). */
  readonly contentType: string;
  /** Encode one event to wire bytes ("" when the event produces none). */
  encode(event: CanonicalStreamEvent): string;
  /** Terminal bytes after the last event (e.g. `data: [DONE]`). */
  end(): string;
}

export interface StreamEncoderContext<TRequest> {
  /** The client's own request, in this adapter's own type */
  sourceRequest: TRequest;
  /** Incoming query parameters (e.g. Gemini alt=sse) */
  query: Record<string, string>;
  /** The model name the client asked for (§3.5) */
  requestedModel: string;
}

/** Generates tool-call IDs; injected so tests can use sequentialIds(). */
export type IdGenerator = () => string;

// ============ ERRORS ============

export type CanonicalErrorKind =
  | "invalid_request" // 400
  | "authentication" // 401
  | "permission" // 403
  | "not_found" // 404
  | "request_too_large" // 413
  | "rate_limit" // 429
  | "unsupported" // 501
  | "upstream" // 502
  | "unavailable" // 503
  | "timeout" // 504
  | "internal"; // 500

export interface CanonicalError {
  /** Error category */
  kind: CanonicalErrorKind;
  /** HTTP status sent to the client */
  status: number;
  /** Human-readable; never contains prompt text or keys */
  message: string;
  /** Seconds to wait before retrying (from upstream Retry-After) */
  retryAfterSeconds?: number;
}

// ============ MODEL LIST ============

export interface CanonicalModel {
  /** Model identifier — passes through verbatim */
  id: string;
  /** Human-readable name, if the provider has one */
  displayName?: string;
  /** Creation/modification timestamp (Unix seconds) */
  created?: number;
  /** Owning organization */
  ownedBy?: string;
}

export interface CanonicalModelList {
  models: CanonicalModel[];
}

// ============ ADAPTER INTERFACE ============

export interface ProviderAdapter<TRequest, TResponse> {
  /** Convert provider request to canonical format */
  toCanonicalRequest(request: TRequest): CanonicalRequest;
  /** Convert canonical request to provider format */
  fromCanonicalRequest(request: CanonicalRequest): TRequest;
  /** Convert provider response to canonical format */
  toCanonicalResponse(
    response: TResponse,
    model: string,
    ids?: IdGenerator,
  ): CanonicalResponse;
  /** Convert canonical response to provider format */
  fromCanonicalResponse(response: CanonicalResponse): TResponse;
  /** New decoder for one upstream stream of this provider's bytes */
  createStreamDecoder(model: string, ids?: IdGenerator): StreamDecoder;
  /** New encoder rendering canonical events in this provider's dialect */
  createStreamEncoder(ctx: StreamEncoderContext<TRequest>): StreamEncoder;
  /** Convert provider model-list response to canonical format */
  toCanonicalModelList(response: unknown): CanonicalModelList;
  /** Convert canonical model list to provider format */
  fromCanonicalModelList(models: CanonicalModelList): unknown;
  /** Read a provider error body (never throws on unrecognised bodies) */
  toCanonicalError(status: number, body: unknown): CanonicalError;
  /** Render a canonical error in the provider's dialect */
  fromCanonicalError(err: CanonicalError): unknown;
}
