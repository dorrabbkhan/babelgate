import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * The lazy node:sqlite boundary (spec §3.4, D4): nothing may import
 * "node:sqlite" at module top — with `USAGE_STORE=off` the builtin is
 * never loaded. openDatabase installs the ExperimentalWarning filter
 * once, then requires the builtin, makes the parent directory, opens
 * the file WAL-mode with a 200 ms busy timeout (DatabaseSync is
 * synchronous — a longer wait would block the event loop).
 */

let filterInstalled = false;

/**
 * Node 22.13–23.x print a one-time ExperimentalWarning when
 * node:sqlite is first used. Node's default warning printer is itself
 * a `warning` listener registered at bootstrap, so a
 * `process.on("warning")` filter cannot swallow it — it runs after
 * the printer. Intercepting `process.emit` does: the matching warning
 * event is dropped before any listener sees it, so nothing reaches
 * stderr. One-shot (installed at most once), and it swallows only an
 * `ExperimentalWarning` whose message mentions SQLite — every other
 * event and warning passes through untouched.
 */
export function installSqliteWarningFilter(): void {
  if (filterInstalled) return;
  filterInstalled = true;
  const original = process.emit as (
    event: string | symbol,
    ...args: unknown[]
  ) => boolean;
  process.emit = function (
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    const warning = args[0];
    if (
      event === "warning" &&
      warning instanceof Error &&
      warning.name === "ExperimentalWarning" &&
      warning.message.includes("SQLite")
    ) {
      return false;
    }
    return original.call(process, event, ...args);
  } as typeof process.emit;
}

/**
 * Open (or create) a SQLite database at `path`, WAL mode. The parent
 * directory is created when missing; `":memory:"` and paths whose
 * parent already exists skip it. The 200 ms `timeout` is the busy
 * wait applied to every statement — a locked database surfaces as an
 * SQLITE_BUSY error after at most 200 ms, never a hang.
 */
export function openDatabase(path: string): DatabaseSync {
  installSqliteWarningFilter();
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path, { timeout: 200 });
  // WAL is also what forces the file open — a non-SQLite file fails
  // here, at open time, not on the first write.
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}
