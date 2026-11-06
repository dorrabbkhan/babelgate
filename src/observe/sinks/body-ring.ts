import { getConfig } from "../../config/env-config";
import { registerSink, type TraceSink } from "../emit";
import type { BodySnapshots, RequestTrace } from "../trace";

/**
 * The §3.5 inspector ring (D3): the last `size` traces' body snapshots,
 * in memory only — nothing reaches disk (that is the usage-store sink's
 * LOG_BODIES job, Task 7). emitTrace hands this sink unstripped traces;
 * get() serves the /ui/api inspector (Task 12).
 */
export interface BodyRing extends TraceSink {
  get(id: string): BodySnapshots | undefined;
}

export function createBodyRing(size: number): BodyRing {
  // A Map iterates in insertion order — the first key is the oldest.
  const held = new Map<string, BodySnapshots>();
  return {
    name: "body-ring",
    accept(trace: RequestTrace) {
      if (trace.bodies === undefined) return;
      held.set(trace.requestId, trace.bodies);
      if (held.size > size) {
        held.delete(held.keys().next().value as string);
      }
    },
    get: (id) => held.get(id),
  };
}

let singleton: BodyRing | undefined;

/**
 * The process-wide ring, created on first use and registered as a
 * trace sink. `observe.inspectorBuffer` (env INSPECTOR_BUFFER, default
 * 50) is read per call: 0 disables body capture entirely and no ring
 * is created. A size change needs a restart — the singleton keeps the
 * size it was created with.
 */
export function getBodyRing(): BodyRing | undefined {
  const size = getConfig().observe.inspectorBuffer;
  if (size <= 0) return undefined;
  if (singleton === undefined) {
    singleton = createBodyRing(size);
    registerSink(singleton);
  }
  return singleton;
}
