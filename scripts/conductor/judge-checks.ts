/**
 * judge-checks.ts — the nine mechanical checks judge.ts runs (spec §3.0.1,
 * in that order): fixtures, assertions, skips, files-block,
 * adapter-independence, canonical-pair, secrets, diff-stat, owner-gate.
 * A check that cannot run on part of the diff FLAGs naming the file —
 * never a silent PASS.
 */
import { basename, dirname, join } from "node:path";
import {
  addedLines,
  isTestFile,
  uninspectable,
  type DiffFile,
} from "./diff-parse";

export interface Check {
  id: string;
  status: "PASS" | "FLAG" | "N/A";
  reasons: string[];
}
export const pass = (id: string, why = ""): Check => ({
  id,
  status: "PASS",
  reasons: why ? [why] : [],
});
const flag = (id: string, reasons: string[]): Check => ({ id, status: "FLAG", reasons });
const na = (id: string, why: string): Check => ({ id, status: "N/A", reasons: [why] });

// ---------- plan **Files:** block ----------

export function filesBlockPatterns(planText: string, task: string): string[] | null {
  const lines = planText.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`### Task ${task}:`));
  if (start < 0) return null;
  let i = start + 1;
  const section: string[] = [];
  while (i < lines.length && !/^(#{2,3}) /.test(lines[i])) section.push(lines[i++]);
  const fb = section.findIndex((l) => l.includes("**Files:**"));
  if (fb < 0) return null;
  const pats: string[] = [];
  for (const l of section.slice(fb + 1)) {
    if (l.startsWith("**") || l.startsWith("### ") || /^\s*-\s*\[/.test(l)) break;
    if (!/^\s*-/.test(l) && !/^\s+\S/.test(l)) {
      if (l.trim() === "") continue;
      break;
    }
    for (const m of l.matchAll(/`([^`]+)`/g)) pats.push(m[1]);
  }
  return pats.length ? pats : null;
}

const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
const patToRe = (p: string) =>
  new RegExp("^" + esc(p).replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
const matchesPat = (pats: string[], path: string) =>
  pats.some((p) => patToRe(p).test(path));

const decisionsAdditions = (files: DiffFile[]) => {
  const dec = files.find((f) => f.path === "docs/decisions.md");
  return dec
    ? dec.hunks
        .flatMap((h) => h.lines)
        .filter((l) => l.kind === "add")
        .map((l) => l.text)
        .join("\n")
    : "";
};

// ---------- 1. fixtures ----------

export function checkFixtures(files: DiffFile[]): Check {
  const reasons: string[] = [];
  for (const f of files) {
    if (
      f.status !== "added" &&
      (f.path.startsWith("tests/fixtures/") ||
        f.path.startsWith("tests/contracts/__snapshots__/"))
    )
      reasons.push(`oracle file ${f.status}: ${f.path}`);
    for (const h of f.hunks)
      for (const l of h.lines)
        if (l.kind !== "ctx" && /\bDEFAULT_(TIMEOUT_MS|RETRIES)\b/.test(l.text))
          reasons.push(`timeout/retry default touched: ${f.path} ${h.header}`);
  }
  return reasons.length ? flag("fixtures", [...new Set(reasons)]) : pass("fixtures");
}

// ---------- 2. assertions ----------

const EXACT = /\.(toEqual|toStrictEqual|toBe)\s*\(/;
const WEAK = /\.(toMatchObject|toContain|toBeTruthy)\s*\(|objectContaining\s*\(/;

export function checkAssertions(files: DiffFile[]): Check {
  const reasons: string[] = [];
  for (const f of files.filter((x) => isTestFile(x.path))) {
    const bad = uninspectable(f);
    if (bad) {
      reasons.push(`could not inspect ${f.path} (${bad})`);
      continue;
    }
    for (const h of f.hunks) {
      const rem = h.lines.filter((l) => l.kind === "del" && /expect\s*\(/.test(l.text));
      const add = h.lines.filter((l) => l.kind === "add" && /expect\s*\(/.test(l.text));
      if (rem.length > add.length)
        reasons.push(
          `${f.path} ${h.header}: ${rem.length} expect() removed, ${add.length} added`,
        );
      const weak = add.find((l) => WEAK.test(l.text));
      if (rem.some((l) => EXACT.test(l.text)) && weak)
        reasons.push(`${f.path}:${weak.line} exact matcher weakened to ${WEAK.exec(weak.text)![0]}`);
    }
  }
  return reasons.length ? flag("assertions", reasons) : pass("assertions");
}

// ---------- 3. skips ----------

const SKIP_RE =
  /\b(describe|context|it|test|xit|xdescribe|suite)\.(only|skip|todo|skipIf|onlyIf)\s*\(/;

export function checkSkips(files: DiffFile[]): Check {
  const reasons: string[] = [];
  for (const f of files.filter((x) => isTestFile(x.path))) {
    const bad = uninspectable(f);
    if (bad) {
      reasons.push(`could not inspect ${f.path} (${bad})`);
      continue;
    }
    for (const l of addedLines(f))
      if (SKIP_RE.test(l.text)) reasons.push(`${f.path}:${l.line} added ${l.text.trim()}`);
  }
  return reasons.length ? flag("skips", reasons) : pass("skips");
}

// ---------- 4. files-block ----------

export function checkFilesBlock(
  files: DiffFile[],
  planText: string | null,
  task: string,
): Check {
  const pats = planText ? filesBlockPatterns(planText, task) : null;
  if (!pats)
    return flag("files-block", [`no **Files:** block found for task ${task} in plan`]);
  const extras = files.filter(
    (f) => f.path !== "docs/decisions.md" && !matchesPat(pats, f.path),
  );
  if (!extras.length) return pass("files-block", "every diff file is in the task's Files block");
  const decText = decisionsAdditions(files);
  const unnamed = extras.filter((e) => !decText.includes(e.path));
  return unnamed.length
    ? flag(
        "files-block",
        unnamed.map((e) => `${e.path} outside Files block and not named in a decisions.md hunk`),
      )
    : pass("files-block", "extra files named in decisions.md");
}

// ---------- 5. adapter-independence ----------

const FORMATS = ["anthropic", "gemini", "ollama", "openai", "responses"];
const ADAPTERS = "src/transformers/adapters/";
const HOSTNAME_RE = /(hostname|baseUrl|base_url)\s*(===|includes|match)/;

export function checkAdapterIndependence(files: DiffFile[]): Check {
  const reasons: string[] = [];
  for (const f of files) {
    const bad = uninspectable(f);
    const inAdapters = f.path.startsWith(ADAPTERS);
    const inConfig = f.path.startsWith("src/config/");
    if (bad) {
      if (inAdapters || !inConfig) reasons.push(`could not inspect ${f.path} (${bad})`);
      continue;
    }
    const prefix = basename(f.path).split(".")[0];
    for (const l of addedLines(f)) {
      if (inAdapters) {
        const imp = /\bfrom\s+["'](\.[^"']+)["']/.exec(l.text);
        if (imp) {
          const resolved = join(dirname(f.path), imp[1]);
          const target = basename(resolved).split(".")[0];
          if (resolved.startsWith(ADAPTERS) && target !== prefix && FORMATS.includes(target))
            reasons.push(`${f.path}:${l.line} imports other-format adapter file ${imp[1]}`);
        }
      }
      if (!inConfig && HOSTNAME_RE.test(l.text))
        reasons.push(`${f.path}:${l.line} host/url branching: ${l.text.trim()}`);
    }
  }
  return reasons.length ? flag("adapter-independence", reasons) : pass("adapter-independence");
}

// ---------- 6. canonical-pair ----------

const CTYPES = "src/types/canonical.types.ts";
const CSCHEMA = "src/types/canonical.schema.ts";

export function checkCanonicalPair(
  files: DiffFile[],
  planText: string | null,
  task: string,
): Check {
  const has = (p: string) => files.some((f) => f.path === p);
  if (!has(CTYPES) && !has(CSCHEMA)) return na("canonical-pair", "canonical files untouched");
  if (has(CTYPES) !== has(CSCHEMA))
    return flag("canonical-pair", [
      `${has(CTYPES) ? CTYPES : CSCHEMA} changed without ${has(CTYPES) ? CSCHEMA : CTYPES}`,
    ]);
  const reasons: string[] = [];
  const pats = planText ? filesBlockPatterns(planText, task) : null;
  if (!pats || !matchesPat(pats, CTYPES) || !matchesPat(pats, CSCHEMA))
    reasons.push("canonical change not named in the task's Files block");
  if (!/canonical/i.test(decisionsAdditions(files)))
    reasons.push("canonical change not logged in docs/decisions.md");
  return reasons.length
    ? flag("canonical-pair", reasons)
    : pass("canonical-pair", "types+schema together, named in task, logged in decisions");
}

// ---------- 7. secrets ----------

const SECRET_RES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9_-]{16,}/i,
];
const BODY_LOG_RE = /console\.log\(.*\b(body|prompt|completion|api_?key|authorization)\b/i;

export function checkSecrets(files: DiffFile[]): Check {
  const reasons: string[] = [];
  for (const f of files) {
    const bad = uninspectable(f);
    if (bad) {
      reasons.push(`could not inspect ${f.path} (${bad})`);
      continue;
    }
    for (const l of addedLines(f)) {
      if (SECRET_RES.some((r) => r.test(l.text)))
        reasons.push(`possible key/token literal: ${f.path}:${l.line}`);
      else if (BODY_LOG_RE.test(l.text))
        reasons.push(`console.log of body/prompt/key material: ${f.path}:${l.line}`);
    }
  }
  return reasons.length ? flag("secrets", reasons) : pass("secrets");
}

// ---------- 8. diff-stat ----------

export function claimedStatFiles(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split("\n")) {
    const m = /^\s*(.+?)\s*\|\s+(?:\d+|Bin\b)/.exec(l);
    if (!m) continue;
    let p = m[1].trim().replace(/^"|"$/g, "");
    const brace = /\{[^}]*=>\s*([^}]*)\}/.exec(p);
    if (brace) p = p.replace(/\{[^}]*=>[^}]*\}/, brace[1].trim());
    else if (p.includes("=>")) p = p.split("=>").pop()!.trim();
    if (p) out.push(p);
  }
  return out;
}

export function checkDiffStat(files: DiffFile[], claimedText: string | null): Check {
  if (claimedText === null)
    return na("diff-stat", "no claimed session output (--claimed / saved .out.md not found)");
  const claimed = claimedStatFiles(claimedText);
  if (!claimed.length)
    return flag("diff-stat", ["no git diff --stat block found in the claimed output"]);
  const actual = new Set(files.map((f) => f.path));
  const hit = (set: string[], p: string) =>
    set.some((c) => (c.startsWith("...") ? p.endsWith(c.slice(3)) : c === p));
  const unclaimed = [...actual].filter((p) => !hit(claimed, p));
  const absent = claimed.filter((c) => ![...actual].some((p) => hit([c], p)));
  const reasons: string[] = [];
  if (unclaimed.length) reasons.push(`in diff but not claimed: ${unclaimed.join(", ")}`);
  if (absent.length) reasons.push(`claimed but absent from diff: ${absent.join(", ")}`);
  return reasons.length
    ? flag("diff-stat", reasons)
    : pass("diff-stat", `${actual.size} file(s) match the claimed git diff --stat`);
}

// ---------- 9. owner-gate ----------

const OWNER_PATHS = [
  /^\.github\/workflows\//,
  /^LICENSE(\.|$)/,
  /^(CLA|Contributor-?License)(\.|$)/i,
  /^package(-lock)?\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^\.npmrc$/,
];

export function checkOwnerGate(files: DiffFile[], title: string): Check {
  const reasons: string[] = [];
  if (/\[OWNER[ _-](GATE|REVIEW)\]/i.test(title)) reasons.push(`title tag: "${title}"`);
  for (const f of files)
    if (OWNER_PATHS.some((r) => r.test(f.path)))
      reasons.push(`owner-gated path touched: ${f.path}`);
  return reasons.length ? flag("owner-gate", [...new Set(reasons)]) : pass("owner-gate");
}
