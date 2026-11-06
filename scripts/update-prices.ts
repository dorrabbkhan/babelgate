/**
 * Refresh the bundled price table (spec §3.6, D8):
 *
 *   npm run update:prices -- <litellm-commit>
 *
 * Fetches LiteLLM's model_prices_and_context_window.json at the
 * pinned commit, keeps chat-mode models, converts USD/token to USD
 * per 1M tokens and rewrites src/cost/prices.json with the source
 * commit and fetch date. Nothing is fetched at runtime — this is a
 * release-checklist step.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const LITELLM_URL = (commit: string) =>
  `https://raw.githubusercontent.com/BerriAI/litellm/${commit}/model_prices_and_context_window.json`;

const OUT = join(__dirname, "..", "src", "cost", "prices.json");
const MILLION = 1_000_000;

interface PriceRow {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PriceTable {
  source: { url: string; commit: string; fetchedAt: string };
  models: Record<string, PriceRow>;
}

/** USD/token → USD/1M, keeping at most 10 significant digits. */
const toPerMillion = (v: number): number =>
  Number((v * MILLION).toPrecision(10));

/** LiteLLM field → PriceRow field (undefined fields are dropped). */
function toPriceRow(entry: Record<string, unknown>): PriceRow | undefined {
  const input = entry["input_cost_per_token"];
  const output = entry["output_cost_per_token"];
  if (typeof input !== "number" || typeof output !== "number") {
    return undefined;
  }
  const row: PriceRow = {
    input: toPerMillion(input),
    output: toPerMillion(output),
  };
  const cacheRead = entry["cache_read_input_token_cost"];
  if (typeof cacheRead === "number") row.cacheRead = toPerMillion(cacheRead);
  const cacheWrite = entry["cache_creation_input_token_cost"];
  if (typeof cacheWrite === "number") {
    row.cacheWrite = toPerMillion(cacheWrite);
  }
  return row;
}

/**
 * The pure transform — exported for tests. Keeps every `mode: "chat"`
 * entry under its LiteLLM key; metadata keys (e.g. `sample_spec`) and
 * non-chat modes are dropped.
 */
export function buildPriceTable(
  litellm: Record<string, unknown>,
  source: PriceTable["source"],
): PriceTable {
  const models: Record<string, PriceRow> = {};
  for (const [key, value] of Object.entries(litellm)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (entry["mode"] !== "chat") continue;
    const row = toPriceRow(entry);
    if (row !== undefined) models[key] = row;
  }
  return { source, models };
}

async function main(): Promise<void> {
  const commit = process.argv[2];
  if (commit === undefined || commit === "") {
    console.error("usage: npm run update:prices -- <litellm-commit>");
    process.exit(2);
  }
  const url = LITELLM_URL(commit);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} → ${res.status}`);
  }
  const litellm = (await res.json()) as Record<string, unknown>;
  const table = buildPriceTable(litellm, {
    url,
    commit,
    fetchedAt: new Date().toISOString(),
  });
  writeFileSync(OUT, JSON.stringify(table, null, 2) + "\n");
  const count = Object.keys(table.models).length;
  console.log(`wrote ${OUT}: ${count} chat models @ ${commit}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
