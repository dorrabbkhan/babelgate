import type {
  CanonicalFinishReason,
  CanonicalStreamEvent,
  CanonicalUsage,
  IdGenerator,
  StreamDecoder,
  StreamEncoder,
  StreamEncoderContext,
} from "../../types/canonical.types";
import type { OllamaChatRequest } from "../../types/ollama.types";
import { createIdGenerator } from "../../utils/ids";
import { makeCanonicalError } from "../../utils/canonical-error";
import { parseToolArguments } from "../../utils/tool-args";
import { createLineSplitter, createUtf8Decoder } from "../../utils/sse";
import { logger } from "../../utils/logger";
import { fromCanonicalError, toCanonicalError } from "./ollama.adapter";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

// `done_reason` on the wire is "stop" or "length" (docs.ollama.com/api/chat);
// anything else has no canonical equivalent.
const OLLAMA_DONE_REASON: Record<string, CanonicalFinishReason> = {
  stop: "stop",
  length: "length",
};

/**
 * Ollama NDJSON → canonical events (spec §3.3, docs.ollama.com/api/chat
 * and github.com/ollama/ollama docs/api.md "Chat request (Streaming)").
 * Each line is one complete chat response object: `message.content`
 * fragments become text deltas (empty content emits nothing, as does
 * `message.thinking`); `message.tool_calls` arrive whole — each call
 * (arguments already an object) becomes start + one delta +
 * end at sequential canonical indices, keeping the wire `id` when
 * present and drawing from `ids` otherwise. The first line emits
 * `message_start` with a generated id (Ollama has no message id). The
 * `done: true` line carries usage (`prompt_eval_count`, `eval_count`)
 * and `done_reason` — a stream that ended in tool calls reports
 * `tool_call` as Ollama itself means it, `length` maps to `length`.
 * `function.arguments` is normally an object (stringified into the
 * canonical delta); a string passes through verbatim. A mid-stream
 * `{"error":"…"}` line (docs.ollama.com/api/errors) maps
 * through `toCanonicalError` — the wire carries no status, so the same
 * failure returned pre-stream (HTTP 500 → `internal`) applies. A
 * line that isn't a plain object, or a `tool_calls` that isn't an
 * array, is an undecodable chunk — one `error` event and the stream
 * is finished. A stream ending without `done: true` ends in an
 * `error` event.
 */
export function createStreamDecoder(
  model: string,
  ids: IdGenerator = createIdGenerator(),
): StreamDecoder {
  const utf8 = createUtf8Decoder();
  const lines = createLineSplitter();
  let started = false;
  let finished = false;
  let nextIndex = 0;
  let sawToolCalls = false;

  function handleObject(obj: Obj, out: CanonicalStreamEvent[]): void {
    if (typeof obj.error === "string") {
      out.push({ type: "error", error: toCanonicalError(500, obj) });
      finished = true;
      return;
    }
    if (!started) {
      started = true;
      out.push({
        type: "message_start",
        id: ids(),
        model: typeof obj.model === "string" ? obj.model : model,
      });
    }
    const message = obj.message;
    if (
      typeof message?.content === "string" &&
      message.content.length > 0
    ) {
      out.push({ type: "text_delta", text: message.content });
    }
    const toolCalls = message?.tool_calls;
    if (toolCalls != null && !Array.isArray(toolCalls)) {
      failUndecodable(out);
      return;
    }
    for (const tc of toolCalls ?? []) {
      sawToolCalls = true;
      const index = nextIndex++;
      out.push({
        type: "tool_call_start",
        index,
        id: typeof tc?.id === "string" ? tc.id : ids(),
        name: tc?.function?.name ?? "",
      });
      // `arguments` is normally an object (JSON.stringify it); a string
      // is already the JSON encoding and passes through verbatim.
      const args = tc?.function?.arguments;
      out.push({
        type: "tool_call_delta",
        index,
        argumentsDelta:
          typeof args === "string" ? args : JSON.stringify(args ?? {}),
      });
      out.push({ type: "tool_call_end", index });
    }
    if (obj.done === true) {
      const input = obj.prompt_eval_count ?? 0;
      const output = obj.eval_count ?? 0;
      out.push({
        type: "usage",
        usage: {
          inputTokens: input,
          outputTokens: output,
          totalTokens: input + output,
        },
      });
      out.push({
        type: "message_end",
        finishReason: sawToolCalls
          ? "tool_call"
          : (OLLAMA_DONE_REASON[obj.done_reason as string] ?? "unknown"),
      });
      finished = true;
    }
  }

  function failUndecodable(out: CanonicalStreamEvent[]): void {
    out.push({
      type: "error",
      error: makeCanonicalError(
        "upstream",
        "Upstream sent an undecodable stream chunk",
      ),
    });
    finished = true;
  }

  function handleLine(line: string, out: CanonicalStreamEvent[]): void {
    if (finished) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      failUndecodable(out);
      return;
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      failUndecodable(out);
      return;
    }
    handleObject(obj as Obj, out);
  }

  function drain(completed: string[], out: CanonicalStreamEvent[]): void {
    for (const line of completed) handleLine(line, out);
  }

  return {
    feed(chunk) {
      const out: CanonicalStreamEvent[] = [];
      drain(lines.feed(utf8(chunk)), out);
      return out;
    },
    end() {
      const out: CanonicalStreamEvent[] = [];
      drain(lines.feed(utf8(new Uint8Array(0))), out);
      drain(lines.end(), out);
      if (!finished) {
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
 * Canonical events → Ollama NDJSON (spec §3.3, §3.4): `message_start`
 * produces nothing — Ollama opens its stream with the first content
 * line. Each `text_delta` is one `done:false` line; a tool call's
 * arguments are buffered by canonical `index` until `tool_call_end`
 * (§3.1 rule 5), then written as one `message.tool_calls` line with
 * the call `id` and `function.index` as recorded Ollama 0.40.11 sends
 * them and the parsed arguments object (or the `_invalid_arguments`
 * wrapper). `message_end` is the `done:true` line with `done_reason`
 * (canonical `tool_call` → "stop", which is what Ollama itself reports
 * for a tool-call answer) and the held usage counts; `error` is one
 * `{"error":"…"}` line. Calls still open when `message_end` arrives
 * flush in ascending canonical index as `message.tool_calls` lines
 * just before the `done:true` line (one `logger.warn` naming the
 * count); before `error` they are dropped — the error is terminal.
 * A `tool_call_delta`/`tool_call_end` for an index that never had
 * `tool_call_start` logs a warning instead of dropping silently.
 * `message_end` and `error` are terminal: any event after them
 * encodes to nothing.
 */
export function createStreamEncoder(
  ctx: StreamEncoderContext<OllamaChatRequest>,
): StreamEncoder {
  const createdAt = new Date().toISOString();
  let finished = false;
  let usage: CanonicalUsage | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const line = (obj: unknown): string => `${JSON.stringify(obj)}\n`;
  const chunk = (message: Obj): string =>
    line({
      model: ctx.requestedModel,
      created_at: createdAt,
      message,
      done: false,
    });
  const toolCallLine = (
    index: number,
    call: { id: string; name: string; args: string },
  ): string => {
    const parsed = parseToolArguments(call.args);
    if (!parsed.valid) {
      logger.warn(
        "Tool call arguments are not valid JSON; sending _invalid_arguments wrapper",
      );
    }
    return chunk({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: call.id,
          function: {
            index,
            name: call.name,
            arguments: parsed.args,
          },
        },
      ],
    });
  };
  const warnUnknownIndex = (type: string, index: number): void => {
    logger.warn(
      `Ollama stream encoder: ${type} for unknown tool-call index ${index}; dropping`,
    );
  };

  return {
    contentType: "application/x-ndjson",
    encode(event) {
      if (finished) return "";
      switch (event.type) {
        case "message_start":
          return "";
        case "text_delta":
          return chunk({
            role: "assistant",
            content: event.text,
          });
        case "reasoning_delta":
        case "reasoning_signature":
          // v1.4 §3.3: reasoning replay to this target lands in a
          // later task; reasoning a target can't take is dropped.
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
          if (call) {
            call.args += event.argumentsDelta;
          } else {
            warnUnknownIndex(event.type, event.index);
          }
          return "";
        }
        case "tool_call_end": {
          const call = calls.get(event.index);
          if (!call) {
            warnUnknownIndex(event.type, event.index);
            return "";
          }
          calls.delete(event.index);
          return toolCallLine(event.index, call);
        }
        case "usage":
          usage = event.usage;
          return "";
        case "message_end": {
          finished = true;
          let out = "";
          if (calls.size > 0) {
            logger.warn(
              `Ollama stream ended with ${calls.size} tool call(s) still open; flushing before done`,
            );
            const pending = [...calls.entries()].sort(
              ([a], [b]) => a - b,
            );
            calls.clear();
            for (const [index, call] of pending) {
              out += toolCallLine(index, call);
            }
          }
          out += line({
            model: ctx.requestedModel,
            created_at: createdAt,
            message: { role: "assistant", content: "" },
            done: true,
            done_reason:
              event.finishReason === "length" ? "length" : "stop",
            total_duration: 0,
            load_duration: 0,
            prompt_eval_count: usage?.inputTokens ?? 0,
            prompt_eval_duration: 0,
            eval_count: usage?.outputTokens ?? 0,
            eval_duration: 0,
          });
          return out;
        }
        case "error":
          finished = true;
          if (calls.size > 0) {
            logger.warn(
              `Ollama stream ended with ${calls.size} tool call(s) still open; dropping`,
            );
            calls.clear();
          }
          return line(fromCanonicalError(event.error));
      }
    },
    end() {
      return "";
    },
  };
}
