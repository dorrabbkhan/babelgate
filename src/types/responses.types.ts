/**
 * OpenAI Responses API types — the fifth dialect (v1.4 spec §2.2).
 * Wire shapes are the official SDK's declarations (a devDependency,
 * type-only imports); the few request fields real Codex fallback
 * clients send that the SDK's create params don't declare are widened
 * in below.
 *
 * Wire-format sources:
 *  - Request fields: https://platform.openai.com/docs/api-reference/responses/create
 *  - Response object, usage, incomplete_details:
 *    https://platform.openai.com/docs/api-reference/responses/object
 *  - Field typings: `openai` npm 7.30.1,
 *    `resources/responses/responses.d.ts`. Fields the API reference
 *    omits (`access_programs`, `cache_write_tokens`,
 *    `context_management`, `prompt_cache_retention`, `namespace` tools)
 *    are evidenced by these SDK typings.
 *  - `client_metadata` is evidenced only by `codex-rs/core/src/client.rs`
 *    (`build_responses_request`) at Codex 0.169.0 and the recorded
 *    traffic in `tests/fixtures/codex/recording.jsonl` — absent from
 *    both the reference and the SDK.
 *  - Error envelope: https://platform.openai.com/docs/guides/error-codes
 *  - Model list: https://platform.openai.com/docs/api-reference/models/list
 */
import type OpenAI from "openai";
import type { ResponseCreateParamsBase } from "openai/resources/responses/responses";

/**
 * `POST /v1/responses` request body (non-streaming and streaming
 * requests differ only by `stream`). `client_metadata` is sent by
 * Codex on every fallback request — the SDK predates it (source:
 * `codex-rs/core/src/client.rs` `build_responses_request` at Codex
 * 0.169.0 + `tests/fixtures/codex/recording.jsonl`; not in the API
 * reference or SDK typings).
 */
export type ResponsesRequest = ResponseCreateParamsBase & {
  client_metadata?: Record<string, string> | null;
};

/** `POST /v1/responses` response body. */
export type ResponsesResponse = OpenAI.Responses.Response;

export type ResponsesInputItem = OpenAI.Responses.ResponseInputItem;
export type ResponsesOutputItem = OpenAI.Responses.ResponseOutputItem;
export type ResponsesTool = OpenAI.Responses.Tool;
export type ResponsesUsage = OpenAI.Responses.ResponseUsage;

/**
 * `GET /v1/models` — a `type: responses` upstream answers the same
 * OpenAI model-list shape as chat-completions upstreams.
 */
export interface ResponsesModelListResponse {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
  }>;
}

/** The Responses error envelope (same shape as chat completions). */
export interface ResponsesErrorBody {
  error: {
    message: string;
    type: string;
    code: string | null;
    param: string | null;
  };
}
