import type { DatabaseSync } from "node:sqlite";
import { getConfig } from "../../config/env-config";
import type { Hop } from "../../routing/route-log";
import { logger } from "../../utils/logger";
import { registerSink, type TraceSink } from "../emit";
import { startRetention } from "../retention";
import { openDatabase } from "../sqlite";
import type { RequestTrace } from "../trace";
import {
  createUsageQueries,
  type UsageQueries,
} from "./usage-queries";

/**
 * The usage store (spec §3.4, D4): one `requests` row per finished
 * chat trace, queued and flushed every 250 ms or at 100 rows in one
 * transaction — and on shutdown (close()). `bodies` rows are written
 * only with LOG_BODIES=true; every column is routing/usage data or a
 * code — never prompt text, completions, tool arguments or keys.
 *
 * The DB is the spec §3.4 schema at `schema_version` 1; migrations are
 * forward-only. A store that cannot be opened or migrated disables
 * itself (getUsageStore returns undefined) — a sink never affects a
 * response. The read path lives in usage-queries.ts.
 */

export type { RequestRow, UsageGroup, UsageQueries } from "./usage-queries";

export interface UsageStore extends TraceSink, UsageQueries {
  flush(): void;
  close(): void;
  /** Retention hook: delete rows older than `cutoffMs` (bodies cascade). */
  pruneBefore(cutoffMs: number): void;
}

const FLUSH_MS = 250;
const FLUSH_ROWS = 100;
/** Flush failures warn at most once a minute. */
const WARN_THROTTLE_MS = 60_000;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE requests (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, client TEXT NOT NULL, user_agent TEXT,
  source_api TEXT NOT NULL, requested_model TEXT NOT NULL, route_reason TEXT NOT NULL,
  provider TEXT, model TEXT, stream INTEGER NOT NULL,
  status TEXT NOT NULL, http_status INTEGER NOT NULL, error_type TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd REAL, would_cost_usd REAL, cost_estimated INTEGER NOT NULL, price_source TEXT,
  ttfb_ms INTEGER, total_ms INTEGER NOT NULL, finish_reason TEXT,
  hops TEXT NOT NULL, notes TEXT NOT NULL, diagnostics TEXT NOT NULL, repairs TEXT NOT NULL
);
CREATE INDEX requests_started ON requests(started_at);
CREATE INDEX requests_model ON requests(model, started_at);
CREATE INDEX requests_client ON requests(client, started_at);
CREATE TABLE bodies (id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE, snapshots TEXT NOT NULL);
`,
  },
];

/** Forward-only migrations driven by the `schema_version` table. */
function migrate(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
  );
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null };
  const current = row.v ?? 0;
  for (const m of MIGRATIONS.filter((m) => m.version > current)) {
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
        m.version,
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** provider/model columns describe the winning hop; a request that won nothing stores NULL. */
function winningHop(trace: RequestTrace): Hop | undefined {
  return [...trace.hops].reverse().find((h) => h.outcome === "ok");
}

export function createUsageStore(opts: {
  path: string;
  logBodies: boolean;
  now?: () => number;
}): UsageStore {
  const now = opts.now ?? Date.now;
  const db = openDatabase(opts.path);
  migrate(db);

  const insertRequest = db.prepare(
    `INSERT INTO requests (
      id, started_at, client, user_agent, source_api, requested_model,
      route_reason, provider, model, stream, status, http_status, error_type,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, would_cost_usd, cost_estimated, price_source,
      ttfb_ms, total_ms, finish_reason, hops, notes, diagnostics, repairs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBody = db.prepare(
    "INSERT OR REPLACE INTO bodies (id, snapshots) VALUES (?, ?)",
  );

  const queue: RequestTrace[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let lastWarn = -Infinity;

  function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    db.exec("BEGIN");
    try {
      for (const trace of batch) {
        const winner = winningHop(trace);
        insertRequest.run(
          trace.requestId,
          trace.startedAt,
          trace.client,
          trace.userAgent ?? null,
          trace.sourceApi,
          trace.requestedModel,
          trace.reason,
          trace.winner ?? null,
          winner?.model ?? null,
          trace.stream ? 1 : 0,
          trace.status,
          trace.httpStatus,
          trace.errorType ?? null,
          trace.inputTokens ?? null,
          trace.outputTokens ?? null,
          trace.cacheReadTokens ?? null,
          trace.cacheWriteTokens ?? null,
          trace.costUsd,
          trace.wouldCostUsd ?? null,
          trace.costEstimated ? 1 : 0,
          trace.priceSource ?? null,
          trace.ttfbMs ?? null,
          trace.totalMs,
          trace.finishReason ?? null,
          JSON.stringify(trace.hops),
          JSON.stringify(trace.notes),
          JSON.stringify(trace.diagnostics),
          JSON.stringify(trace.repairs),
        );
        if (opts.logBodies && trace.bodies !== undefined) {
          insertBody.run(trace.requestId, JSON.stringify(trace.bodies));
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // nothing to roll back
      }
      const t = now();
      if (t - lastWarn >= WARN_THROTTLE_MS) {
        lastWarn = t;
        logger.warn(
          { err, usageDb: opts.path, dropped: batch.length },
          "Usage store flush failed — batch dropped",
        );
      }
    }
  }

  return {
    name: "usage-store",

    accept(trace: RequestTrace): void {
      if (closed) return;
      queue.push(trace);
      if (queue.length >= FLUSH_ROWS) {
        flush();
      } else if (timer === undefined) {
        timer = setTimeout(flush, FLUSH_MS);
        timer.unref();
      }
    },

    ...createUsageQueries(db),

    pruneBefore(cutoffMs: number): void {
      db.prepare("DELETE FROM requests WHERE started_at < ?").run(cutoffMs);
    },

    flush,

    close(): void {
      if (closed) return;
      closed = true;
      flush();
      db.close();
    },
  };
}

let singleton: UsageStore | undefined;
let stopRetention: (() => void) | undefined;
let disabled = false;

/**
 * The process-wide store (spec §3.4), created on first call and
 * registered as a trace sink: `observe.usageStore` off → undefined and
 * node:sqlite is never loaded; an unusable path or schema → one
 * warning naming the path and the fix, the store disables itself, and
 * serving continues. A failed store is never retried — the operator
 * restarts after fixing USAGE_DB / observe.usage_db.
 */
export function getUsageStore(): UsageStore | undefined {
  if (singleton !== undefined || disabled) return singleton;
  const observe = getConfig().observe;
  if (!observe.usageStore) return undefined;
  try {
    singleton = createUsageStore({
      path: observe.usageDb,
      logBodies: observe.logBodies,
    });
  } catch (err) {
    disabled = true;
    logger.warn(
      { err, usageDb: observe.usageDb },
      "Usage store disabled — the usage DB cannot be used; fix " +
        "USAGE_DB / observe.usage_db (or set USAGE_STORE=off)",
    );
    return undefined;
  }
  registerSink(singleton);
  stopRetention = startRetention(singleton, observe.retentionDays);
  return singleton;
}

/**
 * Stop retention, flush and close the store, forget the singleton —
 * used by index.ts on shutdown and by tests. Never creates a store.
 */
export function resetUsageStore(): void {
  stopRetention?.();
  stopRetention = undefined;
  singleton?.close();
  singleton = undefined;
  disabled = false;
}
