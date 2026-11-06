import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./sqlite";
import { newTrace, type RequestTrace } from "./trace";
import { startRetention } from "./retention";
import { createUsageStore, type UsageStore } from "./sinks/usage-store";
import { logger } from "../utils/logger";

/**
 * Retention (spec §3.4): rows older than USAGE_RETENTION_DAYS are
 * deleted, and their `bodies` rows go with them (ON DELETE CASCADE).
 * startRetention runs one pass at start, then every `everyMs`.
 */

function makeTrace(over: Partial<RequestTrace> = {}): RequestTrace {
  return {
    ...newTrace({
      requestId: "r1",
      startedAt: Date.now(),
      client: "other",
      sourceApi: "openai",
    }),
    requestedModel: "gpt-4",
    reason: "default",
    hops: [{ provider: "main", model: "m", outcome: "ok", ms: 5 }],
    winner: "main",
    status: "ok",
    httpStatus: 200,
    totalMs: 10,
    ...over,
  };
}

let dir: string;
let store: UsageStore;
const path = () => join(dir, "usage.db");

const bodiesCount = (p: string): number => {
  const db = openDatabase(p);
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM bodies").get() as { n: number }
  ).n;
  db.close();
  return n;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-retention-"));
});

afterEach(() => {
  store?.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("startRetention", () => {
  it("retention deletes old rows and their bodies", () => {
    store = createUsageStore({ path: path(), logBodies: true });
    const DAY = 86_400_000;
    const now = Date.now();
    const old = makeTrace({ requestId: "old", startedAt: now - 31 * DAY });
    old.bodies = { target: [{ value: { gone: true } }] };
    const fresh = makeTrace({ requestId: "fresh", startedAt: now });
    fresh.bodies = { target: [{ value: { kept: true } }] };
    store.accept(old);
    store.accept(fresh);
    store.flush();
    expect(bodiesCount(path())).toBe(2);

    const stop = startRetention(store, 30, 3_600_000);

    // The start pass removed the old row and cascaded its body.
    expect(store.getRequest("old")).toBeUndefined();
    expect(store.getRequest("fresh")).toBeDefined();
    expect(bodiesCount(path())).toBe(1);

    stop();

    // Interval passes keep pruning rows that age past the cutoff.
    vi.useFakeTimers();
    const stop2 = startRetention(store, 30, 60_000);
    const aged = makeTrace({
      requestId: "aged",
      startedAt: Date.now() - 31 * DAY,
    });
    store.accept(aged);
    store.flush();
    vi.advanceTimersByTime(60_000);
    expect(store.getRequest("aged")).toBeUndefined();
    stop2();
  });

  it("retention survives a failing prune", () => {
    vi.useFakeTimers();
    // A prune that throws every call (SQLITE_BUSY) must never escape
    // startRetention or a tick — it warns, throttled to once a minute.
    const failing = {
      pruneBefore: vi.fn((): void => {
        throw new Error("database is locked");
      }),
    };
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => logger);

    let stop: () => void = () => {};
    expect(() => {
      stop = startRetention(failing, 30, 1_000);
    }).not.toThrow();
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(failing.pruneBefore).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls[0])).toContain(
      "retention failed",
    );

    vi.advanceTimersByTime(60_000);
    expect(failing.pruneBefore).toHaveBeenCalledTimes(62);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(5_000);
    expect(failing.pruneBefore).toHaveBeenCalledTimes(62);
  });
});
