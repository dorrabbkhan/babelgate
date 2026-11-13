import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../utils/logger";
import type { BodySnapshot, RequestTrace, TranslationNote } from "./trace";

/**
 * The per-request trace scope (spec §3.1): observeMiddleware opens it
 * around the rest of the request, so the services, the adapters'
 * note hook (recordNote) and finishTrace all see the same trace
 * without threading it through every signature.
 */
const storage = new AsyncLocalStorage<RequestTrace>();

export function runWithTrace<T>(trace: RequestTrace, fn: () => T): T {
  return storage.run(trace, fn);
}

export function currentTrace(): RequestTrace | undefined {
  return storage.getStore();
}

/**
 * The current upstream attempt's identity (v1.4 spec §3.2): the
 * configured provider NAME and the upstream model it is serving. The
 * services wrap every attempt's encode, upstream call and decode —
 * fallback hops included — so adapters can tag reasoning parts and
 * signatures with the origin that produced them. Separate storage
 * from the trace scope: an attempt's context is per hop, the trace's
 * per request; nested scopes restore the outer one on return.
 */
export type AttemptContext = {
  providerName: string;
  upstreamModel: string;
};

const attemptStorage = new AsyncLocalStorage<AttemptContext>();

export function runWithAttempt<T>(ctx: AttemptContext, fn: () => T): T {
  return attemptStorage.run(ctx, fn);
}

export function currentAttempt(): AttemptContext | undefined {
  return attemptStorage.getStore();
}

/**
 * §3.5: record a lossy-translation note — the debug line the call site
 * used to write (`message`, verbatim), plus a structured
 * TranslationNote on the ambient trace. Notes carry codes and field
 * paths, never content. Adapter signatures do not change; outside a
 * scope (unit tests, non-chat paths) the note only reaches the debug
 * log.
 */
export function recordNote(note: TranslationNote, message?: string): void {
  logger.debug(
    message ??
      `Dropping "${note.path ?? note.code}" (${note.adapter} ${note.stage}: ${note.code})`,
  );
  currentTrace()?.notes.push(note);
}

export type SnapshotStage =
  | "source"
  | "canonical"
  | "target"
  | "response.canonical"
  | "response.wire";

/** §3.11 caps: 1 MB per snapshot, 256 KB for streamed wire bytes. */
const SNAPSHOT_CAP_BYTES = 1_048_576;
export const STREAM_WIRE_CAP_BYTES = 262_144;

/**
 * Serialized values over the stage's cap are replaced by the first
 * cap bytes as a string with `truncated: true`. The cut backs off to a
 * UTF-8 character boundary, so the snapshot never exceeds the cap and
 * never ends in U+FFFD. A string `response.wire` is upstream stream
 * text (256 KB cap); anything else serializes to JSON (1 MB cap).
 */
function capSnapshot(stage: SnapshotStage, value: unknown): BodySnapshot {
  const cap =
    stage === "response.wire" && typeof value === "string"
      ? STREAM_WIRE_CAP_BYTES
      : SNAPSHOT_CAP_BYTES;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text, "utf8") <= cap) {
    return { value };
  }
  const buf = Buffer.from(text, "utf8");
  let end = cap;
  // A continuation byte (10xxxxxx) means the cut splits a character —
  // back off to its lead byte so the decoded string stays ≤ cap bytes.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { value: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * §3.5: capture one pipeline stage's body into `trace.bodies` — a
 * no-op unless the trace carries a `bodies` object, which the proxy
 * service creates only when the inspector ring is enabled
 * (`INSPECTOR_BUFFER` ≠ 0). Headers are never captured.
 */
export function snapshot(stage: SnapshotStage, value: unknown): void {
  const bodies = currentTrace()?.bodies;
  if (bodies === undefined) return;
  const snap = capSnapshot(stage, value);
  switch (stage) {
    case "source":
      bodies.source = snap;
      break;
    case "canonical":
      bodies.canonical = snap;
      break;
    case "target":
      bodies.target.push(snap);
      break;
    case "response.canonical":
      (bodies.response ??= {}).canonical = snap;
      break;
    case "response.wire":
      (bodies.response ??= {}).wire = snap;
      break;
  }
}
