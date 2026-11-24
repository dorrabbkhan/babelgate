/**
 * conformance-verdict.ts — the CONFIRMED vs INCONCLUSIVE decision for
 * one live conformance run (v1.6 spec §3.10, plan Task 13b fix
 * round 3). scripts/research/conformance-live.sh calls this after the
 * vitest run:
 *
 *   node -r ts-node/register/transpile-only \
 *     scripts/research/conformance-verdict.ts \
 *     --gateway <g> --scenario <s> \
 *     --vitest-status <n> --vitest-output <file> \
 *     --spy-log <file.jsonl> --verdict <file.json>
 *
 * A live run may say CONFIRMED only for a doc-cited rule failure on a
 * clean exchange — every spy-log upstream exchange 2xx, every client
 * turn 2xx, and the scenario's own verdict recording a `fail` under a
 * rule that names a provider doc. Everything else is INCONCLUSIVE
 * with its cause: the test timed out, the gateway made no upstream
 * call, an upstream exchange went non-2xx, the test died before the
 * verdict was recorded, a client turn went non-2xx, or the failing
 * check cites no doc. The first live confirmation printed CONFIRMED
 * for a gateway-side 504 (Gemini slow) and for a vitest timeout —
 * both are transport failures, not wire-format findings.
 *
 * The scenario verdict file is written by conformance.process.test.ts
 * when CONFORMANCE_LIVE_VERDICT is set (live mode only): one JSON
 * object `{gateway, scenario, result, pass, reason, ruleDoc,
 * clientStatuses}`. An absent or stale file means the test never
 * reached a verdict — that is INCONCLUSIVE, never CONFIRMED.
 *
 * Task 13f: the file is read before the vitest exit code — an
 * observation run exits 0 and printed `PASS (live)` over a `differs`
 * verdict; an unsupported pair exits 0 and printed `PASS (live)` over
 * `not supported`. `differs` prints `DIFFERS (observed)`, `not
 * supported` prints `NOT SUPPORTED`, `inconclusive` prints
 * INCONCLUSIVE with its recorded cause, and `pass` still prints
 * `PASS (live)`. The CONFIRMED/INCONCLUSIVE rules below are
 * unchanged — they still apply to a non-zero exit.
 */
import { existsSync, readFileSync } from "node:fs";

/** One parsed spy-log line — the fields the verdict reads (the
 * shape conformance-spy.ts writes; `response` is its shape-only
 * summary, unused here but part of the record). */
export interface SpyExchange {
  method?: string;
  url?: string;
  upstreamStatus?: number;
  response?: { hasReasoning?: boolean };
  error?: string;
}

/** The JSON object conformance.process.test.ts writes in live mode. */
export interface LiveRunVerdict {
  gateway?: string;
  scenario?: string;
  result?:
    | "pass"
    | "fail"
    | "differs"
    | "not supported"
    | "inconclusive";
  pass?: boolean;
  reason?: string;
  /** The doc the broken rule cites — absent for observation rules. */
  ruleDoc?: string;
  /** Client-facing HTTP status per completed turn. */
  clientStatuses?: number[];
}

export interface LiveOutcomeInput {
  /** vitest exit code. */
  vitestStatus: number;
  /** Captured vitest stdout+stderr — the timeout signal lives here. */
  vitestOutput: string;
  /** Every parsed spy-log exchange. */
  spy: SpyExchange[];
  /** The scenario's own verdict, or undefined when absent/stale. */
  verdict: LiveRunVerdict | undefined;
}

export type LiveOutcome =
  | { kind: "pass" }
  | { kind: "differs"; reason?: string }
  | { kind: "notSupported"; reason?: string }
  | { kind: "confirmed"; reason?: string; ruleDoc?: string }
  | { kind: "inconclusive"; cause: string };

const is2xx = (s: unknown): boolean =>
  typeof s === "number" && s >= 200 && s < 300;

/**
 * The verdict for one live run, in check order: a timeout or a run
 * that died before recording a verdict can never confirm; a transport
 * failure (no upstream call, upstream non-2xx, client non-2xx) is
 * INCONCLUSIVE, not a wire-format finding.
 */
export function liveOutcome(input: LiveOutcomeInput): LiveOutcome {
  if (input.vitestStatus === 0) {
    // The verdict file labels the run before the exit code does —
    // an observation or a skipped pair exits 0 and is not a PASS.
    switch (input.verdict?.result) {
      case "differs":
        return { kind: "differs", reason: input.verdict.reason };
      case "not supported":
        return { kind: "notSupported", reason: input.verdict.reason };
      case "inconclusive":
        return {
          kind: "inconclusive",
          cause: input.verdict.reason ?? "the run could not be judged",
        };
      default:
        return { kind: "pass" };
    }
  }
  if (/timed out/i.test(input.vitestOutput)) {
    return {
      kind: "inconclusive",
      cause: "the test timed out (vitest) before a verdict completed",
    };
  }
  const turns = input.verdict?.clientStatuses ?? [];
  const badTurn = turns.findIndex((s) => !is2xx(s));
  if (input.spy.length === 0) {
    return {
      kind: "inconclusive",
      cause:
        badTurn >= 0
          ? `the gateway returned ${turns[badTurn]} on turn ` +
            `${badTurn + 1} and made no upstream call`
          : "the gateway made no upstream call",
    };
  }
  const badUpstream = input.spy.find((e) => !is2xx(e.upstreamStatus));
  if (badUpstream !== undefined) {
    return {
      kind: "inconclusive",
      cause:
        `an upstream exchange returned non-2xx ` +
        `(status ${badUpstream.upstreamStatus ?? "none"} on ` +
        `${badUpstream.method ?? "?"} ${badUpstream.url ?? "?"}` +
        `${badUpstream.error ? `, ${badUpstream.error}` : ""})`,
    };
  }
  if (input.verdict === undefined) {
    return {
      kind: "inconclusive",
      cause: "the test failed before the scenario verdict was recorded",
    };
  }
  if (badTurn >= 0) {
    return {
      kind: "inconclusive",
      cause:
        `the gateway returned ${turns[badTurn]} on turn ` +
        `${badTurn + 1} — a transport failure, not a wire-format finding`,
    };
  }
  if (input.verdict.result !== "fail") {
    return {
      kind: "inconclusive",
      cause:
        `the recorded verdict is "${input.verdict.result ?? "missing"}", ` +
        `not a doc-cited rule failure`,
    };
  }
  if (input.verdict.ruleDoc === undefined) {
    return {
      kind: "inconclusive",
      cause:
        "the failing check cites no provider doc — an observation, " +
        "not a doc-cited rule",
    };
  }
  return {
    kind: "confirmed",
    reason: input.verdict.reason,
    ruleDoc: input.verdict.ruleDoc,
  };
}

/** The one verdict line conformance-live.sh prints. */
export function renderOutcome(
  gateway: string,
  scenario: string,
  outcome: LiveOutcome,
): string {
  switch (outcome.kind) {
    case "pass":
      return `conformance-live: ${gateway} ${scenario} PASS (live)`;
    case "differs":
      return (
        `conformance-live: ${gateway} ${scenario} DIFFERS (observed)` +
        `${outcome.reason ? ` — ${outcome.reason}` : ""}`
      );
    case "notSupported":
      return (
        `conformance-live: ${gateway} ${scenario} NOT SUPPORTED` +
        `${outcome.reason ? ` — ${outcome.reason}` : ""}`
      );
    case "confirmed":
      return (
        `conformance-live: ${gateway} ${scenario} CONFIRMED FAILURE ` +
        `(live) — ${outcome.reason ?? "a doc-cited rule failed"}` +
        `${outcome.ruleDoc ? ` (rule: ${outcome.ruleDoc})` : ""}`
      );
    case "inconclusive":
      return (
        `conformance-live: ${gateway} ${scenario} INCONCLUSIVE — ` +
        `${outcome.cause}`
      );
  }
}

/** Read the spy log: one JSON exchange per line. A line that does not
 * parse still counts as an exchange with no 2xx status — a log the
 * verdict cannot read can never confirm. */
export function readSpyLog(path: string): SpyExchange[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l) as SpyExchange;
      } catch {
        return { error: "malformed spy-log line" };
      }
    });
}

/** Read the scenario verdict file; undefined when absent or for a
 * different gateway/scenario (stale). */
export function readVerdict(
  path: string,
  gateway: string,
  scenario: string,
): LiveRunVerdict | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as LiveRunVerdict;
    if (v.gateway !== undefined && v.gateway !== gateway) {
      return undefined;
    }
    if (v.scenario !== undefined && v.scenario !== scenario) {
      return undefined;
    }
    return v;
  } catch {
    return undefined;
  }
}

if (require.main === module) {
  const flags: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    flags[process.argv[i].replace(/^--/, "")] = process.argv[i + 1] ?? "";
  }
  const gateway = flags.gateway ?? "";
  const scenario = flags.scenario ?? "";
  const vitestStatus = Number(flags["vitest-status"] ?? "1");
  const vitestOutput =
    flags["vitest-output"] !== undefined && existsSync(flags["vitest-output"])
      ? readFileSync(flags["vitest-output"], "utf8")
      : "";
  const outcome = liveOutcome({
    vitestStatus,
    vitestOutput,
    spy:
      flags["spy-log"] !== undefined ? readSpyLog(flags["spy-log"]) : [],
    verdict:
      flags.verdict !== undefined
        ? readVerdict(flags.verdict, gateway, scenario)
        : undefined,
  });
  console.log(renderOutcome(gateway, scenario, outcome));
  process.exit(outcome.kind === "pass" ? 0 : 1);
}
