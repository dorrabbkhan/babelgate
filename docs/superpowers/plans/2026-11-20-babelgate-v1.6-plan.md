# babelgate v1.6 ("One command, free to start" + launch ready) Implementation Plan

> **For agentic workers (Devin):** Run each task in its own session with `/babelgate-task v1.6 <N>`. One task → one branch (`v1.6/task-<N>-<short-name>`) → one PR. Steps use checkbox (`- [ ]`) syntax. Read `AGENTS.md`, this plan's Global Constraints and Review Focus, and the spec sections each task names. Use `./scripts/check.sh quick` while iterating and `./scripts/check.sh` before pushing. Verify every write with `git diff`.

**Goal:** Make babelgate launchable: a replay that stays green through harmless client releases, single binaries with one-command installers, free and cheap provider presets with a first run under a minute, recipes for eight more clients, a passive circuit breaker and a small response cache, `between_tools` thinking, a competitor conformance run, launch material and a landing page.

**Architecture:** Product code stays on the canonical pipeline; no canonical change in v1.6. The binary is the existing CommonJS build bundled by esbuild and injected into Node 24 as a SEA, serving `/ui` from SEA assets. A new process-level harness (`tests/process/`) starts a gateway as a separate process against a local mock upstream that replays recorded provider responses; it tests the binary (Tasks 4–5) and, with two more adapters, claude-code-router and free-claude-code (Task 13b). Free presets widen the v1.5 `ProviderPreset` registry and reach the env path through a new `--provider` flag. The circuit breaker lives inside `attemptTargets`; the cache wraps it in the chat services.

**Tech Stack:** As v1.5 (TypeScript 5 strict, Express 5, Zod 4, pino, `yaml`, vitest 3, msw 2, supertest, `node:sqlite`, Preact + Vite UI, ts-node for scripts). New **dev** dependencies only: `esbuild` (Task 4), `postject` (Task 4, unless Node 24's SEA builder makes it unnecessary). **No new runtime dependencies.** The landing page is plain HTML/CSS/inline SVG, no build step.

**Spec:** `docs/superpowers/specs/2026-11-20-babelgate-v1.6-design.md`. Parents: the roadmap spec and revisions (2026-10-26, 2026-11-04, 2026-11-16); previous: `2026-11-16-babelgate-v1.5-design.md`. Research: `docs/research/2026-11-16-market-analysis.md`, `docs/research/2026-11-20-market-check.md`. Landing mockup: `docs/assets/landing-mockup-v2.html`.

**Decided with the owner (2026-11-20), spec §6:** D1 Node SEA binaries + install scripts + Homebrew + winget, `npx` and Docker kept; D2 no Apple/Windows code signing in v1.6; D3 tap `dorrabbkhan/homebrew-babelgate`; D4 winget manifest prepared, owner submits; D5 v1.6 = roadmap v1.6 + launch ready + open issues; D7 replay diff ignores JSON Schema contents; D8 single non-technical landing page per the mockup; D9 publishing competitor results decided at Task 13b's review.

**Conductor's calls in this plan (owner may object on the plan PR):** (a) The binary is tested by a new process-level suite (`npm run test:process`) against a mock upstream server replaying `tests/fixtures/streams/*`, not by re-running the in-process vitest suites (they use supertest and msw, which cannot reach another process); the in-process suites keep running on Node 22 and 24. This refines spec §3.2's "pair suite against the binary". (b) `between_tools` decodes to canonical effort (`output_config.effort` when present, else `"low"`) with note `thinking_mode_mapped`; the canonical path never re-emits `between_tools` (Anthropic targets get `adaptive` with that effort; same-format pass-through keeps the client's bytes). No canonical change. Task 3 STOPs if Anthropic's docs contradict this. (c) `--provider` reads the key through a new `TARGET_API_KEY_ENV` env var (the name of the variable holding the key), so no secret is copied between variables. (d) The circuit breaker is per process and in memory; it never refuses locally: when every target is open, the first is still tried.

**Prerequisite (owner):** merge the spec, `docs/conductor/model-report-v1.6.md`, `docs/research/2026-11-20-market-check.md`, `docs/roadmap.md`, `docs/assets/landing-mockup-v2.html` and this plan before Task 1.

## Global Constraints

- **Pre-approved test/fixture changes (D6), exactly:** `tests/fixtures/codex/recording.jsonl` re-recorded on the new Codex pin in Task 2 (only if the shape diff with D7's rules reports an addition); any test asserting that `thinking: {type: "between_tools"}` records `thinking_dropped` (Task 3). Each changed test asserts the new behaviour at least as exactly. **No other fixture or contract snapshot changes.** New files under `tests/process/replays/` are additions, not fixture changes. Anything else → STOP and escalate.
- **Defaults unchanged** for existing configs. New config and env, with defaults: provider `circuit_breaker: {failures: 3, cooldown_ms: 30000, max_cooldown_ms: 300000}` or `false` (default on); top-level `cache: {enabled: false, ttl_ms: 300000, max_entries: 500, ignore_temperature: false}`; env `TARGET_API_KEY_ENV`, `TARGET_PRESET`, `CACHE` (`on`/`off`), `CIRCUIT_BREAKER` (`off` disables).
- **Preset `passthrough` implication applies to `tier: "shim"` presets only** (the five v1.5 Anthropic presets). New presets never imply pass-through.
- **No unverified free-tier claims.** Every preset carries `docs` (provider URL) and `verified` (YYYY-MM-DD); docs, README and site say "per <provider>'s docs on <date>", never promise limits.
- **Adapters stay independent**; no provider-pair or client branches. Presets are data; the breaker and cache key on provider name and canonical request, never on hostname.
- **Privacy:** cache entries live in memory only and never reach logs, `/metrics`, OTel or `/ui/api/*`; the harness reports in Task 13b store shapes only (`<string:N>`), never prompt or completion text; installers never print keys.
- **Wire-format evidence:** `between_tools` and every preset's base URL, model name and key variable cite the provider's doc URL in a code comment and in the task's decisions entry.
- **Same code tested and shipped:** a release binary is published only if `npm run test:process` passed against that binary on its own runner.
- **No network in `npm test`.** `test:process` binds only `127.0.0.1` (IPv4 explicitly; see `0192cad`) and uses no external network; Task 13b's live confirmation is a separate opt-in script.
- **Workflow files** are never edited in a PR: changes go to `docs/conductor/patches/v1.6-task<N>-<name>.patch` for the owner to apply.
- **Owner-only:** `package.json`/`package-lock.json` change only in Task 4 (dev deps esbuild/postject, scripts `build:binary`, `test:process`), Task 7 (none expected; STOP if needed), Task 12 (devDependencies for the SDK examples only: `@langchain/openai`, `llamaindex`, `ai` + `@ai-sdk/openai`, `ollama` is already present) and Task 18 (version); fixture/snapshot changes; workflows; Pages and Sponsors settings; tap repo; winget submission; gate runs; tagging; publishing; merging; posting the launch.
- **Copy rules** (README, recipes, launch, site): plain language first; every claim links its evidence; no naming-and-shaming; competitor results only as D9 decides.

## Review Focus

1. **A free-tier route hits its daily cap mid-session** (OpenRouter free returns 429 for the rest of the day). Expected: the client gets the provider's 429 in its own dialect with a hint naming the preset and its docs; the breaker opens so later requests go straight to a fallback if one exists, and the first target is still tried when none does. → Task 9 (`free-tier 429 carries preset hint`, `all-open plan still tries first target`).
2. **The first run when port 3000 is taken** (another dev server, a previous babelgate). Expected: exit non-zero with one line naming the port and `--port`, not a stack trace. → Task 8 (`port in use prints hint and exits 1`).
3. **Two requests that differ only in `tool_choice`, tools, `response_format` or reasoning config** hit an enabled cache. Expected: miss; a hit only for identical canonical requests to the same target; a hit is replayed in the asking client's format. → Task 10 (`requests differing only in tool_choice miss`, `hit replays in a different source format`).
4. **An interrupted or tampered download in `install.sh`/`install.ps1`.** Expected: checksum mismatch aborts with a clear message and leaves no partial or replaced binary in the install dir. → Task 6 (`checksum mismatch aborts and leaves no file`).
5. **The binary started from a directory the user can't write, or with a space in the home path** (Windows `C:\Users\First Last`). Expected: usage DB, Codex catalog and logs go under `~/.babelgate` resolved via `os.homedir()`; `/ui` loads; nothing is written to cwd. → Task 4 (`binary writes nothing to cwd`, `home with a space resolves`).

Each line is pinned by a named test in the owning task.

---

## File Map

```
scripts/gates/shape-diff.ts, shape-diff.test.ts, fixtures/shape-diff/*.jsonl            schema subtrees (T1)
scripts/gates/record-codex.sh, docs/recipes/codex.md                                     pin (T2)
src/transformers/adapters/anthropic.adapter.ts (+ test)                                  between_tools (T3)
scripts/build-binary.ts, sea-config.json, src/utils/sea.ts                               NEW (T4)
src/ui-api/static.ts, src/utils/logger.ts                                                SEA assets, logging (T4)
tests/process/{harness.ts,mock-upstream.ts,gateways/babelgate.ts,binary.process.test.ts}, vitest.process.config.ts   NEW (T4)
docs/conductor/patches/v1.6-task5-binaries.patch                                         NEW (T5)
install/install.sh, install/install.ps1, install/test/*, packaging/homebrew/babelgate.rb.tmpl, packaging/winget/*.yaml.tmpl, scripts/packaging/render.ts   NEW (T6)
src/config/provider-presets.ts, src/config/gateway.schema.ts, yaml-config.ts             preset tiers (T7)
src/cli.ts, src/cli-presets.ts (NEW), src/config/env-config.ts                           --provider, presets cmd, codex preset (T7, T8)
src/routing/circuit-breaker.ts (NEW), src/services/attempt-targets.ts                    breaker (T9)
src/services/response-cache.ts (NEW), chat.service.ts, chat-stream.service.ts, src/observe/sinks/usage-store.ts   cache (T10)
docs/recipes/{cursor,continue,aider,open-webui}.md                                      (T11)
docs/recipes/{langchain,llamaindex,vercel-ai-sdk,ollama-apps}.md, examples/sdk/*         (T12)
scripts/research/competitor-check.sh, competitor-repos.txt                               NEW (T13)
tests/process/gateways/{ccr,free-claude-code}.ts, tests/process/scenarios/*.ts, tests/process/replays/*, scripts/research/conformance-run.sh   NEW (T13b)
tests/process/scenarios/{thinking-after-tool,multi-turn-reasoning,inputs.test}.ts, scripts/research/passback-tokens.ts   (T13d)
scripts/conductor/{judge-checks.ts,judge.test.ts,app-env.sh,session-env.sh}, .claude/settings.json   (T13e)
scripts/research/{conformance-spy.ts,conformance-verdict.ts}, tests/process/conformance.process.test.ts, tests/process/gateways/free-claude-code.ts   (T13f)
ui/src/screens/{Routing,Usage,Requests}.tsx                                              breaker, cache, free label (T14)
README.md, docs/launch/v1.6-launch.md, docs/launch/listings.md, docs/support.md, .github/FUNDING.yml (patch), scripts/demo/*.tape   (T15)
site/index.html, site/style.css, scripts/site/build-site.ts, docs/conductor/patches/v1.6-task16-pages.patch   NEW (T16)
tests/live/*.live.test.ts, scripts/gates/first-run.sh                                    (T17)
CHANGELOG.md, package.json version                                                       (T18)
```

## Task Index

| # | Task | Depends on | Gate | Conductor | Why this model |
|---|---|---|---|---|---|
| 1 | Shape-diff ignores schema subtrees (D7) | — | OWNER REVIEW (changes a check) | Sonnet | Script change with seeded tests |
| 2 | Codex pin to current; recipe re-verified; close #148, #99 | 1 | D6 fixture | Sonnet | Evidence capture and housekeeping |
| 3 | `between_tools` thinking | — | D6 test change | Opus | Wire format; reasoning semantics |
| 4 | SEA build, UI from assets, process harness, binary suite | — | | Opus | New build path; must prove tested == shipped |
| 5 | Binaries in CI: Node 24 leg, 5 platforms, suite on each, archives, sums, cosign, SBOM (patch) | 4 | OWNER GATE (publishing) | Sonnet | Workflow patch; owner judges |
| 6 | Installers, Homebrew formula, winget manifest | 5 | OWNER GATE (publishing) | Sonnet | Scripts and templates |
| 7 | Preset tiers; free/cheap presets from provider docs; `babelgate presets` | — | | Sonnet | Config vocabulary, doc-cited values |
| 8 | First run: `--provider`, `--preset codex`, key guidance, suggested models proven | 7 | | Opus | User-facing defaults; live proof per model |
| 8a | Chat encoder never sends an empty assistant message (Codex → DeepSeek) | 8 | | Opus | Wire format; replayed history; found in Task 8's live run |
| 8b | `json_schema` gap: downgrade to `json_object` for providers without schema output (DeepSeek) | 8 | | Sonnet | Gap vocabulary is data plus one fixer |
| 8c | Failed requests reach the `/ui` inspector | — | | Sonnet | Observability; offline tests only |
| 9 | Circuit breaker | — | | Sonnet | Small state machine in one loop |
| 10 | Response cache | 9 | | Opus | Keying correctness; stream replay; schema migration |
| 11 | Recipes: Cursor, Continue, Aider, Open WebUI | 8 | | Sonnet | Copy, hand-verified |
| 12 | Recipes + examples: LangChain, LlamaIndex, Vercel AI SDK, Ollama apps | 8 | | Sonnet | Copy plus CI-checked examples |
| 13 | Competitor-check script | — | | Sonnet | Script |
| 13b | Competitor conformance run | 4 | OWNER REVIEW (claims about other projects) | Opus | Judges evidence that becomes public claims |
| 13c | OpenRouter and DeepSeek presets pass reasoning back | 13b | | Sonnet | Preset data plus one merge rule; conductor runs the live check |
| 13d | Conformance: live model keeps prior reasoning; Responses scenarios send real user items | 13c | | Sonnet | Test inputs and one script default; conductor runs the live re-run |
| 13e | Conductor tooling: judge.sh "tests beside each"; PATH guard for hook and scripts | — | | Sonnet | Conductor scripts with seeded tests |
| 13f | Conformance tooling: spy-log race, `differs` verdict label, free-claude-code live output | 13d | | Sonnet | Test tooling with seeded tests; conductor runs the live re-check |
| 14 | UI: breaker state, cache hits, free-tier label | 7, 9, 10 | | Sonnet | UI over existing data |
| 15 | Launch readiness: README, post, listings, hygiene, Sponsors/support, demo | 6, 8, 11, 12, 13b, 13c, 13d, 13f | OWNER REVIEW | Sonnet | Copy; owner reviews |
| 16 | Landing page + Pages patch | 15 | OWNER REVIEW | Sonnet | Static page from approved mockup |
| 17 | Live cases; gates E and F | 2, 6, 8, 14 | OWNER REVIEW | Opus | Judges release evidence |
| 18 | CHANGELOG, `1.6.0`; gate G | 5, 6, 16, 17 | OWNER GATE | Sonnet | Release chore |

---

### Task 1: Shape-diff ignores schema subtrees (D7) · OWNER REVIEW

Spec §3.1, E7.

**Files:**
- Modify: `scripts/gates/shape-diff.ts`, `scripts/gates/shape-diff.test.ts`, `docs/decisions.md`
- Create: `scripts/gates/fixtures/shape-diff/{pr142-old,pr142-new,pr149-old,pr149-new}.jsonl` (minimal lines reproducing those diffs, shapes only)

**Interfaces:**
- `SCHEMA_SUBTREES: readonly string[]` (exported) = `["tools[].input_schema", "tools[].function.parameters", "tools[].parameters", "tools[].functionDeclarations[].parameters", "output_config.format.schema", "response_format.json_schema.schema", "text.format.schema", "generationConfig.responseSchema", "generationConfig.responseJsonSchema"]`, matched against the body path (after `body `) with any `[]` nesting prefix allowed (namespace `tools[].tools[]…`).
- `walkBody` records the subtree root key itself (`body tools[].input_schema`) and does not descend below it. Tool `name`/`type`, input item types and SSE event types are unchanged.

- [ ] **Step 1: Tests.** `"pr142 schema-only diff exits 0"`, `"pr149 schema-only diff exits 0"`, `"new tool name still fails"`, `"new content block type still fails"`, `"new SSE event type still fails"`, `"new top-level key still fails"`, `"new key inside a known block still fails"`, `"schema root removed is reported, exit 0"`.
- [ ] **Step 2: Run** `npx vitest run scripts/gates/shape-diff.test.ts` → FAIL on the pr142/pr149 cases.
- [ ] **Step 3: Implement.** Update the header comment's "four categories" text to state the schema rule. Decisions entry: D7, the subtree list, and why (PRs #142, #149).
- [ ] **Step 4:** `./scripts/check.sh` → PASS. **Commit** `fix(gates): shape diff ignores JSON Schema contents (D7)`.

### Task 2: Codex pin; recipe re-verified; close #148 and #99 · D6

Spec §3.1, §3.7, E8, E10.

**Files:**
- Modify: `scripts/gates/record-codex.sh` (`CODEX_VERSION` default → current release), `docs/recipes/codex.md` ("tested: codex-cli <v>"), `docs/decisions.md`; `tests/fixtures/codex/recording.jsonl` only under D6

- [ ] **Step 1:** Record with the current Codex (`record-codex.sh`, network step run by the conductor), then `ts-node scripts/gates/shape-diff.ts <new> tests/fixtures/codex/recording.jsonl`. Exit 0 → keep the fixture. Exit 1 → replace it (D6) and list the added lines in the PR body.
- [ ] **Step 2:** Run `scripts/gates/codex-edit.sh config examples/codex-openrouter.yaml` with `LOG_LEVEL=info`; the PR body quotes the babelgate request-log lines (method, path, model, status) that prove Codex went through babelgate. No log lines → STOP.
- [ ] **Step 3:** Update the pin and recipe version. Decisions entry: version, date, evidence. **Commit** `chore(gates): pin codex recorder to <v>`.
- [ ] **Step 4 (conductor, after merge):** when the next scheduled replay is green, `gh issue close 148` with the run link; `gh issue close 99` with "Done in v1.4 Task 7a (#100, #101): canonical `text_signature`, Gemini decoders, envelope `textIndex`."

### Task 3: `between_tools` thinking · D6

Spec §3.6, E9, conductor's call (b).

**Files:**
- Modify: `src/transformers/adapters/anthropic.adapter.ts` (`toCanonicalReasoning`, doc comment), `anthropic.adapter.test.ts`, `docs/decisions.md`

**Interfaces:**
- `toCanonicalReasoning` handles `t.type === "between_tools"` → `{ effort }` with `effort = output_config.effort` when on the ladder (`"max"` lowers to `"xhigh"` as for `adaptive`), else `"low"`; records note `{stage: "decode", adapter: "anthropic", code: "thinking_mode_mapped", path: "thinking.type"}`.
- Encoding to Anthropic is unchanged (adaptive models get `{type: "adaptive"}` + `output_config.effort`).

- [ ] **Step 1:** Read Anthropic's extended-thinking and effort docs; quote the `between_tools` definition and model list in the PR body. Not documented, or documented with a budget or other field this mapping drops → **STOP**.
- [ ] **Step 2: Tests.** `"between_tools maps to output_config effort"`, `"between_tools without effort maps to low"`, `"between_tools max lowers to xhigh"`, `"between_tools records thinking_mode_mapped"`, `"between_tools to gemini target sets thinking level from effort"` (pair test), `"anthropic pass-through keeps between_tools bytes"`. Replace any test asserting `between_tools` → `thinking_dropped` (D6).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** Decisions: doc URLs, mapping, note code. **Step 5:** `./scripts/check.sh` → PASS. **Commit** `feat(anthropic): map between_tools thinking`.

### Task 4: SEA build, UI from assets, process harness, binary suite

Spec §3.2, E1–E3, conductor's call (a), Review Focus 5.

**Files:**
- Create: `scripts/build-binary.ts`, `sea-config.json`, `src/utils/sea.ts`, `src/utils/sea.test.ts`, `tests/process/harness.ts`, `tests/process/mock-upstream.ts`, `tests/process/gateways/babelgate.ts`, `tests/process/binary.process.test.ts`, `vitest.process.config.ts`
- Modify: `src/ui-api/static.ts`, `src/ui-api/static.test.ts`, `src/utils/logger.ts`, `package.json` (devDeps `esbuild`, `postject` if needed; scripts `"build:binary": "ts-node scripts/build-binary.ts"`, `"test:process": "vitest run --config vitest.process.config.ts"`), `.gitignore` (`dist-bin/`), `docs/decisions.md`, `docs/architecture.md`

**Interfaces:**
- `src/utils/sea.ts`: `isSea(): boolean` (wraps `node:sea` `isSea`, false when the module is missing); `seaAsset(key: string): Buffer | undefined`.
- `uiStatic(config, uiDir?, assets?: {get(path: string): Buffer | undefined})`: when `assets` is given (production wiring passes it when `isSea()`), serve `GET/HEAD /ui/*` from it with `Content-Type` by extension, the same index.html fallback, the same access rules; otherwise unchanged. Asset keys are `ui/<relative path>`.
- `loggerOptions`: no transport when `isSea()`.
- `scripts/build-binary.ts [--out dist-bin/] [--node <path>]`: `npm run build` → esbuild bundle `dist/cli.js` to `dist-bin/babelgate.cjs` (platform node, format cjs, target node24, externals none) → `sea-config.json` with `main`, `output`, `assets` = every file in `dist/ui` → blob → copy the running `node` binary → inject (remove macOS signature first and ad-hoc re-sign after with `codesign --sign -` on darwin; no Apple identity, D2) → `dist-bin/babelgate[.exe]`. Fails if not run on Node 24.x.
- `tests/process/mock-upstream.ts`: `startMockUpstream(routes: MockRoute[]): Promise<{url: string; requests: RecordedRequest[]; close(): Promise<void>}>`; `MockRoute = {method: string; path: string | RegExp; reply: {status: number; headers: Record<string,string>; bodyFile: string}}`, `bodyFile` under `tests/fixtures/streams/` or `tests/process/replays/`, streamed as recorded. Binds `127.0.0.1:0`.
- `tests/process/harness.ts`: `interface GatewayUnderTest { name: string; start(o: {upstream: string; port: number; workDir: string}): Promise<RunningGateway> }`, `interface RunningGateway { anthropicBase: string; responsesBase: string; openaiBase: string; stop(): Promise<void> }`, `waitHealthy(url, ms)`.
- `tests/process/gateways/babelgate.ts`: runs `$BABELGATE_BIN` when set, else `node dist/cli.js`, with a generated `babelgate.yaml` pointing every provider at the mock upstream, `HOME` set to `workDir` (a path containing a space).

- [ ] **Step 1: Tests.** `sea.test.ts`: `"isSea false under node"`; `static.test.ts`: `"assets source serves index and a hashed asset with content-type"`, `"assets source falls back to index for client routes"`, `"assets source keeps the loopback rule"`. `binary.process.test.ts` (each against `BABELGATE_BIN`): `"--version prints package version"`, `"anthropic client to openai upstream: text, stream, tool call"`, `"responses client to gemini upstream: stream with tool call"`, `"openai client to ollama upstream"`, `"/ui loads index and an asset"`, `"/metrics responds"`, `"usage row written under HOME/.babelgate"`; Review Focus 5: `"binary writes nothing to cwd"` (cwd read-only temp dir, assert empty after), `"home with a space resolves"`.
- [ ] **Step 2: Run** unit tests → FAIL; `npm run build:binary && BABELGATE_BIN=dist-bin/babelgate npm run test:process` → FAIL.
- [ ] **Step 3: Implement.** Decisions: Node 24 pin and why, dev deps, SEA flags, the `node:sqlite` experimental warning handling (suppress only that warning, by code).
- [ ] **Step 4:** both commands → PASS on Linux; `./scripts/check.sh` → PASS. PR body: binary size and `--version` output. **Commit** `feat: single binary build (Node SEA)`.

### Task 5: Binaries in CI · OWNER GATE

Spec §3.2, D2.

**Files:**
- Create: `docs/conductor/patches/v1.6-task5-binaries.patch`, `scripts/packaging/checksums.ts`, `scripts/packaging/checksums.test.ts`
- Modify: `SECURITY.md` (verify a binary with cosign and SHA-256), `docs/decisions.md`

**Interfaces:**
- Patch adds to `ci.yml`: a Node 24 leg of the existing check job. Adds to `release.yml`: a matrix `{linux-x64: ubuntu-latest, linux-arm64: ubuntu-24.04-arm, darwin-arm64: macos-latest, darwin-x64: macos-13, win-x64: windows-latest}` that runs `npm ci`, `npm run build:binary`, `BABELGATE_BIN=… npm run test:process`, archives `babelgate-<v>-<target>.tar.gz` (`.zip` on Windows), uploads; a join job that runs `checksums.ts` → `SHA256SUMS`, `cosign sign-blob --yes` (keyless) for every archive and `SHA256SUMS` (`.sig` + `.pem`), adds them to the CycloneDX SBOM step from v1.5, attaches all to the GitHub release. A failing target fails the release (no partial publish).
- `checksums.ts <dir>` writes `SHA256SUMS` in `sha256sum` format, sorted by filename.

- [ ] **Step 1: Tests.** `"checksums match sha256sum format"`, `"sorted by filename"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; write the patch (`git diff` format, not applied); dry-run each matrix step locally where the OS allows and paste the Linux run in the PR body.
- [ ] **Step 4:** `./scripts/check.sh` → PASS. PR body: "Owner: apply `docs/conductor/patches/v1.6-task5-binaries.patch`; Windows result decides D5's win-x64 rule (spec §3.2)." **Commit** `ci: release binaries (patch)`.

### Task 6: Installers, Homebrew, winget · OWNER GATE

Spec §3.2, D2–D4, Review Focus 4.

**Files:**
- Create: `install/install.sh`, `install/install.ps1`, `install/test/install.test.ts`, `packaging/homebrew/babelgate.rb.tmpl`, `packaging/winget/dorrabbkhan.babelgate.{installer,locale.en-US,version}.yaml.tmpl`, `scripts/packaging/render.ts`, `scripts/packaging/render.test.ts`
- Modify: `docs/decisions.md`

**Interfaces:**
- `install.sh [--version <v>] [--dir <path>]` (default `~/.local/bin`): detects OS/arch (`uname`), downloads the archive and `SHA256SUMS` from `https://github.com/dorrabbkhan/babelgate/releases/download/v<v>/`, verifies the SHA-256 (`sha256sum` or `shasum -a 256`), verifies with `cosign verify-blob` when `cosign` is on PATH (identity: the release workflow), extracts to a temp dir and moves into place atomically; prints a PATH line if the dir isn't on PATH. Env `BABELGATE_INSTALL_BASE_URL` overrides the download base (tests). No `sudo`. `install.ps1` mirrors it (`%LOCALAPPDATA%\babelgate\bin`, `Get-FileHash`).
- `render.ts --version <v> --sums <SHA256SUMS>` renders the formula (darwin-arm64/x64, linux-x64/arm64 URLs + sha256; `test do` runs `babelgate --version`) and the winget manifests (win-x64 zip, `NestedInstallerType: portable`) into `dist-packaging/`.

- [ ] **Step 1: Tests.** `install.test.ts` (runs `install.sh` against a local HTTP server with a fake archive): `"installs into --dir and prints version"`, Review Focus 4: `"checksum mismatch aborts and leaves no file"`, `"existing binary untouched on failure"`, `"unsupported arch exits with a message"`. `shellcheck install/install.sh` in the test (skipped with a message if shellcheck is absent). `render.test.ts`: `"formula has four platform urls with sums"`, `"winget manifest validates against schema 1.9 shape"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. PR body: owner steps (create `dorrabbkhan/homebrew-babelgate`, push rendered formula at release; submit winget PR at release). **Commit** `feat: installers and package manifests`.

### Task 7: Preset tiers; free and cheap presets; `babelgate presets`

Spec §3.3, E5.

**Files:**
- Modify: `src/config/provider-presets.ts`, `src/config/gateway.schema.ts`, `src/config/yaml-config.ts`, tests beside each, `docs/decisions.md`
- Create: `src/cli-presets.ts`, `src/cli-presets.test.ts`

**Interfaces:**
- `ProviderPreset` becomes `{type: "anthropic" | "openai" | "gemini"; tier: "free" | "cheap" | "shim"; base_url: string; api_key_env?: string; signup_url?: string; gaps: Gap[]; suggested?: {"claude-code"?: string; codex?: string; "openai-apps"?: string}; max_output_tokens?: number; docs: string; verified: string}`. Existing five presets gain `tier: "shim"`; behaviour unchanged.
- New `PRESET_NAMES` entries, each verified against the provider's own docs on the task date or dropped (decisions entry per preset): `openrouter-free` (`openai`, `https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`), `gemini-free` (`gemini`, `GEMINI_API_KEY`), `groq` (`openai`), `nvidia-nim` (`openai`), `cerebras` (`openai`), `deepseek` (`openai`, `tier: "cheap"`). `suggested` stays empty here; Task 8 fills only models proven on the edit task.
- yaml-config: `passthrough` implied only when `preset.tier === "shim"`.
- `src/cli-presets.ts`: `formatPresetList(presets): string[]` — one row per preset: name, tier, key env, suggested models, `docs (verified <date>)`. `babelgate presets` prints it and exits 0.

- [ ] **Step 1: Tests.** `"shim presets keep passthrough"`, `"free preset does not imply passthrough"`, `"openrouter-free preset fills type, base_url and key env"`, `"preset without docs or verified fails schema"`, `"presets command lists tier and docs date"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: free and cheap provider presets`.

### Task 8: First run: `--provider`, `--preset codex`, key guidance

Spec §3.3, E5, E11, conductor's call (c), Review Focus 2.

**Files:**
- Modify: `src/cli.ts`, `src/cli.test.ts`, `src/config/env-config.ts`, `env-config.test.ts`, `src/config/provider-presets.ts` (`suggested`, `max_output_tokens`), `docs/decisions.md`

**Interfaces:**
- `--provider <preset>` (refused with a config file, like `--target`): `wantedEnv` sets `TARGET_API` (preset type), `<TYPE>_API_BASE_URL`, `TARGET_API_KEY_ENV` (preset `api_key_env`), `TARGET_PRESET`, `TARGET_MAX_OUTPUT_TOKENS` (when set), and with `--preset claude-code` `MODEL_MAP=claude-*=<suggested claude-code>`, with `--preset codex` `MODEL_MAP=*=<suggested codex>`; `--model` overrides the suggestion. User env wins, as today.
- env-config: when `TARGET_API_KEY_ENV` is set, the target key is read from `process.env[TARGET_API_KEY_ENV]`; `TARGET_PRESET` is kept on the provider entry as `preset` (for Task 14's label).
- Missing key: before listening, if the effective key env is empty, print `"<KEY_ENV> is not set. Get a key at <signup_url> (free tier per <provider> docs on <verified>)."` and exit 1.
- `--preset codex`: prints the `config.toml` block from `docs/recipes/codex.md` with `base_url` on the actual port, and writes the model catalog JSON (from `examples/codex-model-catalog.json`, model slug replaced) to `~/.babelgate/codex-model-catalog.json`, printing its path. Writes nothing else outside `~/.babelgate`.
- Listen failure `EADDRINUSE` → one line `"Port <p> is in use. Start with --port <p+1> (or stop the other process)."`, exit 1.

- [ ] **Step 1: Tests.** `"--provider sets target env and key env name"`, `"--provider with config file is refused"`, `"user env wins over --provider"`, `"missing key prints signup url and exits 1"`, `"--preset codex prints toml with port and writes catalog under ~/.babelgate"`, `"claude-code preset adds max output tokens when preset sets it"`; Review Focus 2: `"port in use prints hint and exits 1"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.**
- [ ] **Step 4 (live, conductor runs):** for each preset with a key available, run `scripts/gates/claude-code-edit.sh` and `codex-edit.sh` through `babelgate --provider <p>` on candidate models from the provider's docs; record passing models in `suggested` with the date. No passing model → no suggestion for that client. PR body: the table of tried models and results.
- [ ] **Step 5:** `./scripts/check.sh` → PASS. **Commit** `feat: one-command first run with provider presets`.

### Task 8a: Chat encoder never sends an empty assistant message

Found by the conductor's Task 8 live run (2026-11-23, owner decision: fix before DeepSeek gets a Codex suggestion). Spec §3.3 (suggested models must be proven), v1.4 spec §3.3 (reasoning pass-back).

**Evidence.** `codex exec` → babelgate `--preset codex --provider deepseek` (`deepseek-flash` and `deepseek-v4-pro`): turn 1 returns 200 with `finishReason: tool_call` (reasoning + a function call); turn 2 (Codex replays the history) gets upstream `400 invalid_request_error "Invalid assistant message: content, tool_calls or reasoning_content must be set"` on `POST https://api.deepseek.com/v1/chat/completions`. Intermittent (one of four runs passed with a 400 in between). Claude Code through the same preset passes. `src/transformers/adapters/openai.adapter.ts` `convertFromCanonicalMessage` always emits `{role:"assistant", content: null}` for an assistant message, then adds `reasoning_content` only when the reasoning parts survive (origin and `reasoning_passback`) and `tool_calls` only when present. So an assistant message whose only content was dropped reasoning, or an empty text, goes out with none of the three fields. DeepSeek rejects that per https://api-docs.deepseek.com/api/create-chat-completion; other Chat upstreams tolerate it.

**Files:**
- Modify: `src/transformers/adapters/openai.adapter.ts`, `src/transformers/adapters/openai.adapter.test.ts`, `docs/decisions.md`; in Step 5 only, `src/config/provider-presets.ts` and `src/config/provider-presets.test.ts` (DeepSeek `suggested`)
- Modify only if the root cause is on the decode side: `src/transformers/adapters/responses.items.ts`, its test

**Interfaces:**
- No canonical change. No provider-specific branch: the rule holds for every Chat target.
- First find which replayed shape produces the empty message (a reasoning-only assistant turn, an empty `output_text` message item next to a `function_call`, or both) with a decode→encode test built from the Responses input Codex sends on turn 2. Record the shape in the decisions entry.
- Chat encode: an assistant message with no text, no tool calls and no surviving `reasoning_content` is not sent; the encoder records a `field_dropped` trace note at `messages[<i>]`. When an assistant text message is directly followed by an assistant tool-call message from the same turn, they merge into one Chat assistant message (`content` + `tool_calls`), the shape Chat defines.
- Message order and tool-call/tool-result pairing stay valid after a drop (no orphan `tool` message).

- [ ] **Step 1: Tests.** `"chat encode drops an assistant message left empty by dropped reasoning"`, `"chat encode merges assistant text and tool calls from one turn"`, `"responses turn-2 replay encodes to valid chat messages"` (asserts every assistant message has `content`, `tool_calls` or `reasoning_content`), `"empty assistant drop records a trace note"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS.
- [ ] **Step 5 (live, conductor runs):** the Task 8 driver, `--preset codex --provider deepseek` on `deepseek-flash` and `deepseek-v4-pro`, three runs each; all must pass with no upstream 400. Claude Code on both re-run once (no regression). Then DeepSeek's `suggested` (claude-code and codex) is set from the models that passed with both clients, in a fix round on this PR, with the live table in decisions.md and the PR body.
- **Commit** `fix(openai): never send an empty assistant message`.

### Task 8b: `json_schema` gap for providers without schema output

Found by the conductor's Task 8 live run (2026-11-23): Claude Code → babelgate `--provider deepseek` passes the edit task, but 2 side requests per run get upstream `400 "This response_format type is unavailable now"`. Claude Code sends `response_format`/structured output that babelgate encodes as Chat `{type:"json_schema", json_schema:{…}}` (`src/transformers/adapters/openai.adapter.ts`, the `responseFormat` block); DeepSeek documents only `{type:"json_object"}` (https://api-docs.deepseek.com/guides/json_mode). v1.5 spec §3.3 gap vocabulary.

**Files:**
- Modify: `src/config/provider-presets.ts` (new gap `json_schema` in `GAPS`; `deepseek` preset `gaps: ["json_schema"]`), `src/transformers/adapters/openai.adapter.ts` (gap fixer), tests beside each, `docs/recipes/native-endpoints.md` (gap table row), `docs/decisions.md`

**Interfaces:**
- Gap `json_schema`: a Chat request with `response_format.type === "json_schema"` is sent as `{type:"json_object"}`; the schema is not dropped silently: a trace note `response_format_downgraded` at `response_format`, and one system-message line appended naming the expected JSON shape (`Respond with JSON matching this schema: <schema JSON>`). JSON mode requires the word "json" in the prompt per DeepSeek's guide; the appended line satisfies it.
- Only entries whose `gaps` list `json_schema` change; every other provider is byte-identical. No canonical change, no provider branch (the gap is data).
- Verify against DeepSeek's docs page on the task date and cite it in the code comment and the decisions entry; drop `deepseek-anthropic` from scope (its endpoint is the Anthropic shim).

- [ ] **Step 1: Tests.** `"json_schema gap sends json_object with a schema line and a note"`, `"provider without the gap keeps json_schema unchanged"`, `"deepseek preset declares the json_schema gap"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS.
- [ ] **Step 5 (live, conductor runs):** Claude Code edit task through `--provider deepseek` on `deepseek-flash`: passes with no upstream 400 in the log.
- **Commit** `feat(gaps): json_schema downgrade for providers without schema output`.

### Task 8c: Failed requests reach the `/ui` inspector

Found by the conductor's Task 8 live run (2026-11-23): a Codex stream request that got upstream 400 (`POST /v1/responses 400`, route log `status: "error"`) did not appear in `GET /ui/api/requests`; only the successful request did, so its body snapshots could not be inspected. Inspector spec: v1.3 §3.5 / §3.11 (ring of the last `INSPECTOR_BUFFER` traces, memory only).

**Files:**
- Modify: whichever of `src/services/canonical-stream.service.ts`, `src/services/proxy.service.ts`, `src/observe/sinks/body-ring.ts`, `src/ui-api/requests.ts` holds the cause, tests beside each, `docs/decisions.md`

**Interfaces:**
- First find why the row is missing (the request list source, the trace never emitted on the upstream-error path of a stream, or bodies not attached) and record it in the decisions entry.
- A request that fails upstream (HTTP 4xx/5xx before or after headers, streaming and non-streaming) is listed by `/ui/api/requests` with `status: "error"`, its `httpStatus`, and its body snapshots in the ring (`GET /ui/api/requests/:id`), same privacy rules as successful requests (memory only, `INSPECTOR_BUFFER=0` disables).
- No change to what is logged or stored on disk.

- [ ] **Step 1: Tests.** `"stream request with upstream 400 is listed with status error"`, `"failed request bodies are in the ring"`, `"non-stream upstream 500 is listed"`, `"INSPECTOR_BUFFER=0 still stores no bodies for failed requests"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS.
- **Commit** `fix(observe): failed requests reach the inspector`.

### Task 9: Circuit breaker

Spec §3.5, conductor's call (d), Review Focus 1.

**Files:**
- Create: `src/routing/circuit-breaker.ts`, `src/routing/circuit-breaker.test.ts`
- Modify: `src/services/attempt-targets.ts`, `attempt-targets.test.ts`, `src/routing/route-log.ts`, `src/config/gateway.schema.ts`, `yaml-config.ts`, `env-config.ts`, `src/observe/sinks/metrics.ts`, `src/ui-api/routing.ts`, `docs/decisions.md`

**Interfaces:**
- `createBreakers(cfg: Record<string, BreakerConfig | false>, now?: () => number): Breakers`; `Breakers.isOpen(provider): boolean`, `.recordFailure(provider)`, `.recordSuccess(provider)`, `.snapshot(): {provider: string; state: "closed" | "open"; openUntil?: number; consecutiveFailures: number}[]`. Failure = an error for which `isFallbackEligible(err)` is true. Cooldown doubles per re-open up to `max_cooldown_ms`; a success resets.
- `attemptTargets(plan, registry, attempt, ctx, breakers?)`: skips open targets in order; if every target is open, tries `plan.targets[0]`; skipped targets add a hop `{outcome: "skipped_open"}` (`Hop.outcome` in `src/routing/route-log.ts` gains that member; the inspector shows it).
- Metrics gauge `babelgate_circuit_open{provider}`; `/ui/api/routing` gains `breakers: snapshot()`.
- Free-tier 429: when the failing entry has a `preset` with `tier: "free"`, the error message (in the source's dialect) gains `" (free tier: <preset>, limits per <docs>)"`.

- [ ] **Step 1: Tests.** `"opens after 3 eligible failures"`, `"non-eligible error does not count"`, `"cooldown doubles to cap"`, `"success closes"`, `"open target skipped with hop"`, `"circuit_breaker:false never opens"`; Review Focus 1: `"all-open plan still tries first target"`, `"free-tier 429 carries preset hint"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: passive circuit breaker`.

### Task 10: Response cache

Spec §3.5, Review Focus 3.

**Files:**
- Create: `src/services/response-cache.ts`, `src/services/response-cache.test.ts`
- Modify: `src/services/chat.service.ts`, `chat-stream.service.ts`, `canonical-stream.service.ts`, `src/config/gateway.schema.ts`, `yaml-config.ts`, `env-config.ts`, `src/observe/sinks/usage-store.ts` (migration `version: 4`: `ALTER TABLE requests ADD COLUMN cache_hit INTEGER;`), `src/observe/trace.ts`, `docs/decisions.md`

**Interfaces:**
- `createResponseCache(cfg: CacheConfig, now?): ResponseCache`; `cacheKey(target: RouteTarget, req: CanonicalRequest): string` = sha256 of a stable JSON of `{provider, model, messages, system, tools, toolChoice, responseFormat, config}` (every canonical field except stream flag and client metadata); `get(key): CachedEntry | undefined`; `set(key, entry)`; `CachedEntry = {response: CanonicalResponse} | {events: CanonicalStreamEvent[]}`; LRU by `max_entries`, TTL by `ttl_ms`.
- Not cached: `config.temperature > 0` unless `ignore_temperature`; any error; a response whose finish reason is `length` with tool calls; pass-through requests.
- Hit: response re-encoded by the source adapter (stream replayed through the stream encoder); trace `cacheHit: true`, cost 0, `cache_hit = 1` in the row.

- [ ] **Step 1: Tests.** `"identical request hits"`, `"ttl expiry misses"`, `"lru evicts oldest"`, `"temperature>0 not cached unless ignore_temperature"`, `"errors not cached"`, `"passthrough not cached"`, `"stream hit replays events in order"`, `"cache hit row has cache_hit 1 and cost 0"`, `"cache off by default"`; Review Focus 3: `"requests differing only in tool_choice miss"`, `"requests differing only in response_format miss"`, `"hit replays in a different source format"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: opt-in exact-match response cache`.

### Task 11: Recipes: Cursor, Continue, Aider, Open WebUI

Spec §3.4.

**Files:**
- Create: `docs/recipes/cursor.md`, `continue.md`, `aider.md`, `open-webui.md`
- Modify: `docs/recipes/claude-code.md` and `docs/recipes/codex.md` (free-preset path via `--provider`; Claude Code: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` and babelgate's `max_output_tokens` clamp, E11), `README.md` (recipe index only), `docs/decisions.md`

Each page: client version and date verified; client config; the `babelgate --provider <free preset>` command; "what works / what doesn't" with links to `docs/compatibility.md` cells; Open WebUI in both OpenAI and Ollama connection modes.

- [ ] **Step 1 (conductor runs, hand-verified):** for each client, one chat and one tool/edit action through babelgate on a free preset; screenshot or log excerpt in the PR body. A client that can't be pointed at a custom base URL → page says so and the task notes it.
- [ ] **Step 2:** Write the pages. `./scripts/check.sh` → PASS (link check). **Commit** `docs: recipes for cursor, continue, aider, open webui`.

### Task 12: Recipes and examples: LangChain, LlamaIndex, Vercel AI SDK, Ollama apps

Spec §3.4.

**Files:**
- Create: `docs/recipes/langchain.md`, `llamaindex.md`, `vercel-ai-sdk.md`, `ollama-apps.md`; `examples/sdk/{langchain.ts,llamaindex.ts,vercel-ai-sdk.ts,ollama-app.ts}`; `examples/sdk/sdk.examples.test.ts`
- Modify: `README.md` (recipe index), `docs/decisions.md`

**Interfaces:**
- Each example exports `run(baseUrl: string): Promise<string>`; the test starts the app in-process with msw upstreams and asserts a text answer and, where the SDK supports it, one tool call. The SDK packages are devDependencies allowed by Global Constraints (Task 12 only); runtime dependencies stay unchanged.

- [ ] **Step 1: Tests** `"langchain example answers"`, `"llamaindex example answers"`, `"vercel ai sdk example answers with a tool call"`, `"ollama app on a cloud model answers"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `docs: SDK recipes with tested examples`.

### Task 13: Competitor-check script

Spec §3.9, E12.

**Files:**
- Create: `scripts/research/competitor-check.sh`, `scripts/research/competitor-repos.txt`, `scripts/research/competitor-check.test.ts`

**Interfaces:**
- `competitor-repos.txt`: `owner/repo  label` lines (the 2026-11-20 list plus `anthropics/claude-code`, `openai/codex`, `ollama/ollama`). `competitor-check.sh [--out docs/research/<date>-competitor-check.md] [--since YYYY-MM-DD]`: via `gh api`, per repo: stars, pushed date, latest release tag/date, archived flag, open issues since `--since` matching `thinking|tool|stream|reasoning` (count + 5 titles); writes a dated Markdown table plus a section listing each preset's `docs` URL and `verified` date older than 30 days. Pure parsing in a `.ts` helper so it is testable offline.

- [ ] **Step 1: Tests** (recorded `gh api` JSON in `scripts/research/fixtures/`): `"renders one row per repo"`, `"archived repo flagged"`, `"stale preset docs listed"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; PR body: one real run's output. **Commit** `feat: scripted competitor check`.

### Task 13b: Competitor conformance run · OWNER REVIEW

Spec §3.10, D9.

**Files:**
- Create: `tests/process/gateways/ccr.ts`, `tests/process/gateways/free-claude-code.ts`, `tests/process/scenarios/{thinking-after-tool,streamed-tool-args,multi-turn-reasoning}.ts`, `tests/process/conformance.process.test.ts`, `tests/process/replays/<provider>/*.sse` (recorded), `scripts/research/conformance-run.sh`, `scripts/research/conformance-live.sh`, `docs/research/2026-11-XX-conformance-run.md` (draft)

**Interfaces:**
- Scenario: `{name: string; client: "anthropic" | "responses"; upstream: "openai" | "gemini"; turns: ScenarioTurn[]; assert(results: TurnResult[]): ScenarioVerdict}`; `ScenarioVerdict = {pass: boolean; reason?: string; evidence: {request: Shape; response: Shape}}` (shapes only).
  - `thinking-after-tool`: turn 2 sends the tool result with turn 1's thinking block; pass = upstream request carries the reasoning per the target's rules and the client stream has a valid thinking block before text.
  - `streamed-tool-args`: upstream streams arguments in ≥ 5 deltas; pass = client receives one tool call whose concatenated arguments parse as the recorded JSON.
  - `multi-turn-reasoning`: 3 turns; pass = reasoning present every turn, no 400, no dropped block.
- Gateways install at pinned versions into a temp dir (`npm i -g --prefix`, or `pip install` / `uv tool install` per the project's own README; pin recorded in the report); configs point every provider at the mock upstream. Nothing of theirs is committed.
- `conformance-run.sh` → runs `conformance.process.test.ts` for `babelgate`, `ccr`, `free-claude-code` and writes the report table (scenario × gateway, versions, date, repro command). `conformance-live.sh <gateway> <scenario>` reruns one scenario against the live provider (OpenRouter Chat model and Gemini, keys from env) for confirmation.
- Replays: if `tests/fixtures/streams/*` lacks a reasoning or ≥5-delta tool stream, record one with `npm run record:streams` into `tests/process/replays/` (not `tests/fixtures/`).

- [ ] **Step 1: Tests.** `"babelgate passes thinking-after-tool"`, `"babelgate passes streamed-tool-args"`, `"babelgate passes multi-turn-reasoning"` (must pass; a babelgate failure is a bug → fix in this task if small, else STOP).
- [ ] **Step 2:** Add the two competitor adapters; run `conformance-run.sh`. Each competitor failure → `conformance-live.sh`; only live-confirmed failures are reported as failures, others as "mock-only, unconfirmed".
- [ ] **Step 3:** Write the draft report (no adjectives; versions, dates, repro). PR title `[OWNER REVIEW] research: competitor conformance run`; body lists the D9 decision with the conductor's recommendation. **Commit** `test: competitor conformance run`.

### Task 13c: OpenRouter and DeepSeek presets pass reasoning back

Found by Task 13b's live run (2026-11-24, owner decision: fix before launch copy compares gateways). v1.4 spec §3.2/§3.3 (`reasoning_passback`, off by default), v1.6 spec §3.3 (presets).

**Evidence.** babelgate with its default config failed `thinking-after-tool:{anthropic,responses}->openai` live on OpenRouter (`deepseek/deepseek-r1-0528`): the turn-2 assistant message carried only `content, role, tool_calls`, upstream 200. With `reasoning_passback: true` the same cells passed live: the message carried `reasoning_content`, upstream 200. OpenRouter documents `reasoning_content` as an alias of `message.reasoning` ("it functions identically to `reasoning`", https://openrouter.ai/docs/use-cases/reasoning-tokens). DeepSeek names the field `reasoning_content` (https://api-docs.deepseek.com/guides/reasoning_model); re-verify on the task date what it says about sending it back. Passback stays off for plain entries because other Chat servers may reject the field; a preset names one provider, so it can declare what that provider accepts. Both presets are new in v1.6 (unreleased), so no released config changes behaviour.

**Files:**
- Modify: `src/config/provider-presets.ts`, `src/config/provider-presets.test.ts`, `src/config/yaml-config.ts`, `src/config/env-config.ts`, tests beside each, `src/cli-presets.ts` (only if the list shows the flag), `docs/recipes/openai-compatible-providers.md` (one line per preset), `docs/decisions.md`
- Modify: `tests/process/gateways/babelgate.ts` and `scripts/research/conformance-live.sh` (a `babelgate-preset` gateway: `preset: openrouter-free` with `base_url` pointed at the mock, no explicit `reasoning_passback`)

**Interfaces:**
- `ProviderPreset` gains `reasoning_passback?: boolean` (in the type and in `providerPresetSchema`). `openrouter-free` and `deepseek` set it to `true`, each with the doc URL and the verified date in a code comment. No other preset changes.
- yaml-config and env-config: an entry's `reasoning_passback` is the entry's own value when set, else the preset's value, else unset (off). An explicit `reasoning_passback: false` on an entry wins over the preset. The env path (`--provider`, `TARGET_PRESET`) takes the preset's value the same way it takes `gaps`.
- Only the encoded field is `reasoning_content` (unchanged). `reasoning_details` passback (OpenRouter's encrypted and signed reasoning for Anthropic/Gemini models) is out of scope; record it in the decisions entry as a known limit.
- No canonical change, no adapter change, no provider branch: the flag is preset data.

- [ ] **Step 1: Tests.** `"openrouter-free preset turns reasoning passback on"`, `"deepseek preset turns reasoning passback on"`, `"explicit reasoning_passback false wins over the preset"`, `"entry without a preset keeps passback off"`, `"--provider openrouter-free entry has passback on"`; process: `"babelgate-preset passes thinking-after-tool:anthropic->openai"` and `":responses->openai"` (selected through `CONFORMANCE_GATEWAYS`, like `babelgate-default`; the default `npm run test:process` run stays babelgate only).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `npm run build && npm run test:process` and `./scripts/check.sh` → PASS.
- [ ] **Step 5 (live, conductor runs):** `conformance-live.sh babelgate-preset thinking-after-tool:{anthropic,responses}->openai` → PASS. Then two otherwise identical turn-2 requests to OpenRouter, one with and one without `reasoning_content`: `usage.prompt_tokens` must be higher with the field (evidence that OpenRouter uses it, not only accepts it). For DeepSeek, `babelgate --provider deepseek` with the Claude Code and Codex edit tasks re-run once each (no regression from Task 8a). Results go in decisions.md and the PR body. If OpenRouter shows no token difference → STOP: the field name is then the open question, and the owner decides.
- **Commit** `feat(presets): OpenRouter and DeepSeek pass reasoning back`.

### Task 13d: Conformance: live model keeps prior reasoning; Responses scenarios send real user items

Found by the conductor in Task 13c's live step (2026-11-24, PR #183). Spec §3.10, D9.

**Evidence.**
1. On the live conformance model `deepseek/deepseek-r1-0528`, OpenRouter's `usage.prompt_tokens` for the same turn-2 request was 135 with no reasoning field, 135 with `reasoning_content` and 135 with `reasoning`. On `deepseek/deepseek-v4.1-flash` it was 361 / 411 / 411, on `moonshotai/kimi-k3` 268 / 318 / 318, and on `z-ai/glm-5.3` 192 / 241 / 241. R1's chat template drops earlier-turn reasoning, so with R1 a reasoning cell can pass while the model never sees what was sent back.
2. The Responses client turns send user text as bare strings inside the `input` array: `tests/process/scenarios/thinking-after-tool.ts` (`responsesTurn2`, first item) and `tests/process/scenarios/multi-turn-reasoning.ts` (`responsesTurn`, every question). The Responses API's array items are objects, so babelgate drops each string with a `field_dropped` note (`src/transformers/adapters/responses.items.ts`). The upstream request therefore has no user question after turn 1. That is the scenario's bug, not babelgate's: the decoder behaviour stays as it is.

**Files:**
- Modify: `scripts/research/conformance-live.sh` (OpenRouter default model), `tests/process/scenarios/thinking-after-tool.ts`, `tests/process/scenarios/multi-turn-reasoning.ts`, `docs/research/2026-11-24-conformance-run.md`, `docs/research/2026-11-24-conformance-run.shapes.md`, `docs/decisions.md`
- Create: `tests/process/scenarios/inputs.test.ts` (the item-shape test), `scripts/research/passback-tokens.ts` (the with/without `prompt_tokens` check as a script), `scripts/research/passback-tokens.test.ts`

**Changes:**
- `conformance-live.sh`: the OpenRouter default model becomes `deepseek/deepseek-v4.1-flash` (keeps prior-turn reasoning, evidence above). `CONFORMANCE_LIVE_MODEL_OPENAI` still overrides it. The report names the model per run.
- Scenarios: every Responses user turn is `{role: "user", content: "<text>"}`. No other change to turns, pass rules or replays. Pre-approved here: these two scenario files change their request inputs only; no assertion is removed or weakened (D6 applies to nothing else).
- `passback-tokens.ts <spy-log.jsonl>`: takes turn 2's upstream body from a conformance-live spy log, sends it to OpenRouter non-streaming with `max_tokens: 16` three times (no reasoning field / `reasoning_content` / `reasoning`), and prints `status`, upstream provider and `usage.prompt_tokens` per variant. It never prints bodies, completions or keys. Key from `OPENROUTER_API_KEY`. Network script, not part of `npm test`.

- [ ] **Step 1: Tests.** `"responses scenario turns send user text as message items"` (every `input` item built by both scenarios' Responses turns is an object; asserts `{role: "user", content: "What is the weather in Paris?"}` exactly for the first item), `"passback-tokens prints shapes only"` (offline, against a local stub: output lines carry no body text and no key).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `npm run build && npm run test:process` (babelgate only, all cells pass) and `./scripts/check.sh` → PASS.
- [ ] **Step 5 (live, conductor runs):** re-run `conformance-live.sh` for every Responses cell (`*:responses->openai`, `*:responses->gemini`) and every `thinking-after-tool` / `multi-turn-reasoning` cell, for `babelgate`, `babelgate-default`, `babelgate-preset`, `ccr` and `free-claude-code`, on the new model. Then `passback-tokens.ts` on the `babelgate-preset thinking-after-tool:anthropic->openai` spy log: `prompt_tokens` must be higher with `reasoning_content` than without. If not → STOP. The conductor hands the results to a fix session that updates both research docs (which cells changed, old and new model, date). A competitor result that changes from the 13b draft is called out in the PR body for the owner (D9).
- **Commit** `test(conformance): live model keeps prior reasoning; Responses user items`.

### Task 13e: Conductor tooling: judge.sh "tests beside each"; PATH guard for hook and scripts

Found in Task 13c's run (2026-11-24). Conductor tooling only; no product code.

**Evidence.**
1. `judge.sh 183 v1.6 13c` flagged `src/config/env-config.test.ts` as outside the Files block, although Task 13c's block says "tests beside each" and lists `src/config/env-config.ts`. This was a false positive.
2. A stale AppImage mount (`/tmp/.mount_t3_*`, `ENOTCONN`) was on the session's PATH. `env` stops at the first PATH entry it can't stat with an error other than ENOENT, so every `#!/usr/bin/env bash` script failed with `env: unknown error: execvp failed`. That includes the SessionStart hook, which is why `CONDUCTOR_ACTOR` was unset, and `as-app.sh`, `app-token.sh`, the `gh` wrapper and `devin.sh`.

**Files:**
- Modify: `scripts/conductor/judge-checks.ts`, `scripts/conductor/judge.test.ts`, `scripts/conductor/fixtures/*` (new seeded cases only), `scripts/conductor/app-env.sh`, `scripts/conductor/session-env.sh`, `.claude/settings.json` (the hook command only), `docs/decisions.md`

**Changes:**
- `filesBlockPatterns`: when a task's Files block contains the phrase "tests beside each" (case-insensitive), every listed `X.ts` also allows `X.test.ts` in the same directory. Nothing else is widened.
- `app-env.sh`: drop PATH entries that exist but can't be listed (`ls "$d" >/dev/null 2>&1` fails), before it prepends `bin/`. Entries that don't exist are left alone.
- `session-env.sh`: write the same filtered PATH to `$CLAUDE_ENV_FILE`, so the session's own commands use it too.
- `.claude/settings.json`: the hook command becomes `bash "$CLAUDE_PROJECT_DIR"/scripts/conductor/session-env.sh`, so it runs even when PATH lookup through `env` fails. No other settings change.

- [ ] **Step 1: Tests.** `"tests beside each allows the sibling test file"` (`src/config/env-config.test.ts` passes for a block listing `src/config/env-config.ts` with that phrase), `"without the phrase the sibling test is still flagged"`, `"a test beside an unlisted file is still flagged"`. For the PATH guard, a shell test with a directory whose read permission is removed (`chmod 000`) standing in for the dead mount: after sourcing `app-env.sh`, `env bash -c true` succeeds and the bad entry is gone from PATH.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `npx vitest run scripts/conductor` and `./scripts/check.sh` → PASS.
- [ ] **Step 5 (conductor):** re-run `judge.sh 183 v1.6 13c` and confirm the `files-block` FLAG is gone. Open a new session, check that `printenv CONDUCTOR_ACTOR` prints the bot, and check that `scripts/conductor/as-app.sh gh api user` works without the manual PATH strip.
- **Commit** `fix(conductor): judge.sh tests-beside-each; PATH guard`.

### Task 13f: Conformance tooling: spy-log race, `differs` verdict label, free-claude-code live output

Found by the conductor in Task 13d's live step (2026-11-24, PR #185). Spec §3.10, D9. Test and research tooling only; no product code.

**Evidence.**
1. **Spy-log race.** `scripts/research/conformance-spy.ts` appends an exchange's log line in `up.on("end")`, after the upstream response ends. `runScenario` in `tests/process/conformance.process.test.ts` re-reads the log as soon as the client stream completes. A gateway can end the client stream before the spy's `end` fires, so that turn gets no upstream requests. The comment there ("the spy writes before forwarding") does not match the code. Seen once in 41 runs: `babelgate-preset multi-turn-reasoning:responses->openai` reported "turn 2 upstream request dropped the reasoning block", while the spy log's turn-2 body carried a non-empty `reasoning_content`. Two reruns passed. The race can only add false "dropped"/"no reasoning field" failures (a missing turn-1 entry turns the client-side rule into n/a, never into a failure). Every 13d live-confirmed failure was checked against its spy log and stands.
2. **`differs` printed as PASS.** `scripts/research/conformance-verdict.ts` returns `pass` whenever vitest exited 0, before it reads the verdict file. A `differs` result (an observation rule; vitest passes) is therefore printed `PASS (live)`. Seen on `babelgate-default multi-turn-reasoning:{anthropic,responses}->openai`.
3. **free-claude-code live mode never reaches the upstream.** Every FCC live cell got HTTP 400 on turn 1 in 13d, and 503 in 13b, with no upstream call in the spy log. The FCC adapter keeps the gateway's output only when startup fails, so the cause can't be seen.

**Files:**
- Modify: `scripts/research/conformance-spy.ts`, `scripts/research/conformance-verdict.ts`, `tests/process/conformance.process.test.ts`, `tests/process/gateways/free-claude-code.ts`, tests beside each (create the test file where none exists), `docs/research/2026-11-24-conformance-run.md` (the Task 13d amendment's "known tooling limits" and any cell the Step 5 re-check changes), `docs/decisions.md`

**Changes:**
- Spy: count in-flight exchanges (incremented when a request arrives, decremented after its log line is written, on every path: end, error, aborted, forward error). `GET /__inflight` returns `{"inflight": <n>}`.
- Test, live mode only: before re-reading the spy log for a turn, wait until `/__inflight` reports 0 (poll every 50 ms, at most 10 s). On timeout, the turn's verdict is INCONCLUSIVE ("spy still had an exchange in flight"), never a failure. Fix the stale comment. Mock mode is unchanged.
- Verdict: read the verdict file before the vitest status. `differs` → `DIFFERS (observed) — <reason>`; `pass` → `PASS (live)`; `not supported` → `NOT SUPPORTED`; the CONFIRMED and INCONCLUSIVE rules stay exactly as they are. A vitest exit of 0 with no verdict file stays `PASS (live)`.
- FCC adapter, live mode only (`CONFORMANCE_LIVE_UPSTREAM` set): write the gateway's stdout and stderr to `tmp/conformance/live/<gateway>-<scenario>.gateway.log`, with the same key redaction as the spy. Never log request or response bodies. If the cause of the 400 is the adapter's config (model id, provider config, headers), fix it there. If the cause is in free-claude-code itself → STOP: the owner decides whether it is a reportable upstream bug.

- [ ] **Step 1: Tests.** `"spy reports in-flight exchanges until the log line is written"` (a stub upstream that holds its response open: `/__inflight` is 1 while it is held and 0 after the line is on disk), `"spy in-flight returns to 0 when the upstream errors"`, `"live turn waits for the spy before reading upstream requests"` (a stub spy that writes the log line 300 ms after the client stream ends: the turn still sees its request), `"differs verdict prints DIFFERS, not PASS"`, `"pass verdict still prints PASS"`, `"confirmed failure rule unchanged"` (the existing CONFIRMED cases keep their exact output).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `npm run build && npm run test:process` (babelgate only, all cells pass) and `./scripts/check.sh` → PASS.
- [ ] **Step 5 (live, conductor runs):** re-run every cell that 13d recorded as live-confirmed or `differs` for babelgate-default and ccr, plus every free-claude-code OpenRouter cell, once each, on `deepseek/deepseek-v4.1-flash`. Read each FCC gateway log. A result that changes from the 13d table goes in the report and the PR body (D9). The conductor hands the results to a fix session that updates the report.
- **Commit** `fix(conformance): spy in-flight wait; differs label; FCC live log`.

### Task 14: UI: breaker state, cache hits, free-tier label

Spec §3.3 (cost honesty), §3.5.

**Files:**
- Modify: `ui/src/screens/Routing.tsx`, `Requests.tsx`, `Usage.tsx` and their tests, `src/ui-api/*.ts` as needed

- [ ] **Step 1: Tests.** `"routing shows open breaker with time left"`, `"request row shows cache hit badge"`, `"free-tier route cost reads $0 (free tier, per docs on <date>)"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; screenshots via `scripts/ci/ui-smoke.sh` in the PR body. **Commit** `feat(ui): breaker, cache and free-tier labels`.

### Task 15: Launch readiness · OWNER REVIEW

Spec §3.8.

**Files:**
- Modify: `README.md`, `docs/comparison.md` (only as D9 allows), `scripts/demo/demo.tape`, `scripts/demo/codex.tape`, `docs/assets/demo.gif`, `docs/assets/demo-codex.gif`
- Create: `docs/launch/v1.6-launch.md` (HN, r/LocalLLaMA, r/ClaudeAI variants in one file), `docs/launch/listings.md` (Ollama integrations, Open WebUI docs, Claude Code community docs texts), `docs/support.md`, `docs/conductor/patches/v1.6-task15-funding.patch` (`.github/FUNDING.yml`), `docs/launch/repo-settings.md` (description, topics, social preview text, pinned "start here" issue text, 5+ `good first issue` candidates with links)

README order: one-line pitch → install per OS (brew, install.sh, install.ps1, npx, Docker) → free first run for Claude Code and Codex → proof (matrix link, replay badge, signature verification) → clients → everything else, long reference moved under `docs/`.

- [ ] **Step 1:** Re-record the demo tapes on the binary with `--provider gemini-free` (or the first preset with a proven suggestion). **Step 2:** Write the copy; every claim links its evidence; competitor results only as D9 decides. **Step 3:** `./scripts/check.sh` → PASS (link check). PR title `[OWNER REVIEW] docs: v1.6 launch readiness`. **Commit** `docs: v1.6 launch readiness`.

### Task 16: Landing page · OWNER REVIEW

Spec §3.8, D8, `docs/assets/landing-mockup-v2.html`.

**Files:**
- Create: `site/index.html`, `site/style.css`, `site/og.png`, `scripts/site/build-site.ts`, `scripts/site/build-site.test.ts`, `docs/conductor/patches/v1.6-task16-pages.patch`

**Interfaces:**
- `site/index.html` follows the mockup's order and look: nav, serif headline + lede, install command (typed animation, copy button, OS tabs switching the command), animated diagram (CSS + inline SVG `animateMotion`), "Every combination, checked" table, "last checked" line, links. Copy is plain language (spec §3.8). CSS and inline SVG only; ≤ 30 lines of inline JS (copy button, OS tabs); no third-party requests; `prefers-reduced-motion` → still page.
- `build-site.ts` reads `tests/matrix/.out/matrix.json` (or `docs/compatibility.md`) and the latest replay summary (`docs/compatibility.md` header) and writes the table rows and versions into `dist-site/index.html` between `<!-- matrix:start -->`/`<!-- matrix:end -->` markers. Rows: clients with matrix data only; recipe-only clients appear as "verified by hand on <version>" from their recipe page header, or are omitted.
- Site links: install, recipes, `docs/compatibility.md`, `SECURITY.md`, `docs/comparison.md`, repo. Never `docs/superpowers/`, `docs/roadmap.md`, `docs/decisions.md`, `docs/conductor/`, `docs/research/`, `docs/launch/`.
- Patch adds `pages.yml`: on push to `main` touching `site/**` or `docs/compatibility.md`, run `build-site.ts`, deploy `dist-site/` with `actions/deploy-pages`.

- [ ] **Step 1: Tests.** `"table rows come from matrix json"`, `"no hand-typed check marks outside markers"`, `"recipe-only client marked verified by hand"`, `"no internal docs linked"`, `"no external script or font requests"`, `"reduced-motion rule present"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; screenshots (desktop, mobile, reduced motion) in the PR body. PR title `[OWNER REVIEW] site: landing page`. **Commit** `feat(site): landing page`.

### Task 17: Live cases; gates E and F · OWNER REVIEW

Spec §4.

**Files:**
- Modify: `tests/live/gateway.live.test.ts` (free presets when keys present; breaker opens on a forced 429 route), `docs/decisions.md`
- Create: `scripts/gates/first-run.sh`

**Interfaces:**
- `first-run.sh <install-cmd> <preset> <client>`: in a clean `docker run node:24` (Linux) or the current machine with `HOME` set to a fresh temp dir, runs the install command, `babelgate --preset <client> --provider <preset>`, applies the printed exports/config, runs the edit-task gate, prints wall-clock setup time (excluding key sign-up).

- [ ] **Step 1:** Live suite with available keys → PASS. **Step 2 (gate E):** trigger evidence: the latest scheduled replay run green with the D7 diff; seeded wire changes from Task 1's tests listed. **Step 3 (gate F):** `first-run.sh` on Linux in a container (conductor), owner runs it on a Mac and a Windows machine; Claude Code and Codex each < 60 s. Results table in `docs/decisions.md`. PR title `[OWNER REVIEW] gates E and F`. **Commit** `test: v1.6 gates E and F`.

### Task 18: CHANGELOG, `1.6.0`; gate G · OWNER GATE

**Files:**
- Modify: `CHANGELOG.md`, `package.json` (version), `package-lock.json` (version), `docs/roadmap.md` (status line)

- [ ] **Step 1:** CHANGELOG `1.6.0` (user-facing language; runtime dependency count unchanged, stated). **Step 2:** version bump. **Step 3:** `./scripts/check.sh` → PASS. PR title `[OWNER GATE] chore: release 1.6.0`. **Commit** `chore: release 1.6.0`.
- [ ] **Step 4 (owner, gate G at publish):** tag `v1.6.0`; release workflow builds and attaches binaries; verify `SHA256SUMS` and one `cosign verify-blob`; `install.sh` and `brew install dorrabbkhan/babelgate/babelgate` fetch the release; submit winget; npm and GHCR as v1.5 gate D; enable Pages; post the launch.
