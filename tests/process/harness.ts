import { createServer } from "node:net";

/**
 * The process-level harness (v1.6 spec §3.2, conductor's call a): a
 * gateway runs as its own process against a local mock upstream — the
 * same suite drives `node dist/cli.js` and the SEA binary
 * (`BABELGATE_BIN`), because supertest/msw cannot reach another process.
 */

export interface GatewayUnderTest {
  name: string;
  start(o: {
    upstream: string;
    port: number;
    workDir: string;
    /**
     * Model names per upstream dialect — the mock names in replay
     * mode, the real provider models in live mode
     * (conformance-live.sh). Gateways whose provider config lists
     * models (CCR, free-claude-code) need them at start time.
     */
    models: Record<"openai" | "gemini", string>;
  }): Promise<RunningGateway>;
}

/** The client-facing base URLs a running gateway exposes. */
export interface RunningGateway {
  anthropicBase: string;
  responsesBase: string;
  openaiBase: string;
  stop(): Promise<void>;
}

/** Poll GET <url>/health until 2xx or the deadline passes. */
export async function waitHealthy(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `${url} did not become healthy within ${ms}ms: ${String(lastError)}`,
  );
}

/**
 * A free TCP port on 127.0.0.1 — IPv4 explicitly (0192cad), and bound to
 * loopback only so the suite uses no external network (Global
 * Constraints).
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() =>
        resolve(
          typeof addr === "object" && addr !== null ? addr.port : 0,
        ),
      );
    });
  });
}
