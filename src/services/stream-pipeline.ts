import type {
  CanonicalError,
  CanonicalStreamEvent,
  StreamDecoder,
  StreamEncoder,
} from "../types/canonical.types";
import {
  currentTrace,
  snapshot,
  STREAM_WIRE_CAP_BYTES,
} from "../observe/context";
import { makeCanonicalError } from "../utils/canonical-error";
import { createUtf8Decoder } from "../utils/sse";

export interface StreamPipelineOptions {
  /** The upstream response body — bytes as they arrive off the socket */
  upstream: ReadableStream<Uint8Array>;
  /** Target provider: upstream bytes → canonical events */
  decoder: StreamDecoder;
  /** Source provider: canonical events → client wire bytes */
  encoder: StreamEncoder;
  /** Longest allowed gap between upstream chunks (UPSTREAM_STREAM_IDLE_MS) */
  idleMs: number;
  /** Client disconnect — stops the pipe and cancels the upstream read */
  signal: AbortSignal;
}

/** The pipeline without a client dialect — the playground's shape. */
export type CanonicalPipelineOptions = Omit<
  StreamPipelineOptions,
  "encoder"
>;

/**
 * upstream bytes → decoder → canonical events (spec §3.2). The read,
 * idle-watch and wire-tap half of the streaming pipeline — the part a
 * consumer without a source dialect (the /ui playground) drives
 * directly.
 *
 * Termination rules: an upstream read error, undecodable data or an
 * idle gap longer than `idleMs` ends the stream with a canonical
 * `error` event (kind `timeout` for idle, `upstream` otherwise) — the
 * consumer never sees a truncated message followed by silence. A
 * `message_end` or `error` event is terminal: nothing is yielded
 * after it and the upstream read is cancelled, even when the upstream
 * keeps its body open. Aborting `signal` cancels the upstream read
 * and ends the stream quietly — no error event.
 */
export async function* streamCanonicalEvents(
  opts: CanonicalPipelineOptions,
): AsyncGenerator<CanonicalStreamEvent> {
  const { upstream, decoder, idleMs, signal } = opts;
  const reader = upstream.getReader();

  // §3.5: tap the upstream bytes for the inspector ring — read-only,
  // capped a little past the snapshot limit so the wire snapshot can
  // mark `truncated`. Decided once at pipeline start: no trace bodies
  // (ring off, INSPECTOR_BUFFER=0) → no decoder, no accumulation, no
  // snapshot — the tap does zero work.
  const wireUtf8 =
    currentTrace()?.bodies !== undefined ? createUtf8Decoder() : undefined;
  const tapWire = wireUtf8 !== undefined;
  let wireText = "";
  let wireCapped = false;

  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });

  /** Terminal failure — one canonical error event, then the stream ends. */
  function* fail(kind: CanonicalError["kind"], message: string) {
    yield {
      type: "error" as const,
      error: makeCanonicalError(kind, message),
    };
  }

  /** Yields events; returns true at the first terminal one
   * (message_end or error — nothing may follow it). */
  function* yieldAll(events: CanonicalStreamEvent[]) {
    for (const event of events) {
      yield event;
      if (event.type === "message_end" || event.type === "error") {
        return true;
      }
    }
    return false;
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
        yield* fail("upstream", "Upstream stream read failed");
        return;
      }
      clearTimeout(timer);

      if (signal.aborted) {
        cancel();
        return;
      }

      if (chunk === "idle") {
        cancel();
        yield* fail(
          "timeout",
          `Upstream stream idle for over ${idleMs}ms`,
        );
        return;
      }

      let events: CanonicalStreamEvent[];
      if (chunk.done) {
        try {
          events = decoder.end();
        } catch {
          yield* fail("upstream", "Upstream sent a malformed stream");
          return;
        }
        yield* yieldAll(events);
        return;
      }

      if (tapWire && !wireCapped) {
        wireText += wireUtf8(chunk.value);
        if (wireText.length > STREAM_WIRE_CAP_BYTES) wireCapped = true;
      }

      try {
        events = decoder.feed(chunk.value);
      } catch {
        cancel();
        yield* fail("upstream", "Upstream sent undecodable stream data");
        return;
      }
      if (yield* yieldAll(events)) {
        // Terminal event: end now even if the upstream keeps the body
        // open — nothing may follow message_end or error.
        cancel();
        return;
      }
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

/**
 * upstream bytes → decoder → canonical events → encoder → client bytes
 * (spec §3.2). Provider-agnostic; the adapters own all dialect knowledge.
 * A thin encoder over streamCanonicalEvents: the terminal event's bytes
 * are followed by the encoder's tail; an aborted stream ends quietly —
 * no tail, as before.
 */
export async function* runStreamPipeline(
  opts: StreamPipelineOptions,
): AsyncIterable<string> {
  const { encoder, signal } = opts;
  for await (const event of streamCanonicalEvents(opts)) {
    const encoded = encoder.encode(event);
    if (encoded !== "") yield encoded;
    if (event.type === "message_end" || event.type === "error") {
      break;
    }
  }
  if (!signal.aborted) {
    const tail = encoder.end();
    if (tail !== "") yield tail;
  }
}
