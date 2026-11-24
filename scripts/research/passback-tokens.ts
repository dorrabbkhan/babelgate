/**
 * passback-tokens.ts — does the live model actually see the reasoning
 * a gateway sends back? (v1.6 spec §3.10, plan Task 13d)
 *
 *   OPENROUTER_API_KEY=... node -r ts-node/register/transpile-only \
 *     scripts/research/passback-tokens.ts <spy-log.jsonl>
 *
 * Takes turn 2's upstream body from a conformance-live spy log (the
 * second recorded exchange — thinking-after-tool is two turns) and
 * POSTs it to OpenRouter non-streaming with `max_tokens: 16` three
 * times: with no reasoning field on the messages, with the logged
 * reasoning under `reasoning_content`, and under `reasoning`. One
 * line per variant:
 *
 *   variant=<name> status=<http> provider=<upstream> prompt_tokens=<n>
 *
 * A model that keeps prior reasoning in its prompt counts more
 * prompt_tokens with the field than without — the 2026-11-24
 * evidence: deepseek-r1-0528 counted 135/135/135 (its chat template
 * drops earlier-turn reasoning), deepseek-v4.1-flash 361/411/411,
 * kimi-k3 268/318/318, glm-5.3 192/241/241. Field name per
 * https://openrouter.ai/docs/use-cases/reasoning-tokens
 * (`reasoning_content` functions identically to `reasoning`).
 *
 * Privacy: prints status, upstream provider name and token count
 * only — never bodies, completions or keys. The key comes from
 * OPENROUTER_API_KEY. PASSBACK_TARGET overrides the OpenRouter base
 * URL (offline tests point it at a 127.0.0.1 stub). A network
 * script, not part of `npm test`.
 */
import { readFileSync } from "node:fs";

/** The Chat fields that can carry sent-back reasoning on a message
 * (OpenRouter/DeepSeek wire names — see client.ts REASONING_MESSAGE_FIELDS). */
const REASONING_FIELDS = [
  "reasoning",
  "reasoning_content",
  "reasoning_details",
] as const;

export type Variant = "none" | "reasoning_content" | "reasoning";
export const VARIANTS: Variant[] = ["none", "reasoning_content", "reasoning"];

/**
 * Turn 2's upstream body from a conformance-live spy log: the second
 * recorded exchange (thinking-after-tool sends one upstream request
 * per turn). Fails loudly on a log it cannot read — a mistyped path
 * or a one-exchange log must never produce a three-line table.
 */
export function readTurn2Body(spyLogPath: string): Record<string, unknown> {
  const lines = readFileSync(spyLogPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    throw new Error(
      `${spyLogPath}: ${lines.length} recorded exchange(s); ` +
        "turn 2's upstream body needs at least 2",
    );
  }
  let entry: { body?: unknown };
  try {
    entry = JSON.parse(lines[1]);
  } catch {
    throw new Error(`${spyLogPath}: exchange 2 is not JSON`);
  }
  let body: unknown;
  try {
    body = JSON.parse(String(entry.body));
  } catch {
    throw new Error(`${spyLogPath}: turn 2's body is not JSON`);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { messages?: unknown }).messages)
  ) {
    throw new Error(
      `${spyLogPath}: turn 2's body has no messages array — ` +
        "expected a Chat request",
    );
  }
  return body as Record<string, unknown>;
}

/** Per message index, the logged reasoning value (first of the three
 * wire fields present — a string for `reasoning`/`reasoning_content`,
 * an array for `reasoning_details`; kept verbatim). */
function reasoningByIndex(messages: unknown[]): Map<number, unknown> {
  const out = new Map<number, unknown>();
  messages.forEach((m, i) => {
    if (typeof m !== "object" || m === null) return;
    const rec = m as Record<string, unknown>;
    const field = REASONING_FIELDS.find((f) => rec[f] !== undefined);
    if (field !== undefined) out.set(i, rec[field]);
  });
  return out;
}

/**
 * The three request bodies to probe: same messages, tools and model
 * as the logged turn-2 body, forced non-streaming with
 * `max_tokens: 16`, differing only in whether and where the
 * reasoning rides. Throws when the logged body carried no reasoning
 * — the with/without comparison is then meaningless (run it on a
 * passback run, e.g. babelgate-preset).
 */
export function requestVariants(
  loggedBody: Record<string, unknown>,
): { variant: Variant; body: Record<string, unknown> }[] {
  const messages = loggedBody.messages as unknown[];
  const reasoning = reasoningByIndex(messages);
  if (reasoning.size === 0) {
    throw new Error(
      "turn 2's body carries no reasoning field on any message — " +
        "run this on a passback run (e.g. babelgate-preset)",
    );
  }
  return VARIANTS.map((variant) => {
    const body = structuredClone(loggedBody);
    (body.messages as Record<string, unknown>[]).forEach((m, i) => {
      if (typeof m !== "object" || m === null) return;
      for (const f of REASONING_FIELDS) delete m[f];
      if (variant !== "none" && reasoning.has(i)) {
        m[variant] = reasoning.get(i);
      }
    });
    body.stream = false;
    delete body.stream_options;
    body.max_tokens = 16;
    return { variant, body };
  });
}

export interface ProbeResult {
  /** HTTP status; 0 on a transport error (timeout, refused). */
  status: number;
  provider?: string;
  promptTokens?: number;
}

/**
 * POST one variant to `<target>/v1/chat/completions`. Reads only
 * `provider` and `usage.prompt_tokens` out of the reply — the
 * completion text is never held beyond the JSON parse.
 */
export async function probeVariant(
  target: string,
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${target}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { status: 0 };
  }
  let json: Record<string, unknown> | undefined;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  const usage = json?.usage as { prompt_tokens?: unknown } | undefined;
  return {
    status: res.status,
    provider:
      typeof json?.provider === "string" ? (json.provider as string) : undefined,
    promptTokens:
      typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
  };
}

/** One output line — status, provider and token count only. */
export function renderLine(variant: Variant, result: ProbeResult): string {
  return (
    `variant=${variant} status=${result.status} ` +
    `provider=${result.provider ?? "-"} prompt_tokens=${result.promptTokens ?? "-"}`
  );
}

export async function runPassbackCheck(opts: {
  spyLogPath: string;
  apiKey: string;
  /** Base URL; default OpenRouter (`PASSBACK_TARGET` on the CLI). */
  target?: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const target = opts.target ?? "https://openrouter.ai/api";
  const loggedBody = readTurn2Body(opts.spyLogPath);
  const lines: string[] = [];
  for (const { variant, body } of requestVariants(loggedBody)) {
    lines.push(
      renderLine(
        variant,
        await probeVariant(target, opts.apiKey, body, opts.fetchImpl),
      ),
    );
  }
  return lines;
}

if (require.main === module) {
  const spyLogPath = process.argv[2];
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (spyLogPath === undefined || apiKey === "") {
    console.error(
      "usage: passback-tokens.ts <spy-log.jsonl> " +
        "(key from $OPENROUTER_API_KEY, target from $PASSBACK_TARGET)",
    );
    process.exit(2);
  }
  runPassbackCheck({
    spyLogPath,
    apiKey,
    target: process.env.PASSBACK_TARGET || undefined,
  })
    .then((lines) => {
      for (const line of lines) console.log(line);
    })
    .catch((err) => {
      console.error(
        `passback-tokens: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(2);
    });
}
