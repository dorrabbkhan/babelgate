/**
 * The release gates' observability half (spec §4.5): after a gate's
 * edit task, assert the running babelgate instance recorded what the
 * gate promises — a usage row for the client since start, the
 * four-stage inspector body on the latest row, a moved
 * babelgate_requests_total, and whichever --expect-* flags name.
 *
 *   ts-node scripts/gates/observe-check.ts --base <url> --client <id>
 *     [--since <epoch-ms>] [--expect-cost] [--expect-cache-read]
 *     [--expect-providers a,b] [--expect-saved]
 *
 * Exit 0 prints "OBSERVE PASS"; exit 1 prints "OBSERVE FAIL: <the
 * failed expectation>"; exit 2 is a usage error. Loopback only — the
 * script sends `x-babelgate-ui: 1` and expects no PROXY_API_KEY (the
 * gate scripts run that way). It reads row columns and counter values
 * only — never prompt bodies, completions or keys.
 */
import { parseArgs } from "node:util";

const UI_HEADERS = { "x-babelgate-ui": "1" } as const;
const ROW_POLL_MS = 250;
const ROW_DEADLINE_MS = 15_000;
const FETCH_TIMEOUT_MS = 5_000;

/** The request row columns this check reads (GET /ui/api/requests). */
export interface ObserveRow {
  id: string;
  startedAt: number;
  provider: string | null;
  costUsd: number | null;
  wouldCostUsd: number | null;
  cacheReadTokens: number | null;
}

/** The inspector body of GET /ui/api/requests/<id> (the §3.5 stages). */
export interface InspectorBodies {
  source?: { value: unknown };
  canonical?: { value: unknown };
  target: { value: unknown }[];
  response?: {
    canonical?: { value: unknown };
    wire?: { value: unknown };
  };
}

export interface ObserveFlags {
  client: string;
  expectCost: boolean;
  expectCacheRead: boolean;
  expectProviders: string[];
  expectSaved: boolean;
}

/**
 * The check list, in order. `rows` are the client's rows since start
 * (newest first), `bodies` the latest row's inspector body (null when
 * nothing was retained), `requestsTotal` the babelgate_requests_total
 * sum scraped from /metrics. Returns the failed expectation's name and
 * reason, or null when everything holds.
 */
export function evaluateObservations(
  flags: ObserveFlags,
  rows: ObserveRow[],
  bodies: InspectorBodies | null,
  requestsTotal: number,
): string | null {
  if (rows.length === 0) {
    return `no request row for client "${flags.client}"`;
  }
  if (
    bodies === null ||
    bodies.source === undefined ||
    bodies.canonical === undefined ||
    bodies.target.length === 0 ||
    (bodies.response?.canonical === undefined &&
      bodies.response?.wire === undefined)
  ) {
    return "latest request has no four-stage inspector body (source/canonical/target/response)";
  }
  if (requestsTotal <= 0) {
    return "babelgate_requests_total is 0 on /metrics";
  }
  if (flags.expectCost && !rows.some((r) => r.costUsd !== null)) {
    return "--expect-cost: no row has cost_usd";
  }
  if (
    flags.expectCacheRead &&
    !rows.some((r) => (r.cacheReadTokens ?? 0) > 0)
  ) {
    return "--expect-cache-read: no row has cache_read_tokens > 0";
  }
  for (const provider of flags.expectProviders) {
    if (!rows.some((r) => r.provider === provider)) {
      return `--expect-providers: no row was served by "${provider}"`;
    }
  }
  if (flags.expectSaved && !rows.some((r) => r.wouldCostUsd !== null)) {
    return "--expect-saved: no row has a would-have-cost figure";
  }
  return null;
}

/**
 * Sum one counter family out of a Prometheus text exposition: every
 * `name{...} <value>` (and a bare `name <value>`) sample, comments
 * skipped.
 */
export function metricTotal(exposition: string, name: string): number {
  let total = 0;
  for (const line of exposition.split("\n")) {
    if (line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)\s*$/.exec(
      line,
    );
    if (match?.[1] === name) {
      const value = Number(match[3]);
      if (Number.isFinite(value)) total += value;
    }
  }
  return total;
}

interface CliArgs extends ObserveFlags {
  base: string;
  since?: number;
}

function usage(): never {
  console.error(
    "usage: observe-check.ts --base <url> --client <id> " +
      "[--since <epoch-ms>] [--expect-cost] [--expect-cache-read] " +
      "[--expect-providers a,b] [--expect-saved]",
  );
  process.exit(2);
}

function parseCli(argv: string[]): CliArgs {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        base: { type: "string" },
        client: { type: "string" },
        since: { type: "string" },
        "expect-cost": { type: "boolean", default: false },
        "expect-cache-read": { type: "boolean", default: false },
        "expect-providers": { type: "string" },
        "expect-saved": { type: "boolean", default: false },
      },
    });
    if (values.base === undefined || values.client === undefined) {
      usage();
    }
    let since: number | undefined;
    if (values.since !== undefined) {
      since = Number(values.since);
      if (!Number.isFinite(since)) usage();
    }
    return {
      base: values.base!.replace(/\/+$/, ""),
      client: values.client!,
      ...(since !== undefined && { since }),
      expectCost: values["expect-cost"]!,
      expectCacheRead: values["expect-cache-read"]!,
      expectProviders: (values["expect-providers"] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== ""),
      expectSaved: values["expect-saved"]!,
    };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return usage();
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: UI_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${url} answered ${res.status}`);
  }
  return res.json();
}

async function fetchRows(args: CliArgs): Promise<ObserveRow[]> {
  const data = (await fetchJson(
    `${args.base}/ui/api/requests?client=${encodeURIComponent(args.client)}&limit=500`,
  )) as { rows?: ObserveRow[] };
  const rows = data.rows ?? [];
  return args.since === undefined
    ? rows
    : rows.filter((r) => r.startedAt >= args.since!);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));

  // The store flushes every 250 ms — poll briefly so the gate's last
  // request lands before the check reads.
  let rows: ObserveRow[] = [];
  const deadline = Date.now() + ROW_DEADLINE_MS;
  for (;;) {
    try {
      rows = await fetchRows(args);
    } catch (err) {
      console.error(
        `OBSERVE FAIL: cannot reach ${args.base}/ui/api/requests: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(1);
    }
    if (rows.length > 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, ROW_POLL_MS));
  }

  let bodies: InspectorBodies | null = null;
  if (rows.length > 0) {
    const detail = (await fetchJson(
      `${args.base}/ui/api/requests/${encodeURIComponent(rows[0]!.id)}`,
    )) as { bodies?: InspectorBodies | null };
    bodies = detail.bodies ?? null;
  }

  const metrics = await fetch(`${args.base}/metrics`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then((res) => (res.ok ? res.text() : ""));
  const requestsTotal = metricTotal(metrics, "babelgate_requests_total");

  const failure = evaluateObservations(args, rows, bodies, requestsTotal);
  if (failure !== null) {
    console.error(`OBSERVE FAIL: ${failure}`);
    process.exit(1);
  }
  const providers = [
    ...new Set(rows.map((r) => r.provider).filter((p) => p !== null)),
  ].sort();
  console.log(
    `OBSERVE PASS — ${rows.length} row(s) for ${args.client}, ` +
      `providers: ${providers.join(",") || "none"}`,
  );
}

// Run only as a script; the test file imports the pure helpers above.
if (require.main === module) {
  main().catch((err) => {
    console.error(
      `OBSERVE FAIL: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
