import { execFileSync, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { dirname, join } from "node:path";
import type { GatewayUnderTest, RunningGateway } from "../harness";
import { waitHealthy } from "../harness";
import { stopChild } from "./babelgate";

const REPO = join(__dirname, "..", "..", "..");

/**
 * free-claude-code (Alishahryar1/free-claude-code), pinned to tag
 * v6.15.0. AGPL-3.0-only — nothing of its code or docs is vendored;
 * the adapter launches a checkout installed under the gitignored
 * tmp/ by `conformance-run.sh` (`git clone --depth 1 --branch` +
 * `uv sync --frozen`, uv.lock pins the dependency tree).
 *
 * FCC is configured entirely through env (its Settings reads
 * `~/.fcc/.env` plus process env): `FCC_CUSTOM_PROVIDERS` declares a
 * custom OpenAI-Chat endpoint (provider_id must be `custom_<32 hex>`),
 * `MODEL` routes all requests to `<provider_id>/<model_id>` — one
 * configured upstream per server instance. `HOME` points at the temp
 * work dir so nothing touches the real `~/.fcc`.
 */
export const FCC_REPO = "Alishahryar1/free-claude-code";
export const FCC_TAG = "v6.15.0";
export const FCC_COMMIT = "e8806fb608ac37484840778ac1cbcb0aaf51dd3f";
export const FCC_DIR =
  process.env.FCC_INSTALL_DIR ??
  join(REPO, "tmp", "conformance", "free-claude-code");
export const FCC_REPO_URL =
  "https://github.com/Alishahryar1/free-claude-code";

/**
 * The custom provider id FCC_CUSTOM_PROVIDERS declares — FCC routes
 * `provider/model` on the request's own model field, and its
 * provider_ids include the whole built-in catalog: a bare OpenRouter
 * `vendor/model` (`deepseek/deepseek-v4.1-flash`) collides with the
 * built-in `deepseek` provider and goes to api.deepseek.com with no
 * key — the no-upstream-call 400/503 every FCC live cell hit in
 * 13d/13b (Task 13f). The client-facing model therefore carries this
 * prefix.
 */
export const FCC_PROVIDER_ID = "custom_0123456789abcdef0123456789abcdef";

/**
 * The client-facing model ref — `<provider_id>/<model>`. Already-
 * prefixed refs pass through (live models arrive prefixed from
 * liveModel).
 */
export function fccModelRef(model: string): string {
  const prefix = `${FCC_PROVIDER_ID}/`;
  return model.startsWith(prefix) ? model : `${prefix}${model}`;
}

/** The model id the upstream sees — the ref minus the provider prefix. */
export function fccUpstreamModelId(ref: string): string {
  const prefix = `${FCC_PROVIDER_ID}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/**
 * Spy-style redaction for the live gateway log (Task 13f): a
 * `name=value` or `name: value` credential — the spy's query names
 * (key, api_key, access_token) plus the key headers it redacts —
 * lands as `<redacted>`. Only what FCC prints is logged, never
 * request or response bodies.
 */
export function redactGatewayOutput(text: string): string {
  return text.replace(
    /(?<![\w-])(x-goog-api-key|x-api-key|api[_-]?key|access[_-]?token|authorization|key)("?\s*[:=]\s*"?(?:Bearer\s+)?)[^&\s"',}]*/gi,
    "$1$2<redacted>",
  );
}

function fccBin(dir = FCC_DIR): string | undefined {
  for (const name of ["fcc-server", "fcc-server.exe"]) {
    const bin = join(dir, "repo", ".venv", "bin", name);
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

/**
 * Install FCC at the pinned tag: a shallow clone plus `uv sync
 * --frozen`. Honours `https_proxy`/`https_proxy` env for pip/uv and
 * keeps every uv-managed path (cache, python, venv) inside `dir`.
 */
export function installFcc(dir = FCC_DIR): void {
  const repo = join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(repo, ".git"))) {
    execFileSync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        FCC_TAG,
        `https://github.com/${FCC_REPO}.git`,
        repo,
      ],
      { stdio: "inherit" },
    );
  }
  const env = {
    ...process.env,
    UV_CACHE_DIR: join(dir, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: join(dir, "uv-python"),
    UV_PROJECT_ENVIRONMENT: join(repo, ".venv"),
  };
  execFileSync("uv", ["sync", "--frozen", "--no-progress"], {
    cwd: repo,
    env,
    stdio: "inherit",
  });
}

/**
 * The custom provider config for a Chat-Completions mock upstream.
 * `reasoning_history_format: "reasoning_content"` asks FCC to send
 * accumulated reasoning back on the wire — the DeepSeek field,
 * https://api-docs.deepseek.com/guides/reasoning_model.
 */
export function fccCustomProviders(
  upstream: string,
  model: string,
): string {
  return JSON.stringify([
    {
      provider_id: FCC_PROVIDER_ID,
      display_name: "Mock",
      base_url: `${upstream}/v1`,
      api_format: "openai_chat",
      api_keys: ["mock-key"],
      // The upstream model id — the ref minus the provider prefix
      // (live models arrive as `custom_<id>/<vendor>/<model>`).
      model_ids: [fccUpstreamModelId(model)],
      reasoning_history_format: "reasoning_content",
    },
  ]);
}

/**
 * Live mode only (CONFORMANCE_LIVE_UPSTREAM set): the file the
 * gateway's stdout/stderr tee to — the spy log's path with `.jsonl`
 * swapped for `.gateway.log` (conformance-live.sh names it
 * `tmp/conformance/live/<gateway>-<scenario>.jsonl`).
 */
function gatewayLogPath(): string | undefined {
  if (process.env.CONFORMANCE_LIVE_UPSTREAM === undefined) {
    return undefined;
  }
  const spyLog = process.env.CONFORMANCE_LIVE_SPY_LOG;
  if (spyLog === undefined) return undefined;
  return spyLog.endsWith(".jsonl")
    ? spyLog.replace(/\.jsonl$/, ".gateway.log")
    : `${spyLog}.gateway.log`;
}

export const fccGateway: GatewayUnderTest = {
  name: "free-claude-code",
  async start({ upstream, port, workDir, models }): Promise<RunningGateway> {
    const bin = fccBin();
    if (bin === undefined) {
      throw new Error(
        `free-claude-code not installed under ${FCC_DIR} — run ` +
          `scripts/research/conformance-run.sh (it clones ` +
          `${FCC_REPO}@${FCC_TAG} and runs uv sync) or set FCC_INSTALL_DIR`,
      );
    }
    mkdirSync(workDir, { recursive: true });
    // Live mode only: tee stdout/stderr to the scenario's gateway
    // log so a failing cell's cause is visible (Task 13f — the
    // adapter kept output only on startup failure, so 13d's 400s
    // were undiagnosable). Line-buffered so redactGatewayOutput sees
    // whole `name=value` pairs.
    let logStream: WriteStream | undefined;
    const logPath = gatewayLogPath();
    if (logPath !== undefined) {
      mkdirSync(dirname(logPath), { recursive: true });
      logStream = createWriteStream(logPath);
    }
    let pending = "";
    const child = spawn(bin, [], {
      cwd: workDir,
      env: {
        ...process.env,
        // FCC config lives at $HOME/.fcc — the temp workDir, never
        // the real home (conductor's install rule).
        HOME: workDir,
        USERPROFILE: workDir,
        HOST: "127.0.0.1",
        PORT: String(port),
        FCC_CUSTOM_PROVIDERS: fccCustomProviders(upstream, models.openai),
        MODEL: fccModelRef(models.openai),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    const onOutput = (c: Buffer): void => {
      stderr.push(c);
      if (logStream === undefined) return;
      pending += c.toString("utf8");
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        logStream.write(redactGatewayOutput(pending.slice(0, nl + 1)));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    };
    child.stderr.on("data", onOutput);
    child.stdout.on("data", onOutput);
    const base = `http://127.0.0.1:${port}`;
    const running: RunningGateway = {
      anthropicBase: base,
      responsesBase: `${base}/v1`,
      openaiBase: `${base}/v1`,
      stop: async () => {
        await stopChild(child);
        if (logStream === undefined) return;
        if (pending !== "") {
          logStream.write(redactGatewayOutput(pending));
          pending = "";
        }
        await new Promise<void>((resolve) =>
          logStream.end(() => resolve()),
        );
      },
    };
    try {
      await waitHealthy(base, 30_000);
    } catch (err) {
      await running.stop();
      throw new Error(
        `free-claude-code failed to start: ${String(err)}\n` +
          `output: ${redactGatewayOutput(
            Buffer.concat(stderr).toString("utf8").slice(-4000),
          )}`,
      );
    }
    return running;
  },
};

/**
 * FCC cannot serve a gemini-upstream scenario: its built-in `gemini`
 * provider is hard-coded to Google's OpenAI-compatible endpoint
 * (`generativelanguage.googleapis.com/v1beta/openai/`), and
 * FCC_CUSTOM_PROVIDERS accepts only `openai_chat`,
 * `openai_responses` and `anthropic_messages` as `api_format` — no
 * way to point Gemini's generateContent wire format at a mock
 * (per the provider catalog in the FCC repo).
 */
export function fccUnsupported(
  _client: "anthropic" | "responses",
  upstream: "openai" | "gemini",
): string | undefined {
  if (upstream === "gemini") {
    return `not supported (per ${FCC_REPO_URL} — gemini upstream is a fixed Google OpenAI-compatible endpoint)`;
  }
  return undefined;
}
