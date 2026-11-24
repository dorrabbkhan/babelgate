import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { GatewayUnderTest, RunningGateway } from "../harness";
import { waitHealthy } from "../harness";

const REPO = join(__dirname, "..", "..", "..");

/**
 * Every provider type points at the same mock upstream — the request's
 * model name picks the target dialect ("openai/m", "gemini/m", …).
 *
 * `reasoningPassback` is the only knob the run varies (§3.3 makes
 * reasoning_content passback opt-in): the `babelgate` gateway opts in
 * — the scenarios assert reasoning goes back — and `babelgate-default`
 * runs the unchanged default config so the report discloses and
 * measures both.
 */
export function babelgateYaml(
  upstream: string,
  opts: { reasoningPassback?: boolean } = {},
): string {
  const lines = ["default: openai", "providers:"];
  for (const provider of [
    "openai",
    "gemini",
    "ollama",
    "anthropic",
    "responses",
  ]) {
    lines.push(`  ${provider}:`, `    type: ${provider}`, `    base_url: ${upstream}`);
    if (
      opts.reasoningPassback === true &&
      (provider === "openai" || provider === "ollama")
    ) {
      lines.push(`    reasoning_passback: true`);
    }
    // the mock ignores auth — api_key_env is only schema-required
    if (provider !== "ollama") {
      lines.push(`    api_key_env: BABELGATE_MOCK_KEY`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * v1.6 Task 13c's `babelgate-preset`: the `openai` provider is
 * `preset: openrouter-free` with only `base_url` pointed at the mock
 * — `type`, `api_key_env` (OPENROUTER_API_KEY, set to a mock value in
 * the child env), `gaps` and `reasoning_passback` all come from the
 * preset; no explicit `reasoning_passback` key. Every other provider
 * is the stock entry, so the gemini scenarios still run.
 */
export function babelgatePresetYaml(upstream: string): string {
  const lines = ["default: openai", "providers:"];
  for (const provider of [
    "openai",
    "gemini",
    "ollama",
    "anthropic",
    "responses",
  ]) {
    if (provider === "openai") {
      lines.push(
        `  ${provider}:`,
        `    preset: openrouter-free`,
        `    base_url: ${upstream}`,
      );
      continue;
    }
    lines.push(`  ${provider}:`, `    type: ${provider}`, `    base_url: ${upstream}`);
    if (provider !== "ollama") {
      lines.push(`    api_key_env: BABELGATE_MOCK_KEY`);
    }
  }
  return lines.join("\n") + "\n";
}

/** The command under test: `$BABELGATE_BIN` when set, else `node dist/cli.js`. */
export function gatewayCommand(): { cmd: string; args: string[] } {
  const bin = process.env.BABELGATE_BIN;
  if (bin !== undefined) {
    return { cmd: isAbsolute(bin) ? bin : join(REPO, bin), args: [] };
  }
  return { cmd: process.execPath, args: [join(REPO, "dist", "cli.js")] };
}

/** SIGTERM, escalating to SIGKILL if the process is still up after 10s. */
export function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function makeBabelgateGateway(
  name: string,
  opts: { reasoningPassback?: boolean; preset?: boolean } = {},
): GatewayUnderTest {
  return {
    name,
    async start({ upstream, port, workDir }): Promise<RunningGateway> {
      mkdirSync(workDir, { recursive: true });
      const configPath = join(workDir, "babelgate.yaml");
      writeFileSync(
        configPath,
        opts.preset === true
          ? babelgatePresetYaml(upstream)
          : babelgateYaml(upstream, opts),
      );

      const { cmd, args } = gatewayCommand();
      const child = spawn(cmd, [...args, "--config", configPath], {
        cwd: workDir,
        env: {
          ...process.env,
          // HOME is the data root (~/.babelgate); the suite always gives
          // it a space in the path (Review Focus 5). USERPROFILE must be
          // the same directory: on Windows os.homedir() reads USERPROFILE,
          // not HOME, so without it the binary writes under the runner's
          // real profile.
          HOME: workDir,
          USERPROFILE: workDir,
          PORT: String(port),
          BABELGATE_MOCK_KEY: "mock-key",
          // babelgate-preset: the openrouter-free preset's api_key_env —
          // the mock ignores auth; live mode's spy injects the real key.
          ...(opts.preset === true
            ? { OPENROUTER_API_KEY: "mock-key" }
            : {}),
          NODE_ENV: "production",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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
          `${name} failed to start: ${String(err)}\n` +
            `stderr: ${Buffer.concat(stderr).toString("utf8")}`,
        );
      }
      return running;
    },
  };
}

/** The opted-in config: `reasoning_passback: true` on openai/ollama. */
export const babelgateGateway: GatewayUnderTest = makeBabelgateGateway(
  "babelgate",
  { reasoningPassback: true },
);

/** The unchanged default config — measured like a competitor. */
export const babelgateDefaultGateway: GatewayUnderTest =
  makeBabelgateGateway("babelgate-default");

/**
 * The `preset: openrouter-free` config — passback comes from the
 * preset's data, not an explicit key (v1.6 Task 13c).
 */
export const babelgatePresetGateway: GatewayUnderTest =
  makeBabelgateGateway("babelgate-preset", { preset: true });
