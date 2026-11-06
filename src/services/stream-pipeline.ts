import type {
  CanonicalError,
  CanonicalStreamEvent,
  StreamDecoder,
  StreamEncoder,
} from "../types/canonical.types";
import {
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

/**
 * upstream bytes → decoder → canonical events → encoder → client bytes
 * (spec §3.2). Provider-agnostic; the adapters own all dialect knowledge.
 *
 * Termination rules: an upstream read error, undecodable data or an idle
 * gap longer than `idleMs` ends the stream with the source dialect's
 * in-stream error form (kind `timeout` for idle, `upstream` otherwise) —
 * the client never sees a truncated message followed by silence. An
 * encoded `message_end` or `error` event is terminal: the encoder's tail
 * is written, the upstream read is cancelled and the pipe ends, even
 * when the upstream keeps its body open. Aborting `signal` cancels the
 * upstream read and ends the pipe quietly.
 */
export async function* runStreamPipeline(
  opts: StreamPipelineOptions,
): AsyncIterable<string> {
  const { upstream, decoder, encoder, idleMs, signal } = opts;
  const reader = upstream.getReader();

  // §3.5: tap the upstream bytes for the inspector ring — read-only,
  // capped a little past the snapshot limit so the wire snapshot can
  // mark `truncated`; a no-op unless the trace carries bodies.
  const wireUtf8 = createUtf8Decoder();
  let wireText = "";
  let wireCapped = false;

  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });

  /** Terminal events never produce empty output — the encoder writes the
   * provider's in-stream error form, then the stream ends. */
  function* fail(kind: CanonicalError["kind"], message: string) {
    yield encoder.encode({
      type: "error",
      error: makeCanonicalError(kind, message),
    });
    const tail = encoder.end();
    if (tail !== "") yield tail;
  }

  /** Yields encoded bytes; returns true at the first terminal event
   * (message_end or error — nothing may be encoded after it). */
  function* encodeAll(events: CanonicalStreamEvent[]) {
    for (const event of events) {
      const encoded = encoder.encode(event);
      if (encoded !== "") yield encoded;
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
        yield* encodeAll(events);
        const tail = encoder.end();
        if (tail !== "") yield tail;
        return;
      }

      if (!wireCapped) {
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
      if (yield* encodeAll(events)) {
        // Terminal event: end now even if the upstream keeps the body
        // open — nothing may follow message_end or error.
        const tail = encoder.end();
        if (tail !== "") yield tail;
        cancel();
        return;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    if (!wireCapped) wireText += wireUtf8(new Uint8Array(0));
    if (wireText !== "") snapshot("response.wire", wireText);
  }
}
