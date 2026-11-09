/**
 * Structural diff between two JSON-ish values (spec §3.9): the
 * Inspector diffs adjacent pipeline stages (source → canonical →
 * target → response) and highlights what each stage added, removed or
 * changed. Paths are JS-style: `messages[3].content[1]`.
 */

export interface DiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function joinKey(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function joinIndex(path: string, index: number): string {
  return `${path}[${index}]`;
}

function walk(a: unknown, b: unknown, path: string, out: DiffEntry[]): void {
  if (Object.is(a, b)) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (i >= a.length) out.push({ path: joinIndex(path, i), kind: "added" });
      else if (i >= b.length)
        out.push({ path: joinIndex(path, i), kind: "removed" });
      else walk(a[i], b[i], joinIndex(path, i), out);
    }
    return;
  }

  if (isRecord(a) && isRecord(b)) {
    for (const key of Object.keys(a)) {
      if (!(key in b)) out.push({ path: joinKey(path, key), kind: "removed" });
      else walk(a[key], b[key], joinKey(path, key), out);
    }
    for (const key of Object.keys(b)) {
      if (!(key in a)) out.push({ path: joinKey(path, key), kind: "added" });
    }
    return;
  }

  out.push({ path, kind: "changed" });
}

/**
 * Diff `a` → `b`: keys/indices only in `b` are "added", only in `a`
 * are "removed", differing leaves "changed". Container-vs-leaf type
 * changes report the container path once (no descent into a value
 * that no longer shares shape).
 */
export function structuralDiff(a: unknown, b: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(a, b, "", out);
  return out;
}
