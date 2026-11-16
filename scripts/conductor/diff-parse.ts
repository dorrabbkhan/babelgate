/**
 * diff-parse.ts — unified-diff parsing for judge.ts (spec §3.0.1).
 * Tracks hunk-declared line counts so a truncated or binary diff is
 * detectable: uninspectable() says why a file's content can't be checked.
 */
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  line: number; // new-side line number, 0 for deletions
}
export interface Hunk {
  header: string;
  lines: DiffLine[];
  truncated: boolean;
}
export interface DiffFile {
  path: string; // new-side path
  oldPath: string;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  modeChange: boolean;
  hunks: Hunk[];
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: Hunk | null = null;
  let needOld = 0;
  let needNew = 0;
  let newNo = 0;
  const closeHunk = () => {
    if (h && (needOld > 0 || needNew > 0)) h.truncated = true;
    h = null;
  };
  const closeFile = () => {
    closeHunk();
    if (f) files.push(f);
    f = null;
  };
  for (const raw of text.split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (git) {
      closeFile();
      f = {
        path: git[2],
        oldPath: git[1],
        status: "modified",
        binary: false,
        modeChange: false,
        hunks: [],
      };
      continue;
    }
    if (!f) continue;
    if (raw.startsWith("new file mode")) f.status = "added";
    else if (raw.startsWith("deleted file mode")) f.status = "deleted";
    else if (raw.startsWith("old mode") || raw.startsWith("new mode")) f.modeChange = true;
    else if (raw.startsWith("rename from ")) {
      f.oldPath = raw.slice(12);
      f.status = "renamed";
    } else if (raw.startsWith("rename to ")) {
      f.path = raw.slice(10);
      f.status = "renamed";
    } else if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
      f.binary = true;
    } else if (raw.startsWith("+++ ")) {
      const p = raw.slice(4);
      if (p !== "/dev/null") f.path = p.replace(/^b\//, "");
    } else if (raw.startsWith("@@")) {
      closeHunk();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      h = { header: raw, lines: [], truncated: !m };
      if (m) {
        needOld = m[2] === undefined ? 1 : +m[2];
        needNew = m[4] === undefined ? 1 : +m[4];
        newNo = +m[3];
      }
      f.hunks.push(h);
    } else if (h) {
      if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
      const k = raw[0];
      if (k === "+") {
        h.lines.push({ kind: "add", text: raw.slice(1), line: newNo++ });
        needNew--;
      } else if (k === "-") {
        h.lines.push({ kind: "del", text: raw.slice(1), line: 0 });
        needOld--;
      } else if (k === " " || raw === "") {
        h.lines.push({ kind: "ctx", text: raw.slice(1), line: newNo++ });
        needOld--;
        needNew--;
      } else {
        h.truncated = true; // unexpected line inside a hunk
        h = null;
      }
    }
  }
  closeFile();
  return files;
}

/** Why a file's content can't be inspected, or null when it can. */
export function uninspectable(f: DiffFile): string | null {
  if (f.binary) return "binary file";
  if (f.status === "renamed" && f.hunks.length === 0) return "rename-only, no hunks";
  if (f.status === "modified" && f.hunks.length === 0 && !f.modeChange) return "no hunks";
  if (f.hunks.some((x) => x.truncated)) return "truncated hunk";
  return null;
}

export const isTestFile = (p: string) =>
  /\.(test|spec)\.[tj]sx?$/.test(p) || p.startsWith("tests/");

export const addedLines = (f: DiffFile) =>
  f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add"));
