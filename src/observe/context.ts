import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestTrace } from "./trace";

/**
 * The per-request trace scope (spec §3.1): observeMiddleware opens it
 * around the rest of the request, so the services, the adapters'
 * note hook (Task 6) and finishTrace all see the same trace without
 * threading it through every signature.
 */
const storage = new AsyncLocalStorage<RequestTrace>();

export function runWithTrace<T>(trace: RequestTrace, fn: () => T): T {
  return storage.run(trace, fn);
}

export function currentTrace(): RequestTrace | undefined {
  return storage.getStore();
}
