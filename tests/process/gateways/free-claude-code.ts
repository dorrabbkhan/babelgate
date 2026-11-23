import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

const PROVIDER_ID = "custom_0123456789abcdef0123456789abcdef";

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
      provider_id: PROVIDER_ID,
      display_name: "Mock",
      base_url: `${upstream}/v1`,
      api_format: "openai_chat",
      api_keys: ["mock-key"],
      model_ids: [model],
      reasoning_history_format: "reasoning_content",
    },
  ]);
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
        MODEL: `${PROVIDER_ID}/${models.openai}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.stdout.on("data", (c: Buffer) => stderr.push(c));
    const base = `http://127.0.0.1:${port}`;
    const running: RunningGateway = {
      anthropicBase: base,
      responsesBase: `${base}/v1`,
      openaiBase: `${base}/v1`,
      stop: () => stopChild(child),
    };
    try {
      await waitHealthy(base, 30_000);
    } catch (err) {
      await running.stop();
      throw new Error(
        `free-claude-code failed to start: ${String(err)}\n` +
          `output: ${Buffer.concat(stderr).toString("utf8").slice(-4000)}`,
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
