# v1.6 Task 5 — carried from Task 4

**Accepted by the owner on 2026-11-21** (they told the conductor to follow its recommendations after PR #161's
status comment). Found by the Task 4 review. Not a loosening, and no STOP is needed for it:

1. `scripts/build-binary.ts` starts `npm` with `execFileSync` and no shell. On the `win-x64` runner, `npm`
   resolves to `npm.cmd`, and Node refuses to spawn a `.cmd`/`.bat` file without `shell: true` (the
   CVE-2024-27980 fix, Node ≥ 18.20.2 / 20.12.2 / 21.7.3, so every Node 24). Fix it in
   `scripts/build-binary.ts` before the Windows leg depends on it. For example, run `npm` with
   `shell: true` on `win32` only, with fixed arguments (no user input reaches the shell). Or run
   `process.execPath` against the `npm-cli.js` that `npm_execpath` points to. Record the change in this task's
   `docs/decisions.md` entry by full path (`scripts/build-binary.ts` is outside Task 5's Files block).
2. Task 4's `build:binary` and `test:process` were verified on Linux x64 only (PR #161: 126.4 MiB,
   `babelgate 1.5.1`, 9/9). macOS (ad-hoc `codesign`) and Windows paths in `scripts/build-binary.ts` have not
   run yet. Task 5's matrix is their first run, so treat failures there as real, not as flakes.
