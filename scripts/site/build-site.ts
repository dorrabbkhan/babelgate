import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Landing-page build (v1.6 spec §3.8, Task 16): splices the generated
 * proof block — the "Every combination, checked" table, the
 * "verified by hand" rows and the "last checked" line — into
 * `site/index.html` between `<!-- matrix:start -->`/`<!-- matrix:end
 * -->` and copies the static assets into `dist-site/`.
 *
 * Honesty rule (spec §3.8): every table cell and the "last checked"
 * versions come from data — the pair-test matrix
 * (`tests/matrix/.out/matrix.json`, or `docs/compatibility.md` when
 * the test output is absent, e.g. the Pages job), the recipe headers'
 * `> **Verified:**` blockquotes, and the latest client-replay
 * `summary.md` + `run.json` (dropped into `tmp/client-replay/` by the
 * Pages workflow; absent in a local build). Nothing is typed by hand:
 * a pair only earns a check when the four core features (plain,
 * stream, tools, stream_tools) record pass or note, and the checked
 * versions are the versions the replay actually ran.
 */

export const START_MARKER = "<!-- matrix:start -->";
export const END_MARKER = "<!-- matrix:end -->";

const CORE_FEATURES = ["plain", "stream", "tools", "stream_tools"] as const;

interface Cell {
  status: string;
  note?: string;
}

/** feature → source → target → cell */
type Cells = Record<string, Record<string, Record<string, Cell>>>;

/** Display labels for the client (source) rows, most-recognised first. */
const CLIENT_ROWS: { source: string; name: string; note: string }[] = [
  { source: "anthropic", name: "Claude Code", note: "Anthropic API" },
  { source: "responses", name: "Codex", note: "Responses API" },
  { source: "openai", name: "OpenAI-format apps", note: "Chat Completions" },
  { source: "gemini", name: "Gemini-format apps", note: "Gemini API" },
  { source: "ollama", name: "Ollama apps", note: "Ollama API" },
];

const TARGET_LABELS: Record<string, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  ollama: "Ollama",
  anthropic: "Anthropic",
  responses: "Responses",
};

const CLIENT_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const REPO = "https://github.com/dorrabbkhan/babelgate";

export interface SitePaths {
  site: string;
  out: string;
  matrix: string;
  compat: string;
  recipes: string;
  replay: string;
}

const ROOT = join(__dirname, "..", "..");

export const DEFAULT_PATHS: SitePaths = {
  site: join(ROOT, "site", "index.html"),
  out: join(ROOT, "dist-site"),
  matrix: join(ROOT, "tests", "matrix", ".out", "matrix.json"),
  compat: join(ROOT, "docs", "compatibility.md"),
  recipes: join(ROOT, "docs", "recipes"),
  replay: join(ROOT, "tmp", "client-replay"),
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Load cells from the pair-test report, else from the rendered doc. */
function loadCells(paths: SitePaths): Cells {
  try {
    const report = JSON.parse(readFileSync(paths.matrix, "utf8")) as {
      cells?: Cells;
    };
    // A wiped .out/matrix.json (partial test run) reports `cells: {}` —
    // an empty report is no evidence, fall through to the committed doc.
    if (report.cells && Object.keys(report.cells).length > 0) {
      return report.cells;
    }
  } catch {
    /* fall through to the committed doc */
  }
  try {
    return parseCompat(readFileSync(paths.compat, "utf8"));
  } catch {
    // Neither source readable — an empty table makes no claims at all.
    return {};
  }
}

/** Parse a rendered compatibility.md back into cells (core + all). */
function parseCompat(markdown: string): Cells {
  const cells: Cells = {};
  let feature: string | undefined;
  let targets: string[] = [];
  for (const line of markdown.split("\n")) {
    const heading = /^## .+\(`([a-z_]+)`\)\s*$/.exec(line);
    if (heading) {
      feature = heading[1];
      targets = [];
      continue;
    }
    if (feature === undefined || !line.startsWith("|")) continue;
    const fields = line
      .split("|")
      .slice(1, -1)
      .map((f) => f.trim());
    if (fields[0] === "source \\ target") {
      targets = fields.slice(1);
      continue;
    }
    if (fields[0] === "---" || fields.length !== targets.length + 1) {
      continue;
    }
    const source = fields[0]!;
    for (const [i, text] of fields.slice(1).entries()) {
      const cell = compatCell(text);
      if (cell === undefined) continue;
      ((cells[feature] ??= {})[source] ??= {})[targets[i]!] = cell;
    }
  }
  return cells;
}

function compatCell(text: string): Cell | undefined {
  if (text === "" || text === "—") return undefined;
  if (text === "✓") return { status: "pass" };
  if (text.startsWith("✓ ")) return { status: "note", note: text.slice(2) };
  if (text.startsWith("n/a")) return { status: "na" };
  if (text.startsWith("✗")) return { status: "fail" };
  return undefined;
}

/** First-seen union of target ids across the recorded features. */
function collectTargets(cells: Cells): string[] {
  const seen: string[] = [];
  for (const sources of Object.values(cells)) {
    for (const row of Object.values(sources)) {
      for (const t of Object.keys(row)) {
        if (!seen.includes(t)) seen.push(t);
      }
    }
  }
  return seen;
}

function pairChecked(cells: Cells, source: string, target: string): boolean {
  return CORE_FEATURES.every((f) => {
    const cell = cells[f]?.[source]?.[target];
    return cell !== undefined && ["pass", "note"].includes(cell.status);
  });
}

/** One row per client with at least one recorded core cell. */
function clientRows(cells: Cells): typeof CLIENT_ROWS {
  const sources = new Set<string>();
  for (const f of CORE_FEATURES) {
    for (const s of Object.keys(cells[f] ?? {})) sources.add(s);
  }
  const rows = CLIENT_ROWS.filter((r) => sources.has(r.source));
  for (const s of sources) {
    if (!CLIENT_ROWS.some((r) => r.source === s)) {
      rows.push({ source: s, name: s, note: "" });
    }
  }
  return rows;
}

interface VerifiedRecipe {
  name: string;
  version: string;
  date?: string;
  file: string;
}

/**
 * Recipe-only clients: a `docs/recipes/<file>.md` whose header carries a
 * `> **Verified:**` blockquote earns a "verified by hand on <version>"
 * row; "Not verified" recipes are omitted, as are recipes for clients
 * the matrix already covers (spec §3.8) — renderBlock drops them.
 */
function verifiedRecipes(recipesDir: string): VerifiedRecipe[] {
  const out: VerifiedRecipe[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(recipesDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return out;
  }
  for (const file of files) {
    const text = readFileSync(join(recipesDir, file), "utf8");
    const title = /^# Recipe:\s*(.+?)\s+on\b/m.exec(text)?.[1];
    if (title === undefined) continue;
    // Collect the first contiguous `>` blockquote that starts Verified.
    const lines = text.split("\n");
    let block = "";
    for (const [i, line] of lines.entries()) {
      if (/^>\s*\*\*Verified:\*\*/.test(line)) {
        for (let j = i; j < lines.length && lines[j]!.startsWith(">"); j++) {
          block += lines[j] + "\n";
        }
        break;
      }
    }
    if (block === "") continue;
    const version = /\bv?\d+\.\d+(?:\.\d+)?\b/.exec(block)?.[0];
    if (version === undefined) continue;
    const date = /\b\d{4}-\d{2}-\d{2}\b/.exec(block)?.[0];
    out.push({ name: title, version, date, file });
  }
  return out;
}

interface Replay {
  versions: { name: string; version: string }[];
  url?: string;
  date?: string;
}

/** Latest client-replay versions, when the Pages job fetched them. */
function readReplay(replayDir: string, compatText: string): Replay {
  const out: Replay = { versions: [] };
  const header = /Latest client replay run:\s*<([^>]+)>/.exec(compatText);
  if (header) out.url = header[1];
  const summaryPath = join(replayDir, "summary.md");
  if (existsSync(summaryPath)) {
    const summary = readFileSync(summaryPath, "utf8");
    for (const m of summary.matchAll(/^-\s*([\w-]+):\s*`([^`]+)`/gm)) {
      const version = /[\d.]+/.exec(m[2]!)?.[0];
      if (version === undefined) continue;
      out.versions.push({
        name: CLIENT_DISPLAY_NAMES[m[1]!] ?? m[1]!,
        version,
      });
    }
  }
  const runPath = join(replayDir, "run.json");
  if (existsSync(runPath)) {
    try {
      const run = JSON.parse(readFileSync(runPath, "utf8")) as {
        url?: string;
        date?: string;
      };
      if (run.url) out.url = run.url;
      if (run.date) out.date = run.date;
    } catch {
      /* malformed run.json — ignore */
    }
  }
  return out;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-11-23T17:38:19Z" or "2026-11-23" → "23 Nov 2026". */
function fmtDate(iso: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function liveLine(replay: Replay): string {
  const link = replay.url ? `<a href="${esc(replay.url)}">latest replay ↗</a>` : "";
  if (replay.versions.length > 0) {
    const what = replay.versions
      .map((v) => `${esc(v.name)} ${esc(v.version)}`)
      .join(" · ");
    const when = replay.date ? ` · ${esc(fmtDate(replay.date) ?? "")}` : "";
    const tail = link ? ` — ${link}` : "";
    return `Last checked automatically: ${what}${when}${tail}`;
  }
  return `Checked automatically on every change${link ? ` — ${link}` : ""}`;
}

/** Render everything between the markers: table + "last checked". */
function renderBlock(
  cells: Cells,
  recipes: VerifiedRecipe[],
  replay: Replay,
): string {
  const targets = collectTargets(cells);
  const lines: string[] = [
    '<div class="tscroll">',
    "<table>",
    `  <thead><tr><th></th>${targets
      .map((t) => `<th>${esc(TARGET_LABELS[t] ?? t)}</th>`)
      .join("")}</tr></thead>`,
    "  <tbody>",
  ];
  const emitted = clientRows(cells);
  emitted.forEach((row, ri) => {
    const cellsHtml = targets
      .map((t, ci) => {
        const delay = (2.8 + ri * 0.2 + ci * 0.08).toFixed(2);
        if (pairChecked(cells, row.source, t)) {
          return `<td><span class="ck" style="animation-delay:${delay}s">✓</span></td>`;
        }
        return `<td><span class="miss">—</span></td>`;
      })
      .join("");
    const note = row.note ? ` <small>${esc(row.note)}</small>` : "";
    lines.push(`    <tr><td>${esc(row.name)}${note}</td>${cellsHtml}</tr>`);
  });
  const handBlocks: string[] = [];
  for (const r of recipes) {
    if (emitted.some((row) => row.name.toLowerCase() === r.name.toLowerCase())) {
      continue;
    }
    const when = r.date ? ` · ${esc(r.date)}` : "";
    const recipe = `${REPO}/blob/main/docs/recipes/${r.file}`;
    const text =
      `verified by hand on ${esc(r.version)}${when} — ` +
      `<a href="${recipe}">recipe</a>`;
    lines.push(
      `    <tr class="hand"><td>${esc(r.name)}</td>` +
        `<td colspan="${targets.length}">${text}</td></tr>`,
    );
    // ≤760px the table scrolls inside .tscroll and a colspan cell's text
    // sits off-screen; this block repeats the rows below the table
    // (style.css hides tr.hand and shows .handlist only there).
    handBlocks.push(
      `  <div class="handrow"><b>${esc(r.name)}</b>` +
        `<span class="hv">${text}</span></div>`,
    );
  }
  lines.push("  </tbody>", "</table>", "</div>");
  if (handBlocks.length > 0) {
    lines.push('<div class="handlist">', ...handBlocks, "</div>");
  }
  lines.push(
    '<div class="scrollhint" aria-hidden="true">scroll for all providers →</div>',
    `<div class="live"><i></i><span>${liveLine(replay)}</span></div>`,
  );
  return lines.join("\n");
}

/** Assets copied beside the generated index.html. */
function copyAssets(siteDir: string, outDir: string): void {
  for (const name of ["style.css", "og.png"]) {
    const src = join(siteDir, name);
    if (existsSync(src)) copyFileSync(src, join(outDir, name));
  }
  const demo = join(ROOT, "docs", "assets", "demo.gif");
  if (existsSync(demo)) copyFileSync(demo, join(outDir, "demo.gif"));
}

/** Build dist-site/ from the site source and the data files. */
export function build(paths: SitePaths): { wrote: string[] } {
  const html = readFileSync(paths.site, "utf8");
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `${paths.site} must contain ${START_MARKER} … ${END_MARKER}`,
    );
  }
  let compatText = "";
  try {
    compatText = readFileSync(paths.compat, "utf8");
  } catch {
    /* optional: supplies only the replay link when present */
  }
  const cells = loadCells(paths);
  const recipes = verifiedRecipes(paths.recipes);
  const block = renderBlock(cells, recipes, readReplay(paths.replay, compatText));
  const out =
    html.slice(0, start + START_MARKER.length) +
    "\n" +
    block +
    "\n" +
    html.slice(end);
  mkdirSync(paths.out, { recursive: true });
  const indexPath = join(paths.out, "index.html");
  writeFileSync(indexPath, out);
  copyAssets(join(paths.site, ".."), paths.out);
  return { wrote: [indexPath] };
}

/** CLI: `--site --out --matrix --compat --recipes --replay-dir <path>`. */
export function run(
  argv: string[],
  paths: SitePaths = DEFAULT_PATHS,
  out: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): number {
  const p: SitePaths = { ...paths };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i]!;
    if (arg === "--site") p.site = next();
    else if (arg === "--out") p.out = next();
    else if (arg === "--matrix") p.matrix = next();
    else if (arg === "--compat") p.compat = next();
    else if (arg === "--recipes") p.recipes = next();
    else if (arg === "--replay-dir") p.replay = next();
    else {
      out(`unknown argument: ${arg}`);
      return 2;
    }
  }
  try {
    const { wrote } = build(p);
    for (const f of wrote) out(`wrote ${f}`);
    return 0;
  } catch (e) {
    out(`build-site failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

/* c8 ignore next 3 */
if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
