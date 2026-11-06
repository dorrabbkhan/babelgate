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
 * §3.5: record a lossy-translation note — the debug line the call site
 * used to write, plus a structured TranslationNote on the ambient
 * trace. Notes carry codes and field paths, never content. Adapter
 * signatures do not change; outside a scope (unit tests, non-chat
 * paths) the note only reaches the debug log.
 */
export function recordNote(note: TranslationNote): void {
  logger.debug(
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
 * cap bytes as a string with `truncated: true` — the subarray cut is
 * byte-accurate, so a split multi-byte character ends as U+FFFD rather
 * than a lone surrogate. A string `response.wire` is upstream stream
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
  return {
    value: Buffer.from(text, "utf8").subarray(0, cap).toString("utf8"),
    truncated: true,
  };
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
