import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { babelgateGateway } from "./gateways/babelgate";
import { ccrGateway, ccrClientHeaders, CCR_VERSION } from "./gateways/ccr";
import {
  fccGateway,
  fccUnsupported,
  FCC_TAG,
  FCC_COMMIT,
} from "./gateways/free-claude-code";
import { freePort, type RunningGateway } from "./harness";
import {
  startMockUpstream,
  type MockRoute,
  type RecordedRequest,
} from "./mock-upstream";
import { sendTurn } from "./scenarios/client";
import { scenarios as streamedToolArgs } from "./scenarios/streamed-tool-args";
import { scenarios as thinkingAfterTool } from "./scenarios/thinking-after-tool";
import { scenarios as multiTurnReasoning } from "./scenarios/multi-turn-reasoning";
import type {
  GatewaySpec,
  Scenario,
  TurnResult,
} from "./scenarios/types";

/**
 * Competitor conformance run (v1.6 spec §3.10, plan Task 13b). The
 * default `npm run test:process` drives babelgate only; competitor
 * gateways join via CONFORMANCE_GATEWAYS (conformance-run.sh sets
 * `babelgate,ccr,free-claude-code`). No it.skip anywhere — cases are
 * generated only for selected gateways, and a dialect pair a gateway
 * cannot serve at all is recorded "not supported (per <url>)", never
 * a failure.
 */
const REPO = join(__dirname, "..", "..");
const TMP = join(REPO, "tmp", "conformance");

const ALL_SCENARIOS: Scenario[] = [
  ...thinkingAfterTool,
  ...streamedToolArgs,
  ...multiTurnReasoning,
];

const GATEWAYS: Record<string, GatewaySpec> = {
  babelgate: {
    adapter: babelgateGateway,
    models: { openai: "openai/mock-chat", gemini: "gemini/mock-gem" },
  },
  ccr: {
    adapter: ccrGateway,
    models: { openai: "mock-chat", gemini: "mock-gem" },
    clientHeaders: ccrClientHeaders,
  },
  "free-claude-code": {
    adapter: fccGateway,
    models: { openai: "mock-chat", gemini: "mock-gem" },
    unsupported: fccUnsupported,
  },
};

const GATEWAY_VERSIONS: Record<string, string> = {
  babelgate: `local build (${process.env.BABELGATE_BIN ?? "node dist/cli.js"})`,
  ccr: `@musistudio/claude-code-router ${CCR_VERSION} (npm, --ignore-scripts)`,
  "free-claude-code": `Alishahryar1/free-claude-code ${FCC_TAG} (${FCC_COMMIT.slice(0, 12)}, uv sync --frozen)`,
};

const selected = (process.env.CONFORMANCE_GATEWAYS ?? "babelgate")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const name of selected) {
  if (!(name in GATEWAYS)) {
    throw new Error(
      `CONFORMANCE_GATEWAYS: unknown gateway "${name}" ` +
        `(known: ${Object.keys(GATEWAYS).join(", ")})`,
    );
  }
}

/* ---- report collection ---- */

interface Cell {
  gateway: string;
  scenario: string;
  client: Scenario["client"];
  upstream: Scenario["upstream"];
  result: "pass" | "fail" | "not supported";
  reason?: string;
  evidence?: { request: unknown; response: unknown };
  /** "mock-only, unconfirmed" until conformance-live.sh confirms. */
  live: "pending" | "confirmed" | "not supported";
}
const cells: Cell[] = [];
const record = (cell: Cell): void => void cells.push(cell);

/** The mock routes a scenario needs — one replay file answers every
 * turn's upstream call in its dialect. */
function routesFor(s: Scenario): MockRoute[] {
  const reply = {
    status: 200,
    headers: {
      "content-type": s.replay.endsWith(".sse")
        ? "text/event-stream"
        : "application/json",
    },
    bodyFile: s.replay,
  };
  return s.upstream === "openai"
    ? [{ method: "POST", path: /chat\/completions$/, reply }]
    // streamed calls hit :streamGenerateContent ("Generate" capital G)
    : [{ method: "POST", path: /[gG]enerateContent/, reply }];
}

/** The same resolution order as mock-upstream.ts, checked up front so
 * a missing recorded replay fails with a clear reason instead of a
 * mid-request crash. */
function replayExists(replay: string): boolean {
  return [
    join(REPO, replay),
    join(REPO, "tests", replay),
    join(REPO, "tests", "process", "replays", replay),
    join(REPO, "tests", "fixtures", "streams", replay),
  ].some((p) => existsSync(p));
}

/* ---- live mode (scripts/research/conformance-live.sh) ----
 * CONFORMANCE_LIVE_UPSTREAM points the gateways' provider configs at
 * a local logging forward-proxy (the spy) instead of the replay mock;
 * the spy records every upstream request to CONFORMANCE_LIVE_SPY_LOG
 * as JSONL and forwards to the real provider. Replays are not
 * required in live mode. Model names come from
 * CONFORMANCE_LIVE_MODEL_{OPENAI,GEMINI} or CONFORMANCE_LIVE_MODEL.
 */
const LIVE_UPSTREAM = process.env.CONFORMANCE_LIVE_UPSTREAM;
const SPY_LOG = process.env.CONFORMANCE_LIVE_SPY_LOG;

function liveModel(
  gateway: string,
  upstream: Scenario["upstream"],
): string | undefined {
  const model =
    process.env[`CONFORMANCE_LIVE_MODEL_${upstream.toUpperCase()}`] ??
    process.env.CONFORMANCE_LIVE_MODEL;
  if (model === undefined) return undefined;
  // babelgate routes by "<provider>/<model>"; the others forward the
  // bare upstream model name.
  return gateway === "babelgate" ? `${upstream}/${model}` : model;
}

function modelsFor(
  spec: GatewaySpec,
  gatewayName: string,
): Record<"openai" | "gemini", string> {
  if (LIVE_UPSTREAM === undefined) return spec.models;
  return {
    openai: liveModel(gatewayName, "openai") ?? spec.models.openai,
    gemini: liveModel(gatewayName, "gemini") ?? spec.models.gemini,
  };
}

/** Append new spy-log entries to `requests` (live mode only). */
function syncSpyLog(requests: RecordedRequest[]): number {
  if (SPY_LOG === undefined || !existsSync(SPY_LOG)) return requests.length;
  const lines = readFileSync(SPY_LOG, "utf8").split("\n").filter(Boolean);
  for (const line of lines.slice(requests.length)) {
    const entry = JSON.parse(line) as RecordedRequest;
    requests.push(entry);
  }
  return requests.length;
}

async function runScenario(
  spec: GatewaySpec,
  gatewayName: string,
  scenario: Scenario,
): Promise<{ verdict: ReturnType<Scenario["assert"]>; results: TurnResult[] }> {
  const live = LIVE_UPSTREAM !== undefined;
  const upstream = live
    ? {
        url: LIVE_UPSTREAM,
        requests: [] as RecordedRequest[],
        close: () => Promise.resolve(),
      }
    : await startMockUpstream(routesFor(scenario));
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, `${spec.adapter.name} home-`));
  const models = modelsFor(spec, gatewayName);
  let gw: RunningGateway | undefined;
  const results: TurnResult[] = [];
  try {
    gw = await spec.adapter.start({
      upstream: upstream.url,
      port: await freePort(),
      workDir: dir,
      models,
    });
    for (let i = 0; i < scenario.turns.length; i += 1) {
      const prevCount = live
        ? syncSpyLog(upstream.requests)
        : upstream.requests.length;
      const result = await sendTurn(
        gw,
        models[scenario.upstream],
        spec.clientHeaders,
        scenario,
        i,
        results,
        upstream.requests,
      );
      if (live) {
        // the spy writes before forwarding, so every request for the
        // turn is on disk once the client stream completed — re-slice
        // against the refreshed log (sendTurn sliced a stale array)
        syncSpyLog(upstream.requests);
        result.upstream = upstream.requests.slice(prevCount).map((r) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(r.body);
          } catch {
            parsed = undefined;
          }
          return { url: r.url, body: parsed, rawBody: r.body };
        });
      }
      results.push(result);
    }
    return { verdict: scenario.assert(results), results };
  } finally {
    await gw?.stop();
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("conformance (spec §3.10)", () => {
  for (const gatewayName of selected) {
    const spec = GATEWAYS[gatewayName];
    for (const scenario of ALL_SCENARIOS) {
      const unsupported = spec.unsupported?.(
        scenario.client,
        scenario.upstream,
      );
      if (unsupported !== undefined) {
        it(`${gatewayName} ${scenario.name} is not supported`, () => {
          record({
            gateway: gatewayName,
            scenario: scenario.name,
            client: scenario.client,
            upstream: scenario.upstream,
            result: "not supported",
            reason: unsupported,
            live: "not supported",
          });
          expect(unsupported).toContain("per ");
        });
        continue;
      }
      it(`${gatewayName} passes ${scenario.name}`, async () => {
        if (LIVE_UPSTREAM === undefined && !replayExists(scenario.replay)) {
          record({
            gateway: gatewayName,
            scenario: scenario.name,
            client: scenario.client,
            upstream: scenario.upstream,
            result: "fail",
            reason: `replay ${scenario.replay} not recorded (conductor recording step)`,
            live: "pending",
          });
          throw new Error(
            `replay ${scenario.replay} not recorded — the conductor ` +
              `records it with npm run record:streams ` +
              `(RECORD_OUT_DIR=tests/process/replays)`,
          );
        }
        const { verdict } = await runScenario(spec, gatewayName, scenario);
        record({
          gateway: gatewayName,
          scenario: scenario.name,
          client: scenario.client,
          upstream: scenario.upstream,
          result: verdict.pass ? "pass" : "fail",
          reason: verdict.reason,
          evidence: verdict.evidence,
          live: "pending",
        });
        expect(
          verdict.pass,
          verdict.reason
            ? `${verdict.reason}\nevidence: ${JSON.stringify(verdict.evidence)}`
            : JSON.stringify(verdict.evidence),
        ).toBe(true);
      });
    }
  }
});

/* ---- report ---- */

const RESULTS_PATH = process.env.CONFORMANCE_RESULTS;
const REPORT_PATH = process.env.CONFORMANCE_REPORT;
const RUN_DATE = process.env.CONFORMANCE_DATE ?? new Date().toISOString().slice(0, 10);

function renderReport(): string {
  const gatewayNames = [...new Set(cells.map((c) => c.gateway))];
  const scenarioNames = [...new Set(cells.map((c) => c.scenario))];
  const rows = scenarioNames.map((s) => {
    const cols = gatewayNames.map((g) => {
      const cell = cells.find((c) => c.gateway === g && c.scenario === s);
      if (!cell) return "—";
      if (cell.result === "not supported") return `not supported`;
      if (cell.result === "pass") return "pass (mock)";
      if (cell.reason?.startsWith("replay ")) return "replay pending";
      return cell.live === "confirmed"
        ? "fail (live-confirmed)"
        : "fail (mock-only, unconfirmed)";
    });
    return `| ${s} | ${cols.join(" | ")} |`;
  });
  const lines: string[] = [
    `# Conformance run — ${RUN_DATE} — DRAFT`,
    "",
    "Draft per spec §3.10/D9: private to the PR; publishing decisions",
    "are the owner's. Competitor failures are mock-only, unconfirmed",
    "until scripts/research/conformance-live.sh confirms them against",
    "the live provider.",
    "",
    "## Versions",
    "",
  ];
  for (const g of gatewayNames) {
    lines.push(`- ${g}: ${GATEWAY_VERSIONS[g] ?? "unknown"}`);
  }
  lines.push("", `## Scenario × gateway`, "", `| scenario | ${gatewayNames.join(" | ")} |`);
  lines.push(`| ${gatewayNames.map(() => "---").join(" | ")} |`);
  lines.push(...rows);
  lines.push("", "## Failing cells (shapes only)", "");
  const failures = cells.filter((c) => c.result === "fail");
  if (failures.length === 0) {
    lines.push("- none");
  }
  for (const f of failures) {
    lines.push(
      `- ${f.gateway} / ${f.scenario}: ${f.reason ?? "failed"}`,
      `  - repro: CONFORMANCE_GATEWAYS=${f.gateway} npm run test:process -- conformance.process.test.ts`,
    );
    if (f.evidence !== undefined) {
      lines.push(
        `  - request shape: \`${JSON.stringify(f.evidence.request)}\``,
        `  - response shape: \`${JSON.stringify(f.evidence.response)}\``,
      );
    }
  }
  lines.push("", "## Live confirmation", "");
  if (failures.length === 0) {
    lines.push("- none");
  }
  for (const f of failures) {
    lines.push(
      `- ${f.gateway} / ${f.scenario}: \`scripts/research/conformance-live.sh ${f.gateway} "${f.scenario}"\``,
    );
  }
  const unsupported = cells.filter((c) => c.result === "not supported");
  if (unsupported.length > 0) {
    lines.push("", "## Not supported", "");
    for (const u of unsupported) {
      lines.push(`- ${u.gateway} / ${u.scenario}: ${u.reason}`);
    }
  }
  lines.push(
    "",
    "## Reproduce",
    "",
    "```sh",
    "CONFORMANCE_GATEWAYS=babelgate,ccr,free-claude-code npm run test:process -- conformance.process.test.ts",
    "scripts/research/conformance-run.sh   # installs pinned competitors, runs, rewrites this report",
    "```",
    "",
  );
  return lines.join("\n");
}

afterAll(() => {
  if (cells.length === 0) return;
  mkdirSync(TMP, { recursive: true });
  const payload = {
    date: RUN_DATE,
    gateways: Object.fromEntries(
      selected.map((g) => [g, GATEWAY_VERSIONS[g] ?? "unknown"]),
    ),
    cells,
  };
  if (RESULTS_PATH) {
    writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2) + "\n");
  }
  if (REPORT_PATH) {
    writeFileSync(REPORT_PATH, renderReport());
  }
});
