import { defineConfig } from "@playwright/test";

/**
 * The one §4.4 smoke test. The app and its mock upstream are started
 * by scripts/ci/ui-smoke.sh (also locally); baseURL comes from
 * SMOKE_BASE_URL so the script picks the port.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3199",
  },
});
