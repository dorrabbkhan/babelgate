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
  CanonicalResponseFormat,
  CanonicalTool,
  ProviderAdapter,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { ValidationError } from "../../utils/errors";
import { recordNote } from "../../observe/context";
import {
  EFFORT_LADDER,
  nearestSupported,
  type Effort,
} from "../reasoning-effort";
import { systemText } from "../system-text";
import {
  decodeInputItem,
  encodeMessage,
  createInputDecodeState,
  flushPendingReasoning,
} from "./responses.items";
import {
  toCanonicalTool,
  toCanonicalToolChoice,
  toResponsesTool,
  toResponsesToolChoice,
} from "./responses.tools";
import { isSchemaObject } from "../response-format";
import {
  toCanonicalResponse,
  fromCanonicalResponse,
} from "./responses.response";
import { createStreamDecoder } from "./responses.stream.decode";
import { createStreamEncoder } from "./responses.stream.encode";
import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesModelListResponse,
} from "../../types/responses.types";

import type { MediaSupport } from "../../services/media-inline";

/**
 * Responses media support (v1.5 spec §3.2.2):
 *  - `input_image.image_url` takes remote http(s) URLs —
 *    https://platform.openai.com/docs/guides/images-vision
 *  - `input_file` carries base64 `file_data` or a remote `file_url` —
 *    https://platform.openai.com/docs/guides/pdf-files
 *  - tool outputs (function_call_output) carry text parts only.
 */
export const MEDIA_SUPPORT: MediaSupport = {
  imageUrl: true,
  documentData: true,
  documentUrl: true,
  toolMessageImages: false,
};

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


function note(
  code: string,
  path: string,
  message: string,
  stage: "decode" | "encode" = "decode",
): void {
  recordNote({ stage, adapter: "responses", code, path }, message);
}


// ============ REQUEST: Responses → Canonical ============

/**
 * Top-level request fields with no canonical equivalent (v1.4 spec
 * §2.2). The stateful set (`previous_response_id`, `conversation`,
 * `store: true`) is refused earlier — in proxy.service before
 * routing — so this list is the tolerated remainder: caching hints,
 * tiering, tracing metadata, and the fields later tasks own
 * (`include` reasoning items → Task 8).
 * `reasoning` and `include` are decoded (Task 6): `reasoning` maps to
 * `config.reasoning`, and `include: ["reasoning.encrypted_content"]`
 * marks the client as reasoning-capable. `text.format` is decoded
 * (Task 9); `text`'s other keys (`verbosity` et al.) keep the
 * `field_dropped` note on `text`.
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
    const state = createInputDecodeState();
    input.forEach((item, i) =>
      decodeInputItem(item, i, messages, systemTexts, state),
    );
    flushPendingReasoning(state, messages);
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

  const reasoning = toCanonicalReasoning(request);
  const responseFormat = toCanonicalResponseFormat(request.text);

  return {
    model: request.model as string,
    messages,
    ...(systemTexts.length > 0 && {
      systemPrompt: systemTexts.join("\n\n"),
    }),
    ...(responseFormat !== undefined && { responseFormat }),
    config: {
      ...(typeof request.temperature === "number" && {
        temperature: request.temperature,
      }),
      ...(typeof request.max_output_tokens === "number" && {
        maxTokens: request.max_output_tokens,
      }),
      ...(typeof request.top_p === "number" && { topP: request.top_p }),
      ...(reasoning !== undefined && { reasoning }),
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


/**
 * `text.format` → canonical `responseFormat` (v1.4 spec §3.5). Wire
 * fields per the create reference
 * (https://platform.openai.com/docs/api-reference/responses/create)
 * and SDK `ResponseTextConfig`/`ResponseFormatTextConfig` (openai
 * 7.30.1): `{type:"json_schema", name, schema, strict?, description?}`
 * and `{type:"json_object"}`; `{type:"text"}` is the documented
 * default — no constraint, decoded silently. `text`'s other keys
 * (`verbosity` — which Codex sends — et al.) keep the `field_dropped`
 * note on `text`; a non-object `text` keeps its note too. The schema
 * object passes through by reference — never cloned or rewritten
 * (§3.5: schemas are never weakened).
 */
function toCanonicalResponseFormat(
  text: ResponsesRequest["text"],
): CanonicalResponseFormat | undefined {
  if (text === undefined) return undefined;
  if (text === null || typeof text !== "object" || Array.isArray(text)) {
    note(
      "field_dropped",
      "text",
      'Dropping request field "text" (not an object)',
    );
    return undefined;
  }
  const t = text as { format?: unknown };
  if (Object.keys(t).some((key) => key !== "format")) {
    note(
      "field_dropped",
      "text",
      'Dropping request field "text" keys with no canonical equivalent',
    );
  }
  const format = t.format;
  if (format === undefined || format === null) return undefined;
  if (
    typeof format !== "object" ||
    Array.isArray(format)
  ) {
    note(
      "field_dropped",
      "text.format",
      'Dropping request field "text.format" (not an object)',
    );
    return undefined;
  }
  const f = format as Record<string, unknown>;
  if (f.type === "text") return undefined;
  if (f.type === "json_object") return { type: "json_object" };
  if (
    f.type === "json_schema" &&
    typeof f.name === "string" &&
    f.name !== "" &&
    isSchemaObject(f.schema)
  ) {
    return {
      type: "json_schema",
      name: f.name,
      schema: f.schema,
      ...(typeof f.strict === "boolean" && { strict: f.strict }),
      ...(typeof f.description === "string" && {
        description: f.description,
      }),
    };
  }
  note(
    "field_dropped",
    "text.format",
    "Dropping an unsupported text.format value",
  );
  return undefined;
}

/**
 * `reasoning` + `include` → `config.reasoning` (v1.4 spec §3.3, the
 * only decoder that produces it). Wire fields per the create
 * reference and SDK `Shared.Reasoning`: `effort` (the canonical
 * ladder plus `max`, which has no canonical slot → `xhigh` with a
 * note), `summary`/`generate_summary` (any set value → `summary:
 * true` — canonical carries a boolean, not the wire's level).
 * `include: ["reasoning.encrypted_content"]` marks the request as
 * reasoning-capable on its own (Codex sends it every turn, E16);
 * other `include` values keep their `field_dropped` note. Malformed
 * inputs — a non-object `reasoning`, a non-string `effort`, a
 * non-array `include` — keep 1.3's `field_dropped` note on the
 * field path, no values echoed.
 */
type CanonicalReasoning = NonNullable<
  NonNullable<CanonicalRequest["config"]>["reasoning"]
>;

function toCanonicalReasoning(
  request: ResponsesRequest,
): CanonicalReasoning | undefined {
  let reasoning: CanonicalReasoning | undefined;

  const wire = request.reasoning;
  if (wire !== undefined) {
    if (wire !== null && typeof wire === "object" && !Array.isArray(wire)) {
      reasoning = {};
      const fields = wire as {
        effort?: unknown;
        summary?: unknown;
        generate_summary?: unknown;
      };
      if (fields.effort !== undefined) {
        if (typeof fields.effort === "string") {
          if (
            (EFFORT_LADDER as readonly string[]).includes(fields.effort)
          ) {
            reasoning.effort = fields.effort as Effort;
          } else if (fields.effort === "max") {
            // `max` is the only documented level above the ladder
            // (ReasoningEffort in shared.d.ts + the reasoning guide).
            reasoning.effort = "xhigh";
            note(
              "reasoning_effort_lowered",
              "reasoning.effort",
              'Lowering reasoning effort "max" to "xhigh" (canonical maximum)',
            );
          } else {
            note(
              "field_dropped",
              "reasoning.effort",
              "Dropping unknown reasoning effort level",
            );
          }
        } else {
          note(
            "field_dropped",
            "reasoning.effort",
            'Dropping request field "reasoning.effort" (not a level string)',
          );
        }
      }
      if (
        fields.summary !== undefined ||
        fields.generate_summary !== undefined
      ) {
        reasoning.summary = true;
      }
    } else {
      note(
        "field_dropped",
        "reasoning",
        'Dropping request field "reasoning" (not an object)',
      );
    }
  }

  const include = request.include;
  if (include !== undefined) {
    if (Array.isArray(include)) {
      for (const entry of include) {
        if (entry === "reasoning.encrypted_content") {
          reasoning ??= {};
        } else {
          note(
            "field_dropped",
            "include",
            "Dropping an include value (no canonical equivalent)",
          );
        }
      }
    } else {
      note(
        "field_dropped",
        "include",
        'Dropping request field "include" (not an array)',
      );
    }
  }

  return reasoning;
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

  // Custom calls re-encode as custom_tool_call and their results as
  // custom_tool_call_output (SDK ResponseCustomToolCall/Output) — the
  // id set is scanned up front so results typed before their calls
  // still match.
  const customCallIds = new Set(
    request.messages.flatMap((m) =>
      (m.toolCalls ?? [])
        .filter((c) => c.custom === true)
        .map((c) => c.id),
    ),
  );
  let itemSeq = 0;
  const itemId = () => `rs_${itemSeq++}`;
  for (const message of request.messages) {
    input.push(...encodeMessage(message, customCallIds, itemId));
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
      tool_choice: toResponsesToolChoice(
        request.toolChoice,
        request.tools,
      ),
    }),
    // v1.4 spec §3.5: `text.format` per the create reference + SDK
    // ResponseFormatTextConfig — `text`'s other keys are untouched.
    ...(request.responseFormat !== undefined && {
      text: { format: toWireFormat(request.responseFormat) },
    }),
  };

  const reasoning = request.config?.reasoning;
  if (reasoning !== undefined) {
    // Wire fields per Shared.Reasoning / ReasoningEffort (openai SDK
    // shared.d.ts) and the reasoning guide
    // https://developers.openai.com/api/docs/guides/reasoning —
    // `summary: "auto"` is the documented value; the canonical side
    // carries only a boolean.
    const reasoningWire: Record<string, unknown> = {};
    if (reasoning.effort !== undefined) {
      reasoningWire.effort = reasoning.effort;
    }
    if (reasoning.summary === true) {
      reasoningWire.summary = "auto";
    }
    result.reasoning = reasoningWire;
    // Reasoning items come back encrypted when the client asked for
    // them; echoing the marker is also what makes a translated
    // request carry reasoning context on the next turn (Task 8).
    result.include = ["reasoning.encrypted_content"];
    if (reasoning.budgetTokens !== undefined) {
      note(
        "reasoning_budget_dropped",
        "reasoning.budget_tokens",
        "Dropping reasoning.budget_tokens (no Responses equivalent)",
        "encode",
      );
    }
  }
  return result as unknown as ResponsesRequest;
}

/**
 * Canonical `responseFormat` → `text.format` value (v1.4 spec §3.5):
 * `json_schema` → `{type:"json_schema", name, schema, strict?,
 * description?}`, `json_object` → `{type:"json_object"}`. The schema
 * passes through by reference — never cloned or rewritten.
 */
function toWireFormat(
  format: CanonicalResponseFormat,
): Record<string, unknown> {
  if (format.type === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    name: format.name,
    schema: format.schema,
    ...(format.strict !== undefined && { strict: format.strict }),
    ...(format.description !== undefined && {
      description: format.description,
    }),
  };
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


// ============ STREAMING ============
// The SSE codec lives in ./responses.stream; the adapter object above
// wires it like the other providers.

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
