/**
 * Responses pass-through SSE relay (v1.4 spec §3.4): upstream bytes
 * → client bytes. SSE blocks are relayed at event boundaries; only
 * the five lifecycle events are JSON-parsed (to restore
 * `response.model`); everything else is verbatim. Split from
 * passthrough.ts (rule 7): this file owns the wire relay, that one
 * owns the routing decision, request body and trace.
 *
 * Wire-format sources (every event/field this file touches):
 *  - The Responses SSE event set (`response.created`,
 *    `response.in_progress`, `response.completed`,
 *    `response.incomplete`, `response.failed`, and the bare `error`
 *    event): https://platform.openai.com/docs/api-reference/responses-streaming
 *  - Codex's Responses parser, which reads the same event set and
 *    takes `type` from the `data:` payload (no `event:` lines) —
 *    `codex-rs/codex-api/src/sse/responses.rs` at 0.169.0 (E19).
 *  - The Response object inside each `response.*` event:
 *    https://platform.openai.com/docs/api-reference/responses/object
 */
import { toResponsesResponseObject } from "../transformers/adapters/responses.response";
import {
  currentTrace,
  snapshot,
  STREAM_WIRE_CAP_BYTES,
} from "../observe/context";
import { createUtf8Decoder, formatSse } from "../utils/sse";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

// ============ Response headers ============

/**
 * §3.4 header policy (recorded in docs/decisions.md): upstream
 * end-to-end headers are relayed to the client EXCEPT
 *  - hop-by-hop headers (RFC 7230 §6.1), including every field name
 *    the upstream's own `connection` header lists,
 *  - `content-length` — stale: the body length changes whenever a
 *    lifecycle `response.model` is restored,
 *  - `content-encoding` — fetch already decoded the body; forwarding
 *    it would have the client decode twice,
 *  - `content-type` — the stream descriptor carries it so the route
 *    can set it after the service headers.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function relayResponseHeaders(
  upstream: Record<string, string> | undefined,
): Record<string, string> {
  if (upstream === undefined) return {};
  const banned = new Set(HOP_BY_HOP);
  for (const token of (upstream.connection ?? "").split(",")) {
    const t = token.trim().toLowerCase();
    if (t !== "") banned.add(t);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstream)) {
    const lower = name.toLowerCase();
    if (
      banned.has(lower) ||
      lower === "content-length" ||
      lower === "content-encoding" ||
      lower === "content-type"
    ) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/**
 * What the relay learned while streaming — read by
 * finishPassthroughTrace. `terminal` is the reply's terminal
 * lifecycle event (`response.completed` / `.incomplete` / `.failed`,
 * per the streaming reference); `errorKind` is set when a bare
 * `error` SSE event was relayed or a failure was synthesized.
 */
export interface PassthroughObservation {
  terminal?: { type: string; response?: Obj };
  errorKind?: string;
}

/** The five lifecycle events whose `response.model` is restored
 *  (streaming reference; codex-rs `ResponseEvent` variants). */
const LIFECYCLE_EVENTS = new Set([
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

/** Terminal lifecycle events — the reply's final state. */
const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

interface RelayBlock {
  /** bytes sent downstream for this SSE block */
  text: string;
  /** the event's type when the block carried a Responses event */
  type?: string;
  /** the parsed `response` object of a lifecycle event */
  response?: Obj;
}

/**
 * One complete SSE block (terminated by the blank line), relayed
 * verbatim unless it is one of the five lifecycle events — then its
 * `data:` JSON is parsed, `response.model` set to the client's model
 * and the block re-rendered keeping every non-`data:` field line
 * (`event:`, `id:`, comments) in place. The event type comes from the
 * payload's `type`, the SSE `event:` line only when absent — the
 * same precedence Codex's parser uses (codex-rs 0.169.0). Unparseable
 * data and `data: [DONE]` are relayed untouched.
 */
function relayBlock(block: string, requestedModel: string): RelayBlock {
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let eventType: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return { text: block };

  let parsed: Obj;
  try {
    const p: unknown = JSON.parse(dataLines.join("\n"));
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      return { text: block };
    }
    parsed = p as Obj;
  } catch {
    // `data: [DONE]` and anything else that isn't JSON: verbatim.
    return { text: block };
  }

  const type = typeof parsed.type === "string" ? parsed.type : eventType;
  const response = parsed.response;
  if (
    type === undefined ||
    !LIFECYCLE_EVENTS.has(type) ||
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) {
    return { text: block, ...(type !== undefined && { type }) };
  }

  // A lifecycle event: `response.model` restored (object reference).
  (response as Obj).model = requestedModel;
  const kept = lines.filter(
    (l) =>
      l !== "" &&
      (l.indexOf(":") === -1 ? l : l.slice(0, l.indexOf(":"))) !== "data",
  );
  const text =
    (kept.length > 0 ? kept.join(eol) + eol : "") +
    `data: ${JSON.stringify(parsed)}${eol}${eol}`;
  return { text, type, response: response as Obj };
}

/**
 * The `response.failed` frame synthesized when the upstream stream
 * dies mid-flight without a terminal event — the same frame shape the
 * Responses encoder emits for a canonical error (streaming
 * reference; `toResponsesResponseObject` keeps the field set
 * identical to the bridged path's).
 */
function failedFrame(requestedModel: string, message: string): string {
  const response = toResponsesResponseObject({
    id: "resp_babelgate",
    createdAt: Math.floor(Date.now() / 1000),
    status: "failed",
    model: requestedModel,
    output: [],
    outputText: "",
    error: { code: "api_error", message },
    incompleteDetails: null,
    usage: null,
  });
  return formatSse(
    JSON.stringify({ type: "response.failed", response }),
    "response.failed",
  );
}

/**
 * Content-coded bodies: undici decompresses transparently yet keeps
 * the upstream `content-encoding` header, while an upstream reached
 * through a recorder or a bare socket may hand us still-compressed
 * bytes. When a header claims gzip/deflate, sniff the magic bytes:
 * still compressed → pipe through DecompressionStream; already
 * decoded → relay as-is. Without an encoding header the body is
 * relayed untouched.
 */
async function openReader(
  upstream: ReadableStream<Uint8Array>,
  headers: Record<string, string> | undefined,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const encoding = headers?.["content-encoding"]?.toLowerCase() ?? "";
  const format = encoding.includes("gzip")
    ? ("gzip" as const)
    : encoding.includes("deflate")
      ? ("deflate" as const)
      : undefined;
  const reader = upstream.getReader();
  if (format === undefined) return reader;

  const first = await reader.read().catch(() => ({
    done: true as const,
    value: undefined,
  }));
  if (first.done || first.value === undefined) return reader;
  const v = first.value;
  const compressed =
    format === "gzip"
      ? v[0] === 0x1f && v[1] === 0x8b
      : v[0] === 0x78;

  // Re-expose the consumed first chunk ahead of the remaining stream.
  const rest = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(v);
    },
    async pull(c) {
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value!);
    },
    async cancel() {
      await reader.cancel();
    },
  });
  if (!compressed) return rest.getReader();
  const gunzip =
    new DecompressionStream(format) as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
  return rest.pipeThrough(gunzip).getReader();
}

/**
 * upstream bytes → client bytes (§3.4): SSE blocks are relayed at
 * event boundaries; only the five lifecycle events are JSON-parsed
 * (to restore `response.model`); everything else is verbatim. The
 * relay buffers only up to an event boundary — a complete event in a
 * chunk goes out before the next upstream chunk is awaited.
 * Termination mirrors the canonical pipeline: a client abort ends
 * quietly, an idle gap or read error before a terminal event ends in
 * a synthesized `response.failed`, and after a terminal event the
 * upstream may keep the body open — the relay follows until close.
 * The wire tap is the same §3.5 `response.wire` snapshot the
 * canonical pipeline takes (a no-op when the ring is off).
 */
export async function* relayResponsesStream(opts: {
  upstream: ReadableStream<Uint8Array>;
  upstreamHeaders?: Record<string, string>;
  requestedModel: string;
  idleMs: number;
  signal: AbortSignal;
  observation: PassthroughObservation;
}): AsyncGenerator<string> {
  const {
    upstreamHeaders,
    requestedModel,
    idleMs,
    signal,
    observation,
  } = opts;
  const reader = await openReader(opts.upstream, upstreamHeaders);
  const utf8 = createUtf8Decoder();
  const wireUtf8 =
    currentTrace()?.bodies !== undefined ? createUtf8Decoder() : undefined;
  const tapWire = wireUtf8 !== undefined;
  let wireText = "";
  let wireCapped = false;
  let pending = "";

  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });

  const terminalSeen = () =>
    observation.terminal !== undefined || observation.errorKind !== undefined;

  function* drain(): Generator<string> {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(pending);
      if (boundary === null) return;
      const block = pending.slice(0, boundary.index + boundary[0].length);
      pending = pending.slice(boundary.index + boundary[0].length);
      const out = relayBlock(block, requestedModel);
      if (out.type === "error") {
        observation.errorKind = "upstream";
      } else if (out.type !== undefined && TERMINAL_EVENTS.has(out.type)) {
        observation.terminal = { type: out.type, response: out.response };
      }
      yield out.text;
    }
  }

  function* fail(kind: string, message: string): Generator<string> {
    observation.errorKind = kind;
    yield failedFrame(requestedModel, message);
  }

  try {
    for (;;) {
      if (signal.aborted) {
        cancel();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let chunk: ReadableStreamReadResult<Uint8Array> | "idle";
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<"idle">((resolve) => {
            timer = setTimeout(() => resolve("idle"), idleMs);
          }),
        ]);
      } catch {
        clearTimeout(timer);
        cancel();
        // A read failure after the terminal event still ends cleanly —
        // the reply already reached the client whole.
        if (!terminalSeen()) {
          yield* fail("upstream", "Upstream stream read failed");
        }
        return;
      }
      clearTimeout(timer);
      if (signal.aborted) {
        cancel();
        return;
      }

      if (chunk === "idle") {
        cancel();
        if (!terminalSeen()) {
          yield* fail(
            "timeout",
            `Upstream stream idle for over ${idleMs}ms`,
          );
        }
        return;
      }

      if (chunk.done) {
        pending += utf8(new Uint8Array(0));
        yield* drain();
        if (pending !== "") {
          yield pending;
          pending = "";
        }
        if (!terminalSeen()) {
          yield* fail(
            "upstream",
            "Upstream stream ended without a terminal event",
          );
        }
        return;
      }

      if (tapWire && !wireCapped) {
        wireText += wireUtf8(chunk.value);
        if (wireText.length > STREAM_WIRE_CAP_BYTES) wireCapped = true;
      }

      pending += utf8(chunk.value);
      yield* drain();
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    if (tapWire) {
      if (!wireCapped) wireText += wireUtf8(new Uint8Array(0));
      if (wireText !== "") snapshot("response.wire", wireText);
    }
  }
}
