import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayUnderTest, RunningGateway } from "../harness";
import { waitHealthy } from "../harness";
import { stopChild } from "./babelgate";

const REPO = join(__dirname, "..", "..", "..");

/**
 * claude-code-router (@musistudio/claude-code-router), pinned. The
 * package's model gateway runtime is `dist/main/next-ai-gateway.js`:
 * it reads a JSON config (`GATEWAY_CONFIG_PATH`), static-key auth via
 * env, and exposes `/v1/messages`, `/v1/responses`,
 * `/v1/chat/completions`, `/v1beta/...` and `/health` on one port
 * (verified 2026-11-23 against v3.1.6). The `ccr serve` management
 * layer (web UI, profiles) is a desktop concern and is not needed to
 * route requests, so the adapter launches the gateway runtime
 * directly — same package, same pinned code.
 */
export const CCR_PACKAGE = "@musistudio/claude-code-router";
export const CCR_VERSION = "3.1.6";
export const CCR_DIR =
  process.env.CCR_INSTALL_DIR ??
  join(REPO, "tmp", "conformance", "ccr");

const GATEWAY_JS = join(
  "lib",
  "node_modules",
  CCR_PACKAGE,
  "dist",
  "main",
  "next-ai-gateway.js",
);

/** The gateway entry inside an installed prefix, or undefined. */
export function ccrGatewayEntry(dir = CCR_DIR): string | undefined {
  const entry = join(dir, GATEWAY_JS);
  return existsSync(entry) ? entry : undefined;
}

/**
 * `npm install --global --prefix <dir>` — the published package at the
 * pinned version, no lifecycle scripts (the gateway runtime only
 * needs the bundled code; the management layer's native deps stay
 * out). Global is what lays the package out under
 * <dir>/lib/node_modules. Proxy flags are passed explicitly when
 * HTTP(S)_PROXY is set — CLI flags beat npm_config_* env config, which
 * some sandboxes point at dead ports.
 */
export function installCcr(dir = CCR_DIR): void {
  mkdirSync(dir, { recursive: true });
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  // Keep the npm cache inside `dir` — mirrors installFcc's
  // UV_CACHE_DIR and survives sandboxes whose npm_config_cache env
  // points at a read-only ~/.npm. CONFORMANCE_NPM_CACHE overrides.
  const cache =
    process.env.CONFORMANCE_NPM_CACHE ?? join(dir, "npm-cache");
  execFileSync(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      dir,
      `${CCR_PACKAGE}@${CCR_VERSION}`,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `--cache=${cache}`,
      ...(proxy ? [`--proxy=${proxy}`, `--https-proxy=${proxy}`] : []),
    ],
    { stdio: "inherit" },
  );
}

const CLIENT_KEY = "conformance-mock-key";

/**
 * Every provider a scenario may reach, pointed at the same mock
 * upstream. Model name picks the provider, like babelgate's
 * `<provider>/<model>` but flat: `mock-chat` → openai_chat_completions
 * (<upstream>/v1/chat/completions), `mock-gem` →
 * gemini_generate_content (<upstream>/v1beta/models/<m>:…).
 */
export function ccrGatewayConfig(
  upstream: string,
  models: Record<"openai" | "gemini", string>,
): string {
  return JSON.stringify(
    {
      providers: [
        {
          name: "mock-openai",
          type: "openai_chat_completions",
          apikey: "mock-key",
          baseurl: `${upstream}/v1`,
          models: [models.openai],
        },
        {
          name: "mock-gemini",
          type: "gemini_generate_content",
          apikey: "mock-key",
          baseurl: upstream,
          models: [models.gemini],
        },
      ],
    },
    null,
    2,
  );
}

export const ccrGateway: GatewayUnderTest = {
  name: "ccr",
  async start({ upstream, port, workDir, models }): Promise<RunningGateway> {
    const entry = ccrGatewayEntry();
    if (entry === undefined) {
      throw new Error(
        `ccr not installed under ${CCR_DIR} — run ` +
          `scripts/research/conformance-run.sh (it installs ` +
          `${CCR_PACKAGE}@${CCR_VERSION}) or set CCR_INSTALL_DIR`,
      );
    }
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "gateway-config.json");
    writeFileSync(configPath, ccrGatewayConfig(upstream, models));
    const child = spawn(process.execPath, [entry], {
      cwd: workDir,
      env: {
        ...process.env,
        HOME: workDir,
        USERPROFILE: workDir,
        HOST: "127.0.0.1",
        PORT: String(port),
        GATEWAY_CONFIG_PATH: configPath,
        AUTH_ENABLED: "true",
        AUTH_MODE: "static_api_key",
        AUTH_REQUIRED: "true",
        AUTH_STATIC_API_KEY_BEARER_ONLY: "false",
        AUTH_STATIC_API_KEY: CLIENT_KEY,
        AUTH_STATIC_API_KEY_HEADER: "authorization",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.stdout.on("data", () => {});
    const base = `http://127.0.0.1:${port}`;
    const running: RunningGateway = {
      anthropicBase: base,
      responsesBase: `${base}/v1`,
      openaiBase: `${base}/v1`,
      stop: () => stopChild(child),
    };
    try {
      await waitHealthy(base, 20_000);
    } catch (err) {
      await running.stop();
      throw new Error(
        `ccr failed to start: ${String(err)}\n` +
          `stderr: ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }
    return running;
  },
};

/** The static API key the client sends on every request. */
export const ccrClientHeaders = {
  authorization: `Bearer ${CLIENT_KEY}`,
};
