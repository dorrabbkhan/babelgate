/**
 * record-streams.ts — record stream fixtures against real providers
 * (spec §4.1).
 *
 *   npm run record:streams
 *
 * Opt-in, real network. Providers run only when configured:
 *   ollama    — OLLAMA_API_BASE_URL (default http://localhost:11434)
 *   openai    — OPENAI_API_KEY (+ OPENAI_API_BASE_URL override)
 *   anthropic — ANTHROPIC_API_KEY (+ ANTHROPIC_API_BASE_URL override)
 *   gemini    — GEMINI_API_KEY (+ GEMINI_API_BASE_URL override)
 *
 * Filters / guards:
 *   RECORD_PROVIDERS=ollama,gemini   — limit which providers run
 *   RECORD_CASES=text,max_tokens     — limit which cases run
 *   RECORD_TWINS=max_tokens          — limit which cases get a non-streaming
 *                                      twin call (default: every non-error
 *                                      case; RECORD_TWINS=none → no twins)
 *   RECORD_TWINS_ONLY=1              — top-up mode (v1.6 Task 13b fix
 *                                      round 3): record only the missing
 *                                      <case>.nonstreaming.json for the
 *                                      selected cases — never call the
 *                                      stream endpoint, never touch the
 *                                      committed <case>.<ext>/.json bytes
 *                                      (the default skip guards a case
 *                                      whose wire file exists, so a
 *                                      missing twin could never be added
 *                                      after the fact without
 *                                      RECORD_OVERWRITE re-recording the
 *                                      stream too)
 *   RECORD_OVERWRITE=1               — allow rewriting files that already
 *                                      exist (default: never overwrite)
 *   RECORD_OUT_DIR=<dir>             — output root (default
 *                                      tests/fixtures/streams); the v1.6
 *                                      conformance replays record under
 *                                      tests/process/replays
 *   RECORD_<PROVIDER>_MODEL          — model override per provider
 *   OLLAMA_MIDSTREAM_KILL            — opt-in shell command run ONCE,
 *                                      mid-stream, to kill the running model
 *                                      for the ollama "error" case (e.g.
 *                                      `docker exec ollama pkill -f
 *                                      llama-server`). No default: unset →
 *                                      the error case is skipped and nothing
 *                                      is killed. `pkill -f llama-server`
 *                                      stops EVERY model runner in the
 *                                      container — use it only on an Ollama
 *                                      instance dedicated to recording.
 *
 * Writes raw wire bytes to tests/fixtures/streams/<provider>/<case>.sse
 * (or .ndjson), the non-streamed twin to <case>.nonstreaming.json, and the
 * <case>.json (source/date/model/expectedEvents/nonStreaming) generated
 * from the bytes by stream-fixture-events.ts. Cases whose bytes don't
 * match the case's claim (e.g. an "error" case that got a pre-stream
 * non-2xx, or a 2xx stream with no in-stream error) are skipped, never
 * written.
 */
import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { providerSetups, type ProviderRecording } from "./record-streams-cases";
import {
  buildFixtureJson,
  FixtureAmbiguity,
} from "./stream-fixture-events";
import type { Provider } from "../src/transformers";

const STREAMS_DIR =
  process.env.RECORD_OUT_DIR !== undefined && process.env.RECORD_OUT_DIR !== ""
    ? resolve(__dirname, "..", process.env.RECORD_OUT_DIR)
    : join(__dirname, "..", "tests", "fixtures", "streams");
const DATE = new Date().toISOString().slice(0, 10);

const RECORD_PROVIDERS = csv(process.env.RECORD_PROVIDERS);
const RECORD_CASES = csv(process.env.RECORD_CASES);
const RECORD_TWINS = csv(process.env.RECORD_TWINS);
const TWINS_ONLY = process.env.RECORD_TWINS_ONLY === "1";
const OVERWRITE = process.env.RECORD_OVERWRITE === "1";
const OLLAMA_MIDSTREAM_KILL = process.env.OLLAMA_MIDSTREAM_KILL;

/** Live upstream requests issued per provider this run. */
const requestCounts: Partial<Record<Provider, number>> = {};

function csv(v: string | undefined): string[] | null {
  if (!v) return null;
  return v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  midStream?: { afterLines: number; action: string },
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.body) return { status: res.status, text: await res.text() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let fired = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (
      midStream &&
      !fired &&
      text.split("\n").filter((l) => l.trim()).length >= midStream.afterLines
    ) {
      fired = true;
      exec(midStream.action).unref();
    }
  }
  text += decoder.decode();
  return { status: res.status, text };
}

function writeGuarded(path: string, contents: string): void {
  if (existsSync(path) && !OVERWRITE) {
    console.log(`  not overwriting ${path.split("tests/")[1]}`);
    return;
  }
  writeFileSync(path, contents);
}

async function recordProvider(
  provider: Provider,
  rec: ProviderRecording,
): Promise<void> {
  mkdirSync(rec.dir, { recursive: true });
  console.log(`recording ${provider} at ${rec.baseUrl}, model ${rec.model}`);
  for (const [name, c] of Object.entries(rec.cases)) {
    if (RECORD_CASES && !RECORD_CASES.includes(name)) continue;
    const wirePath = join(rec.dir, `${name}.${rec.ext}`);
    if (TWINS_ONLY) {
      // Top-up mode: fill in a missing <case>.nonstreaming.json
      // without re-recording or rewriting the committed wire/meta
      // bytes (Task 13b fix round 3 — the round-2 replays recorded
      // with RECORD_TWINS=none have no twin). The stream endpoint is
      // never called; <case>.<ext> and <case>.json are never touched.
      if (c.expectInStreamError) continue;
      if (RECORD_TWINS && !RECORD_TWINS.includes(name)) continue;
      const twinFile = join(rec.dir, `${name}.nonstreaming.json`);
      if (existsSync(twinFile) && !OVERWRITE) {
        console.log(`  ${name}: twin exists on disk — skipped`);
        continue;
      }
      requestCounts[provider] = (requestCounts[provider] ?? 0) + 1;
      const twin = await post(
        `${rec.baseUrl}${(rec.twinPath ?? rec.streamPath)(rec.model)}`,
        rec.headers,
        rec.body(rec.model, false, c.request),
      );
      if (twin.status >= 200 && twin.status < 300) {
        writeGuarded(twinFile, twin.text);
        console.log(
          `  ${name}.nonstreaming.json <- HTTP ${twin.status} ` +
            `(${twin.text.length} bytes)`,
        );
      } else {
        console.log(`  ${name}: twin HTTP ${twin.status} — skipped`);
      }
      continue;
    }
    if (existsSync(wirePath) && !OVERWRITE) {
      console.log(`  ${name}: exists on disk — skipped`);
      continue;
    }
    if (c.midStreamAfterLines && !c.midStreamAction) {
      console.log(
        `  ${name}: skipped — needs OLLAMA_MIDSTREAM_KILL ` +
          `(mid-stream kill command; nothing was killed)`,
      );
      continue;
    }
    const midStream =
      c.midStreamAction && c.midStreamAfterLines
        ? { afterLines: c.midStreamAfterLines, action: c.midStreamAction }
        : undefined;
    requestCounts[provider] = (requestCounts[provider] ?? 0) + 1;
    const res = await post(
      `${rec.baseUrl}${rec.streamPath(rec.model)}`,
      rec.headers,
      rec.body(rec.model, true, c.request),
      midStream,
    );
    if (res.status < 200 || res.status >= 300) {
      // A pre-stream non-2xx is the normal JSON-error path, never a
      // stream fixture (plan Review Focus #4).
      console.log(`  ${name}: HTTP ${res.status} before stream — skipped`);
      continue;
    }
    const source =
      rec.sourcePrefix + (c.sourceNote ?? "") + (rec.sourceSuffix ?? "");
    let fixture;
    try {
      fixture = buildFixtureJson(
        provider,
        res.text,
        rec.model,
        source,
        DATE,
        undefined,
      );
    } catch (err) {
      if (err instanceof FixtureAmbiguity) {
        console.log(`STOP: ${provider}/${name}: ${err.message}`);
        continue;
      }
      throw err;
    }
    const lastType = fixture.expectedEvents.at(-1)?.type;
    if (c.expectInStreamError) {
      if (lastType !== "error") {
        console.log(
          `  ${name}: HTTP ${res.status} but no in-stream error — skipped`,
        );
        continue;
      }
    } else if (lastType === "error") {
      console.log(
        `STOP: ${provider}/${name}: stream ended in an error event for a non-error case`,
      );
      continue;
    }

    // Non-streaming twin (not for error cases — a non-stream call can't
    // reproduce a mid-stream failure). RECORD_TWINS limits which cases
    // pay for a twin call.
    if (
      !c.expectInStreamError &&
      (!RECORD_TWINS || RECORD_TWINS.includes(name))
    ) {
      requestCounts[provider] = (requestCounts[provider] ?? 0) + 1;
      const twin = await post(
        `${rec.baseUrl}${(rec.twinPath ?? rec.streamPath)(rec.model)}`,
        rec.headers,
        rec.body(rec.model, false, c.request),
      );
      if (twin.status >= 200 && twin.status < 300) {
        writeGuarded(join(rec.dir, `${name}.nonstreaming.json`), twin.text);
        fixture = buildFixtureJson(
          provider,
          res.text,
          rec.model,
          source,
          DATE,
          JSON.parse(twin.text),
        );
      } else {
        console.log(
          `  ${name}: twin HTTP ${twin.status} — nonStreaming stays null`,
        );
      }
    }

    writeGuarded(wirePath, res.text);
    writeGuarded(
      join(rec.dir, `${name}.json`),
      JSON.stringify(fixture, null, 2) + "\n",
    );
    console.log(
      `  ${name}.${rec.ext} <- HTTP ${res.status} (${res.text.length} bytes, ` +
        `${fixture.expectedEvents.length} events, nonStreaming: ` +
        `${fixture.nonStreaming === null ? "null" : "set"})`,
    );
  }
}

async function main(): Promise<void> {
  const setups = providerSetups(STREAMS_DIR, OLLAMA_MIDSTREAM_KILL);
  for (const provider of [
    "ollama",
    "openai",
    "anthropic",
    "gemini",
  ] as Provider[]) {
    if (RECORD_PROVIDERS && !RECORD_PROVIDERS.includes(provider)) continue;
    const setup = setups[provider];
    if (setup === undefined) continue;
    const rec = await setup();
    if (typeof rec === "string") {
      console.log(`${provider}: skipped (${rec})`);
      continue;
    }
    await recordProvider(provider, rec);
  }
  const counts = (Object.keys(requestCounts) as Provider[])
    .map((p) => `${p}=${requestCounts[p]}`)
    .join(", ");
  console.log(`upstream requests made: ${counts || "none"}`);
}

main().catch((err) => {
  console.error(`record:streams failed: ${err}`);
  process.exit(1);
});
