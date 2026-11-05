import type {
  CanonicalStreamEvent,
  CanonicalUsage,
  IdGenerator,
  StreamDecoder,
  StreamEncoder,
  StreamEncoderContext,
} from "../../types/canonical.types";
import type { GenerateContentRequest } from "../../types/gemini.types";
import { createIdGenerator } from "../../utils/ids";
import { makeCanonicalError } from "../../utils/canonical-error";
import { parseToolArguments } from "../../utils/tool-args";
import { createSseParser, createUtf8Decoder } from "../../utils/sse";
import { logger } from "../../utils/logger";
import {
  fromCanonicalError,
  geminiUsageFromCanonical,
  geminiUsageToCanonical,
  mapFinishReason,
  mapToGeminiFinishReason,
  toCanonicalError,
} from "./gemini.adapter";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Gemini `streamGenerateContent?alt=sse` → canonical events (spec §3.3,
 * ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
 * and the GenerateContentResponse/Candidate/FunctionCall/UsageMetadata
 * references there): each `data:` frame is a GenerateContentResponse.
 * The first frame emits `message_start` (`responseId` → id,
 * `modelVersion` → model). `candidates[0]` text parts become
 * `text_delta`s (empty strings — e.g. thoughtSignature-only parts —
 * emit nothing); `functionCall` parts arrive whole — each becomes
 * start + one delta (`JSON.stringify(args)`) + end at sequential
 * canonical indices, keeping the wire `id` when present and drawing
 * from `ids` otherwise. `usageMetadata` is cumulative on every frame —
 * the last one seen is emitted once as `usage` when a `finishReason`
 * ends the stream; a stream that ends in function calls reports
 * `tool_call`, `MAX_TOKENS` maps to `length` via `mapFinishReason`.
 * An `{"error":{code,message,status}}` frame maps through
 * `toCanonicalError` and ends the stream. A payload that parses as
 * JSON but isn't a plain object, or `candidates`/`parts` that aren't
 * arrays, is an undecodable chunk — one `error` event and the stream
 * is finished. A stream ending without `finishReason` ends in an
 * `error` event.
 */
export function createStreamDecoder(
  model: string,
  ids: IdGenerator = createIdGenerator(),
): StreamDecoder {
  const utf8 = createUtf8Decoder();
  const sse = createSseParser();
  let started = false;
  let finished = false;
  let nextIndex = 0;
  let sawToolCalls = false;
  let usage: Obj | undefined;

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

  function handleObject(obj: Obj, out: CanonicalStreamEvent[]): void {
    // An in-stream {"error":{code,message,status}} frame — the same
    // failure shape as a non-streaming error body.
    if (obj.error != null) {
      const code = typeof obj.error?.code === "number" ? obj.error.code : 500;
      out.push({ type: "error", error: toCanonicalError(code, obj) });
      finished = true;
      return;
    }
    if (
      obj.candidates != null &&
      (!Array.isArray(obj.candidates) ||
        obj.candidates.some((c: unknown) => !isObj(c)))
    ) {
      failUndecodable(out);
      return;
    }
    if (!started) {
      started = true;
      out.push({
        type: "message_start",
        id: typeof obj.responseId === "string" ? obj.responseId : ids(),
        model: typeof obj.modelVersion === "string" ? obj.modelVersion : model,
      });
    }
    // Single candidate (§2.2 — multiple candidates are out of scope),
    // matching toCanonicalResponse's candidates[0].
    const candidate = obj.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (
      parts != null &&
      (!Array.isArray(parts) || parts.some((p: unknown) => !isObj(p)))
    ) {
      failUndecodable(out);
      return;
    }
    for (const part of parts ?? []) {
      if (typeof part?.text === "string" && part.text.length > 0) {
        out.push({ type: "text_delta", text: part.text });
      }
      const fc = part?.functionCall;
      if (fc != null) {
        if (typeof fc !== "object") {
          failUndecodable(out);
          return;
        }
        sawToolCalls = true;
        const index = nextIndex++;
        out.push({
          type: "tool_call_start",
          index,
          id: typeof fc.id === "string" ? fc.id : ids(),
          name: typeof fc.name === "string" ? fc.name : "",
        });
        out.push({
          type: "tool_call_delta",
          index,
          argumentsDelta: JSON.stringify(fc.args ?? {}),
        });
        out.push({ type: "tool_call_end", index });
      }
    }
    // Cumulative token counts — the last frame's values win.
    if (obj.usageMetadata != null) usage = obj.usageMetadata;
    const finishReason = candidate?.finishReason;
    if (typeof finishReason === "string") {
      if (usage != null) {
        out.push({ type: "usage", usage: geminiUsageToCanonical(usage) });
      }
      out.push({
        type: "message_end",
        finishReason: sawToolCalls
          ? "tool_call"
          : mapFinishReason(finishReason),
      });
      finished = true;
    }
  }

  function handleEvent(data: string, out: CanonicalStreamEvent[]): void {
    if (finished) return;
    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch {
      failUndecodable(out);
      return;
    }
    if (!isObj(obj)) {
      failUndecodable(out);
      return;
    }
    handleObject(obj, out);
  }

  function drain(
    events: { event?: string; data: string }[],
    out: CanonicalStreamEvent[],
  ): void {
    for (const e of events) handleEvent(e.data, out);
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
        out.push({
          type: "error",
          error: makeCanonicalError(
            "upstream",
            "Upstream stream ended without completing",
          ),
        });
        finished = true;
      }
      return out;
    },
  };
}

/**
 * Canonical events → Gemini streamGenerateContent responses (spec §3.3,
 * §3.4): `ctx.query.alt === "sse"` selects `data: <response>\r\n\r\n`
 * frames (`text/event-stream`); anything else is the streamed JSON
 * array (`[`, elements separated by `,\r\n`, `]`) with content type
 * `application/json` — the `]` still closes after an error element so
 * the body stays valid JSON. `message_start` produces no element (the
 * wire has no start frame); its id is echoed as `responseId` and
 * `ctx.requestedModel` as `modelVersion` on every element. Each
 * `text_delta` is one single-part candidate element; tool calls are
 * buffered by canonical `index` until `tool_call_end`, then written as
 * one element whose part is `functionCall{name, args, id}` — `args`
 * via `parseToolArguments` (`{}` for empty, `_invalid_arguments`
 * wrapper for invalid), `id` preserved since FunctionCall.id is a
 * documented optional field. `usage` is held into the closing
 * element's `usageMetadata`, which also carries the `finishReason`
 * (`mapToGeminiFinishReason`). `error` becomes an
 * `{"error":{code,message,status}}` element via `fromCanonicalError`.
 * Calls still open at `message_end` flush in ascending canonical
 * index just before the final element (one `logger.warn` naming the
 * count); before `error` they are dropped. `message_end` and `error`
 * are terminal: any event after them encodes to nothing.
 */
export function createStreamEncoder(
  ctx: StreamEncoderContext<GenerateContentRequest>,
): StreamEncoder {
  const sse = ctx.query.alt === "sse";
  let finished = false;
  let arrayOpen = false;
  let arrayClosed = false;
  let responseId: string | undefined;
  let usage: CanonicalUsage | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  /** One wire element: SSE `data:` frame, or the next JSON-array element. */
  function element(obj: Obj): string {
    const json = JSON.stringify(obj);
    if (sse) return `data: ${json}\r\n\r\n`;
    const prefix = arrayOpen ? ",\r\n" : "[";
    arrayOpen = true;
    return prefix + json;
  }

  /** A GenerateContentResponse carrying one candidate. */
  function chunk(candidate: Obj): string {
    return element({
      candidates: [{ index: 0, ...candidate }],
      ...(responseId !== undefined && { responseId }),
      modelVersion: ctx.requestedModel,
    });
  }

  const toolCallChunk = (call: {
    id: string;
    name: string;
    args: string;
  }): string => {
    const parsed = parseToolArguments(call.args);
    if (!parsed.valid) {
      logger.warn(
        "Tool call arguments are not valid JSON; sending _invalid_arguments wrapper",
      );
    }
    return chunk({
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: call.id,
              name: call.name,
              args: parsed.args,
            },
          },
        ],
      },
    });
  };
  const warnUnknownIndex = (type: string, index: number): void => {
    logger.warn(
      `Gemini stream encoder: ${type} for unknown tool-call index ${index}; dropping`,
    );
  };

  return {
    contentType: sse ? "text/event-stream" : "application/json",
    encode(event) {
      if (finished) return "";
      switch (event.type) {
        case "message_start":
          responseId = event.id;
          return "";
        case "text_delta":
          return chunk({
            content: {
              role: "model",
              parts: [{ text: event.text }],
            },
          });
        case "tool_call_start":
          if (calls.has(event.index)) {
            logger.warn(
              `Gemini stream encoder: ${event.type} for already-open tool-call index ${event.index}; keeping the first call`,
            );
            return "";
          }
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
          return toolCallChunk(call);
        }
        case "usage":
          usage = event.usage;
          return "";
        case "message_end": {
          finished = true;
          let out = "";
          if (calls.size > 0) {
            logger.warn(
              `Gemini stream ended with ${calls.size} tool call(s) still open; flushing before finishReason`,
            );
            const pending = [...calls.entries()].sort(([a], [b]) => a - b);
            calls.clear();
            for (const [, call] of pending) out += toolCallChunk(call);
          }
          return (
            out +
            element({
              candidates: [
                {
                  index: 0,
                  content: { role: "model", parts: [] },
                  finishReason: mapToGeminiFinishReason(event.finishReason),
                },
              ],
              ...(usage !== undefined && {
                usageMetadata: geminiUsageFromCanonical(usage),
              }),
              ...(responseId !== undefined && { responseId }),
              modelVersion: ctx.requestedModel,
            })
          );
        }
        case "error":
          finished = true;
          if (calls.size > 0) {
            logger.warn(
              `Gemini stream ended with ${calls.size} tool call(s) still open; dropping`,
            );
            calls.clear();
          }
          return element(fromCanonicalError(event.error) as Obj);
      }
    },
    end() {
      if (sse || arrayClosed) return "";
      arrayClosed = true;
      return arrayOpen ? "]" : "[]";
    },
  };
}
