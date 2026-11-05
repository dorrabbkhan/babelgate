import type {
  CanonicalFinishReason,
  CanonicalStreamEvent,
  CanonicalUsage,
  IdGenerator,
  StreamDecoder,
  StreamEncoder,
  StreamEncoderContext,
} from "../../types/canonical.types";
import type { ChatCompletionRequest } from "../../types/openai.types";
import { createIdGenerator } from "../../utils/ids";
import { makeCanonicalError } from "../../utils/canonical-error";
import {
  createLineSplitter,
  createUtf8Decoder,
  formatSse,
} from "../../utils/sse";
import {
  fromCanonicalError,
  mapToOpenaiFinishReason,
  openaiUsageFromCanonical,
  openaiUsageToCanonical,
  toCanonicalError,
} from "./openai.adapter";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

const OPENAI_FINISH: Record<string, CanonicalFinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_call",
  function_call: "tool_call",
  content_filter: "content_filter",
};

/**
 * OpenAI SSE → canonical events (spec §3.3): every `data:` line carries a
 * complete chat.completion.chunk JSON payload, `data: [DONE]` ends the
 * stream. Lines are handled individually — the blank-line event
 * separators real OpenAI sends are just ignored, so recordings without
 * them decode identically. Tool calls are re-keyed from wire
 * `tool_calls[].index` to canonical indices in first-appearance order; a
 * call closes when the finish chunk arrives (or at end-of-stream). The
 * `choices: []` usage chunk is the usage event. A stream that ends
 * without `[DONE]` ends in an `error` event.
 */
export function createStreamDecoder(
  model: string,
  ids: IdGenerator = createIdGenerator(),
): StreamDecoder {
  const utf8 = createUtf8Decoder();
  const lines = createLineSplitter();
  let started = false;
  let finished = false;
  let finish: CanonicalFinishReason | undefined;
  let usage: CanonicalUsage | undefined;
  let nextIndex = 0;
  const callsByWire = new Map<number, number>();
  const openCalls: number[] = [];

  function closeAll(out: CanonicalStreamEvent[]): void {
    for (const index of openCalls.splice(0)) {
      out.push({ type: "tool_call_end", index });
    }
  }

  function handleChunk(chunk: Obj, out: CanonicalStreamEvent[]): void {
    if (chunk.error) {
      // In-stream error object (spec §3.3): ends the stream.
      out.push({ type: "error", error: toCanonicalError(502, chunk) });
      finished = true;
      return;
    }
    if (!started) {
      started = true;
      out.push({
        type: "message_start",
        id: typeof chunk.id === "string" ? chunk.id : ids(),
        model: typeof chunk.model === "string" ? chunk.model : model,
      });
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        out.push({ type: "text_delta", text: delta.content });
      }
      for (const tc of delta?.tool_calls ?? []) {
        const wireIndex = typeof tc.index === "number" ? tc.index : 0;
        let index = callsByWire.get(wireIndex);
        if (index === undefined) {
          index = nextIndex++;
          callsByWire.set(wireIndex, index);
          openCalls.push(index);
          out.push({
            type: "tool_call_start",
            index,
            id: typeof tc.id === "string" ? tc.id : ids(),
            name: tc.function?.name ?? "",
          });
        }
        if (
          typeof tc.function?.arguments === "string" &&
          tc.function.arguments.length > 0
        ) {
          out.push({
            type: "tool_call_delta",
            index,
            argumentsDelta: tc.function.arguments,
          });
        }
      }
      if (choice?.finish_reason && finish === undefined) {
        finish = OPENAI_FINISH[choice.finish_reason as string] ?? "unknown";
        closeAll(out);
      }
    }
    if (chunk.usage && usage === undefined) {
      usage = openaiUsageToCanonical(chunk.usage);
    }
  }

  function handleLine(line: string, out: CanonicalStreamEvent[]): void {
    if (finished || !line.startsWith("data:")) return;
    const data = line.slice(5).replace(/^ /, "");
    if (data === "[DONE]") {
      finished = true;
      closeAll(out);
      if (usage) out.push({ type: "usage", usage });
      out.push({ type: "message_end", finishReason: finish ?? "unknown" });
      return;
    }
    if (data === "") return;
    let chunk: Obj;
    try {
      chunk = JSON.parse(data) as Obj;
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
    handleChunk(chunk, out);
  }

  function drain(completed: string[], out: CanonicalStreamEvent[]) {
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
 * Canonical events → OpenAI SSE (spec §3.3): text deltas and tool-call
 * pieces become chat.completion.chunk data lines; a usage event becomes
 * the `choices: []` usage chunk, but only when the client asked for it
 * (`stream_options.include_usage`); an error event is a
 * `data: {"error":{…}}` line. `end()` writes `data: [DONE]`.
 */
export function createStreamEncoder(
  ctx: StreamEncoderContext<ChatCompletionRequest>,
): StreamEncoder {
  const includeUsage =
    ctx.sourceRequest.stream_options?.include_usage === true;
  const created = Math.floor(Date.now() / 1000);
  let id = "chatcmpl-babelgate";

  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ): string =>
    formatSse(
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: ctx.requestedModel,
        choices: [
          { index: 0, delta, logprobs: null, finish_reason: finishReason },
        ],
      }),
    );

  return {
    contentType: "text/event-stream",
    encode(event) {
      switch (event.type) {
        case "message_start":
          id = event.id;
          return chunk({ role: "assistant", content: "" });
        case "text_delta":
          return chunk({ content: event.text });
        case "tool_call_start":
          return chunk({
            tool_calls: [
              {
                index: event.index,
                id: event.id,
                type: "function",
                function: { name: event.name, arguments: "" },
              },
            ],
          });
        case "tool_call_delta":
          return chunk({
            tool_calls: [
              {
                index: event.index,
                function: { arguments: event.argumentsDelta },
              },
            ],
          });
        case "tool_call_end":
          return "";
        case "usage":
          if (!includeUsage) return "";
          return formatSse(
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: ctx.requestedModel,
              choices: [],
              usage: openaiUsageFromCanonical(event.usage),
            }),
          );
        case "message_end":
          return chunk({}, mapToOpenaiFinishReason(event.finishReason));
        case "error":
          return formatSse(JSON.stringify(fromCanonicalError(event.error)));
      }
    },
    end() {
      return formatSse("[DONE]");
    },
  };
}
