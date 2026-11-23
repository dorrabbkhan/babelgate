import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { GatewayUnderTest, RunningGateway } from "../harness";
import { waitHealthy } from "../harness";

const REPO = join(__dirname, "..", "..", "..");

/**
 * Every provider type points at the same mock upstream — the request's
 * model name picks the target dialect ("openai/m", "gemini/m", …).
 */
export function babelgateYaml(upstream: string): string {
  const lines = ["default: openai", "providers:"];
  for (const provider of [
    "openai",
    "gemini",
    "ollama",
    "anthropic",
    "responses",
  ]) {
    lines.push(`  ${provider}:`, `    type: ${provider}`, `    base_url: ${upstream}`);
    // §3.3: reasoning_content reaches an openai/ollama target only
    // with the entry's reasoning_passback opt-in — the conformance
    // scenarios assert it goes back, so the mock entries set it.
    if (provider === "openai" || provider === "ollama") {
      lines.push(`    reasoning_passback: true`);
    }
    // the mock ignores auth — api_key_env is only schema-required
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

export const babelgateGateway: GatewayUnderTest = {
  name: "babelgate",
  async start({ upstream, port, workDir }): Promise<RunningGateway> {
    mkdirSync(workDir, { recursive: true });
    const configPath = join(workDir, "babelgate.yaml");
    writeFileSync(configPath, babelgateYaml(upstream));

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
        `babelgate failed to start: ${String(err)}\n` +
          `stderr: ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }
    return running;
  },
};
