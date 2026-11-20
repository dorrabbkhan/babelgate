# babelgate v1.6 — Design Spec ("One command, free to start" + launch ready)

**Date:** 2026-11-20 · **Status:** scope, distribution approach and D1–D7 decided by the owner in conversation
on 2026-11-20; this written spec awaits owner review · **Roadmap:** `docs/roadmap.md` (Phase 2, v1.6) ·
**Parent specs:** `2026-10-26-babelgate-roadmap-design.md`, `2026-11-04-…-roadmap-revision-design.md`,
`2026-11-16-…-roadmap-revision-design.md` · **Previous version:** `2026-11-16-babelgate-v1.5-design.md` ·
**Research:** `docs/research/2026-11-16-market-analysis.md`, `docs/research/2026-11-20-market-check.md`

## 1. Purpose

v1.6 is the launch version. The owner held the public launch until now on purpose. After v1.6, a stranger
who reads the launch post installs babelgate with one command, runs Claude Code or Codex on a free or
cheap provider within a minute, and finds the published evidence (matrix, replay, signed releases) green.

### 1.1 Why this shape
The product is not the bottleneck; distribution is (market check §3). babelgate has 0 stars while
"Claude Code / Codex on any model" tools hold 10k–150k, and those tools win on install friction and on
cost (free-token lists, desktop apps). So v1.6 spends its effort on:
1. **Install in one command** — a single binary per platform, no Node required.
2. **Free to start** — curated free and cheap provider presets, and a first run that gets you from zero
   to a working Claude Code or Codex session in under a minute.
3. **Proof that stays green** — the weekly replay went red three times in three days for harness reasons
   (#148, now fixed), and each Claude Code tool-schema edit costs an owner fixture PR; the headline
   "the translator you can check" cannot launch on a badge that flips with harmless client releases.
4. **Launch material** — README, recipes, demo, posts, all leading with the free first run and the proof.

The rest of the roadmap's v1.6 (recipes for more clients, minimal health, a small response cache,
Antigravity CLI) stays, kept small.

### 1.2 Evidence (read from main and the replay artifacts, 2026-11-20)
| # | Finding | Where | Effect |
|---|---|---|---|
| E1 | Runtime deps are pure JS (express, pino, zod, yaml, dotenv, prom-client, OpenTelemetry); SQLite is Node's built-in `node:sqlite`; build output is CommonJS | `package.json`, `tsconfig.json` (`module: commonjs`), `src/observe/sqlite.ts` | A Node single executable application (SEA) is feasible with no native addons |
| E2 | The `/ui` bundle is served from disk (`express.static(uiDir)`, `sendFile`) | `src/ui-api/static.ts` | The binary must embed the UI as SEA assets and serve them from memory |
| E3 | pino uses a `pino-pretty` worker transport outside production when resolvable | `src/utils/logger.ts` | The binary runs without transports (plain JSON or a built-in pretty printer); worker transports don't bundle |
| E4 | Install today: `npx babelgate` (needs Node ≥ 22.13) and Docker (`node:22-alpine`). CI, live and release workflows run Node 22 only | `README.md`, `Dockerfile`, `.github/workflows/*.yml` | Both stay; the binary is added. The binary's Node line must be tested in CI too |
| E5 | CLI presets are client presets only (`claude-code`, `openai-apps`; no `codex` preset — the Codex recipe uses `--config <yaml>` plus Codex's `config.toml` and a model catalog JSON). Provider presets are Anthropic-endpoint shims only (`type: "anthropic"`, five entries), read only by `yaml-config.ts`, where `preset:` implies `passthrough: true`; the CLI refuses `--target`/`--model` in config mode | `src/cli.ts`, `src/config/provider-presets.ts`, `src/config/yaml-config.ts`, `docs/recipes/codex.md` | Free/cheap presets need the preset type widened, a CLI path that doesn't need YAML, and a `codex` client preset |
| E6 | Fallback chains exist (v1.2); no health checks or circuit breaker | `src/routing/fallback.ts` | Health is additive and small |
| E7 | Replay #148 failed on 11-18, 11-19 and 11-20 (dispatch) on two causes, both since fixed: Claude Code 2.1.327 and 2.1.328 each added a property inside the built-in `ReportFindings` tool's `input_schema` (`shape-diff.ts` exits 1 on any *added* path; removed paths are already informational), fixed by owner-approved fixture PRs #142 and #149; and the Codex recorder bypass (E8). The dispatch run 44744362690 at `8c02ed8` (11-20 13:26) is **green** on Claude Code 2.1.329 and codex 0.171.0 | issue #148, runs 44549011473 / 44744362690 `summary.md`, PRs #142 #149 | Proof is green today, but every Claude Code release that edits a tool schema costs an owner fixture PR. §3.1 stops that churn (D7) |
| E8 | Codex recorder saw zero requests on codex 0.170: `localhost` resolved to `::1` while the recorder listens on IPv4. Fixed on main in `0192cad` (pin `127.0.0.1`); `CODEX_VERSION` pin is still 0.169.0 | `scripts/gates/record-codex.sh`, `docs/decisions.md` | Not a transport change. Only the version pin and closing #148 remain |
| E9 | `between_tools` thinking falls to `thinking_dropped`; `enabled`, `disabled`, `adaptive` are mapped | `anthropic.adapter.ts` `toCanonicalReasoning` | Map it (§3.6) |
| E10 | #99: Gemini text-part `thoughtSignature` is dropped on decode; the canonical stream has no event for it | issue #99 | Canonical change (§3.7, OWNER REVIEW) |
| E11 | Claude Code 2.1.329 dropped its retry at a gateway model's `max_tokens` limit and asks gateway users to set `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; babelgate's per-target `max_output_tokens` already clamps | Claude Code release notes 2026-11-19 | Recipes and presets set it; no product change |
| E12 | The scripted competitor check decided on 2026-11-16 does not exist; the 11-20 check was done by hand | `scripts/`, roadmap "Running alongside" | Add it (§3.9) |

### 1.3 Success criteria
1. **One command:** on clean macOS (arm64), Linux (x64) and Windows (x64) machines without Node, one
   documented command installs `babelgate`, and `babelgate --version` prints the release version.
2. **Free first run:** from that install, a new user with only a free OpenRouter key (or a free Gemini API
   key) completes the Claude Code edit task with one `babelgate` command plus the printed `export` lines,
   in under a minute of wall-clock setup (excluding key sign-up). Same for Codex.
3. **Same code tested and shipped:** the release binaries pass the full pair suite and the live smoke
   run executed *against the binary*, not only against `node dist`.
4. **Green proof:** the weekly replay is green on the then-current Claude Code and Codex releases, and it
   no longer fails on JSON Schema contents inside tool definitions (D7); a real wire change (new content
   block type, new event type, new top-level request key, a new tool) still fails it.
5. **Launch ready:** README opens with the one-command install and free first run; recipe pages exist for
   every client in §3.4; launch posts and the demo are refreshed; `docs/compatibility.md` and the replay
   badge are green on `main` on release day.
6. No existing expected value, fixture or contract snapshot changes except those pre-approved in D6.
7. **After launch (measured, not gated):** 60 days after the posts go out, against the roadmap's tiers —
   floor 300 stars and 1 community-doc listing; goal 1k stars, 2 listings, 5 outside contributors; stretch
   2k stars, 3 listings, 10+ contributors — plus weekly installs (binaries, npm, Homebrew) and issues from
   outside users. Release-download and install counts need no telemetry in the product: they come from
   GitHub release, npm and Homebrew analytics. Below the floor, the pitch or channel is reviewed before the
   next version spec.

## 2. Scope

### 2.1 In v1.6
- **Replay hardening** (§3.1): shape-diff tolerance for tool-schema contents (D7); Codex pin moved to
  current; #148 closed.
- **Single binary and installers** (§3.2).
- **Free and cheap provider presets and the first run** (§3.3).
- **Client recipes** (§3.4): Cursor, Continue, Aider, Open WebUI, LangChain, LlamaIndex, Vercel AI SDK,
  Ollama-only apps on cloud models; Antigravity CLI moves into the README's client list.
- **Minimal health** (§3.5): passive circuit breaker on the existing fallback chains.
- **Response cache, small** (§3.5).
- **Reasoning fixes** (§3.6): `between_tools`; (§3.7) #99 Gemini text-part signatures.
- **Launch readiness** (§3.8).
- **Scripted competitor check** (§3.9).

### 2.2 Not in v1.6
- Tray or desktop app (D1 rejected it for v1.6). Revisit only on user demand after launch.
- Key load balancing and per-client rate limits (v2.0 unless users ask earlier).
- Active health probing that spends tokens; semantic caching (rejected 2026-11-04).
- Self-update inside the binary (package managers update it).
- Posting the launch. That is the owner's act, after v1.6 ships.

### 2.3 Non-goals and anti-goals
- **Not a token reseller and no hosted relay** (unchanged).
- **No unverified free-tier claims.** Every free/cheap preset cites the provider's own docs with a
  verification date; limits are stated as "per the provider's docs on <date>", never as our promise.
- **No shipped artefact that differs from the tested one.** If the binary can't run the suites, it does
  not ship (§3.2).
- **No new runtime dependencies for the binary path.** Bundling tools are dev dependencies only; the
  runtime dependency count in release notes must not grow.
- Anti-goal: a launch whose first-run instructions fail for a stranger. The first-run gate (§4, gate F)
  runs on a clean machine or container, not the owner's environment.

## 3. Design

### 3.1 Replay hardening (first; #148)
The replay is green today (E7); the causes of #148 are fixed. What remains is the churn: each Claude Code
release that edits a built-in tool's JSON Schema fails the diff and needs an owner-approved fixture PR.
- **Shape-diff tolerance (D7).** `scripts/gates/shape-diff.ts` stops descending below a tool's schema:
  `tools[].input_schema` (Anthropic), `tools[].function.parameters` (Chat), `tools[].parameters`
  (Responses), Gemini `functionDeclarations[].parameters`, and `output_config.format.schema` /
  `response_format.json_schema.schema` / `text.format.schema`. The schema key itself and the tool list
  shape stay compared; a new tool (new `name`) is reported as its own line and still fails. Everything
  else is unchanged: a new top-level request key, content block or input item type, stream event type,
  or key inside a known block still fails; removed paths stay informational (already the case).
  Seeded tests in `shape-diff.test.ts`: the exact #142 and #149 diffs pass; a synthetic new block type,
  new event type, new top-level key and new tool name fail.
- **Fixtures** keep the full schemas (they are evidence of what the client sent); D7 only changes what
  the diff compares. Fixture updates from new recordings stay owner-approved (D6).
- **Codex pin.** `CODEX_VERSION` in `record-codex.sh` moves to the current release after a green
  recorded run; the Codex recipe is re-verified on it from babelgate's request log.
- #148 closes after the next scheduled replay is green with the new diff.

### 3.2 Single binary and installers (D1: Node SEA)
- **Build.** A dev-only bundler (esbuild) bundles `dist/cli.js` and its runtime dependencies into one
  CommonJS file; Node's SEA tooling on the pinned Node (`--experimental-sea-config` plus the injector,
  e.g. `postject`, or the built-in builder if that Node line has one — the plan checks the Node docs)
  injects it with the `/ui` bundle as SEA assets. Bundler and injector are **dev** dependencies only.
  **Pinned Node: 24 LTS** (conductor's call: SEA assets and `node:sqlite` are more mature there than on
  22). CI's unit/integration job gains a Node 24 leg next to 22 so the shipped runtime is tested on every
  PR, not only at release; `engines` stays `>=22.13` for `npx`. The binary uses production logging (E3).
- **UI from memory.** `src/ui-api/static.ts` gains a second source: when running as a SEA
  (`node:sea` `isSea()`), serve assets from `getAsset()` with the same paths, cache headers and
  `index.html` fallback; otherwise unchanged. Tests cover both sources with the same expectations.
- **Targets:** `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `win-x64`. Built in CI on native
  runners (no cross-injection), one archive each plus `SHA256SUMS`, all cosign-signed (keyless, same as the
  v1.5 image signing) and listed in the CycloneDX SBOM. `win-x64` has never run the suites (`node:sqlite`,
  data-folder paths): it ships only if they pass on Windows; if they don't, Task 6 escalates with the
  failures instead of shipping a binary that wasn't tested.
- **Tested binary:** CI runs the pair suite's HTTP-level tests and `test:live` (smoke subset) against the
  built binary on each runner (a `BABELGATE_BIN` switch in the test harness). If a test can only run in
  process, it says why in the plan.
- **Installers:**
  - `install.sh` (macOS/Linux) and `install.ps1` (Windows): download the archive for the platform from the
    GitHub release, verify the SHA-256 and (when `cosign` is present) the signature, install to
    `~/.local/bin` / `%LOCALAPPDATA%\babelgate`, print the PATH line if needed. No `sudo`.
  - **Homebrew**: a formula in `dorrabbkhan/homebrew-babelgate` (D3) pointing at the release archives. Formula installs avoid the
    macOS quarantine prompt for unsigned binaries.
  - **winget**: a manifest for `microsoft/winget-pkgs`, validated locally (`winget validate`) and submitted
    by the owner (D4).
  - `npx babelgate` and the Docker image stay.
- **macOS and Windows code signing:** none in v1.6 (D2). The installers and README state how to verify with
  cosign and SHA-256, and the README notes the Gatekeeper/SmartScreen prompt for direct downloads.
- **Release workflow** changes are a patch under `docs/conductor/patches/` that the owner applies (the app
  has no Workflows permission; same as v1.5).

### 3.3 Free and cheap provider presets and the first run
- **Preset type widened.** `ProviderPreset` gains `type: "openai-compatible" | "gemini" | "anthropic"`, a
  `tier: "free" | "cheap" | "shim"` field, a suggested model per client preset (`claude-code`, `codex`,
  `openai-apps`), `max_output_tokens` where the provider's limit is below the client's default (E11), the
  docs URL and verification date. Existing shim presets keep their behaviour.
- **Candidate presets** (each verified against the provider's own docs in its task, or dropped):
  OpenRouter free models, Gemini API free tier (native adapter), Groq, NVIDIA NIM, Cerebras (free tier),
  DeepSeek (cheap; Chat and the existing Anthropic shim). The **suggested model per preset must complete
  the Claude Code edit task** through babelgate (live check in the task); a preset with no model that
  passes ships without a Claude Code suggestion, never with an untested one.
- **How a preset applies without YAML (conductor's call).** `--provider <preset>` is an env-path flag like
  `--target`: it sets the target type, base URL, key env var, model and `max_output_tokens` as env
  defaults (user env still wins, as today). It is refused in config mode, like `--target`. In YAML,
  `preset:` keeps working; the `passthrough: true` implication applies to `tier: shim` presets only, so
  existing configs behave exactly as before.
- **First run.** `babelgate --preset claude-code --provider openrouter-free`:
  - reads the provider's key from its env var; if missing, prints where to get one (the preset's sign-up
    URL) and exits non-zero without starting;
  - starts the proxy and prints the `export` lines for Claude Code, as today, including
    `CLAUDE_CODE_MAX_OUTPUT_TOKENS` when the preset sets a limit (E11).
- **Codex client preset (new).** `--preset codex` prints the `config.toml` block (model provider pointing at
  babelgate, `wire_api = "responses"`) and writes nothing outside babelgate's own data folder: the model
  catalog JSON Codex needs is generated there for the preset's model and its path printed. The user pastes
  one block. Success criterion 2 counts that paste as part of the first run.
- **`babelgate presets`** lists every preset with tier, key env var, suggested models and docs date.
- **Cost honesty.** The `/ui` cost view already shows $0 for local; routes whose preset has `tier: free`
  show "$0 (free tier, per <provider> docs on <date>)" — the label comes from the preset, so Task 15
  follows Task 8. Prices for cheap presets come from the existing price table.

### 3.4 Client recipes
One page per client under `docs/recipes/`, each with: the client's config (verified on a named client
version), the `babelgate` command, a "what works / what doesn't" list taken from the compatibility matrix,
and a free-preset variant. Clients: **Cursor** (OpenAI base URL override), **Continue**, **Aider**,
**Open WebUI** (OpenAI and Ollama modes), **LangChain**, **LlamaIndex**, **Vercel AI SDK**, **Ollama-only
apps on cloud models** (babelgate's Ollama inbound — a unique cell). Each recipe has a small check: SDK
recipes (LangChain, LlamaIndex, Vercel AI SDK) get an example under `examples/` exercised in CI against the
mocks; app recipes (Cursor, Continue, Aider, Open WebUI) are verified by hand once, with the version and
date on the page. The Claude Code and Codex recipes gain the free-preset path and the
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` note (E11). Antigravity CLI (adopted in v1.5) joins the README client list.

### 3.5 Minimal health and a small response cache
- **Circuit breaker (passive).** Per target, count consecutive failures that the fallback chain already
  classifies as retryable (429/5xx/timeout/transport). After N (default 3) the target is *open* for a
  cool-down (default 30 s, doubling to a cap of 5 min); open targets are skipped in fallback order, and a
  request whose every target is open still tries the first one (never refuse locally on a guess). One
  success closes it. State is in memory; `/ui` routing view and `/metrics` show it. Configurable per target
  in `babelgate.yaml`; `circuit_breaker: false` turns it off. No active probes (they spend tokens).
- **Response cache (exact match, opt-in).** `cache: { enabled: true, ttl, max_entries }`, off by default.
  Key: hash of the canonical request (model after routing, messages, tools, config) plus target. Non-stream
  and stream (stored as the canonical chunk sequence, replayed in the client's format). Never caches
  requests with `temperature > 0` unless `cache.ignore_temperature: true` (for CI), errors, or responses
  with tool calls cut short. In memory, LRU; usage rows mark cache hits with `$0`. Documented for the CI and
  test-suite use case only. Cache hits are recorded as usage rows with a new nullable `cache_hit`
  column (an additive SQLite migration, logged in `docs/decisions.md`; not a canonical change).

### 3.6 `between_tools` thinking
Map Anthropic `thinking: {type: "between_tools"}` to canonical reasoning with a recorded meaning (the plan
reads Anthropic's docs for the exact semantics and picks the canonical effort it maps to); encode it back
for Anthropic targets on models that accept it; other targets get the mapped effort. Verified against the
docs, not our mocks; a live check on an Anthropic route if a key is available.

### 3.7 #99 — Gemini text-part `thoughtSignature` (OWNER REVIEW: canonical change)
As proposed in #99: an optional `signature` on canonical `text_delta` (or a `text_signature` event — the
task picks one and justifies it), in `canonical.types.ts` and `canonical.schema.ts` together, logged in
`docs/decisions.md`. Both Gemini decoders keep it (twin contract: stream == non-stream), the envelope
carries it in `textIndex`, other targets ignore it.

### 3.8 Launch readiness
- **README** restructured: one-line pitch ("the translator you can check"), one-command install per OS, the
  free first run for Claude Code and Codex, then the proof (matrix link, replay badge, signature
  verification), then everything else. Long reference sections move to `docs/`.
- **Launch posts** (`docs/launch/`): one v1.6 launch post for HN / r/LocalLLaMA / r/ClaudeAI that
  supersedes the v1.4 and v1.5 drafts (they become source material), plus short per-channel variants.
  Rules from the v1.5 comparison page apply: no naming-and-shaming, every claim links its evidence.
- **Demo:** the VHS tapes re-recorded on the binary with the free first run.
- **Landing page (owner, 2026-11-20: a single page, not a docs site).** One static page on GitHub Pages
  (`dorrabbkhan.github.io/babelgate` until the owner picks a domain), written for people who are not gateway
  experts: what babelgate does in plain words ("use the AI model you want with the tools you already have"),
  who it is for, the free first run as three steps, the demo GIF, why it can be trusted (tested every way,
  checked against each new Claude Code and Codex release, signed releases) without jargon, and install
  commands per OS. Technical depth is one click away, not on the page. Plain HTML/CSS in `site/`, no
  framework and no new dependencies; no trackers or third-party scripts. A Pages workflow patch for the
  owner to apply (the app has no Workflows permission); enabling Pages is the owner's act.
  **Direction approved 2026-11-20 as a first draft to build on:** `docs/assets/landing-mockup-v2.html`.
  Calm editorial look (serif headline "Any AI tool, any model. *And we show you it works.*"), then the
  install command first (typed-in animation, copy button, OS tabs), then an animated diagram (tools → babelgate
  hub with a ticker of translations → models, free ones marked), then the "Every combination, checked" table
  with checks popping in and a "last checked automatically" line. Modern-tool-site motion is wanted; it is
  CSS and inline SVG only (no animation libraries, no trackers), and `prefers-reduced-motion` gets a still page.
  **Honesty rule:** every table cell and the "last checked" versions come from the generated matrix and the
  latest replay run at build time, never typed by hand; clients that are recipe-only (e.g. Cursor, Open WebUI)
  are marked "verified by hand on <version>" or left out. The owner reviews the built page (Task 16b).
- **What the site links to:** user-facing docs only — install, recipes, `docs/compatibility.md`, release
  verification (`SECURITY.md`), `docs/comparison.md`, the GitHub repo. Not linked: `docs/superpowers/`
  (specs, plans), `docs/roadmap.md`, `docs/decisions.md`, `docs/conductor/`, `docs/research/`,
  `docs/launch/`. They stay public in the repo, as the roadmap's visibility table says, but are not part of
  the product's front door.
- **Listings prepared, not submitted:** text for Ollama's community integrations, Open WebUI docs and the
  Claude Code community docs, ready for the owner to submit.
- **Repo hygiene for visitors:** topics, description, social preview image, a pinned "start here" issue,
  `good first issue` labels on 5+ real issues.
- **GitHub Sponsors and support-contract page** (roadmap's v1.6 running track): `FUNDING.yml` and a short
  `docs/support.md`; enabling Sponsors is the owner's act.

### 3.9 Scripted competitor check
`scripts/research/competitor-check.sh` (+ a tracked repo list file): GitHub API metadata, latest release,
open-issue counts for keyword searches, written as a dated Markdown table under `docs/research/`. Run by
hand monthly and before every version spec; no scheduled workflow (keeps the app's permissions unchanged).

## 4. Testing and gates
- **Unit/integration:** shape-diff rules (seeded), SEA asset serving (both sources), preset schema and
  first-run messages, circuit-breaker state machine (fake timers), cache keying and the never-cache rules,
  `between_tools` mapping, #99 decoders (twin contract), installer scripts (shellcheck + a dry-run mode
  tested in CI).
- **Binary:** the HTTP-level suites against the built binary on every release runner (§3.2).
- **Live (opt-in):** each free/cheap preset's suggested model on the edit task, when its key is present.
- **Release gates (OWNER REVIEW):**
  - **E** — the replay job green on current Claude Code and Codex with the new diff; the seeded wire
    changes still fail it.
  - **F** — first run from scratch: clean container (Linux) and the owner's Mac and a Windows machine or VM:
    install with the one command, Claude Code and Codex finish the edit task on a free preset, under a
    minute of setup.
  - **G** — at publish: binaries' SHA-256 and cosign signatures verify; Homebrew and the install scripts
    fetch the published release; npm and GHCR as in v1.5 gate D.

## 5. Task outline (the plan will detail these)
| # | Task | Gate | Conductor |
|---|---|---|---|
| 1 | Shape-diff tolerance (D7) with seeded tests | OWNER REVIEW (changes a check) | Sonnet |
| 2 | Codex pin to current release; Codex recipe re-verified from the request log; close #148 after a green scheduled replay | | Sonnet |
| 3 | `between_tools` thinking mapping (§3.6) | | Opus |
| 4 | Canonical change for text-part signatures + Gemini decoders + envelope (#99) | OWNER REVIEW (interface change) | Opus |
| 5 | SEA build: bundle, SEA config, UI from memory, logging in binary; local build script | | Opus |
| 6 | Binary in CI: build per platform, run suites against it, archives, SHA256SUMS, cosign, SBOM (workflow patch) | OWNER GATE (publishing config) | Sonnet |
| 7 | Installers: `install.sh`, `install.ps1`, Homebrew formula, winget manifest (prepared) | OWNER GATE (publishing) | Sonnet |
| 8 | Preset type widened; free/cheap presets verified against provider docs; `babelgate presets` | | Sonnet |
| 9 | First run: `--provider`, `--preset codex`, missing-key guidance, suggested models proven on the edit task | | Opus |
| 10 | Circuit breaker (§3.5) | | Sonnet |
| 11 | Response cache (§3.5) | | Opus |
| 12 | Recipes: Cursor, Continue, Aider, Open WebUI (§3.4) | | Sonnet |
| 13 | Recipes + examples: LangChain, LlamaIndex, Vercel AI SDK, Ollama-only apps | | Sonnet |
| 14 | Competitor-check script (§3.9) | | Sonnet |
| 15 | UI: breaker state, cache hits, free-tier cost label | | Sonnet |
| 16 | Launch readiness: README, launch post + variants, listings text, repo hygiene, Sponsors/support docs, demo tapes | OWNER REVIEW | Sonnet |
| 16b | Landing page in `site/` from the approved mockup; table and versions generated from the matrix and replay; Pages workflow patch | OWNER REVIEW | Sonnet |
| 17 | Live-suite cases; gates E and F | OWNER REVIEW | Opus |
| 18 | CHANGELOG, `1.6.0`; gate G at publish | OWNER GATE | Sonnet |

Tasks 1–2 go first so the proof stays green without owner fixture PRs while the rest is built. Devin implements every task on SWE-2
High; the Conductor column follows the v1.5 model report rule (Opus where an interface, wire format or
owner-gate judgment is involved; Sonnet otherwise), and `docs/conductor/model-report-v1.6.md` records the
breakdown and the measured usage.

### 5.2 Time estimate
Measured pace (git history, spec date → release commit): v1.2 5 days (15 PRs), v1.3 9 days (21), v1.4 3 days
(11), v1.5 4 days (28). v1.6 is about v1.5's size in code (19 tasks) but waits more on the outside world:
five-platform CI builds, Windows, live checks per free provider, the owner's reviews, gate F on three
machines, tap and winget. **Estimate: 7–12 days from plan approval to `1.6.0`**, Windows being the most
likely overrun.

## 6. Owner decisions
| # | Decision | Chosen / status |
|---|---|---|
| D1 | Distribution approach | **Node SEA single binaries** + install scripts, Homebrew, winget; `npx` and Docker kept (2026-11-20). Bun compile rejected (different runtime from the tested one; `node:sqlite` risk); tray app rejected for v1.6 (L-size, against "small and auditable") |
| D2 | Apple notarization / Windows code signing | **Unsigned for v1.6** (2026-11-20): cosign + SHA-256, Homebrew and install scripts as the main paths; README explains verification and the Gatekeeper/SmartScreen prompt for direct downloads. Revisit on launch feedback |
| D3 | Homebrew tap repo | **`dorrabbkhan/homebrew-babelgate`** (2026-11-20): the owner creates the empty public repo; Task 7 prepares the formula; the owner pushes it or grants the app access. Install: `brew install dorrabbkhan/babelgate/babelgate` |
| D4 | winget submission | **Prepared by Task 7, submitted by the owner** (2026-11-20) to `microsoft/winget-pkgs` at release time |
| D5 | Launch scope | v1.6 = the roadmap's v1.6 + launch ready + open issues (#148, #99) (2026-11-20); posting is the owner's act after release |
| D6 | Pre-approved test/fixture changes | *To list in the plan:* the Codex recording re-recorded on the new pin in Task 2; any test pinning `between_tools` → `thinking_dropped` in Task 3; the #99 drop assertions in Gemini decoder tests in Task 4. Each replacement asserts the new behaviour at least as exactly |
| D8 | Website | **Single non-technical landing page** on GitHub Pages (2026-11-20), direction per `docs/assets/landing-mockup-v2.html`; docs stay in the repo; internal docs (specs, plans, roadmap, decisions, conductor, research, launch drafts) are not linked. VitePress docs site and Starlight/Docusaurus considered and not chosen |
| D7 | Replay diff ignores JSON Schema contents inside tool and output-format definitions | **Ignore** (2026-11-20). New tools, content blocks, input item types, event types and top-level keys still fail |

**Owner actions:** review the canonical change (Task 4) and launch material (Task 16); apply workflow
patches (Tasks 6, 16b) and enable GitHub Pages; create `dorrabbkhan/homebrew-babelgate` (D3) and submit the winget manifest (D4); have free keys for OpenRouter
and Gemini (and any other preset tested live); run gate F on a Mac and a Windows machine or VM; tag
`v1.6.0` and publish; post the launch.

## 7. Risks
| Risk | Mitigation |
|---|---|
| D7 hides a real schema-translation regression | The pair suites and the edit-task gates still exercise schema translation; D7 only stops the *replay diff* from flagging schema text a client changed |
| SEA quirks (bundling, `node:sqlite` experimental warnings, asset paths) | Task 5 builds early; the binary runs the suites (§3.2); fallback is `npx` + Docker, already shipped |
| Free tiers change or vanish | Presets cite docs with dates; the competitor-check script lists preset docs to re-read; README never promises limits |
| Free models fail Claude Code tool loops | A suggested model must pass the edit task; otherwise no suggestion for that client |
| Unsigned macOS/Windows binaries scare users | Homebrew formula and install scripts avoid the quarantine path; cosign + SHA-256 documented; D2 can add signing |
| Launch lands while the replay is red again | Gate E on release day; the badge links the run so a red result shows its cause |
| Scope is M-plus with launch work | Recipes and launch docs are Sonnet/Devin work in parallel with Tasks 5–11; cache (Task 11) is the first thing to cut if the owner wants a smaller v1.6 |
