import { defineConfig } from "vitest/config";

/**
 * The process-level suite (v1.6 spec §3.2, conductor's call a): starts
 * a gateway as a separate process against the local mock upstream —
 * the suite that runs against the SEA binary via BABELGATE_BIN
 * (dist/cli.js when unset). Deliberately NOT part of `npm test`;
 * vitest.config.ts excludes tests/process/ and this config is reached
 * only through `npm run test:process`. Binds 127.0.0.1 only.
 */
export default defineConfig({
  test: {
    include: ["tests/process/**/*.test.ts"],
    // Spawning the gateway process, waiting for /health and a graceful
    // SIGTERM flush is slower than any in-process test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
