import type {
  CanonicalFinishReason,
  CanonicalReasoningOrigin,
  CanonicalReasoningSignature,
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
import { decodeOrigin } from "../reasoning-origin";
import {
  packEnvelope,
  type EnvelopePayload,
} from "../reasoning-envelope";
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
 * `content_block_start{thinking}`/`{redacted_thinking}` open a
 * reasoning block (own index namespace, v1.4 spec §3.3) — `thinking_delta`
 * → `reasoning_delta`, `signature_delta` → `reasoning_signature`, and a
 * `redacted_thinking` block's `data` is its signature's data;
 * `content_block_start{text}` and other non-tool blocks
 * (server_tool_use, …) produce nothing; `message_delta` contributes the
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
  // wire content-block index → canonical reasoning index (own
  // namespace, like the tool calls').
  const reasoningIndexByWire = new Map<number, number>();
  let nextReasoningIndex = 0;
  // §3.5: dropped block types are noted once per stream, named by
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
        } else if (
          block.type === "thinking" ||
          block.type === "redacted_thinking"
        ) {
          // v1.4 §3.3: a thinking block opens a reasoning block. Its
          // signature normally streams later as signature_delta; a
          // redacted block's `data` is the signature data and arrives
          // complete in the start event.
          // https://platform.claude.com/docs/en/build-with-claude/extended-thinking
          // (thinking/redacted_thinking blocks, signature, data).
          const rIndex = nextReasoningIndex++;
          reasoningIndexByWire.set(index, rIndex);
          const origin = decodeOrigin(model);
          out.push({
            type: "reasoning_start",
            index: rIndex,
            origin,
            ...(block.type === "redacted_thinking" && {
              redacted: true,
            }),
          });
          const sig =
            block.type === "redacted_thinking"
              ? block.data
              : block.signature;
          if (typeof sig === "string" && sig !== "") {
            out.push({
              type: "reasoning_signature",
              index: rIndex,
              signature: { origin, data: sig },
            });
          }
        } else if (block.type !== "text") {
          // text opens nothing (deltas carry it); anything else —
          // server_tool_use, web_search_tool_result, … — is dropped
          // and noted once per stream.
          logDrop(typeof block.type === "string" ? block.type : "?");
        }
        break;
      }
      case "content_block_delta": {
        const index = typeof event.index === "number" ? event.index : 0;
        const delta = event.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          out.push({ type: "text_delta", text: delta.text });
        } else if (delta.type === "thinking_delta") {
          // thinking_delta / signature_delta:
          // https://docs.anthropic.com/en/api/messages-streaming
          const rIndex = reasoningIndexByWire.get(index);
          if (rIndex !== undefined && typeof delta.thinking === "string") {
            out.push({
              type: "reasoning_delta",
              index: rIndex,
              text: delta.thinking,
            });
          }
        } else if (delta.type === "signature_delta") {
          const rIndex = reasoningIndexByWire.get(index);
          if (
            rIndex !== undefined &&
            typeof delta.signature === "string"
          ) {
            out.push({
              type: "reasoning_signature",
              index: rIndex,
              signature: { origin: decodeOrigin(model), data: delta.signature },
            });
          }
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
        reasoningIndexByWire.delete(index);
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

  // v1.5 §3.1 (Task 4): a reasoning block streams as a thinking block
  // — content_block_start{thinking}, thinking_deltas, one
  // signature_delta carrying the `bg1.` envelope (the part, its real
  // signature, and any signatures that arrived since the previous
  // reasoning block) before content_block_stop. A redacted part has
  // no deltas: its envelope is the block's `data`, emitted whole at
  // close. Signatures that never meet a reasoning block are dropped
  // with `reasoning_dropped`. Wire shapes:
  // `thinking`/`redacted_thinking` blocks, `signature`, `data` —
  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking
  // (https://platform.claude.com/docs/en/build-with-claude/thinking);
  // `thinking_delta`, `signature_delta` —
  // https://docs.anthropic.com/en/api/messages-streaming.
  interface ReasoningBlock {
    index: number;
    wireIndex?: number;
    origin: CanonicalReasoningOrigin;
    redacted: boolean;
    text: string;
    signature?: CanonicalReasoningSignature;
  }
  let openReasoning: ReasoningBlock | undefined;
  const pendingSigs: EnvelopePayload["signatures"] = [];
  // Mirrors reassembleStream: text_signature signs the current text
  // part — the last one opened, or a fresh empty part — so textIndex
  // counts text parts, not text deltas.
  const textParts: { signed: boolean }[] = [];

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

  function noteReasoningDropped(path: string, why: string): void {
    recordNote(
      {
        stage: "encode",
        adapter: "anthropic",
        code: "reasoning_dropped",
        path,
      },
      why,
    );
  }

  function envelopeFor(
    block: ReasoningBlock,
  ): EnvelopePayload {
    return {
      v: 1,
      reasoning: [
        {
          type: "reasoning",
          reasoning: {
            text: block.text,
            origin: block.origin,
            ...(block.redacted && { redacted: true }),
          },
          ...(block.signature !== undefined && {
            signature: block.signature,
          }),
        },
      ],
      signatures: pendingSigs.splice(0),
    };
  }

  /** Emit the open reasoning block's close (or whole redacted block). */
  function closeReasoning(): string {
    const block = openReasoning;
    if (block === undefined) return "";
    openReasoning = undefined;
    const env = packEnvelope(envelopeFor(block));
    if (env === undefined) {
      noteReasoningDropped(
        "reasoning",
        "Dropping a thinking block's signature (envelope over the 1 MiB cap)",
      );
    }
    if (block.redacted) {
      const index = nextBlockIndex++;
      return (
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "redacted_thinking", data: env ?? "" },
        }) +
        sse("content_block_stop", {
          type: "content_block_stop",
          index,
        })
      );
    }
    return (
      (env !== undefined
        ? sse("content_block_delta", {
            type: "content_block_delta",
            index: block.wireIndex,
            delta: { type: "signature_delta", signature: env },
          })
        : "") +
      sse("content_block_stop", {
        type: "content_block_stop",
        index: block.wireIndex,
      })
    );
  }

  function dropPendingSigs(): void {
    if (pendingSigs.length === 0) return;
    pendingSigs.length = 0;
    noteReasoningDropped(
      "signature",
      "Dropping signatures with no following reasoning block to carry them",
    );
  }

  /**
   * Signatures still pending at `message_end` — they arrived after
   * the last reasoning block closed — ride one trailing `thinking`
   * block (`thinking: ""`, one `signature_delta` with a `bg1.`
   * envelope whose `reasoning` is []), the mirror of
   * fromCanonicalResponse's leading-block rule (its
   * `segmentSigs(i, ∞)` carries them in the stream's twin). Over the
   * 1 MiB cap the block emits without the signature_delta and the
   * signatures drop with `reasoning_dropped`, as the leading block's.
   */
  function flushTrailingSigs(): string {
    if (pendingSigs.length === 0) return "";
    const env = packEnvelope({
      v: 1,
      reasoning: [],
      signatures: pendingSigs.splice(0),
    });
    if (env === undefined) {
      noteReasoningDropped(
        "reasoning",
        "Dropping a thinking block's signature (envelope over the 1 MiB cap)",
      );
    }
    const index = nextBlockIndex++;
    return (
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      }) +
      (env !== undefined
        ? sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: env },
          })
        : "") +
      sse("content_block_stop", {
        type: "content_block_stop",
        index,
      })
    );
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
          let out = closeReasoning();
          if (openTextIndex === undefined) {
            openTextIndex = nextBlockIndex++;
            out += sse("content_block_start", {
              type: "content_block_start",
              index: openTextIndex,
              content_block: { type: "text", text: "" },
            });
          }
          const last = textParts[textParts.length - 1];
          if (last === undefined || last.signed) {
            textParts.push({ signed: false });
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
        case "reasoning_start": {
          // A reasoning block closes the one before it and any open
          // text block — Anthropic never overlaps content blocks.
          const out = closeText() + closeReasoning();
          if (event.redacted === true) {
            // No thinking deltas: the block (and its envelope) emits
            // whole when it closes.
            openReasoning = {
              index: event.index,
              origin: event.origin,
              redacted: true,
              text: "",
            };
            return out;
          }
          const wireIndex = nextBlockIndex++;
          openReasoning = {
            index: event.index,
            wireIndex,
            origin: event.origin,
            redacted: false,
            text: "",
          };
          return (
            out +
            sse("content_block_start", {
              type: "content_block_start",
              index: wireIndex,
              content_block: { type: "thinking", thinking: "" },
            })
          );
        }
        case "reasoning_delta": {
          if (
            openReasoning?.index !== event.index ||
            openReasoning.redacted
          )
            return "";
          openReasoning.text += event.text;
          return sse("content_block_delta", {
            type: "content_block_delta",
            index: openReasoning.wireIndex,
            delta: { type: "thinking_delta", thinking: event.text },
          });
        }
        case "reasoning_signature": {
          // The part's real signature rides inside the envelope —
          // never on the wire (conductor's call (a)).
          if (openReasoning?.index === event.index) {
            openReasoning.signature = event.signature;
          }
          return "";
        }
        case "text_signature": {
          // Canonically the signed text part follows the open
          // reasoning block, so the signature joins its envelope
          // ("signatures up to the next reasoning part") — buffered,
          // not a wire event. The envelope's textIndex counts the
          // text parts the client echoes back, so the signed part
          // needs wire presence: sign the open text block and close
          // it — the next canonical text part is a new wire block,
          // as non-stream emits one block per part — or, when no
          // text block is open, the signature signs a fresh empty
          // part (Gemini's max_tokens.sse signs an empty final part)
          // which emits an empty wire text block.
          const last = textParts[textParts.length - 1];
          let index: number;
          let out: string;
          if (last === undefined || last.signed) {
            index = textParts.length;
            textParts.push({ signed: true });
            pendingSigs.push({
              textIndex: index,
              signature: event.signature,
            });
            const wireIndex = nextBlockIndex++;
            out =
              closeReasoning() +
              sse("content_block_start", {
                type: "content_block_start",
                index: wireIndex,
                content_block: { type: "text", text: "" },
              }) +
              sse("content_block_stop", {
                type: "content_block_stop",
                index: wireIndex,
              });
          } else {
            last.signed = true;
            index = textParts.length - 1;
            pendingSigs.push({
              textIndex: index,
              signature: event.signature,
            });
            out = closeText();
          }
          return out;
        }
        case "tool_call_start": {
          // The call's signature canonically follows the open
          // reasoning block — buffered before the close drains the
          // pending list into its envelope.
          if (event.signature !== undefined) {
            pendingSigs.push({
              toolCallId: event.id,
              signature: event.signature,
            });
          }
          const out = closeReasoning() + closeText();
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
        case "message_end": {
          finished = true;
          const out =
            closeReasoning() + closeText() + flushTrailingSigs();
          return (
            out +
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
        }
        case "error": {
          finished = true;
          const out = closeReasoning();
          dropPendingSigs();
          return (
            out +
            closeText() +
            formatSse(
              JSON.stringify(fromCanonicalError(event.error)),
              "error",
            )
          );
        }
      }
    },
    end() {
      return "";
    },
  };
}
