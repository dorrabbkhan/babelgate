/**
 * shape-diff.ts — diffs a fresh client shape recording against the
 * committed fixture (v1.5 spec §3.4 client-release replay). Both files
 * are JSONL written by record-shapes.ts: one line per request with
 * `method`, `path`, `queryKeys`, `headerNames`, `bodyShape` and, in
 * RECORD_KEEP_ENUMS mode, verbatim `type`/`name` enum strings plus
 * `sseEvents`.
 *
 *   ts-node scripts/gates/shape-diff.ts <new.jsonl> <fixture.jsonl>
 *
 * Prints one line per added/removed shape element in four categories —
 * request keys (method+path, query keys and every bodyShape key path),
 * tool types (`type`/`name` values of `tools[]` elements, including
 * nested namespace `tools[]`), input item types (`type` values of
 * `input[]`, `content[]` and `system[]` elements — Anthropic blocks,
 * Responses items and Codex parts alike) and SSE event types — then a
 * totals line. Exit 1 when anything was ADDED (a new client field,
 * tool or event the fixtures never saw); removals are reported but
 * never fail — a leaner release is not a break.
 *
 * Deliberately NOT diffed: `headerNames` (conditional headers like
 * `x-stainless-retry-count` only appear on retried requests — a flaky
 * upstream would file a false-positive issue every week) and every
 * value (`model` slugs, `<string:N>` lengths, `status`, user-agent
 * versions) — only keys, type/name enum strings and event names are
 * shape. `bodyShape` values that are non-verbatim strings (a recording
 * without RECORD_KEEP_ENUMS) simply contribute keys, never enum
 * entries.
 */
import { readFileSync } from "node:fs";

type Category =
  | "request key"
  | "tool type"
  | "input item type"
  | "SSE event type";

interface ShapeSets {
  requestKeys: Set<string>;
  toolTypes: Set<string>;
  inputItemTypes: Set<string>;
  sseEventTypes: Set<string>;
}

const CATEGORIES: { key: keyof ShapeSets; label: Category }[] = [
  { key: "requestKeys", label: "request key" },
  { key: "toolTypes", label: "tool type" },
  { key: "inputItemTypes", label: "input item type" },
  { key: "sseEventTypes", label: "SSE event type" },
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Verbatim enum strings only — "<string:N>" shape markers say nothing. */
const isEnum = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && !v.startsWith("<");

/** Array-valued body keys whose elements' `type` is an item type. */
const ITEM_ARRAY_KEYS = new Set(["input", "content", "system"]);

function walkBody(value: unknown, path: string, sets: ShapeSets): void {
  if (Array.isArray(value)) {
    for (const el of value) walkBody(el, `${path}[]`, sets);
    return;
  }
  if (!isObj(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    sets.requestKeys.add(`body ${childPath}`);
    if (key === "tools" && Array.isArray(child)) {
      // Anthropic `tools[]` entries name tools by `name`; Responses and
      // Codex discriminate by `type` (and namespace entries carry their
      // own nested `tools[]`, caught when the walk reaches them).
      for (const tool of child) {
        if (!isObj(tool)) continue;
        if (isEnum(tool.type)) sets.toolTypes.add(`type:${tool.type}`);
        if (isEnum(tool.name)) sets.toolTypes.add(`name:${tool.name}`);
      }
    }
    if (ITEM_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      for (const item of child) {
        if (isObj(item) && isEnum(item.type)) {
          sets.inputItemTypes.add(item.type);
        }
      }
    }
    walkBody(child, childPath, sets);
  }
}

function collect(lines: Record<string, unknown>[]): ShapeSets {
  const sets: ShapeSets = {
    requestKeys: new Set(),
    toolTypes: new Set(),
    inputItemTypes: new Set(),
    sseEventTypes: new Set(),
  };
  for (const line of lines) {
    if (typeof line.method === "string" && typeof line.path === "string") {
      sets.requestKeys.add(`request ${line.method} ${line.path}`);
    }
    if (Array.isArray(line.queryKeys)) {
      for (const k of line.queryKeys) {
        if (typeof k === "string") sets.requestKeys.add(`query ${k}`);
      }
    }
    walkBody(line.bodyShape, "", sets);
    if (isObj(line.sseEvents)) {
      for (const name of Object.keys(line.sseEvents)) {
        sets.sseEventTypes.add(name);
      }
    }
  }
  return sets;
}

function readJsonl(path: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    const parsed: unknown = JSON.parse(raw);
    if (isObj(parsed)) lines.push(parsed);
  }
  return lines;
}

/** Returns the process exit code: 1 when anything was added, else 0. */
export function run(
  args: string[],
  out: (line: string) => void = console.log,
): number {
  if (args.length !== 2) {
    out("usage: shape-diff.ts <new.jsonl> <fixture.jsonl>");
    return 2;
  }
  const [newPath, fixturePath] = args;
  let fresh: Record<string, unknown>[];
  let fixture: Record<string, unknown>[];
  try {
    fresh = readJsonl(newPath);
    fixture = readJsonl(fixturePath);
  } catch (err) {
    out(`shape-diff: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const freshSets = collect(fresh);
  const fixtureSets = collect(fixture);
  let added = 0;
  let removed = 0;
  for (const { key, label } of CATEGORIES) {
    for (const name of [...freshSets[key]].sort()) {
      if (!fixtureSets[key].has(name)) {
        out(`added ${label}: ${name}`);
        added += 1;
      }
    }
    for (const name of [...fixtureSets[key]].sort()) {
      if (!freshSets[key].has(name)) {
        out(`removed ${label}: ${name}`);
        removed += 1;
      }
    }
  }
  out(`SHAPE DIFF: ${added} added, ${removed} removed`);
  return added > 0 ? 1 : 0;
}

/* c8 ignore next 3 */
if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
