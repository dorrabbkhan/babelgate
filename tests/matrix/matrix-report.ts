import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Provider } from "../../src/transformers";

/**
 * Pair-test → compatibility-matrix reporting (v1.5 spec §3.4, Task
 * 11). `recordMatrixCell` is called inside the pair tests — vitest
 * worker processes — so each call appends one JSON line to a
 * per-process file under `.out/`; the module-level `initialized`
 * flag truncates that file once per process, which also discards a
 * stale file a crashed run left behind at a reused pid.
 *
 * The file doubles as the vitest `globalSetup`: `setup` (main
 * process, before any worker) wipes `.out/` entirely so a crashed
 * run can never leak cells into the next one; `teardown` (main
 * process, after all workers) merges every `cells-*.jsonl`
 * last-write-wins into `.out/matrix.json` and removes the line
 * files. vitest 3.2.4 has no `globalTeardown` option — the setup
 * module's `teardown` export is its run-once-after-tests hook
 * (logged in docs/decisions.md).
 */

export type MatrixFeature =
  | "plain"
  | "stream"
  | "tools"
  | "stream_tools"
  | "structured"
  | "reasoning"
  | "url_image"
  | "document"
  | "tool_image"
  | "passthrough";

export type MatrixStatus = "pass" | "note" | "fail";

export interface MatrixCell {
  status: MatrixStatus;
  /** Note code (status "note") or failure reason (status "fail"). */
  note?: string;
}

export interface MatrixReport {
  version: 1;
  cells: {
    [feature in MatrixFeature]?: {
      [source in Provider]?: {
        [target in Provider]?: MatrixCell;
      };
    };
  };
}

export const MATRIX_OUT_DIR = join(__dirname, ".out");
export const MATRIX_JSON_PATH = join(MATRIX_OUT_DIR, "matrix.json");

const CELL_FILE = join(
  MATRIX_OUT_DIR,
  `cells-${process.pid}-${process.env.VITEST_WORKER_ID ?? "w"}.jsonl`,
);
let initialized = false;

export function recordMatrixCell(
  source: Provider,
  target: Provider,
  feature: MatrixFeature,
  status: MatrixStatus,
  note?: string,
): void {
  if (!initialized) {
    mkdirSync(MATRIX_OUT_DIR, { recursive: true });
    writeFileSync(CELL_FILE, "");
    initialized = true;
  }
  appendFileSync(
    CELL_FILE,
    JSON.stringify({ source, target, feature, status, note }) + "\n",
  );
}

/** vitest globalSetup: a clean `.out/` before any worker runs. */
export function setup(): void {
  rmSync(MATRIX_OUT_DIR, { recursive: true, force: true });
  mkdirSync(MATRIX_OUT_DIR, { recursive: true });
}

/** vitest globalSetup teardown: merge the workers' cells. */
export function teardown(): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(MATRIX_OUT_DIR);
  } catch {
    entries = [];
  }
  const report: MatrixReport = { version: 1, cells: {} };
  for (const entry of entries) {
    if (!entry.startsWith("cells-") || !entry.endsWith(".jsonl")) {
      continue;
    }
    const path = join(MATRIX_OUT_DIR, entry);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let cell: {
        source: Provider;
        target: Provider;
        feature: MatrixFeature;
        status: MatrixStatus;
        note?: string;
      };
      try {
        cell = JSON.parse(line);
      } catch {
        continue;
      }
      const byFeature = (report.cells[cell.feature] ??= {});
      const bySource = (byFeature[cell.source] ??= {});
      bySource[cell.target] = { status: cell.status, note: cell.note };
    }
    rmSync(path, { force: true });
  }
  writeFileSync(MATRIX_JSON_PATH, JSON.stringify(report, null, 2) + "\n");
}
