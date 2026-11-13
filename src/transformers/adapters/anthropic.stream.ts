import type {
  CanonicalFinishReason,
  CanonicalStreamEvent,
  CanonicalUsage,
  IdGenerator,
  StreamDecoder,
  StreamEncoder,
  StreamEncoderContext,
} from "../../types/canonical.types";
import type { MessageCreateParams } from "../../types/anthropic.types";
import { createIdGenerator } from "../../utils/ids";
import { makeCanonicalError } from "../../utils/canonical-error";
import { parseToolArguments } from "../../utils/tool-args";
import {
  createSseParser,
  createUtf8Decoder,
  formatSse,
} from "../../utils/sse";
import { logger } from "../../utils/logger";
import { recordNote } from "../../observe/context";
import { estimateInputTokens } from "../../utils/token-estimate";
import {
  fromCanonicalError,
  mapFinishReason,
  mapToAnthropicStopReason,
  toCanonicalError,
  toCanonicalRequest,
} from "./anthropic.adapter";
import {
  anthropicUsageToCanonical,
  canonicalUsageToAnthropic,
} from "./anthropic.cache";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/**
 * HTTP status an Anthropic in-stream error `type` corresponds to
 * (docs.claude.com/en/api/errors); the canonical kind comes from
 * `kindFromStatus` like the non-streaming path.
 */
const ANTHROPIC_STREAM_ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  billing_error: 402,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/**
 * Anthropic event-typed SSE → canonical events (spec §3.3,
 * docs.claude.com/en/api/messages-streaming):
 * `message_start` carries the Message skeleton and input-token usage;
 * `content_block_start{tool_use}` opens a tool call (re-keyed from wire
 * block index to canonical index in first-appearance order) whose
 * `input_json_delta.partial_json` chunks become `tool_call_delta`s;
 * `content_block_start{text}` and non-tool blocks (thinking,
 * server_tool_use, …) produce nothing, as do `thinking_delta`,
 * `signature_delta` and `ping`; `message_delta` contributes the
 * cumulative `usage` and the stop reason; `message_stop` is terminal —
 * the held usage and `message_end` are emitted there, so a stream cut
 * before `message_stop` ends in an `error` event. `event: error` maps
 * through `toCanonicalError` and ends the stream.
 */
export function createStreamDecoder(
  model: string,
  ids: IdGenerator = createIdGenerator(),
): StreamDecoder {
  const utf8 = createUtf8Decoder();
  const sse = createSseParser();
  let finished = false;
  let nextToolIndex = 0;
  let inputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let outputTokens: number | undefined;
  let finish: CanonicalFinishReason | undefined;
  // wire content-block index → block kind / canonical tool index
  const toolIndexByWire = new Map<number, number>();
  const openCalls: number[] = [];
  // §3.5: dropped thinking types are noted once per stream, named by
  // their wire block/delta type.
  const loggedDrops = new Set<string>();

  function logDrop(type: string): void {
    if (loggedDrops.has(type)) return;
    loggedDrops.add(type);
    recordNote(
      {
        stage: "decode",
        adapter: "anthropic",
        code: "stream_block_dropped",
        path: type,
      },
      `Dropping stream block "${type}" (no canonical equivalent)`,
    );
  }

  function closeAll(out: CanonicalStreamEvent[]): void {
    for (const index of openCalls.splice(0)) {
      out.push({ type: "tool_call_end", index });
    }
  }

  function handleEvent(
    eventType: string | undefined,
    data: string,
    out: CanonicalStreamEvent[],
  ): void {
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
      case "message_start": {
        const message = event.message ?? {};
        inputTokens = message.usage?.input_tokens;
        cacheReadTokens = message.usage?.cache_read_input_tokens;
        cacheWriteTokens = message.usage?.cache_creation_input_tokens;
        out.push({
          type: "message_start",
          id: typeof message.id === "string" ? message.id : ids(),
          model: typeof message.model === "string" ? message.model : model,
        });
        break;
      }
      case "content_block_start": {
        const index = typeof event.index === "number" ? event.index : 0;
        const block = event.content_block ?? {};
        if (block.type === "tool_use") {
          const toolIndex = nextToolIndex++;
          toolIndexByWire.set(index, toolIndex);
          openCalls.push(toolIndex);
          out.push({
            type: "tool_call_start",
            index: toolIndex,
            id: typeof block.id === "string" ? block.id : ids(),
            name: typeof block.name === "string" ? block.name : "",
          });
        }
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          logDrop(block.type);
        }
        // text, thinking, server_tool_use, … blocks produce nothing
        break;
      }
      case "content_block_delta": {
        const index = typeof event.index === "number" ? event.index : 0;
        const delta = event.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          out.push({ type: "text_delta", text: delta.text });
        } else if (delta.type === "thinking_delta") {
          logDrop("thinking_delta");
        } else if (delta.type === "signature_delta") {
          logDrop("signature_delta");
        } else if (delta.type === "input_json_delta") {
          const toolIndex = toolIndexByWire.get(index);
          if (
            toolIndex !== undefined &&
            typeof delta.partial_json === "string" &&
            delta.partial_json.length > 0
          ) {
            out.push({
              type: "tool_call_delta",
              index: toolIndex,
              argumentsDelta: delta.partial_json,
            });
          }
        }
        // citations_delta and anything else → nothing
        break;
      }
      case "content_block_stop": {
        const index = typeof event.index === "number" ? event.index : 0;
        const toolIndex = toolIndexByWire.get(index);
        if (toolIndex !== undefined) {
          toolIndexByWire.delete(index);
          openCalls.splice(openCalls.indexOf(toolIndex), 1);
          out.push({ type: "tool_call_end", index: toolIndex });
        }
        break;
      }
      case "message_delta": {
        // Held until message_stop — a stream cut before it must end in
        // an error event, never a half-emitted message_end.
        const stopReason = event.delta?.stop_reason;
        if (typeof stopReason === "string") {
          finish = mapFinishReason(stopReason);
        }
        if (event.usage?.input_tokens != null) {
          inputTokens = event.usage.input_tokens;
        }
        if (event.usage?.cache_read_input_tokens != null) {
          cacheReadTokens = event.usage.cache_read_input_tokens;
        }
        if (event.usage?.cache_creation_input_tokens != null) {
          cacheWriteTokens = event.usage.cache_creation_input_tokens;
        }
        if (event.usage?.output_tokens != null) {
          outputTokens = event.usage.output_tokens;
        }
        break;
      }
      case "message_stop": {
        if (inputTokens !== undefined || outputTokens !== undefined) {
          // §3.2: canonical inputTokens is ALL input, cached included —
          // Anthropic's input_tokens excludes the cache fields.
          const usage = anthropicUsageToCanonical({
            input_tokens: inputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: cacheWriteTokens,
            output_tokens: outputTokens,
          });
          out.push({ type: "usage", usage });
        }
        out.push({
          type: "message_end",
          finishReason: finish ?? "unknown",
        });
        finished = true;
        break;
      }
      case "error": {
        const status =
          ANTHROPIC_STREAM_ERROR_STATUS[event.error?.type as string] ?? 500;
        out.push({ type: "error", error: toCanonicalError(status, event) });
        finished = true;
        break;
      }
      // ping and anything unrecognised → nothing
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

/**
 * Canonical events → Anthropic event-typed SSE (spec §3.3, §3.4): text
 * deltas run inside an open text block; tool calls are buffered until
 * `tool_call_end`, then written as one `content_block_start{tool_use}` +
 * a single `input_json_delta` (the parsed arguments object, or the
 * `_invalid_arguments` wrapper) + `content_block_stop` — an open text
 * block stops first, since Anthropic never overlaps content blocks.
 * Content-block indices are contiguous in emission order — the
 * canonical tool `index` keys the buffer but is not the wire index.
 * `usage` is held into the closing `message_delta`, followed by
 * `message_stop`; `error` becomes `event: error` via
 * `fromCanonicalError`. `message_end` and `error` are terminal: any
 * event after them encodes to nothing.
 */
export function createStreamEncoder(
  ctx: StreamEncoderContext<MessageCreateParams>,
): StreamEncoder {
  // §3.5 + owner note (task 11): Claude Code reads message_start's usage
  // for its context display, but the real counts only arrive in the
  // final message_delta — so message_start carries the local estimate
  // of the client's request, derived from ctx.sourceRequest (the same
  // body the service already decoded; adding an estimate field to
  // StreamEncoderContext would be a canonical interface change).
  const estimatedInput = estimateInputTokens(
    toCanonicalRequest(ctx.sourceRequest),
  );
  let nextBlockIndex = 0;
  let openTextIndex: number | undefined;
  let finished = false;
  let usage: CanonicalUsage | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const sse = (type: string, data: Obj): string =>
    formatSse(JSON.stringify(data), type);

  function closeText(): string {
    if (openTextIndex === undefined) return "";
    const index = openTextIndex;
    openTextIndex = undefined;
    return sse("content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }

  return {
    contentType: "text/event-stream",
    encode(event) {
      if (finished) return "";
      switch (event.type) {
        case "message_start":
          return sse("message_start", {
            type: "message_start",
            message: {
              id: event.id,
              type: "message",
              role: "assistant",
              model: ctx.requestedModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: estimatedInput, output_tokens: 0 },
            },
          });
        case "text_delta": {
          let out = "";
          if (openTextIndex === undefined) {
            openTextIndex = nextBlockIndex++;
            out += sse("content_block_start", {
              type: "content_block_start",
              index: openTextIndex,
              content_block: { type: "text", text: "" },
            });
          }
          return (
            out +
            sse("content_block_delta", {
              type: "content_block_delta",
              index: openTextIndex,
              delta: { type: "text_delta", text: event.text },
            })
          );
        }
        case "reasoning_start":
        case "reasoning_delta":
        case "reasoning_signature":
          // v1.4 §3.3: reasoning replay to this target lands in a
          // later task; reasoning a target can't take is dropped.
          return "";
        case "tool_call_start": {
          const out = closeText();
          calls.set(event.index, {
            id: event.id,
            name: event.name,
            args: "",
          });
          return out;
        }
        case "tool_call_delta": {
          const call = calls.get(event.index);
          if (call) call.args += event.argumentsDelta;
          return "";
        }
        case "tool_call_end": {
          const call = calls.get(event.index);
          if (!call) return "";
          calls.delete(event.index);
          const parsed = parseToolArguments(call.args);
          if (!parsed.valid) {
            logger.warn(
              "Tool call arguments are not valid JSON; sending _invalid_arguments wrapper",
            );
          }
          const out = closeText();
          const index = nextBlockIndex++;
          return (
            out +
            sse("content_block_start", {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: {},
              },
            }) +
            sse("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(parsed.args),
              },
            }) +
            sse("content_block_stop", {
              type: "content_block_stop",
              index,
            })
          );
        }
        case "usage":
          usage = event.usage;
          return "";
        case "message_end":
          finished = true;
          return (
            closeText() +
            sse("message_delta", {
              type: "message_delta",
              delta: {
                stop_reason: mapToAnthropicStopReason(event.finishReason),
                stop_sequence: null,
              },
              usage:
                usage !== undefined
                  ? canonicalUsageToAnthropic(usage)
                  : { output_tokens: 0 },
            }) +
            sse("message_stop", { type: "message_stop" })
          );
        case "error":
          finished = true;
          return (
            closeText() +
            formatSse(
              JSON.stringify(fromCanonicalError(event.error)),
              "error",
            )
          );
      }
    },
    end() {
      return "";
    },
  };
}
