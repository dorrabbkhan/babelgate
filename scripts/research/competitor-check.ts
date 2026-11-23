/**
 * competitor-check.ts — render the monthly competitor check report
 * from `gh api` JSON (v1.6 spec §3.9).
 *
 *   ts-node scripts/research/competitor-check.ts --data <dir> \
 *     [--repos <txt>] [--since YYYY-MM-DD] [--date YYYY-MM-DD] --out <file>
 *
 * competitor-check.sh does the fetching (`gh api repos/<repo>`,
 * `releases/latest`, `search/issues`); this file only parses what the
 * API returned and renders the dated Markdown table plus the list of
 * preset `docs` URLs whose `verified` date is older than 30 days, so
 * the whole report is testable offline against the recorded JSON in
 * scripts/research/fixtures/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROVIDER_PRESETS } from "../../src/config/provider-presets";

const REPO_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_REPOS = join(
  REPO_ROOT,
  "scripts",
  "research",
  "competitor-repos.txt",
);
const STALE_DAYS = 30;

/** One `owner/repo  label` line of competitor-repos.txt. */
export interface RepoListEntry {
  repo: string;
  label: string;
}

/** The fields of `gh api repos/<repo>` the report reads. */
export interface GhRepoMeta {
  stargazers_count?: number;
  pushed_at?: string;
  archived?: boolean;
}

/** The fields of `gh api repos/<repo>/releases/latest`. */
export interface GhRelease {
  tag_name?: string;
  published_at?: string;
}

export interface GhIssueSearchItem {
  title?: string;
  number?: number;
  html_url?: string;
}

/** The fields of `gh api search/issues`. */
export interface GhIssueSearch {
  total_count?: number;
  items?: GhIssueSearchItem[];
}

export interface RepoCheckData {
  entry: RepoListEntry;
  meta: GhRepoMeta | null;
  /** null when the repo publishes no GitHub release (404). */
  release: GhRelease | null;
  issues: GhIssueSearch | null;
}

export interface PresetDoc {
  name: string;
  docs: string;
  verified: string;
}

/** Parse `owner/repo  label` lines; `#` comments and blanks are skipped. */
export function parseRepoList(text: string): RepoListEntry[] {
  const entries: RepoListEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m || !m[1].includes("/")) {
      throw new Error(`competitor-repos: bad line ${JSON.stringify(raw)}`);
    }
    entries.push({ repo: m[1], label: (m[2] ?? "").trim() });
  }
  return entries;
}

export function slugFor(repo: string): string {
  return repo.replace("/", "_");
}

function readJson<T>(path: string, required: boolean): T | null {
  if (!existsSync(path)) {
    if (required) throw new Error(`competitor-check: missing ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new Error(`competitor-check: ${path} is not valid JSON`);
  }
}

/**
 * Load one repo's recorded API JSON: `<slug>.repo.json` and
 * `<slug>.issues.json` are required (their absence means the fetch
 * failed); a missing `<slug>.release.json` means "no GitHub release".
 */
export function loadRepoData(
  dir: string,
  entry: RepoListEntry,
): RepoCheckData {
  const slug = slugFor(entry.repo);
  return {
    entry,
    meta: readJson<GhRepoMeta>(join(dir, `${slug}.repo.json`), true),
    release: readJson<GhRelease>(join(dir, `${slug}.release.json`), false),
    issues: readJson<GhIssueSearch>(join(dir, `${slug}.issues.json`), true),
  };
}

export function loadDir(dir: string, entries: RepoListEntry[]): RepoCheckData[] {
  return entries.map((entry) => loadRepoData(dir, entry));
}

function defaultPresetDocs(): PresetDoc[] {
  return Object.entries(PROVIDER_PRESETS).map(([name, p]) => ({
    name,
    docs: p.docs,
    verified: p.verified,
  }));
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Presets whose `verified` date is more than `staleDays` before `date`. */
export function stalePresetDocs(
  presets: PresetDoc[],
  date: string,
  staleDays = STALE_DAYS,
): PresetDoc[] {
  return presets.filter((p) => daysBetween(p.verified, date) > staleDays);
}

function formatStars(n: number | undefined): string {
  if (n === undefined) return "—";
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatRelease(release: GhRelease | null): string {
  if (!release?.tag_name) return "—";
  const date = release.published_at?.slice(0, 10);
  return date ? `${release.tag_name} (${date})` : release.tag_name;
}

function cell(text: string): string {
  // Table safety: recorded titles/labels never carry pipes or newlines.
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
}

export function renderReport(opts: {
  date: string;
  since: string;
  rows: RepoCheckData[];
  presets?: PresetDoc[];
  staleDays?: number;
}): string {
  const { date, since, rows } = opts;
  const staleDays = opts.staleDays ?? STALE_DAYS;
  const presets = opts.presets ?? defaultPresetDocs();

  const lines: string[] = [
    `# Competitor check — ${date}`,
    "",
    `\`scripts/research/competitor-check.sh\` run on ${date}; repo list`,
    "`scripts/research/competitor-repos.txt`. Stars, last push, latest",
    "release and the archived flag are GitHub API values on the run date.",
    `\`Issues\` counts open issues created since ${since} matching`,
    "`thinking|tool|stream|reasoning` in title or body (GitHub issue",
    "search).",
    "",
    "| Repo | Label | Stars | Last push | Latest release | Archived | Issues |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const { entry, meta, release, issues } of rows) {
    const count =
      issues === null
        ? "?"
        : String(issues.total_count ?? issues.items?.length ?? 0);
    lines.push(
      `| [${entry.repo}](https://github.com/${entry.repo}) ` +
        `| ${cell(entry.label)} ` +
        `| ${formatStars(meta?.stargazers_count)} ` +
        `| ${meta?.pushed_at?.slice(0, 10) ?? "—"} ` +
        `| ${cell(formatRelease(release))} ` +
        `| ${meta?.archived ? "**archived**" : "—"} ` +
        `| ${count} |`,
    );
  }

  lines.push(
    "",
    `## Issue titles matching \`thinking|tool|stream|reasoning\` since ${since}`,
    "",
    "Up to 5 per repo:",
    "",
  );
  for (const { entry, issues } of rows) {
    const count = issues?.total_count ?? issues?.items?.length ?? 0;
    const items = issues?.items ?? [];
    if (count === 0 || items.length === 0) continue;
    lines.push(`- **${entry.repo}** (${count})`);
    for (const item of items.slice(0, 5)) {
      const title = (item.title ?? "").replace(/\s+/g, " ").trim();
      const link =
        item.number !== undefined && item.html_url
          ? ` ([#${item.number}](${item.html_url}))`
          : "";
      lines.push(`  - ${title.replace(/[\[\]]/g, "\\$&")}${link}`);
    }
  }

  lines.push("", "## Preset docs to re-verify", "");
  const stale = stalePresetDocs(presets, date, staleDays);
  if (stale.length === 0) {
    lines.push(
      `Every preset \`docs\` URL was verified within ${staleDays} days of`,
      `${date} — nothing stale.`,
    );
  } else {
    lines.push(
      `\`docs\` URLs whose \`verified\` date is more than ${staleDays} days`,
      `before ${date} — re-read before trusting the preset (free tiers`,
      "change):",
      "",
    );
    for (const p of stale) {
      lines.push(
        `- \`${p.name}\` — ${p.docs} (verified ${p.verified},`,
        `  ${daysBetween(p.verified, date)} days ago)`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function usage(): never {
  console.error(
    "usage: ts-node scripts/research/competitor-check.ts --data <dir> " +
      "[--repos <txt>] [--since YYYY-MM-DD] [--date YYYY-MM-DD] --out <file>",
  );
  process.exit(2);
}

if (require.main === module) {
  let data = "";
  let repos = DEFAULT_REPOS;
  let out = "";
  let since = "";
  let date = new Date().toISOString().slice(0, 10);
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (
      (arg === "--data" ||
        arg === "--repos" ||
        arg === "--out" ||
        arg === "--since" ||
        arg === "--date") &&
      next
    ) {
      if (arg === "--data") data = next;
      else if (arg === "--repos") repos = next;
      else if (arg === "--out") out = next;
      else if (arg === "--since") since = next;
      else date = next;
      i++;
    } else {
      usage();
    }
  }
  if (!data || !out) usage();
  if (!since) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - STALE_DAYS);
    since = d.toISOString().slice(0, 10);
  }
  try {
    const entries = parseRepoList(readFileSync(repos, "utf8"));
    const md = renderReport({
      date,
      since,
      rows: loadDir(data, entries),
    });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, md);
    console.log(`[competitor-check] wrote ${out}`);
  } catch (err) {
    console.error(
      `competitor-check: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}
