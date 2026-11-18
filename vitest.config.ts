import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Compatibility-matrix reporting (v1.5 spec §3.4, Task 11): the
    // setup wipes tests/matrix/.out before workers run; its teardown
    // merges the workers' recorded cells into .out/matrix.json after
    // the suite — vitest 3.2.4 has no `globalTeardown` option, the
    // setup module's `teardown` export is the run-once hook.
    globalSetup: "tests/matrix/matrix-report.ts",
    // The live suite hits real upstreams; `npm test` must stay offline.
    // Run it explicitly with `npm run test:live`.
    // scripts/gates/fixtures/ holds the Claude Code gate's intentionally
    // failing edit-task project — it is not a vitest suite.
    exclude: [
      ...configDefaults.exclude,
      'tests/live/**',
      'scripts/gates/fixtures/**',
      // the UI suite runs via ui/vitest.config.ts (happy-dom), part of
      // `npm test` as a second vitest invocation
      'ui/**',
    ],
  },
});
