/**
 * Conformance scenario types (v1.6 plan Task 13b, spec §3.10). A
 * scenario is a fixed client dialect + upstream dialect pair, a list
 * of turns to send through a gateway, and an assert over the turn
 * results. Verdicts carry shapes only (`<string:N>`), never prompt
 * or completion text.
 */
import type { GatewayUnderTest } from "../harness";

export type ClientDialect = "anthropic" | "responses";
export type UpstreamDialect = "openai" | "gemini";

/**
 * A gateway adapter plus the per-run metadata scenarios need: the
 * model name each upstream dialect answers to (babelgate's
 * `openai/<m>`, the competitors' flat names), extra client headers
 * (CCR's static key), and a "not supported" predicate — a gateway
 * that cannot serve a dialect pair at all reports it, never a
 * failure (conductor rule 3).
 */
export interface GatewaySpec {
  adapter: GatewayUnderTest;
  models: Record<UpstreamDialect, string>;
  clientHeaders?: Record<string, string>;
  unsupported?(
    client: ClientDialect,
    upstream: UpstreamDialect,
  ): string | undefined;
}

/**
 * A structural outline with every string replaced by `<string:N>`
 * (N = code-point length). Evidence in a verdict is shapes only.
 */
export type Shape =
  | { kind: "object"; fields: Record<string, Shape> }
  | { kind: "array"; length: number; items: Shape[] }
  | { kind: "string"; length: number }
  | { kind: "number" | "boolean" | "null" };

export function shape(value: unknown): Shape {
  if (value === null) return { kind: "null" };
  if (typeof value === "string") {
    return { kind: "string", length: [...value].length };
  }
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      items: value.map(shape),
    };
  }
  if (typeof value === "object") {
    const fields: Record<string, Shape> = {};
    for (const [k, v] of Object.entries(value)) fields[k] = shape(v);
    return { kind: "object", fields };
  }
  return { kind: "string", length: 0 };
}

/** One recorded upstream request as parsed JSON (undefined when the
 * body was not JSON — shape evidence still covers it). */
export interface UpstreamRequest {
  url: string;
  body: unknown;
  rawBody: string;
}

/** Everything the scenario assert needs from one turn. */
export interface TurnResult {
  turn: number;
  /** HTTP status of the client-facing response. */
  status: number;
  /** Raw client response body (SSE text or JSON). */
  body: string;
  /** SSE `event:` names in order — empty for a JSON response. */
  sseEvents: string[];
  /** Upstream requests this turn produced, parsed where JSON. */
  upstream: UpstreamRequest[];
}

/**
 * One pass rule a scenario checks and the doc that requires it —
 * every "fail" the report prints must hold up publicly (D9). A rule
 * with no `doc` is an observation: no provider doc requires the
 * behaviour, so it renders as `differs`, never a failure.
 */
export interface PassRule {
  /** What is checked — one line for the report's Rules section. */
  check: string;
  /** Doc URL that requires the behaviour. Absent = observation only. */
  doc?: string;
  /** For undocumented checks: the counter-evidence (e.g. DeepSeek's
   * reasoning guide excluding earlier reasoning_content from context). */
  note?: string;
}

export interface ScenarioVerdict {
  pass: boolean;
  reason?: string;
  /** The rule the failure is judged under — undefined only where the
   * failure precedes any rule (defensive; treated as required). */
  rule?: PassRule;
  /** The exact missing or extra field path for the report's
   * one-line failing cell (e.g. `messages[1] (assistant) carries no
   * reasoning field`). */
  detail?: string;
  /** Shapes only — never prompt or completion text. */
  evidence: { request: Shape; response: Shape };
}

export interface ScenarioTurn {
  /**
   * The client request body. `model` is the placeholder `"$MODEL"`,
   * replaced by the running gateway's model for this scenario's
   * upstream dialect. A function turn is built from earlier results
   * (e.g. echoing turn 1's thinking block).
   */
  request: unknown | ((prev: TurnResult[]) => unknown);
}

export interface Scenario {
  name: string;
  client: ClientDialect;
  upstream: UpstreamDialect;
  /**
   * The recorded provider body the mock upstream replays — resolved
   * like mock-upstream.ts (replays root before the streams corpus).
   */
  replay: string;
  /** The pass rules the assert checks, in order — each cites the doc
   * that requires it, or carries `note` when none does (observation). */
  rules: PassRule[];
  turns: ScenarioTurn[];
  assert(results: TurnResult[]): ScenarioVerdict;
}

/** One SSE frame (`data:` payload joined, `event:` name if given). */
export interface SseEvent {
  event: string;
  data: string;
}

/** Parse an SSE body into frames; ignores comments and `[DONE]`. */
export function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event = "";
  let dataLines: string[] = [];
  const flush = () => {
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (data && data !== "[DONE]") {
      events.push({ event, data });
    }
    event = "";
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return events;
}

/** The parsed `data:` JSON of each frame (non-JSON frames skipped). */
export function sseJson(body: string): { event: string; json: any }[] {
  const out: { event: string; json: any }[] = [];
  for (const e of parseSse(body)) {
    try {
      out.push({ event: e.event, json: JSON.parse(e.data) });
    } catch {
      // non-JSON data frame — not part of the event stream model
    }
  }
  return out;
}
