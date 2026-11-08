import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// UI component tests run in happy-dom (spec §4.4). `root` is pinned to
// ui/ so `npm test` (run from the repo root) only sees ui/src — the
// server suite stays under the root vitest.config.ts. JSX is handled
// by esbuild directly (jsxImportSource: preact) so vitest's own
// bundled vite major never has to match the app's vite major.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
