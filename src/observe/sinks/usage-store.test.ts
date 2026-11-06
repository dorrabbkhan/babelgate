import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "../../config/env-config";
import { resetSinks } from "../emit";
import * as sqlite from "../sqlite";
import { startRetention } from "../retention";
import { newTrace, type RequestTrace } from "../trace";
import { logger } from "../../utils/logger";
import {
  createUsageStore,
  getUsageStore,
  resetUsageStore,
} from "./usage-store";

/**
 * The usage store (spec §3.4): one row per finished chat trace,
 * queued and flushed every 250 ms or at 100 rows in one transaction;
 * a `schema_version` table drives forward-only migrations. SQLite is
 * real here — `:memory:` and temp dirs, never mocked. Review Focus 2
 * ("app answers chat 200") is exercised end-to-end in
 * tests/integration/observe.test.ts.
 */

function makeTrace(over: Partial<RequestTrace> = {}): RequestTrace {
  return {
    ...newTrace({
      requestId: "r1",
      startedAt: 1_000,
      client: "claude-code",
      sourceApi: "openai",
    }),
    userAgent: "claude-cli/2.1.3",
    requestedModel: "gpt-4",
    reason: "default",
    hops: [{ provider: "main", model: "m", outcome: "ok", ms: 5 }],
    winner: "main",
    stream: true,
    status: "ok",
    httpStatus: 200,
    errorType: undefined,
    inputTokens: 10,
    outputTokens: 8,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    costUsd: 0.005,
    costEstimated: true,
    priceSource: "bundled",
    ttfbMs: 7,
    totalMs: 42,
    finishReason: "stop",
    notes: [
      {
        stage: "decode",
        adapter: "openai",
        code: "thinking_dropped",
        path: "messages[0]",
      },
    ],
    diagnostics: [],
    repairs: [],
    ...over,
  };
}

let dir: string;
const dbPath = () => join(dir, "usage.db");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-usage-"));
});

afterEach(() => {
  resetUsageStore();
  resetSinks();
  resetConfig();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("createUsageStore", () => {
  it("row per trace with every column", () => {
    const store = createUsageStore({
      path: dbPath(),
      logBodies: false,
    });
    const trace = makeTrace({ requestId: "row-1" });
    trace.bodies = { target: [{ value: { should: "not persist" } }] };
    store.accept(trace);
    store.flush();

    const row = store.getRequest("row-1");
    expect(row).toStrictEqual({
      id: "row-1",
      startedAt: 1_000,
      client: "claude-code",
      userAgent: "claude-cli/2.1.3",
      sourceApi: "openai",
      requestedModel: "gpt-4",
      routeReason: "default",
      provider: "main",
      model: "m",
      stream: true,
      status: "ok",
      httpStatus: 200,
      errorType: null,
      inputTokens: 10,
      outputTokens: 8,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      costUsd: 0.005,
      wouldCostUsd: null,
      costEstimated: true,
      priceSource: "bundled",
      ttfbMs: 7,
      totalMs: 42,
      finishReason: "stop",
      hops: [{ provider: "main", model: "m", outcome: "ok", ms: 5 }],
      notes: [
        {
          stage: "decode",
          adapter: "openai",
          code: "thinking_dropped",
          path: "messages[0]",
        },
      ],
      diagnostics: [],
      repairs: [],
    });
    store.close();
  });

  it("batched flush at 100 rows or 250 ms", () => {
    vi.useFakeTimers();
    const store = createUsageStore({
      path: dbPath(),
      logBodies: false,
    });

    for (let i = 0; i < 99; i++) {
      store.accept(makeTrace({ requestId: `t${i}` }));
    }
    vi.advanceTimersByTime(249);
    expect(store.listRequests({ limit: 200 }).rows).toHaveLength(0);

    // The 100th queued row flushes the batch immediately.
    store.accept(makeTrace({ requestId: "t99" }));
    expect(store.listRequests({ limit: 200 }).rows).toHaveLength(100);

    // Below the row cap the 250 ms timer flushes.
    store.accept(makeTrace({ requestId: "t100" }));
    vi.advanceTimersByTime(250);
    expect(store.listRequests({ limit: 200 }).rows).toHaveLength(101);
    store.close();
  });

  it("bodies only with logBodies", () => {
    const trace = makeTrace({ requestId: "with-bodies" });
    trace.bodies = { target: [{ value: { model: "m" } }] };

    const off = createUsageStore({
      path: join(dir, "off.db"),
      logBodies: false,
    });
    off.accept(trace);
    off.flush();
    expect(off.getRequest("with-bodies")?.bodies).toBeUndefined();
    off.close();

    const on = createUsageStore({
      path: join(dir, "on.db"),
      logBodies: true,
    });
    on.accept(trace);
    on.flush();
    expect(on.getRequest("with-bodies")?.bodies).toStrictEqual({
      target: [{ value: { model: "m" } }],
    });
    on.close();
  });

  it("migration from an empty file creates schema v1", () => {
    const path = dbPath();
    writeFileSync(path, ""); // an empty file is a valid empty db
    const store = createUsageStore({ path, logBodies: false });
    store.accept(makeTrace({ requestId: "m1" }));
    store.flush();
    store.close();

    // A second connection sees the committed schema and row.
    const db = sqlite.openDatabase(path);
    const version = db
      .prepare("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v: number };
    expect(version.v).toBe(1);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["requests", "bodies", "schema_version"]),
    );
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM requests").get() as {
        n: number;
      }).n,
    ).toBe(1);
    db.close();
  });

  it("list is newest first and cursor-paged", () => {
    const store = createUsageStore({ path: dbPath(), logBodies: false });
    for (let i = 0; i < 5; i++) {
      store.accept(
        makeTrace({ requestId: `p${i}`, startedAt: 1_000 + i * 1_000 }),
      );
    }
    store.flush();

    const page1 = store.listRequests({ limit: 2 });
    expect(page1.rows.map((r) => r.id)).toEqual(["p4", "p3"]);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2 = store.listRequests({ limit: 2, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.id)).toEqual(["p2", "p1"]);
    expect(page2.nextCursor).toEqual(expect.any(String));

    const page3 = store.listRequests({ limit: 2, cursor: page2.nextCursor });
    expect(page3.rows.map((r) => r.id)).toEqual(["p0"]);
    expect(page3.nextCursor).toBeUndefined();

    // Filters compose with the cursor.
    store.accept(
      makeTrace({
        requestId: "other",
        startedAt: 9_000,
        client: "other",
        status: "error",
        httpStatus: 500,
      }),
    );
    store.flush();
    const errors = store.listRequests({ limit: 10, status: "error" });
    expect(errors.rows.map((r) => r.id)).toEqual(["other"]);
    const byClient = store.listRequests({ limit: 10, client: "claude-code" });
    expect(byClient.rows).toHaveLength(5);
    const byModel = store.listRequests({ limit: 10, model: "m" });
    expect(byModel.rows).toHaveLength(6);
    const byProvider = store.listRequests({ limit: 10, provider: "none" });
    expect(byProvider.rows).toHaveLength(0);
    store.close();
  });

  it("usage groups by day/model/provider/client", () => {
    const store = createUsageStore({ path: dbPath(), logBodies: false });
    const day1 = Date.UTC(2026, 10, 5, 12);
    const day2 = Date.UTC(2026, 10, 6, 12);
    store.accept(
      makeTrace({
        requestId: "a",
        startedAt: day1,
        client: "claude-code",
        winner: "main",
        hops: [{ provider: "main", model: "m1", outcome: "ok", ms: 5 }],
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        costUsd: 1.5,
        status: "ok",
      }),
    );
    store.accept(
      makeTrace({
        requestId: "b",
        startedAt: day1 + 1_000,
        client: "codex",
        winner: "second",
        hops: [
          { provider: "main", model: "m1", outcome: "http_error", ms: 3 },
          { provider: "second", model: "m2", outcome: "ok", ms: 9 },
        ],
        inputTokens: 200,
        outputTokens: 20,
        costUsd: null,
        status: "ok",
      }),
    );
    store.accept(
      makeTrace({
        requestId: "c",
        startedAt: day2,
        client: "codex",
        winner: undefined,
        hops: [{ provider: "main", model: "m1", outcome: "transport", ms: 2 }],
        inputTokens: undefined,
        outputTokens: undefined,
        costUsd: null,
        status: "error",
        httpStatus: 502,
        errorType: "upstream",
      }),
    );
    store.flush();

    const from = day1 - 1_000;
    const to = day2 + 86_400_000;

    const byDay = store.usage({ from, to, group: "day" });
    expect(byDay).toHaveLength(2);
    expect(byDay[0].key).toBe("2026-11-05");
    expect(byDay[1].key).toBe("2026-11-06");
    expect(byDay[0]).toMatchObject({
      requests: 2,
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 24,
      cacheWriteTokens: 7,
      costUsd: 1.5,
      unpriced: 1,
      errors: 0,
      fallbacks: 1,
    });
    expect(byDay[1]).toMatchObject({
      requests: 1,
      inputTokens: 0,
      errors: 1,
      fallbacks: 0,
    });

    const byModel = store.usage({ from, to, group: "model" });
    expect(byModel).toHaveLength(3);
    const m1 = byModel.find((g) => g.key === "m1");
    const m2 = byModel.find((g) => g.key === "m2");
    const none = byModel.find((g) => g.key === "none");
    // "b" is grouped under m2 — the winning hop's model, not the
    // failed first hop's m1.
    expect(m1).toMatchObject({ requests: 1, inputTokens: 100 });
    expect(m2).toMatchObject({ requests: 1, inputTokens: 200 });
    expect(none).toMatchObject({ requests: 1, errors: 1 });

    const byProvider = store.usage({ from, to, group: "provider" });
    expect(byProvider.map((g) => g.key).sort()).toEqual([
      "main",
      "none",
      "second",
    ]);

    const byClient = store.usage({ from, to, group: "client" });
    expect(byClient).toHaveLength(2);
    expect(byClient.find((g) => g.key === "codex")).toMatchObject({
      requests: 2,
      errors: 1,
      fallbacks: 1,
    });
    store.close();
  });

  it("flush never throws", () => {
    // A transaction already open on the store's own connection makes
    // flush()'s own BEGIN fail — from the 250 ms timer or accept()
    // that throw would kill the process. The batch drops with the
    // usual warning instead.
    const openSpy = vi.spyOn(sqlite, "openDatabase");
    const store = createUsageStore({ path: dbPath(), logBodies: false });
    const db = openSpy.mock.results[0]
      ?.value as ReturnType<typeof sqlite.openDatabase>;
    db.exec("BEGIN");

    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => logger);
    store.accept(makeTrace({ requestId: "doomed" }));
    expect(() => store.flush()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: 1 }),
      expect.stringContaining("batch dropped"),
    );
    try {
      db.exec("ROLLBACK");
    } catch {
      // flush's catch already rolled the transaction back
    }
    store.close();
  });
});

describe("getUsageStore (singleton)", () => {
  const envFor = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    TARGET_API: "ollama",
    OLLAMA_API_BASE_URL: "http://localhost:11434",
    ...extra,
  });

  it("USAGE_STORE=off never loads node:sqlite", () => {
    process.env = envFor({ USAGE_STORE: "off" });
    resetConfig();
    const spy = vi.spyOn(sqlite, "openDatabase");
    expect(getUsageStore()).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unusable path disables the sink with one warning", () => {
    // A path whose parent is a regular file — mkdir fails.
    writeFileSync(join(dir, "a-file"), "x");
    process.env = envFor({ USAGE_DB: join(dir, "a-file", "usage.db") });
    resetConfig();
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => logger);
    expect(getUsageStore()).toBeUndefined();
    expect(getUsageStore()).toBeUndefined(); // disabled — never retried
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls[0])).toContain(
      join(dir, "a-file", "usage.db"),
    );
    expect(JSON.stringify(warnSpy.mock.calls[0])).toContain("USAGE_STORE");
  });

  it("a non-sqlite file at the path disables the sink", () => {
    const textDb = join(dir, "text.db");
    writeFileSync(textDb, "this is not sqlite");
    process.env = envFor({ USAGE_DB: textDb });
    resetConfig();
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => logger);
    expect(getUsageStore()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls[0])).toContain(textDb);
  });

  it("a locked db drops the batch after the busy timeout", () => {
    const locked = join(dir, "locked.db");
    const store = createUsageStore({ path: locked, logBodies: false });
    const holder = sqlite.openDatabase(locked);
    holder.exec("BEGIN EXCLUSIVE");

    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => logger);
    store.accept(makeTrace({ requestId: "dropped" }));
    store.flush();
    expect(store.listRequests({ limit: 10 }).rows).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    holder.exec("ROLLBACK");
    holder.close();

    // Once unlocked the same store keeps working.
    store.accept(makeTrace({ requestId: "after-lock" }));
    store.flush();
    expect(store.listRequests({ limit: 10 }).rows).toHaveLength(1);
    store.close();
  });

  it("a locked db never breaks retention", () => {
    const locked = join(dir, "retention-locked.db");
    const store = createUsageStore({ path: locked, logBodies: false });
    // A second connection holds an exclusive write lock with one row
    // written — the retention DELETE blocks and throws SQLITE_BUSY.
    const holder = sqlite.openDatabase(locked);
    holder.exec("BEGIN EXCLUSIVE");
    holder.exec(
      `INSERT INTO requests (
        id, started_at, client, source_api, requested_model, route_reason,
        stream, status, http_status, cost_estimated, total_ms,
        hops, notes, diagnostics, repairs
      ) VALUES (
        'holder-row', 1, 'claude-code', 'openai', 'gpt-4', 'default',
        0, 'ok', 200, 0, 1, '[]', '[]', '[]', '[]'
      )`,
    );

    vi.useFakeTimers();
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => logger);
    let stop: () => void = () => {};
    expect(() => {
      stop = startRetention(store, 30, 1_000);
    }).not.toThrow();
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    stop();
    holder.exec("ROLLBACK");
    holder.close();
    expect(() => store.close()).not.toThrow();
  });
});

describe("ExperimentalWarning filter", () => {
  it("no ExperimentalWarning printed", () => {
    // A real child-process start with the store on (default): opening
    // a DB runs on Node versions where node:sqlite still warns
    // (22.13–23.x). Whatever the version, ExperimentalWarning must
    // never reach stderr.
    const child = spawnSync(
      process.execPath,
      [
        "-r",
        "ts-node/register",
        "-e",
        `const { openDatabase } = require("./src/observe/sqlite");
         const db = openDatabase(":memory:");
         db.exec("CREATE TABLE t (a)");
         console.log("DB-OK");`,
      ],
      {
        cwd: join(__dirname, "..", "..", ".."),
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1" },
        encoding: "utf8",
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("DB-OK");
    expect(child.stderr).not.toContain("ExperimentalWarning");
  });
});
