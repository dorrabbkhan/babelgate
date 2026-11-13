/**
 * The OpenAI Responses API adapter (v1.4 spec §3.1): the fifth
 * provider, for Codex-class clients and Responses-native upstreams.
 *
 * Layout (rule 7 — this file stays under ~400 lines): the wire codec
 * lives in responses.items.ts (input/output items), responses.tools.ts
 * (tools + tool_choice) and responses.response.ts (the Response
 * object). This file owns the public request/response entry points,
 * the adapter object, model lists, errors and the streaming stubs
 * (Task 4).
 *
 * Stateless contract (spec §2.2): `previous_response_id`,
 * `conversation`, `store: true` and the responses-lite markers are
 * refused in proxy.service before routing; nothing stateful reaches
 * this adapter.
 *
 * Wire-format sources (Global Constraints: evidence per field):
 *  - Request fields: https://platform.openai.com/docs/api-reference/responses/create
 *    and `openai` npm 7.30.1 `resources/responses/responses.d.ts`
 *    (`ResponseCreateParamsBase`). `client_metadata` is evidenced only
 *    by `codex-rs/core/src/client.rs` (`build_responses_request`) at
 *    Codex 0.169.0 + `tests/fixtures/codex/recording.jsonl`.
 *  - Input items, tools + tool_choice, Response object: see the
 *    per-section citations in responses.items.ts, responses.tools.ts
 *    and responses.response.ts.
 *  - Model list: https://platform.openai.com/docs/api-reference/models/list
 *  - Error envelope: https://platform.openai.com/docs/guides/error-codes
 */
import type {
  CanonicalRequest,
  CanonicalError,
  CanonicalErrorKind,
  CanonicalMessage,
  CanonicalModelList,
  CanonicalTool,
  ProviderAdapter,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { NotSupportedError, ValidationError } from "../../utils/errors";
import { recordNote } from "../../observe/context";
import { systemText } from "../system-text";
import {
  decodeInputItem,
  encodeMessage,
} from "./responses.items";
import {
  toCanonicalTool,
  toCanonicalToolChoice,
  toResponsesTool,
  toResponsesToolChoice,
} from "./responses.tools";
import {
  toCanonicalResponse,
  fromCanonicalResponse,
} from "./responses.response";
import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesModelListResponse,
} from "../../types/responses.types";

export const responsesAdapter: ProviderAdapter<
  ResponsesRequest,
  ResponsesResponse
> = {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
  toCanonicalModelList,
  fromCanonicalModelList,
  toCanonicalError,
  fromCanonicalError,
  createStreamDecoder,
  createStreamEncoder,
};


function note(code: string, path: string, message: string): void {
  recordNote({ stage: "decode", adapter: "responses", code, path }, message);
}


// ============ REQUEST: Responses → Canonical ============

/**
 * Top-level request fields with no canonical equivalent (v1.4 spec
 * §2.2). The stateful set (`previous_response_id`, `conversation`,
 * `store: true`) is refused earlier — in proxy.service before
 * routing — so this list is the tolerated remainder: caching hints,
 * tiering, tracing metadata, `text`, and the fields later tasks own
 * (`reasoning` → Task 6, `include` → Task 8, `text.format` → Task 9).
 * Names per the create reference and SDK `ResponseCreateParamsBase`
 * (openai 7.30.1); `client_metadata` is evidenced only by codex-rs +
 * the recording — see the file header.
 */
const DROPPED_REQUEST_FIELDS = [
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "service_tier",
  "metadata",
  "client_metadata",
  "safety_identifier",
  "user",
  "text",
  "include",
  "reasoning",
  "truncation",
  "background",
  "prompt",
  "stream_options",
  "top_logprobs",
  "moderation",
  "context_management",
  "access_programs",
  "previous_response_id",
  "conversation",
] as const;


export function toCanonicalRequest(
  request: ResponsesRequest,
): CanonicalRequest {
  if (request === null || typeof request !== "object") {
    throw new ValidationError("Request body must be an object");
  }
  if (request.model === undefined || request.model === null) {
    throw new ValidationError('Missing required field "model"');
  }

  const messages: CanonicalMessage[] = [];
  const systemTexts: string[] = [];

  // `instructions` is an implicit leading system message (the API's own
  // semantics) — kept as a canonical system message AND merged into
  // the aggregated systemPrompt, same dual shape as anthropic decode.
  if (typeof request.instructions === "string" && request.instructions !== "") {
    messages.push({ role: "system", content: request.instructions });
    systemTexts.push(request.instructions);
  }

  const input = request.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    input.forEach((item, i) =>
      decodeInputItem(item, i, messages, systemTexts),
    );
  }

  for (const field of DROPPED_REQUEST_FIELDS) {
    if (request[field as keyof ResponsesRequest] !== undefined) {
      note(
        "field_dropped",
        field,
        `Dropping request field "${field}" (no canonical equivalent)`,
      );
    }
  }

  const tools = request.tools
    ?.map((tool, i) => toCanonicalTool(tool, i))
    .filter((t): t is CanonicalTool => t !== undefined);

  return {
    model: request.model as string,
    messages,
    ...(systemTexts.length > 0 && {
      systemPrompt: systemTexts.join("\n\n"),
    }),
    config: {
      ...(typeof request.temperature === "number" && {
        temperature: request.temperature,
      }),
      ...(typeof request.max_output_tokens === "number" && {
        maxTokens: request.max_output_tokens,
      }),
      ...(typeof request.top_p === "number" && { topP: request.top_p }),
    },
    ...(tools !== undefined && tools.length > 0 && { tools }),
    ...(request.tool_choice !== undefined &&
      request.tool_choice !== null && {
        toolChoice: toCanonicalToolChoice(request.tool_choice),
      }),
    ...(typeof request.parallel_tool_calls === "boolean" && {
      parallelToolCalls: request.parallel_tool_calls,
    }),
    ...(typeof request.stream === "boolean" && { stream: request.stream }),
  };
}


// ============ REQUEST: Canonical → Responses ============

export function fromCanonicalRequest(
  request: CanonicalRequest,
): ResponsesRequest {
  const input: Array<Record<string, unknown>> = [];

  // `instructions` is emitted only when the canonical request carries
  // system text as systemPrompt alone (no system messages) — the
  // decode side pushes every system message back as a developer item,
  // so emitting both would duplicate the system text.
  const hasSystemMessages = request.messages.some(
    (m) => m.role === "system",
  );
  const instructions =
    !hasSystemMessages && request.systemPrompt !== undefined
      ? systemText(request.systemPrompt)
      : undefined;

  for (const message of request.messages) {
    input.push(...encodeMessage(message));
  }

  const result: Record<string, unknown> = {
    model: request.model,
    ...(instructions !== undefined && { instructions }),
    input,
    // Stateless by construction (spec §2.2).
    store: false,
    ...(request.config?.temperature !== undefined && {
      temperature: request.config.temperature,
    }),
    ...(request.config?.topP !== undefined && { top_p: request.config.topP }),
    ...(request.config?.maxTokens !== undefined && {
      max_output_tokens: request.config.maxTokens,
    }),
    ...(request.stream !== undefined && { stream: request.stream }),
    ...(request.parallelToolCalls !== undefined && {
      parallel_tool_calls: request.parallelToolCalls,
    }),
    ...(request.tools !== undefined && {
      tools: request.tools.map(toResponsesTool),
    }),
    ...(request.toolChoice !== undefined && {
      tool_choice: toResponsesToolChoice(request.toolChoice),
    }),
  };
  return result as unknown as ResponsesRequest;
}


// ============ RESPONSE ============
// The response codec lives in ./responses.response; re-exported so the
// adapter's public surface matches the other providers.
export {
  toCanonicalResponse,
  fromCanonicalResponse,
} from "./responses.response";

// ============ MODEL LIST ============
// OpenAI model-list envelope: https://platform.openai.com/docs/api-reference/models/list
// (a `type: responses` upstream answers the same shape as chat-completions).

export function toCanonicalModelList(response: unknown): CanonicalModelList {
  const res = response as ResponsesModelListResponse;
  return {
    models: (res.data ?? [])
      .filter((m) => Boolean(m?.id))
      .map((m) => ({
        id: m.id,
        created: m.created,
        ownedBy: m.owned_by,
      })),
  };
}

export function fromCanonicalModelList(
  list: CanonicalModelList,
): ResponsesModelListResponse {
  return {
    object: "list",
    data: list.models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created ?? 0,
      owned_by: m.ownedBy ?? "babelgate",
    })),
  };
}


// ============ STREAMING (Task 4 wires the real codec) ============

function createStreamDecoder(): never {
  throw new NotSupportedError(
    "responses streaming is not supported yet (lands in Task 4)",
  );
}

function createStreamEncoder(): never {
  throw new NotSupportedError(
    "responses streaming is not supported yet (lands in Task 4)",
  );
}


// ============ ERRORS ============
// Error envelope `{error: {message, type, param, code}}` per
// https://platform.openai.com/docs/guides/error-codes (Responses
// shares the chat-completions error shape; `code`/`param` carry the
// UnsupportedParameterError detail fields).

const RESPONSES_ERROR_TYPE: Record<CanonicalErrorKind, string> = {
  invalid_request: "invalid_request_error",
  authentication: "authentication_error",
  permission: "permission_error",
  not_found: "not_found_error",
  request_too_large: "invalid_request_error",
  rate_limit: "rate_limit_error",
  unsupported: "invalid_request_error",
  upstream: "api_error",
  unavailable: "service_unavailable_error",
  timeout: "api_error",
  internal: "api_error",
};

export function toCanonicalError(
  status: number,
  body: unknown,
): CanonicalError {
  const err = (body as { error?: { message?: unknown } } | null)?.error;
  const message =
    typeof err?.message === "string" && err.message.length > 0
      ? err.message
      : `Upstream responses returned ${status}`;
  return makeCanonicalError(kindFromStatus(status), message);
}

/**
 * The Responses envelope shares the chat-completions error shape.
 * `code`/`param` carry the optional canonical fields
 * UnsupportedParameterError sets (spec §2.2 stateful rejections);
 * other canonical kinds fall back to the kind itself, same as openai.
 */
export function fromCanonicalError(err: CanonicalError): unknown {
  return {
    error: {
      message: err.message,
      type: RESPONSES_ERROR_TYPE[err.kind],
      param: err.param ?? null,
      code: err.code ?? err.kind,
    },
  };
}
