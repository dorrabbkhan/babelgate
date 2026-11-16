/**
 * usage-report.ts — per-session and per-task Claude Code usage (spec §3.0.5,
 * evidence E9–E11).
 *
 *   scripts/conductor/usage-report.sh [--since YYYY-MM-DD] [--version vX.Y]
 *                                     [--json] [--projects-dir <dir>]
 *
 * Reads ~/.claude/projects/<repo-slug>/*.jsonl where the slug is the repo's
 * absolute path with "/" → "-" (as Claude Code names it). Override with
 * --projects-dir or CLAUDE_PROJECTS_DIR — tests point it at synthetic
 * fixtures under scripts/conductor/fixtures/usage/; real session logs are
 * never copied into the repo (they contain prompt bodies).
 *
 * A session is attributed to <version>-task<N> by the first `/conduct <v> <N>`
 * or `<v>-task<N>` mention in a user message, else `unattributed`.
 * Output is aggregates only — counts, tokens, $, tool names. Never prompt
 * text, never tool inputs or outputs.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// USD per 1M tokens (spec §3.0.5 price table).
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite1h: number }> = {
  "opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite1h: 8 },
  "sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite1h: 4 },
  "haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite1h: 0.2 },
};

export interface Turn {
  model: string;
  modelKey: keyof typeof PRICES | "other";
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  ctx: number; // input + cacheRead + cacheWrite
  ts: string;
}

export interface Session {
  id: string;
  file: string;
  task: string;
  turns: Turn[]; // the session's own turns
  subagentTurns: Turn[]; // turns from <id>/subagents/*.jsonl, priced by their own model
  tools: Map<string, number>;
}

const modelKey = (m: unknown): Turn["modelKey"] => {
  const s = typeof m === "string" ? m : "";
  if (s.includes("opus")) return "opus-5-5";
  if (s.includes("sonnet")) return "sonnet-5-5";
  if (s.includes("haiku")) return "haiku-5-5";
  return "other";
};

/** Tool-call buckets, per E11's mix (grep / diff reads / file reads / CI-Devin waits / Devin). */
function toolBucket(name: string, command: unknown): string {
  const cmd = typeof command === "string" ? command : "";
  if (name === "Grep" || /^(rg|grep|find|fd)\b/.test(cmd)) return "grep";
  if (/\b(git\s+diff|git\s+show|gh\s+pr\s+diff)\b/.test(cmd)) return "diff-read";
  if (name === "Read") return "file-read";
  if (/\b(gh\s+pr\s+checks|gh\s+run\s+(view|watch)|wait-ci)\b/.test(cmd)) return "ci-wait";
  if (/\bdevin(\.sh)?\b/.test(cmd)) return "devin";
  if (name === "Bash") return "bash";
  return name;
}

interface LogEvent {
  type?: string;
  timestamp?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

function userText(ev: LogEvent): string {
  const c = ev.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .filter((b): b is { type: string; text: string } => !!b && b.type === "text")
      .map((b) => b.text)
      .join("\n");
  return "";
}

function readEvents(file: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEvent);
    } catch {
      // malformed log line — skip it, never fail the report on one bad event
    }
  }
  return out;
}

const TASK_RES = [
  /\/conduct\s+(v[\w.]+)\s+(\w+)/,
  /\b(v\d[\d.]*)-task(\w+)\b/,
];

/** The <version>-task<N> a session belongs to, else "unattributed". */
export function attributeTask(file: string): string {
  for (const ev of readEvents(file)) {
    if (ev.type !== "user") continue;
    const text = userText(ev);
    for (const re of TASK_RES) {
      const m = re.exec(text);
      if (m) return `${m[1]}-task${m[2]}`;
    }
  }
  return "unattributed";
}

export function parseSession(file: string): Session {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  const tools = new Map<string, number>();
  for (const ev of readEvents(file)) {
    if (ev.type !== "assistant" || !ev.message?.usage) continue;
    const u = ev.message.usage;
    const input = u.input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const turn: Turn = {
      model: ev.message.model ?? "?",
      modelKey: modelKey(ev.message.model),
      input,
      cacheRead,
      cacheWrite,
      output: u.output_tokens ?? 0,
      ctx: input + cacheRead + cacheWrite,
      ts: ev.timestamp ?? "",
    };
    // Claude Code writes one JSONL line per assistant content block, all
    // repeating the same message.id and usage — count usage once per
    // message.id (the last line's), tool_use blocks from every line.
    const msgId = ev.message.id;
    if (msgId) {
      const seen = byId.get(msgId);
      if (seen) Object.assign(seen, turn);
      else {
        byId.set(msgId, turn);
        turns.push(turn);
      }
    } else {
      turns.push(turn);
    }
    const content = ev.message.content;
    if (Array.isArray(content))
      for (const b of content)
        if (b && b.type === "tool_use") {
          const k = toolBucket(String(b.name ?? "?"), b.input?.command);
          tools.set(k, (tools.get(k) ?? 0) + 1);
        }
  }
  return {
    id: basename(file).replace(/\.jsonl$/, ""),
    file,
    task: attributeTask(file),
    turns,
    subagentTurns: [],
    tools,
  };
}

/** The session's own turns plus its subagent sidechain turns. */
export const allTurns = (s: Session): Turn[] => s.turns.concat(s.subagentTurns);

export function loadSessions(dir: string): Session[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => {
      const s = parseSession(join(dir, f));
      // Sidechain logs: <projects-dir>/<sessionId>/subagents/*.jsonl — their
      // turns belong to this session (priced by their own model).
      const sub = join(dir, f.replace(/\.jsonl$/, ""), "subagents");
      if (existsSync(sub))
        for (const g of readdirSync(sub).filter((x) => x.endsWith(".jsonl")).sort()) {
          const t = parseSession(join(sub, g));
          s.subagentTurns.push(...t.turns);
          for (const [k, n] of t.tools) s.tools.set(k, (s.tools.get(k) ?? 0) + n);
        }
      return s;
    });
}

const MILLION = 1_000_000;

function turnCost(t: Turn): number {
  const p = PRICES[t.modelKey as keyof typeof PRICES];
  if (!p) return 0;
  return (
    (t.input * p.in + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite1h + t.output * p.out) /
    MILLION
  );
}

/** Cost of the session's own turns — subagent turns via totalCost. */
export function sessionCost(s: Session, opusOnly = false): number {
  return s.turns
    .filter((t) => !opusOnly || t.modelKey === "opus-5-5")
    .reduce((a, t) => a + turnCost(t), 0);
}

/** Cost of all turns including subagent sidechains. */
export function totalCost(s: Session, opusOnly = false): number {
  return allTurns(s)
    .filter((t) => !opusOnly || t.modelKey === "opus-5-5")
    .reduce((a, t) => a + turnCost(t), 0);
}

export function firstTurnContext(s: Session): number {
  return s.turns.length ? s.turns[0].ctx : 0;
}

const meanCtx = (s: Session) => {
  const turns = allTurns(s);
  return turns.length ? turns.reduce((a, t) => a + t.ctx, 0) / turns.length : 0;
};

interface Agg {
  sessions: number;
  turns: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  usd: number;
  ctxFirstMedian: number;
  ctxMeanMedian: number;
  tools: [string, number][];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function aggregate(sessions: Session[], opusOnly: boolean): Agg {
  const sums = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 };
  const tools = new Map<string, number>();
  let used = 0;
  const firsts: number[] = [];
  const means: number[] = [];
  for (const s of sessions) {
    const turns = allTurns(s).filter((t) => !opusOnly || t.modelKey === "opus-5-5");
    if (!turns.length) continue;
    used++;
    firsts.push(turns[0].ctx);
    means.push(turns.reduce((a, t) => a + t.ctx, 0) / turns.length);
    for (const t of turns) {
      sums.turns++;
      sums.input += t.input;
      sums.cacheRead += t.cacheRead;
      sums.cacheWrite += t.cacheWrite;
      sums.output += t.output;
      sums.usd += turnCost(t);
    }
    for (const [k, n] of s.tools) tools.set(k, (tools.get(k) ?? 0) + n);
  }
  return {
    sessions: used,
    ...sums,
    ctxFirstMedian: median(firsts),
    ctxMeanMedian: median(means),
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]),
  };
}

const fmt = (n: number) =>
  Math.abs(n) >= MILLION
    ? `${(n / MILLION).toFixed(2)}M`
    : Math.abs(n) >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(Math.round(n));
const usd = (n: number) => n.toFixed(3);
const toolsTop = (t: [string, number][], n = 5) =>
  t.slice(0, n)
    .map(([k, c]) => `${k}:${c}`)
    .join(" ");

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const rpad = (s: string | number, n: number) => String(s).padStart(n).slice(0, n);

export interface RenderOpts {
  since?: string;
  version?: string;
  projectsDir?: string;
}

/** The --since/--version filter shared by render() and toJson(). */
function filterSessions(sessions: Session[], opts: RenderOpts): Session[] {
  const since = opts.since ? new Date(`${opts.since}T00:00:00Z`).getTime() : -Infinity;
  const after = (t: Turn) => !t.ts || new Date(t.ts).getTime() >= since;
  return sessions
    .map((s) => ({
      ...s,
      turns: s.turns.filter(after),
      subagentTurns: s.subagentTurns.filter(after),
    }))
    .filter(
      (s) =>
        (s.turns.length || s.subagentTurns.length) &&
        (!opts.version || s.task === opts.version || s.task.startsWith(`${opts.version}-task`)),
    );
}

export function render(sessions: Session[], opts: RenderOpts): string {
  const kept = filterSessions(sessions, opts);

  const out: string[] = [];
  out.push(
    `usage report · projects ${opts.projectsDir ?? "?"} · ${kept.length} session(s)` +
      ` · since ${opts.since ?? "all"} · version ${opts.version ?? "all"}`,
  );
  out.push("");
  out.push("sessions");
  out.push(
    `${pad("session", 22)}${pad("task", 16)}${rpad("turns", 6)}${rpad("$", 9)}` +
      `${rpad("ctx-first", 10)}${rpad("ctx-mean", 10)}  tool mix`,
  );
  for (const s of kept)
    out.push(
      `${pad(s.id, 22)}${pad(s.task, 16)}${rpad(allTurns(s).length, 6)}${rpad(usd(totalCost(s)), 9)}` +
        `${rpad(fmt(firstTurnContext(s)), 10)}${rpad(fmt(meanCtx(s)), 10)}  ` +
        toolsTop([...s.tools.entries()].sort((a, b) => b[1] - a[1])),
    );

  const byTask = new Map<string, Session[]>();
  for (const s of kept) {
    const arr = byTask.get(s.task) ?? [];
    arr.push(s);
    byTask.set(s.task, arr);
  }
  for (const [label, opus] of [
    ["per task (all models)", false],
    ["per task (opus only)", true],
  ] as const) {
    out.push("");
    out.push(label);
    out.push(
      `${pad("task", 18)}${rpad("sess", 5)}${rpad("turns", 7)}${rpad("input", 8)}` +
        `${rpad("cache-rd", 10)}${rpad("cache-wr", 10)}${rpad("output", 9)}${rpad("$", 9)}` +
        `${rpad("ctx1~", 9)}${rpad("ctxμ~", 9)}  tool mix`,
    );
    for (const [task, ss] of [...byTask.entries()].sort()) {
      const a = aggregate(ss, opus);
      if (!a.sessions) continue;
      out.push(
        `${pad(task, 18)}${rpad(a.sessions, 5)}${rpad(a.turns, 7)}${rpad(fmt(a.input), 8)}` +
          `${rpad(fmt(a.cacheRead), 10)}${rpad(fmt(a.cacheWrite), 10)}${rpad(fmt(a.output), 9)}` +
          `${rpad(usd(a.usd), 9)}${rpad(fmt(a.ctxFirstMedian), 9)}${rpad(fmt(a.ctxMeanMedian), 9)}  ` +
          toolsTop(a.tools),
      );
    }
  }
  return out.join("\n");
}

export function toJson(sessions: Session[], opts: RenderOpts): string {
  const kept = filterSessions(sessions, opts);
  const byTask = new Map<string, Session[]>();
  for (const s of kept) {
    const arr = byTask.get(s.task) ?? [];
    arr.push(s);
    byTask.set(s.task, arr);
  }
  return JSON.stringify(
    {
      projectsDir: opts.projectsDir,
      since: opts.since ?? null,
      version: opts.version ?? null,
      sessions: kept.map((s) => ({
        id: s.id,
        task: s.task,
        turns: allTurns(s).length,
        usd: totalCost(s),
        usdOpus: totalCost(s, true),
        ctxFirst: firstTurnContext(s),
        ctxMean: meanCtx(s),
        tools: Object.fromEntries(s.tools),
      })),
      tasks: Object.fromEntries(
        [...byTask.entries()].map(([t, ss]) => [
          t,
          { total: aggregate(ss, false), opus: aggregate(ss, true) },
        ]),
      ),
    },
    null,
    2,
  );
}

function repoSlug(): string {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return root.replaceAll("/", "-");
}

function main(argv: string[]): number {
  const opts: RenderOpts & { json?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--version") opts.version = argv[++i];
    else if (a === "--projects-dir") opts.projectsDir = argv[++i];
    else {
      process.stderr.write(
        "usage: usage-report.ts [--since YYYY-MM-DD] [--version vX.Y] [--json] [--projects-dir <dir>]\n",
      );
      return 2;
    }
  }
  const dir =
    opts.projectsDir ??
    process.env.CLAUDE_PROJECTS_DIR ??
    join(homedir(), ".claude", "projects", repoSlug());
  const sessions = loadSessions(dir);
  const out = opts.json
    ? toJson(sessions, { ...opts, projectsDir: dir })
    : render(sessions, { ...opts, projectsDir: dir });
  process.stdout.write(out + "\n");
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
