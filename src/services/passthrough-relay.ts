/**
 * Pass-through SSE relay: upstream bytes → client bytes. SSE blocks
 * are relayed at event boundaries, verbatim except where the dialect
 * names a `model` holder — then that one object is JSON-parsed,
 * `model` set to the client's model, and the block re-rendered
 * keeping every non-`data:` field line (`event:`, `id:`, comments)
 * in place. The relay itself is dialect-neutral: what counts as a
 * lifecycle event, a terminal event and an in-stream error, plus the
 * synthesized failure frame, comes from a `RelayDialect` descriptor
 * (passthrough-dialects.ts holds the three dialects, one per
 * source format). This file also owns the upstream-header relay
 * policy and `PassthroughObservation`; passthrough.ts keeps the
 * routing decision, the request body and the trace finish.
 *
 * Observation: beside the wire-level `terminal`/`errorKind`, the
 * anthropic and openai dialects run the relayed bytes through the
 * source's own stream decoder — the canonical events that come out
 * (`observation.events`) give finishPassthroughTrace usage, finish
 * reason and tool calls without a second wire-format field map (the
 * same "pure observation" argument as responses's terminal.response
 * decode). The responses dialect needs none: its terminal event
 * already carries the whole Response object.
 */
import {
  currentTrace,
  snapshot,
  STREAM_WIRE_CAP_BYTES,
} from "../observe/context";
import type {
  CanonicalStreamEvent,
  StreamDecoder,
} from "../types/canonical.types";
import { createUtf8Decoder } from "../utils/sse";

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

// ============ Observation + dialect ============

/**
 * What the relay learned while streaming — read by
 * finishPassthroughTrace. `terminal` is the reply's terminal
 * wire event (`response.completed` / `.incomplete` / `.failed` on
 * responses, `message_stop` on anthropic, `[DONE]` on chat);
 * `errorKind` is set when an in-stream error frame was relayed or a
 * failure was synthesized. `events` is the anthropic/chat
 * observation channel: the canonical events the source dialect's
 * own decoder produced from the relayed bytes (absent on the
 * responses relay, which decodes `terminal.response` instead).
 */
export interface PassthroughObservation {
  terminal?: { type: string; response?: Obj };
  errorKind?: string;
  events?: CanonicalStreamEvent[];
}

/**
 * The wire-format knowledge one pass-through dialect contributes
 * (v1.5 spec §3.3). Everything the generic relay needs to classify
 * and rewrite SSE blocks without knowing the dialect itself.
 */
export interface RelayDialect {
  /**
   * The wire event type of a parsed `data:` JSON payload; the SSE
   * `event:` line is passed as the fallback for dialects that take
   * `type` from the payload first (all three do — Codex's
   * precedence). Undefined → the block relays verbatim and is
   * neither terminal nor an error.
   */
  eventType(parsed: Obj, sseEvent: string | undefined): string | undefined;
  /**
   * The wire event type of a `data:` payload that is not JSON —
   * Chat's `data: [DONE]` terminator. Undefined → verbatim,
   * unclassified.
   */
  rawDataType?(data: string): string | undefined;
  /**
   * The object inside `parsed` whose `model` is restored (the
   * lifecycle event's nested payload: `response` on responses,
   * `message` on anthropic's message_start, the chunk itself on
   * chat). Undefined → the block relays verbatim.
   */
  modelHolder?(type: string | undefined, parsed: Obj): Obj | undefined;
  /** Wire types that end a healthy reply. */
  terminal: ReadonlySet<string>;
  /** Wire types that mark the reply failed. */
  error: ReadonlySet<string>;
  /**
   * The failure frame synthesized in this dialect when the upstream
   * stream dies mid-flight without a terminal event — the same
   * shape the bridged encoder emits for a canonical error.
   */
  failedFrame(requestedModel: string, message: string): string;
  /**
   * The observation decoder for this dialect — the source adapter's
   * own stream decoder, fed every relayed byte so the trace reads
   * usage, finish reason and tool calls from `observation.events`.
   * Absent on responses: its terminal event already carries the
   * whole Response object.
   */
  createObserver?(model: string): StreamDecoder;
}

/** Options shared by every dialect's relay entry point. */
export interface RelayStreamOpts {
  upstream: ReadableStream<Uint8Array>;
  upstreamHeaders?: Record<string, string>;
  requestedModel: string;
  idleMs: number;
  signal: AbortSignal;
  observation: PassthroughObservation;
}

interface RelayBlock {
  /** bytes sent downstream for this SSE block */
  text: string;
  /** the event's wire type when the block carried one */
  type?: string;
  /** the parsed payload object a lifecycle event's model was restored in */
  response?: Obj;
}

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * One complete SSE block (terminated by the blank line), relayed
 * verbatim unless the dialect names a `model` holder in its `data:`
 * JSON — then the JSON is re-rendered with `model` set to the
 * client's model, keeping every non-`data:` field line in place.
 * Unparseable data is relayed untouched, classified only by the
 * dialect's `rawDataType` (Chat's `[DONE]`).
 */
function relayBlock(
  block: string,
  requestedModel: string,
  dialect: RelayDialect,
): RelayBlock {
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
    // `data: [DONE]` and anything else that isn't JSON: verbatim,
    // classified only through the dialect's raw-data hook.
    const type = dialect.rawDataType?.(dataLines.join("\n"));
    return type === undefined ? { text: block } : { text: block, type };
  }

  const type = dialect.eventType(parsed, eventType);
  const holder = dialect.modelHolder?.(type, parsed);
  if (holder === undefined || !isObj(holder)) {
    return { text: block, ...(type !== undefined && { type }) };
  }

  // A lifecycle event: `model` restored in the holder object.
  holder.model = requestedModel;
  const kept = lines.filter(
    (l) =>
      l !== "" &&
      (l.indexOf(":") === -1 ? l : l.slice(0, l.indexOf(":"))) !== "data",
  );
  const text =
    (kept.length > 0 ? kept.join(eol) + eol : "") +
    `data: ${JSON.stringify(parsed)}${eol}${eol}`;
  return { text, type, response: holder };
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
 * upstream bytes → client bytes (v1.4 §3.4, v1.5 §3.3): SSE blocks
 * are relayed at event boundaries; only blocks whose `data:` JSON
 * the dialect names a `model` holder for are parsed (so `model` can
 * be restored); everything else is verbatim. The relay buffers only
 * up to an event boundary — a complete event in a chunk goes out
 * before the next upstream chunk is awaited. Termination mirrors
 * the canonical pipeline: a client abort ends quietly, an idle gap
 * or read error before a terminal event ends in the dialect's
 * synthesized failure frame, and after a terminal event the
 * upstream may keep the body open — the relay follows until close.
 * The wire tap is the same §3.5 `response.wire` snapshot the
 * canonical pipeline takes (a no-op when the ring is off).
 */
export async function* relayUpstreamStream(
  opts: RelayStreamOpts,
  dialect: RelayDialect,
): AsyncGenerator<string> {
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

  // anthropic/chat: the source's own decoder observes the relayed
  // bytes — usage, finish reason and tool calls for the trace.
  const observer = dialect.createObserver?.(requestedModel);
  if (observer !== undefined) observation.events ??= [];

  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });

  const terminalSeen = () =>
    observation.terminal !== undefined || observation.errorKind !== undefined;

  function classify(out: RelayBlock): void {
    if (out.type !== undefined && dialect.error.has(out.type)) {
      observation.errorKind = "upstream";
    } else if (
      out.type !== undefined &&
      dialect.terminal.has(out.type)
    ) {
      observation.terminal = { type: out.type, response: out.response };
    }
  }

  function* drain(): Generator<string> {
    for (;;) {
      // A client abort stops the relay between blocks too — a
      // multi-event upstream chunk is not flushed whole after the
      // client is gone.
      if (signal.aborted) return;
      const boundary = /\r?\n\r?\n/.exec(pending);
      if (boundary === null) return;
      const block = pending.slice(0, boundary.index + boundary[0].length);
      pending = pending.slice(boundary.index + boundary[0].length);
      const out = relayBlock(block, requestedModel, dialect);
      classify(out);
      yield out.text;
    }
  }

  function* fail(kind: string, message: string): Generator<string> {
    observation.errorKind = kind;
    yield dialect.failedFrame(requestedModel, message);
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
        if (observer !== undefined) {
          observation.events!.push(...observer.end());
        }
        pending += utf8(new Uint8Array(0));
        yield* drain();
        if (pending !== "") {
          // The stream's last event may arrive without its blank-line
          // terminator (the anthropic/chat fixtures both end on a
          // bare `\n`): it is still a complete event — classify it,
          // since it may be the terminal one.
          const out = relayBlock(pending, requestedModel, dialect);
          classify(out);
          yield out.text;
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

      if (observer !== undefined) {
        observation.events!.push(...observer.feed(chunk.value));
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
