/**
 * Responses SSE encoder (v1.4 spec §3.1, §3.7): canonical stream
 * events -> client-facing Responses SSE. Split from the decoder
 * (responses.stream.decode.ts) per rule 7.
 *
 * Wire-format sources (Global Constraints: evidence per event/field):
 *  - Event set and per-event field names (`sequence_number`,
 *    `output_index`, `item_id`, `content_index`, `delta`, `text`,
 *    `arguments`, `item`, `part`, `response`):
 *    https://platform.openai.com/docs/api-reference/responses-streaming
 *  - The same event set in Codex's parser:
 *    `codex-rs/codex-api/src/sse/responses.rs` at Codex 0.169.0 (E2).
 *  - The Response object inside `response.*` events:
 *    https://platform.openai.com/docs/api-reference/responses/object
 */
import type {
  CanonicalStreamEvent,
  CanonicalUsage,
  StreamEncoder,
  StreamEncoderContext,
} from "../../types/canonical.types";
import type {
  ResponsesRequest,
  ResponsesResponse,
} from "../../types/responses.types";
import { formatSse } from "../../utils/sse";
import {
  toResponsesResponseObject,
  toResponsesUsage,
} from "./responses.response";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

// ============ ENCODER: canonical → client-facing Responses SSE ============

/** Call state buffered until its `tool_call_end` (never interleaved). */
interface EncodeCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Canonical events → Responses SSE (spec §3.1, §3.7): every frame is
 * `event: <type>\ndata: <json>\n\n` with a `type` in the payload and a
 * 0-based `sequence_number` (+1 per event, per the streaming
 * reference). `message_start` emits `response.created` +
 * `response.in_progress`; each text block is a message output item
 * (`output_item.added` → `content_part.added` → `output_text.delta`* →
 * the `.done`s); tool calls are buffered and each emitted whole at its
 * `tool_call_end` in canonical index order — output items never
 * interleave (a text block closes first and re-opens after); the
 * terminal event is `response.completed` (with the streamed items and
 * usage), `response.incomplete` for truncation, or `response.failed`
 * (`response.error {code, message}`) on `error`. The stream ends after
 * the terminal event — the reference has no `[DONE]`.
 */
export function createStreamEncoder(
  ctx: StreamEncoderContext<ResponsesRequest>,
): StreamEncoder {
  let seq = 0;
  let finished = false;
  let responseId = "resp_babelgate";
  const createdAt = Math.floor(Date.now() / 1000);
  let nextItemSeq = 0;
  let nextOutputIndex = 0;
  let usage: CanonicalUsage | undefined;
  let openText:
    | { itemId: string; outputIndex: number; text: string }
    | undefined;
  const calls = new Map<number, EncodeCall>();
  const completed = new Map<number, EncodeCall>();
  let nextCallEmit = 0;
  const emittedItems: Obj[] = [];
  let outputText = "";

  const emit = (type: string, data: Obj): string =>
    formatSse(
      JSON.stringify({ type, sequence_number: seq++, ...data }),
      type,
    );

  // The Response object inside every `response.*` frame carries the
  // unary path's field set via toResponsesResponseObject — the
  // skeleton just has `output: []`, `status: in_progress` and
  // `usage: null` (the object reference makes usage nullable;
  // Codex's `Response.usage` is `Option` — codex-rs/codex-api/src/
  // sse/responses.rs at Codex 0.169.0).
  const responseSkeleton = (): ResponsesResponse =>
    toResponsesResponseObject({
      id: responseId,
      createdAt,
      status: "in_progress",
      model: ctx.requestedModel,
      output: [],
      outputText: "",
      error: null,
      incompleteDetails: null,
      usage: null,
    });

  function closeText(itemStatus = "completed"): string {
    if (openText === undefined) return "";
    const { itemId, outputIndex, text } = openText;
    openText = undefined;
    const part = { type: "output_text", text, annotations: [] };
    const item = {
      id: itemId,
      type: "message",
      status: itemStatus,
      role: "assistant",
      content: [part],
    };
    emittedItems.push(item);
    return (
      emit("response.output_text.done", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text,
      }) +
      emit("response.content_part.done", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part,
      }) +
      emit("response.output_item.done", {
        output_index: outputIndex,
        item,
      })
    );
  }

  /** Serialize one buffered call as a complete function_call item. */
  function emitCall(call: EncodeCall): string {
    const itemId = `fc_${nextItemSeq++}`;
    const outputIndex = nextOutputIndex++;
    const openItem = {
      id: itemId,
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: "",
      status: "in_progress",
    };
    const doneItem = { ...openItem, arguments: call.args, status: "completed" };
    emittedItems.push(doneItem);
    return (
      closeText() +
      emit("response.output_item.added", {
        output_index: outputIndex,
        item: openItem,
      }) +
      (call.args !== ""
        ? emit("response.function_call_arguments.delta", {
            item_id: itemId,
            output_index: outputIndex,
            delta: call.args,
          })
        : "") +
      emit("response.function_call_arguments.done", {
        item_id: itemId,
        output_index: outputIndex,
        arguments: call.args,
      }) +
      emit("response.output_item.done", {
        output_index: outputIndex,
        item: doneItem,
      })
    );
  }

  /** Emit every completed call whose turn it is (index order). */
  function flushCompleted(): string {
    let out = "";
    for (;;) {
      const call = completed.get(nextCallEmit);
      if (!call) return out;
      completed.delete(nextCallEmit);
      nextCallEmit++;
      out += emitCall(call);
    }
  }

  function terminalResponse(
    status: "completed" | "incomplete" | "failed",
    extra?: {
      error?: { code: string; message: string };
      incompleteReason?: string;
    },
  ): ResponsesResponse {
    return toResponsesResponseObject({
      id: responseId,
      createdAt,
      status,
      incompleteDetails:
        status === "incomplete"
          ? { reason: extra?.incompleteReason ?? "max_output_tokens" }
          : null,
      model: ctx.requestedModel,
      output: emittedItems,
      outputText,
      error: extra?.error ?? null,
      // `usage` is always present on a terminal response — the usage
      // object when canonical usage arrived, `null` otherwise; the
      // object reference makes the field nullable
      // (https://platform.openai.com/docs/api-reference/responses/object)
      // and Codex's `Response.usage` is `Option<ResponseUsage>`
      // (codex-rs/codex-api/src/sse/responses.rs at Codex 0.169.0).
      // A `failed` response keeps usage that already arrived.
      usage: usage === undefined ? null : toResponsesUsage(usage),
    });
  }

  return {
    contentType: "text/event-stream",
    encode(event) {
      if (finished) return "";
      switch (event.type) {
        case "message_start":
          responseId = event.id;
          return (
            emit("response.created", { response: responseSkeleton() }) +
            emit("response.in_progress", { response: responseSkeleton() })
          );
        case "text_delta": {
          if (event.text === "") return "";
          let open = "";
          if (openText === undefined) {
            openText = {
              itemId: `msg_${nextItemSeq++}`,
              outputIndex: nextOutputIndex++,
              text: "",
            };
            open =
              emit("response.output_item.added", {
                output_index: openText.outputIndex,
                item: {
                  id: openText.itemId,
                  type: "message",
                  status: "in_progress",
                  role: "assistant",
                  content: [],
                },
              }) +
              emit("response.content_part.added", {
                item_id: openText.itemId,
                output_index: openText.outputIndex,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              });
          }
          openText.text += event.text;
          outputText += event.text;
          const { itemId, outputIndex } = openText;
          return (
            open +
            emit("response.output_text.delta", {
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              delta: event.text,
            })
          );
        }
        case "reasoning_start":
        case "reasoning_delta":
        case "reasoning_signature":
          // v1.4 spec §3.3: reasoning items are emitted by Task 8's
          // envelope work; until then they are dropped, like the
          // other encoders.
          return "";
        case "tool_call_start":
          calls.set(event.index, {
            id: event.id,
            name: event.name,
            args: "",
          });
          return "";
        case "tool_call_delta": {
          const call = calls.get(event.index);
          if (call) call.args += event.argumentsDelta;
          return "";
        }
        case "tool_call_end": {
          const call = calls.get(event.index);
          if (!call) return "";
          calls.delete(event.index);
          completed.set(event.index, call);
          return flushCompleted();
        }
        case "usage":
          usage = event.usage;
          return "";
        case "message_end": {
          finished = true;
          switch (event.finishReason) {
            case "length":
            case "content_filter":
              return (
                closeText("incomplete") +
                flushCompleted() +
                emit("response.incomplete", {
                  response: terminalResponse("incomplete", {
                    incompleteReason:
                      event.finishReason === "length"
                        ? "max_output_tokens"
                        : "content_filter",
                  }),
                })
              );
            case "error":
              return (
                closeText() +
                flushCompleted() +
                emit("response.failed", {
                  response: terminalResponse("failed", {
                    error: {
                      code: "api_error",
                      message: "The upstream stream ended in error",
                    },
                  }),
                })
              );
            default:
              return (
                closeText() +
                flushCompleted() +
                emit("response.completed", {
                  response: terminalResponse("completed"),
                })
              );
          }
        }
        case "error":
          finished = true;
          return (
            closeText() +
            flushCompleted() +
            emit("response.failed", {
              response: terminalResponse("failed", {
                error: {
                  code: event.error.code ?? event.error.kind,
                  message: event.error.message,
                },
              }),
            })
          );
      }
    },
    end() {
      return "";
    },
  };
}
