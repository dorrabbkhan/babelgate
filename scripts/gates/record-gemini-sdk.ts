/**
 * record-gemini-sdk.ts — Gemini SDK shape recorder (plan v1.5 Task 1,
 * spec §3.1 "Evidence first"). Puts record-shapes.ts in front of the
 * Gemini API and drives the @google/generative-ai SDK (a real client,
 * not a hand-rolled request) through a function-calling chat loop with
 * thinking on, so the recorded bodies show how the SDK carries `thought`
 * parts and `thoughtSignature` fields into the next turn. No babelgate
 * in the loop: SDK → recorder → upstream.
 *
 *   ts-node scripts/gates/record-gemini-sdk.ts [outJsonl]
 *
 * The loop is designed for three generateContent requests: the model
 * calls `lookup_timezone`, the script answers with a fixed result, the
 * model calls `get_time` on it, the script answers, the model replies
 * with text. Each request lands as one shape line — method, path,
 * query keys, header names and a value-free body shape — in the JSONL
 * the script prints. The recorder runs with RECORD_KEEP_ENUMS=1: type
 * values, tool (function) names and model land verbatim; everything
 * else stays a "<string:len>" shape — prompt text, function arguments,
 * completions, thought text, signatures and the API key never reach
 * the file (header names only).
 *
 * Real upstream only — this script makes network calls and needs
 * GEMINI_API_KEY: exported in the environment, or present as a
 * GEMINI_API_KEY= line in ./.env (loaded via dotenv; never printed).
 *
 * Env overrides: RECORD_GEMINI_MODEL (default gemini-2.5-flash),
 * GEMINI_BASE_URL (the upstream the recorder forwards to, default
 * https://generativelanguage.googleapis.com — point it at a local
 * stub for an offline dry run; with a non-default base a missing key
 * becomes the literal "dummy" instead of failing),
 * RECORD_GEMINI_TIMEOUT_S (hard cap on the SDK loop, default 300).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import {
  FunctionCallingMode,
  GoogleGenerativeAI,
  SchemaType,
  type FunctionCall,
  type GenerationConfig,
} from "@google/generative-ai";

const repoRoot = join(__dirname, "../..");
const [, , outArg] = process.argv;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outJsonl =
  outArg ?? join(repoRoot, "tmp", "gemini-sdk-records", `${stamp}.jsonl`);
const model = process.env.RECORD_GEMINI_MODEL ?? "gemini-2.5-flash";
const forwardBase =
  process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com";
const timeoutS = Number(process.env.RECORD_GEMINI_TIMEOUT_S ?? "300");

if (outArg === "-h" || outArg === "--help" || process.argv.length > 3) {
  console.error("usage: record-gemini-sdk.ts [outJsonl]");
  process.exit(2);
}
if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
  console.error("RECORD FAIL: RECORD_GEMINI_TIMEOUT_S must be a positive number");
  process.exit(2);
}

// Key from the environment first; if unset, the same ./.env babelgate
// loads — parsed with dotenv itself so quoting rules match. The value
// is never printed and never reaches the JSONL (header names only).
dotenvConfig({ path: join(repoRoot, ".env"), quiet: true });
let apiKey = process.env.GEMINI_API_KEY ?? "";
if (apiKey === "" && forwardBase !== "https://generativelanguage.googleapis.com") {
  // Stub upstream (offline verification): a placeholder is fine — the
  // recorder records header names, never values.
  apiKey = "dummy";
}
if (apiKey === "") {
  console.error("RECORD FAIL: GEMINI_API_KEY is not set (env or .env)");
  process.exit(1);
}

/** One free port, OS-assigned, for the recorder. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Resolve when the recorder prints its readiness line; reject if it dies first. */
function waitForReady(child: ChildProcess, log: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("recorder did not start within 30s")),
      30_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      log.push(text);
      if (text.includes("record-shapes listening")) {
        clearTimeout(deadline);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`recorder exited early (code ${code})`));
    });
  });
}

/**
 * The two fake tools. Deterministic canned answers — the recording is
 * about request shapes, not tool fidelity, and fixed answers keep the
 * loop to exactly three requests on a cooperative model.
 */
function runTool(call: FunctionCall): object {
  if (call.name === "lookup_timezone") return { timezone: "Europe/Paris" };
  if (call.name === "get_time") return { time: "14:30" };
  return { error: "unknown_function" };
}

async function main(): Promise<number> {
  const port = await freePort();
  mkdirSync(dirname(outJsonl), { recursive: true });

  // ts-node from this checkout (the script itself runs under it); the
  // recorder gets RECORD_KEEP_ENUMS=1 like record-codex.sh.
  const tsNode = join(repoRoot, "node_modules", "ts-node", "dist", "bin.js");
  const recorder = spawn(
    process.execPath,
    [
      tsNode,
      join(repoRoot, "scripts", "gates", "record-shapes.ts"),
      String(port),
      forwardBase,
      outJsonl,
    ],
    {
      env: { ...process.env, RECORD_KEEP_ENUMS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const recorderLog: string[] = [];
  recorder.stderr?.on("data", (c: Buffer) => recorderLog.push(c.toString()));

  const stop = (code: number) => {
    recorder.kill();
    return code;
  };
  process.once("SIGINT", () => process.exit(stop(130)));
  process.once("SIGTERM", () => process.exit(stop(143)));

  try {
    await waitForReady(recorder, recorderLog);
  } catch (err) {
    console.error(`RECORD FAIL: ${(err as Error).message}`);
    console.error(recorderLog.join("").split("\n").slice(-20).join("\n"));
    return stop(1);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  // thinkingConfig is accepted by the Gemini API (generationConfig is
  // sent verbatim) but is not typed in @google/generative-ai 0.24.1 —
  // the cast keeps the field on the wire:
  // https://ai.google.dev/gemini-api/docs/thinking
  const generationConfig = {
    maxOutputTokens: 2048,
    thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
  } as GenerationConfig;
  const chat = genAI
    .getGenerativeModel(
      {
        model,
        generationConfig,
        tools: [
          {
            functionDeclarations: [
              {
                name: "lookup_timezone",
                description: "Return the IANA timezone of a city.",
                parameters: {
                  type: SchemaType.OBJECT,
                  properties: { city: { type: SchemaType.STRING } },
                  required: ["city"],
                },
              },
              {
                name: "get_time",
                description: "Return the current local time for an IANA timezone.",
                parameters: {
                  type: SchemaType.OBJECT,
                  properties: { timezone: { type: SchemaType.STRING } },
                  required: ["timezone"],
                },
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingMode.AUTO },
        },
      },
      {
        baseUrl: `http://127.0.0.1:${port}`,
        timeout: Math.min(timeoutS, 120) * 1000,
      },
    )
    .startChat();

  const deadline = Date.now() + timeoutS * 1000;
  let requests = 0;
  try {
    // Prompt engineered for two sequential calls so the second and
    // third request bodies carry the model's earlier parts — the
    // thought/thoughtSignature handling under test.
    let result = await chat.sendMessage(
      "Do this in order: call lookup_timezone for the city Paris; " +
        "then call get_time with the timezone it returned; " +
        "then reply with only the time. One call per step.",
    );
    requests += 1;
    while (Date.now() < deadline) {
      const calls = result.response.functionCalls();
      if (!calls || calls.length === 0) break;
      if (requests >= 8) break;
      const responses = calls.map((call) => ({
        functionResponse: { name: call.name, response: runTool(call) },
      }));
      result = await chat.sendMessage(responses);
      requests += 1;
    }
  } catch (err) {
    console.error(`RECORD FAIL: SDK run errored after ${requests} requests`);
    // Error messages can carry the endpoint URL; keep only the name.
    console.error(`  error: ${(err as Error).name}`);
    return stop(1);
  } finally {
    recorder.kill();
  }

  // Let the recorder flush its last line.
  await new Promise((r) => setTimeout(r, 500));

  let recorded = 0;
  try {
    recorded = readFileSync(outJsonl, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "").length;
  } catch {
    // Missing file reads as zero.
  }

  const sdkVersion = (
    require("@google/generative-ai/package.json") as { version: string }
  ).version;
  console.log(`sdk version: @google/generative-ai ${sdkVersion}`);
  console.log(`model: ${model} (upstream: ${forwardBase})`);
  console.log(`requests recorded: ${recorded}`);
  console.log(`jsonl: ${outJsonl}`);

  // Three turns is the design; more is fine (retries, extra calls),
  // fewer means the loop did not exercise passback.
  if (requests >= 3 && recorded >= 3) {
    console.log("RECORD PASS: 3+ turns recorded");
    return stop(0);
  }
  console.error(
    "RECORD FAIL: expected 3+ generateContent requests " +
      `(sent ${requests}, recorded ${recorded})`,
  );
  return stop(1);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`RECORD FAIL: ${(err as Error).name}: ${(err as Error).message}`);
    process.exit(1);
  });
