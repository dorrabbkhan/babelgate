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
import {
  babelgateGateway,
  babelgateDefaultGateway,
} from "./gateways/babelgate";
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
import { sendTurn, upstreamRequestFrom } from "./scenarios/client";
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
  "babelgate-default": {
    adapter: babelgateDefaultGateway,
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
  "babelgate-default": `local build (${process.env.BABELGATE_BIN ?? "node dist/cli.js"})`,
  ccr: `@musistudio/claude-code-router ${CCR_VERSION} (npm, --ignore-scripts)`,
  "free-claude-code": `Alishahryar1/free-claude-code ${FCC_TAG} (${FCC_COMMIT.slice(0, 12)}, uv sync --frozen)`,
};

/**
 * Non-default settings the run used, per gateway — the report's
 * Configuration section (D9: every claim must disclose how the
 * gateway was configured). A gateway absent from the list ran its
 * stock defaults.
 */
const GATEWAY_CONFIG_NOTES: Record<string, string[]> = {
  babelgate: [
    "`reasoning_passback: true` on the mock `openai` and `ollama` " +
      "provider entries — the spec §3.3 opt-in for Chat " +
      "`reasoning_content` passback (docs/recipes/codex.md). " +
      "Everything else is the stock default config.",
  ],
  "babelgate-default": [
    "unchanged default config — `reasoning_passback` unset on every " +
      "provider entry (its spec §3.3 default is off).",
  ],
  ccr: [
    "no reasoning or transformer option is set — v3.1.6 documents " +
      "none for `openai_chat_completions` or `gemini_generate_content` " +
      "providers: checked the package `README.md` and the docs source " +
      "`docs/src/content/docs/en/configuration/providers.md` at tag " +
      "`v3.1.6` (https://github.com/musistudio/claude-code-router/tree/v3.1.6" +
      " — published as https://ccrdesk.top/en/configuration/providers/). " +
      "The provider entries carry `name`, `type`, `apikey`, `baseurl` " +
      "and `models` only.",
  ],
  "free-claude-code": [
    "`reasoning_history_format: \"reasoning_content\"` on the custom " +
      "provider (its default is `\"disabled\"` — " +
      "`src/free_claude_code/config/custom_providers.py` at " +
      `${FCC_TAG}, https://github.com/Alishahryar1/free-claude-code) ` +
      "— the DeepSeek wire field for replaying reasoning " +
      "(https://api-docs.deepseek.com/guides/reasoning_model).",
  ],
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
  /**
   * "fail" only when a doc-cited rule broke (D9); a broken rule with
   * no citing doc is "differs" — an observation, never a failure.
   * `babelgate` stays exact: any broken rule is a failure for it.
   */
  result: "pass" | "fail" | "differs" | "not supported";
  reason?: string;
  /** The exact missing/extra field path for the one-line cell. */
  detail?: string;
  /** The doc URL the broken rule cites, when it cites one. */
  ruleDoc?: string;
  evidence?: { request: unknown; response: unknown };
  /** "mock-only, unconfirmed" until conformance-live.sh confirms;
   * "n/a" on observations — nothing is claimed, nothing to confirm. */
  live: "pending" | "confirmed" | "not supported" | "n/a";
}
const cells: Cell[] = [];
const record = (cell: Cell): void => void cells.push(cell);

/**
 * Competitor-facing classification (D9): a check counts as a failure
 * only when its rule cites a doc that requires the behaviour. For
 * `babelgate` itself the gate stays at least as exact — every broken
 * rule fails it (our own spec is stricter than public docs).
 */
function cellResult(
  gateway: string,
  verdict: { pass: boolean; rule?: { doc?: string } },
): Cell["result"] {
  if (verdict.pass) return "pass";
  if (gateway !== "babelgate" && verdict.rule?.doc === undefined) {
    return "differs";
  }
  return "fail";
}

/** The vitest side of the same rule: `babelgate` asserts on every
 * broken rule; the rest only on doc-cited ones — an observation
 * ("differs") does not fail the suite. */
function assertable(result: Cell["result"], pass: boolean): boolean {
  return result === "differs" ? true : pass;
}

/** The mock routes a scenario needs — one replay file answers every
 * turn's upstream call in its dialect. */
function routesFor(s: Scenario): MockRoute[] {
  const streamReply = {
    status: 200,
    headers: {
      "content-type": s.replay.endsWith(".sse")
        ? "text/event-stream"
        : "application/json",
    },
    bodyFile: s.replay,
  };
  if (s.upstream === "openai") {
    // Every gateway calls Chat with stream:true — the recorded
    // upstream request bodies show no "stream":false caller (fix
    // round 3), so one streaming route.
    return [
      { method: "POST", path: /chat\/completions$/, reply: streamReply },
    ];
  }
  // Gemini splits streaming from non-streaming in the path itself
  // (:streamGenerateContent vs :generateContent — CCR calls the
  // non-streaming endpoint, seen in the live spy log). Each gets its
  // own replay: the recorded SSE for streamed calls, the recorded
  // non-streaming twin for plain calls — a non-streaming call never
  // gets SSE (fix round 3).
  const twin = s.replay.endsWith(".sse")
    ? s.replay.replace(/\.sse$/, ".nonstreaming.json")
    : s.replay;
  return [
    {
      method: "POST",
      path: /:streamGenerateContent/,
      reply: streamReply,
    },
    {
      method: "POST",
      path: /:generateContent/,
      reply: {
        status: 200,
        headers: { "content-type": "application/json" },
        bodyFile: twin,
        missingBodyFile:
          `non-streaming replay not recorded: ${twin} — the conductor ` +
          `records it with npm run record:streams ` +
          `RECORD_OUT_DIR=tests/process/replays ` +
          `RECORD_PROVIDERS=gemini RECORD_TWINS_ONLY=1`,
      },
    },
  ];
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
  return gateway.startsWith("babelgate") ? `${upstream}/${model}` : model;
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
        // against the refreshed log (sendTurn sliced a stale array).
        // upstreamRequestFrom carries the spy's shape-only response
        // summary into responseHadReasoning.
        syncSpyLog(upstream.requests);
        result.upstream = upstream.requests
          .slice(prevCount)
          .map((r) => upstreamRequestFrom(r, scenario.upstream));
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
        const result = cellResult(gatewayName, verdict);
        record({
          gateway: gatewayName,
          scenario: scenario.name,
          client: scenario.client,
          upstream: scenario.upstream,
          result,
          reason: verdict.reason,
          detail: verdict.detail,
          ruleDoc: verdict.rule?.doc,
          evidence: verdict.evidence,
          live: result === "differs" ? "n/a" : "pending",
        });
        expect(
          assertable(result, verdict.pass),
          verdict.reason
            ? `${verdict.reason}\nevidence: ${JSON.stringify(verdict.evidence)}`
            : JSON.stringify(verdict.evidence),
        ).toBe(true);
      });
    }
  }
});

/* ---- mock route split (fix round 3) ----
 * Offline regression: Gemini's streaming vs non-streaming endpoints
 * get different replays. A :streamGenerateContent call gets the
 * recorded SSE bytes verbatim; a :generateContent call gets the
 * recorded non-streaming twin — and until the conductor records it,
 * a clear 502 "non-streaming replay not recorded", never SSE. */
describe("mock upstream gemini route split", () => {
  it("streams SSE to :streamGenerateContent and never to :generateContent", async () => {
    const scenario = ALL_SCENARIOS.find(
      (s) => s.upstream === "gemini" && s.replay.endsWith(".sse"),
    );
    expect(scenario).toBeDefined();
    const upstream = await startMockUpstream(routesFor(scenario!));
    try {
      const sseRes = await fetch(
        `${upstream.url}/v1beta/models/mock-gem:streamGenerateContent?alt=sse`,
        { method: "POST", body: "{}" },
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      // The replay is served byte-for-byte.
      expect(await sseRes.text()).toBe(
        readFileSync(
          join(REPO, "tests", "process", "replays", scenario!.replay),
          "utf8",
        ),
      );

      const jsonRes = await fetch(
        `${upstream.url}/v1beta/models/mock-gem:generateContent`,
        { method: "POST", body: "{}" },
      );
      const twin = scenario!.replay.replace(/\.sse$/, ".nonstreaming.json");
      if (replayExists(twin)) {
        expect(jsonRes.status).toBe(200);
        expect(jsonRes.headers.get("content-type")).toContain(
          "application/json",
        );
        expect((await jsonRes.text()).startsWith("data:")).toBe(false);
      } else {
        // Until the twin is recorded the non-streaming call fails
        // with a clear error — never the SSE replay.
        expect(jsonRes.status).toBe(502);
        expect(await jsonRes.text()).toContain(
          "non-streaming replay not recorded",
        );
      }
    } finally {
      await upstream.close();
    }
  });
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
      if (cell.result === "differs") return "differs (observed)";
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
    "are the owner's. A \"fail\" is only ever a check a cited provider",
    "doc requires; a check no doc requires is reported as an",
    "observation (`differs`), never a failure. Failures are mock-only,",
    "unconfirmed until scripts/research/conformance-live.sh confirms",
    "them against the live provider.",
    "",
    "## Versions",
    "",
  ];
  for (const g of gatewayNames) {
    lines.push(`- ${g}: ${GATEWAY_VERSIONS[g] ?? "unknown"}`);
  }
  lines.push(
    "",
    "## Configuration",
    "",
    "Every non-default setting the run used, per gateway, with the",
    "doc that documents it.",
    "",
  );
  for (const g of gatewayNames) {
    for (const note of GATEWAY_CONFIG_NOTES[g] ?? [
      "stock defaults — nothing non-default configured.",
    ]) {
      lines.push(`- ${g}: ${note}`);
    }
  }
  lines.push(
    "",
    "## Rules",
    "",
    "Per scenario, what is checked and the doc that requires it. A",
    "rule with no citing doc is an observation: it can produce",
    "`differs`, never `fail`.",
    "",
  );
  for (const s of ALL_SCENARIOS) {
    lines.push(`- ${s.name}`);
    for (const r of s.rules) {
      lines.push(`  - ${r.check}${r.doc !== undefined ? ` (${r.doc})` : ` — ${r.note ?? "no doc cited"}`}`);
    }
  }
  lines.push(
    "",
    `## Scenario × gateway`,
    "",
    `| scenario | ${gatewayNames.join(" | ")} |`,
  );
  lines.push(
    `| ${["---", ...gatewayNames.map(() => "---")].join(" | ")} |`,
  );
  lines.push(...rows);
  lines.push("", "## Failing cells", "");
  const failures = cells.filter((c) => c.result === "fail");
  if (failures.length === 0) {
    lines.push("- none");
  }
  for (const f of failures) {
    lines.push(
      `- ${f.gateway} / ${f.scenario}: ${f.reason ?? "failed"}` +
        `${f.detail ? ` — ${f.detail}` : ""}` +
        `${f.ruleDoc ? ` (rule: ${f.ruleDoc})` : ""}`,
      `  - repro: CONFORMANCE_GATEWAYS=${f.gateway} npm run test:process -- conformance.process.test.ts`,
    );
  }
  const differs = cells.filter((c) => c.result === "differs");
  if (differs.length > 0) {
    lines.push(
      "",
      "## Observed differences",
      "",
      "Not failures — no cited doc requires the behaviour (Rules).",
      "",
    );
    for (const d of differs) {
      lines.push(
        `- ${d.gateway} / ${d.scenario}: differs — ` +
          `${d.reason ?? "differed"}${d.detail ? ` (${d.detail})` : ""}`,
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
    "CONFORMANCE_GATEWAYS=babelgate,babelgate-default,ccr,free-claude-code npm run test:process -- conformance.process.test.ts",
    "scripts/research/conformance-run.sh   # installs pinned competitors, runs, rewrites this report",
    "```",
    "",
  );
  return lines.join("\n");
}

/** The evidence appendix — full shape dumps for every non-pass cell
 * (shapes only, `<string:N>`), kept out of the readable report. */
function renderShapes(): string {
  const lines: string[] = [
    `# Conformance run — ${RUN_DATE} — evidence shapes (appendix)`,
    "",
    "Shapes only (`<string:N>`), never prompt or completion text. One",
    "entry per non-pass cell of the same-date conformance-run report.",
    "",
  ];
  for (const c of cells.filter(
    (c) => c.result === "fail" || c.result === "differs",
  )) {
    lines.push(`## ${c.gateway} / ${c.scenario} (${c.result})`, "");
    if (c.evidence !== undefined) {
      lines.push(
        `- request shape: \`${JSON.stringify(c.evidence.request)}\``,
        `- response shape: \`${JSON.stringify(c.evidence.response)}\``,
        "",
      );
    } else {
      lines.push("- no evidence recorded", "");
    }
  }
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
    // Full shape dumps live beside the report — the report itself
    // stays a one-line-per-cell read (fix round 2).
    writeFileSync(
      REPORT_PATH.replace(/\.md$/, "") + ".shapes.md",
      renderShapes(),
    );
  }
});
