/**
 * Responses SSE decoder (v1.4 spec §3.1, §3.7, E2): upstream event-typed
 * SSE bytes -> canonical stream events. Split from the encoder
 * (responses.stream.encode.ts) per rule 7.
 *
 * Wire-format sources (Global Constraints: evidence per event/field):
 *  - Event set and per-event field names (`sequence_number`,
 *    `output_index`, `item_id`, `content_index`, `delta`, `text`,
 *    `arguments`, `item`, `part`, `response`):
 *    https://platform.openai.com/docs/api-reference/responses-streaming
 *  - The same event set in Codex's parser:
 *    `codex-rs/codex-api/src/sse/responses.rs` at Codex 0.169.0 (E2);
 *    observed event order/counts in
 *    `tests/fixtures/codex/recording.jsonl` `sseEvents`.
 *  - The Response object inside `response.*` events:
 *    https://platform.openai.com/docs/api-reference/responses/object
 *  - E19: OpenRouter's Responses SSE carries no `event:` lines - the
 *    event type is read from the `data:` payload's `type` field, like
 *    Codex's own parser; `data: [DONE]` is tolerated after the
 *    terminal event.
 */
import type {
  CanonicalStreamEvent,
  IdGenerator,
  StreamDecoder,
} from "../../types/canonical.types";
import type { ResponsesResponse } from "../../types/responses.types";
import { createIdGenerator } from "../../utils/ids";
import { makeCanonicalError } from "../../utils/canonical-error";
import { createSseParser, createUtf8Decoder } from "../../utils/sse";
import { logger } from "../../utils/logger";
import { toCanonicalResponse } from "./responses.response";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

// ============ DECODER: upstream Responses SSE → canonical ============

/** Call state keyed by the wire item_id and output_index. */
interface DecodeCall {
  index: number;
  args: string;
  done: boolean;
}

/**
 * Responses SSE → canonical events (spec §3.1, E2/E19): the event
 * type comes from each `data:` payload's `type` field, the SSE
 * `event:` line only when the payload lacks one (OpenRouter sends no
 * `event:` lines). `response.created`/`in_progress` opens the
 * canonical message; a `function_call` output item is a tool call
 * keyed by item_id/output_index; `output_text` and
 * `function_call_arguments` deltas stream through; the terminal
 * `response.completed`/`incomplete` closes open calls, emits usage
 * and `message_end`; `response.failed` and the `error` event become
 * a canonical `error`. A terminal response's `output` items whose
 * content never streamed are reconciled (a delta-only or
 * object-only upstream still yields its content exactly once —
 * announced-but-contentless message items included). Unknown event types and item
 * types are ignored with a debug line — Tasks 5/8 own custom-tool
 * and reasoning events. A stream ending without a terminal event
 * ends in an `error` event.
 */
export function createStreamDecoder(
  model: string,
  ids: IdGenerator = createIdGenerator(),
): StreamDecoder {
  const utf8 = createUtf8Decoder();
  const sse = createSseParser();
  let started = false;
  let finished = false;
  let sawTerminal = false;
  let nextToolIndex = 0;
  const callsByItem = new Map<string, DecodeCall>();
  const callsByIndex = new Map<number, DecodeCall>();
  const openCalls: number[] = [];
  const seenItemIds = new Set<string>();
  const textItems = new Set<string>();
  const loggedTypes = new Set<string>();

  function ensureStarted(out: CanonicalStreamEvent[], response?: Obj): void {
    if (started) return;
    started = true;
    out.push({
      type: "message_start",
      id:
        typeof response?.id === "string" && response.id !== ""
          ? response.id
          : ids(),
      model:
        typeof response?.model === "string" && response.model !== ""
          ? response.model
          : model,
    });
  }

  function logUnknown(type: string): void {
    if (loggedTypes.has(type)) return;
    loggedTypes.add(type);
    logger.debug({ type }, "responses stream: ignoring event type");
  }

  function closeAll(out: CanonicalStreamEvent[]): void {
    for (const index of openCalls.splice(0)) {
      out.push({ type: "tool_call_end", index });
    }
  }

  function callFor(event: Obj): DecodeCall | undefined {
    if (typeof event.item_id === "string") {
      const call = callsByItem.get(event.item_id);
      if (call) return call;
    }
    if (typeof event.output_index === "number") {
      return callsByIndex.get(event.output_index);
    }
    return undefined;
  }

  function openCall(item: Obj, out: CanonicalStreamEvent[]): DecodeCall {
    const call: DecodeCall = { index: nextToolIndex++, args: "", done: false };
    openCalls.push(call.index);
    if (typeof item.id === "string") callsByItem.set(item.id, call);
    out.push({
      type: "tool_call_start",
      index: call.index,
      id:
        typeof item.call_id === "string" && item.call_id !== ""
          ? item.call_id
          : typeof item.id === "string" && item.id !== ""
            ? item.id
            : ids(),
      name: typeof item.name === "string" ? item.name : "",
    });
    return call;
  }

  /** Emit the events of one terminal `output[]` item never streamed. */
  function reconcileItem(item: Obj, out: CanonicalStreamEvent[]): void {
    if (item.type === "message") {
      // A message item is reconciled unless its item_id already
      // produced text (delta or done); `output_item.added` alone does
      // not suppress it — an announced-but-contentless item still
      // yields its terminal content.
      if (typeof item.id === "string" && textItems.has(item.id)) return;
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" && typeof part.text === "string" && part.text !== "") {
          out.push({ type: "text_delta", text: part.text });
        }
      }
      return;
    }
    if (typeof item.id === "string" && seenItemIds.has(item.id)) return;
    if (item.type === "function_call") {
      const call = openCall(item, out);
      if (typeof item.arguments === "string" && item.arguments !== "") {
        call.args = item.arguments;
        out.push({
          type: "tool_call_delta",
          index: call.index,
          argumentsDelta: item.arguments,
        });
      }
      call.done = true;
      openCalls.splice(openCalls.indexOf(call.index), 1);
      out.push({ type: "tool_call_end", index: call.index });
    }
  }

  function handleEvent(
    eventType: string | undefined,
    data: string,
    out: CanonicalStreamEvent[],
  ): void {
    if (finished) return;
    if (data === "[DONE]") {
      // Tolerated after the terminal event (E19); without one the
      // stream ended early, like a bare EOF.
      finished = true;
      if (!sawTerminal) {
        closeAll(out);
        out.push({
          type: "error",
          error: makeCanonicalError(
            "upstream",
            "Upstream stream ended without completing",
          ),
        });
      }
      return;
    }
    let event: Obj;
    try {
      event = JSON.parse(data) as Obj;
    } catch {
      out.push({
        type: "error",
        error: makeCanonicalError(
          "upstream",
          "Upstream sent an undecodable stream chunk",
        ),
      });
      finished = true;
      return;
    }
    const type = typeof event.type === "string" ? event.type : eventType;
    switch (type) {
      case "response.created":
      case "response.in_progress":
        ensureStarted(out, event.response);
        break;
      case "response.output_item.added": {
        const item = event.item ?? {};
        if (typeof item.id === "string") seenItemIds.add(item.id);
        if (item.type === "function_call") {
          ensureStarted(out);
          const call = openCall(item, out);
          if (typeof event.output_index === "number") {
            callsByIndex.set(event.output_index, call);
          }
        }
        break;
      }
      case "response.output_item.done": {
        const item = event.item ?? {};
        if (typeof item.id === "string") seenItemIds.add(item.id);
        if (item.type !== "function_call") break;
        let call =
          typeof item.id === "string"
            ? callsByItem.get(item.id)
            : undefined;
        call ??= callFor(event);
        if (call === undefined) {
          // A function_call item seen only at its done event —
          // emit the whole call here.
          call = openCall(item, out);
        }
        if (!call.done) {
          call.done = true;
          openCalls.splice(openCalls.indexOf(call.index), 1);
          if (
            call.args === "" &&
            typeof item.arguments === "string" &&
            item.arguments !== ""
          ) {
            call.args = item.arguments;
            out.push({
              type: "tool_call_delta",
              index: call.index,
              argumentsDelta: item.arguments,
            });
          }
          out.push({ type: "tool_call_end", index: call.index });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const call = callFor(event);
        if (
          call &&
          !call.done &&
          typeof event.delta === "string" &&
          event.delta !== ""
        ) {
          call.args += event.delta;
          out.push({
            type: "tool_call_delta",
            index: call.index,
            argumentsDelta: event.delta,
          });
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const call = callFor(event);
        if (
          call &&
          call.args === "" &&
          typeof event.arguments === "string" &&
          event.arguments !== ""
        ) {
          // An upstream that skipped deltas still yields the full
          // arguments at done.
          call.args = event.arguments;
          out.push({
            type: "tool_call_delta",
            index: call.index,
            argumentsDelta: event.arguments,
          });
        }
        break;
      }
      case "response.output_text.delta": {
        ensureStarted(out);
        if (typeof event.item_id === "string") {
          textItems.add(event.item_id);
        }
        if (typeof event.delta === "string" && event.delta !== "") {
          out.push({ type: "text_delta", text: event.delta });
        }
        break;
      }
      case "response.output_text.done": {
        if (
          typeof event.item_id === "string" &&
          !textItems.has(event.item_id) &&
          typeof event.text === "string" &&
          event.text !== ""
        ) {
          ensureStarted(out);
          out.push({ type: "text_delta", text: event.text });
          textItems.add(event.item_id);
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = (event.response ?? {}) as Obj;
        ensureStarted(out, response);
        for (const item of response.output ?? []) {
          reconcileItem(item as Obj, out);
        }
        closeAll(out);
        const decoded = toCanonicalResponse(
          response as ResponsesResponse,
          model,
        );
        if (decoded.usage) out.push({ type: "usage", usage: decoded.usage });
        out.push({
          type: "message_end",
          finishReason: decoded.finishReason,
        });
        sawTerminal = true;
        finished = true;
        break;
      }
      case "response.failed":
      case "error": {
        ensureStarted(out, event.response);
        const err = event.response?.error ?? event.error ?? event;
        out.push({
          type: "error",
          error: {
            ...makeCanonicalError(
              "upstream",
              typeof err?.message === "string" && err.message !== ""
                ? err.message
                : "Upstream response failed",
            ),
            ...(typeof err?.code === "string" && { code: err.code }),
          },
        });
        sawTerminal = true;
        finished = true;
        break;
      }
      case "response.content_part.added":
      case "response.content_part.done":
        // Part lifecycle events carry no deltas.
        break;
      default:
        if (type !== undefined) logUnknown(type);
    }
  }

  function drain(
    events: { event?: string; data: string }[],
    out: CanonicalStreamEvent[],
  ): void {
    for (const e of events) {
      if (finished) break;
      handleEvent(e.event, e.data, out);
    }
  }

  return {
    feed(chunk) {
      const out: CanonicalStreamEvent[] = [];
      drain(sse.feed(utf8(chunk)), out);
      return out;
    },
    end() {
      const out: CanonicalStreamEvent[] = [];
      drain(sse.feed(utf8(new Uint8Array(0))), out);
      drain(sse.end(), out);
      if (!finished) {
        closeAll(out);
        out.push({
          type: "error",
          error: makeCanonicalError(
            "upstream",
            "Upstream stream ended without completing",
          ),
        });
      }
      return out;
    },
  };
}

