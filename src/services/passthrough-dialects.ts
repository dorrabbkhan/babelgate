/**
 * Pass-through dialects (v1.5 spec §3.3, D6): the wire-format
 * knowledge each same-format relay needs, as `RelayDialect`
 * descriptors for the generic engine in passthrough-relay.ts, plus
 * the three public relay entry points the task names —
 * `relayResponsesStream`, `relayAnthropicStream`,
 * `relayChatStream`. Split from passthrough-relay.ts (rule 7) so
 * neither file passes ~400 lines.
 *
 * Wire-format sources (every event/field this file touches):
 *  - Responses lifecycle/terminal events and the Response object:
 *    https://platform.openai.com/docs/api-reference/responses-streaming
 *    (codex-rs/codex-api/src/sse/responses.rs at 0.169.0, E19, for
 *    the type-from-payload precedence)
 *  - Anthropic event names and the error frame:
 *    https://docs.anthropic.com/en/api/messages-streaming
 *  - Chat chunks, `data: [DONE]`, the `choices: []` usage chunk and
 *    the `{"error":{…}}` frame:
 *    https://platform.openai.com/docs/api-reference/chat/streaming
 *
 * Each dialect's synthesized failure frame goes through its own
 * adapter's `fromCanonicalError` (responses's through
 * `toResponsesResponseObject`), so a mid-flight upstream failure
 * reaches the client in exactly the shape the bridged encoder would
 * have emitted. Observation runs the same way: the anthropic/chat
 * relays feed the relayed bytes through their own adapter's stream
 * decoder (`observation.events`); the responses relay decodes the
 * terminal event's `response` object instead — no second field map
 * anywhere.
 */
import { adapters } from "../transformers";
import { toResponsesResponseObject } from "../transformers/adapters/responses.response";
import { fromCanonicalError as anthropicError } from "../transformers/adapters/anthropic.adapter";
import { fromCanonicalError as openaiError } from "../transformers/adapters/openai.adapter";
import { makeCanonicalError } from "../utils/canonical-error";
import { formatSse } from "../utils/sse";
import {
  relayUpstreamStream,
  type RelayDialect,
  type RelayStreamOpts,
} from "./passthrough-relay";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Codex's precedence: `type` from the `data:` payload, `event:` as
 *  fallback — identical on all three dialects. */
const payloadType = (parsed: Obj, sseEvent: string | undefined) =>
  typeof parsed.type === "string" ? parsed.type : sseEvent;

// ============ Responses (v1.4 spec §3.4) ============

/** The five lifecycle events whose `response.model` is restored. */
const RESPONSES_LIFECYCLE = new Set([
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

const RESPONSES_DIALECT: RelayDialect = {
  eventType: payloadType,
  modelHolder: (type, parsed) =>
    type !== undefined && RESPONSES_LIFECYCLE.has(type)
      ? parsed.response
      : undefined,
  terminal: new Set([
    "response.completed",
    "response.incomplete",
    "response.failed",
  ]),
  // The bare `error` event the streaming reference defines beside
  // the response.* lifecycle.
  error: new Set(["error"]),
  failedFrame: (requestedModel, message) =>
    formatSse(
      JSON.stringify({
        type: "response.failed",
        response: toResponsesResponseObject({
          id: "resp_babelgate",
          createdAt: Math.floor(Date.now() / 1000),
          status: "failed",
          model: requestedModel,
          output: [],
          outputText: "",
          error: { code: "api_error", message },
          incompleteDetails: null,
          usage: null,
        }),
      }),
      "response.failed",
    ),
};

// ============ Anthropic (v1.5 spec §3.3) ============

const ANTHROPIC_DIALECT: RelayDialect = {
  eventType: payloadType,
  // `message.model` lives only in message_start — every other event
  // relays verbatim.
  modelHolder: (type, parsed) =>
    type === "message_start" ? parsed.message : undefined,
  terminal: new Set(["message_stop"]),
  // `event: error` — https://docs.anthropic.com/en/api/messages-streaming
  error: new Set(["error"]),
  failedFrame: (requestedModel, message) =>
    // anthropic's own error dialect — the same frame its stream
    // encoder emits for a canonical error (kind upstream →
    // `api_error`; the model is carried by message_start, which the
    // client already saw).
    formatSse(
      JSON.stringify(
        anthropicError(makeCanonicalError("upstream", message)),
      ),
      "error",
    ),
  createObserver: (model) => adapters.anthropic.createStreamDecoder(model),
};

// ============ Chat Completions (v1.5 spec §3.3) ============

const CHAT_DIALECT: RelayDialect = {
  // A `{"error":{…}}` payload is the error frame; normal chunks are
  // `chat.completion.chunk`s (their `object`), the `event:` line a
  // fallback for upstreams that send one.
  eventType: (parsed, sseEvent) =>
    isObj(parsed.error)
      ? "error"
      : typeof parsed.object === "string"
        ? parsed.object
        : payloadType(parsed, sseEvent),
  rawDataType: (data) => (data.trim() === "[DONE]" ? "[DONE]" : undefined),
  // Every chunk carries `model` — restored wherever it appears; an
  // error frame has none.
  modelHolder: (_type, parsed) =>
    typeof parsed.model === "string" ? parsed : undefined,
  terminal: new Set(["[DONE]"]),
  error: new Set(["error"]),
  failedFrame: (requestedModel, message) =>
    // The bridged encoder's error line + its terminal `data: [DONE]`
    // (kind upstream → `"type":"api_error","code":"upstream"`; the
    // chunk id/model are not synthesised — an error line carries
    // neither).
    formatSse(
      JSON.stringify(openaiError(makeCanonicalError("upstream", message))),
    ) + formatSse("[DONE]"),
  createObserver: (model) => adapters.openai.createStreamDecoder(model),
};

// ============ Entry points ============

export function relayResponsesStream(
  opts: RelayStreamOpts,
): AsyncGenerator<string> {
  return relayUpstreamStream(opts, RESPONSES_DIALECT);
}

export function relayAnthropicStream(
  opts: RelayStreamOpts,
): AsyncGenerator<string> {
  return relayUpstreamStream(opts, ANTHROPIC_DIALECT);
}

export function relayChatStream(
  opts: RelayStreamOpts,
): AsyncGenerator<string> {
  return relayUpstreamStream(opts, CHAT_DIALECT);
}
