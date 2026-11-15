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
  CanonicalContentPart,
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
import { recordNote } from "../../observe/context";
import { packEnvelope, type EnvelopePayload } from "./responses.envelope";
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
  namespace?: string;
  custom?: boolean;
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
  // Task 8 (spec §3.3): reasoning blocks stream into one `reasoning`
  // output item per contiguous group; signatures collected on later
  // events go into the next envelope emitted.
  let reasoningItem:
    | {
        itemId: string;
        outputIndex: number;
        summaryIndex: number;
        partOpen: boolean;
        partText: string;
      }
    | undefined;
  const reasoningParts = new Map<number, CanonicalContentPart>();
  const pendingSigs: EnvelopePayload["signatures"] = [];
  let textPartIndex = 0;

  const emit = (type: string, data: Obj): string =>
    formatSse(
      JSON.stringify({ type, sequence_number: seq++, ...data }),
      type,
    );

  /**
   * `reasoning` output item (Task 8, spec §3.3): `output_item.added`
   * opens it, `reasoning_summary_part` frames stream the visible
   * summary text, and `output_item.done` carries the `bg1.` envelope
   * in `encrypted_content` — the turn's reasoning parts verbatim plus
   * the signatures collected so far. Over the 1 MiB cap the item
   * emits without `encrypted_content` (envelope_too_large note).
   */
  function closeReasoning(): string {
    if (reasoningItem === undefined) return "";
    const { itemId, outputIndex, partOpen, partText, summaryIndex } =
      reasoningItem;
    reasoningItem = undefined;
    const parts = [...reasoningParts.values()];
    reasoningParts.clear();
    const summary = parts
      .filter(
        (p) =>
          p.type === "reasoning" &&
          p.reasoning?.text !== undefined &&
          p.reasoning.text !== "",
      )
      .map((p) => ({ type: "summary_text", text: p.reasoning!.text! }));
    const packed = packEnvelope({
      v: 1,
      reasoning: parts,
      signatures: pendingSigs.splice(0),
    });
    if (packed === undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "responses",
          code: "reasoning_dropped",
          path: "envelope_too_large",
        },
        "Dropping reasoning envelope over the 1 MiB cap",
      );
    }
    const item = {
      id: itemId,
      type: "reasoning",
      summary,
      ...(packed !== undefined && { encrypted_content: packed }),
    };
    emittedItems.push(item);
    return (
      (partOpen
        ? emit("response.reasoning_summary_text.done", {
            item_id: itemId,
            output_index: outputIndex,
            summary_index: summaryIndex,
            text: partText,
          }) +
          emit("response.reasoning_summary_part.done", {
            item_id: itemId,
            output_index: outputIndex,
            summary_index: summaryIndex,
            part: { type: "summary_text", text: partText },
          })
        : "") +
      emit("response.output_item.done", { output_index: outputIndex, item })
    );
  }

  /** A signature-only envelope item, for signatures collected after
   *  the reasoning group closed (call/text signatures). */
  function emitPendingSigs(): string {
    if (pendingSigs.length === 0) return "";
    const itemId = `rs_${nextItemSeq++}`;
    const outputIndex = nextOutputIndex++;
    const packed = packEnvelope({
      v: 1,
      reasoning: [],
      signatures: pendingSigs.splice(0),
    });
    if (packed === undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "responses",
          code: "reasoning_dropped",
          path: "envelope_too_large",
        },
        "Dropping reasoning envelope over the 1 MiB cap",
      );
    }
    const item = {
      id: itemId,
      type: "reasoning",
      summary: [],
      ...(packed !== undefined && { encrypted_content: packed }),
    };
    emittedItems.push(item);
    return (
      emit("response.output_item.added", {
        output_index: outputIndex,
        item,
      }) +
      emit("response.output_item.done", { output_index: outputIndex, item })
    );
  }

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

  /** Serialize one buffered call as a complete call item. */
  function emitCall(call: EncodeCall): string {
    const itemId = `fc_${nextItemSeq++}`;
    const outputIndex = nextOutputIndex++;
    if (call.custom === true) {
      // `custom_tool_call` + `response.custom_tool_call_input.delta`/
      // `.done` — event names per
      // https://platform.openai.com/docs/api-reference/responses-streaming
      // and the openai 7.30.1 SDK typings (v1.4 spec §3.6).
      const openItem = {
        id: itemId,
        type: "custom_tool_call",
        call_id: call.id,
        name: call.name,
        // `namespace` rides custom_tool_call too
        // (recording-responses-lite.jsonl).
        ...(call.namespace !== undefined && { namespace: call.namespace }),
        input: "",
        status: "in_progress",
      };
      const doneItem = { ...openItem, input: call.args, status: "completed" };
      emittedItems.push(doneItem);
      return (
        closeText() +
        emitPendingSigs() +
        emit("response.output_item.added", {
          output_index: outputIndex,
          item: openItem,
        }) +
        (call.args !== ""
          ? emit("response.custom_tool_call_input.delta", {
              item_id: itemId,
              output_index: outputIndex,
              delta: call.args,
            })
          : "") +
        emit("response.custom_tool_call_input.done", {
          item_id: itemId,
          output_index: outputIndex,
          input: call.args,
        }) +
        emit("response.output_item.done", {
          output_index: outputIndex,
          item: doneItem,
        })
      );
    }
    const openItem = {
      id: itemId,
      type: "function_call",
      call_id: call.id,
      name: call.name,
      // Codex's explicit `namespace` field on the call —
      // codex-rs/core/src/tools/router.rs reads it at 0.169.0.
      ...(call.namespace !== undefined && { namespace: call.namespace }),
      arguments: "",
      status: "in_progress",
    };
    const doneItem = { ...openItem, arguments: call.args, status: "completed" };
    emittedItems.push(doneItem);
    return (
      closeText() +
      emitPendingSigs() +
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
      // A reasoning item stays open across reasoning_* events; the
      // first other event closes it (spec §3.3: reasoning precedes
      // the content it explains).
      const prefix =
        event.type === "reasoning_start" ||
        event.type === "reasoning_delta" ||
        event.type === "reasoning_signature"
          ? ""
          : closeReasoning();
      switch (event.type) {
        case "reasoning_start": {
          // One summary part per reasoning block, all inside the
          // group item (Task 8 event chain per the streaming
          // reference).
          reasoningParts.set(event.index, {
            type: "reasoning",
            reasoning: {
              ...(event.redacted === true
                ? { redacted: true }
                : { text: "" }),
              origin: event.origin,
            },
          });
          let out = "";
          if (reasoningItem === undefined) {
            const itemId = `rs_${nextItemSeq++}`;
            const outputIndex = nextOutputIndex++;
            reasoningItem = {
              itemId,
              outputIndex,
              summaryIndex: 0,
              partOpen: false,
              partText: "",
            };
            out = emit("response.output_item.added", {
              output_index: outputIndex,
              item: { id: itemId, type: "reasoning", summary: [] },
            });
          } else if (reasoningItem.partOpen) {
            const { itemId, outputIndex, summaryIndex, partText } =
              reasoningItem;
            reasoningItem.summaryIndex += 1;
            out =
              emit("response.reasoning_summary_text.done", {
                item_id: itemId,
                output_index: outputIndex,
                summary_index: summaryIndex,
                text: partText,
              }) +
              emit("response.reasoning_summary_part.done", {
                item_id: itemId,
                output_index: outputIndex,
                summary_index: summaryIndex,
                part: { type: "summary_text", text: partText },
              });
          }
          const { itemId, outputIndex, summaryIndex } = reasoningItem;
          reasoningItem.partOpen = true;
          reasoningItem.partText = "";
          return (
            out +
            emit("response.reasoning_summary_part.added", {
              item_id: itemId,
              output_index: outputIndex,
              summary_index: summaryIndex,
              part: { type: "summary_text", text: "" },
            })
          );
        }
        case "reasoning_delta": {
          const part = reasoningParts.get(event.index);
          if (part?.reasoning !== undefined && reasoningItem !== undefined) {
            part.reasoning.text = (part.reasoning.text ?? "") + event.text;
            reasoningItem.partText += event.text;
            const { itemId, outputIndex, summaryIndex } = reasoningItem;
            return emit("response.reasoning_summary_text.delta", {
              item_id: itemId,
              output_index: outputIndex,
              summary_index: summaryIndex,
              delta: event.text,
            });
          }
          return "";
        }
        case "reasoning_signature": {
          const part = reasoningParts.get(event.index);
          if (part !== undefined) part.signature = event.signature;
          return "";
        }
        case "text_signature":
          // Task 7a part signature — into the next envelope's
          // signatures (spec §3.3); the index counts the text parts
          // signed so far.
          pendingSigs.push({
            textIndex: textPartIndex++,
            signature: event.signature,
          });
          return prefix;
        case "message_start":
          responseId = event.id;
          return (
            prefix +
            emit("response.created", { response: responseSkeleton() }) +
            emit("response.in_progress", { response: responseSkeleton() })
          );
        case "text_delta": {
          if (event.text === "") return prefix;
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
            prefix +
            open +
            emit("response.output_text.delta", {
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              delta: event.text,
            })
          );
        }
        case "tool_call_start":
          calls.set(event.index, {
            id: event.id,
            name: event.name,
            ...(event.namespace !== undefined && {
              namespace: event.namespace,
            }),
            ...(event.custom !== undefined && { custom: event.custom }),
            args: "",
          });
          // A model-bound signature on the call (Gemini
          // thoughtSignature) — into the next envelope emitted, so a
          // reasoning item precedes the call it explains.
          if (event.signature !== undefined) {
            pendingSigs.push({
              toolCallId: event.id,
              signature: event.signature,
            });
          }
          return prefix;
        case "tool_call_delta": {
          const call = calls.get(event.index);
          if (call) call.args += event.argumentsDelta;
          return prefix;
        }
        case "tool_call_end": {
          const call = calls.get(event.index);
          if (!call) return prefix;
          calls.delete(event.index);
          completed.set(event.index, call);
          return prefix + flushCompleted();
        }
        case "usage":
          usage = event.usage;
          return prefix;
        case "message_end": {
          finished = true;
          switch (event.finishReason) {
            case "length":
            case "content_filter":
              return (
                prefix +
                closeText("incomplete") +
                emitPendingSigs() +
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
                prefix +
                closeText() +
                emitPendingSigs() +
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
                prefix +
                closeText() +
                emitPendingSigs() +
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
            prefix +
            closeText() +
            emitPendingSigs() +
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
