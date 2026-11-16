# babelgate v1.5 ("Correct everywhere") Implementation Plan

> **For agentic workers (Devin):** Run each task in its own session with `/babelgate-task v1.5 <N>`. One task → one branch (`v1.5/task-<N>-<short-name>`) → one PR. Steps use checkbox (`- [ ]`) syntax. Read `AGENTS.md`, this plan's Global Constraints and Review Focus, and the spec sections each task names. Use `./scripts/check.sh quick` while iterating and `./scripts/check.sh` before pushing. Verify every write with `git diff`.

**Goal:** First make the build process cheaper (Task 0), then carry reasoning and media across all five formats, add a same-format shim with declared provider gaps, minimal embeddings, and publish the evidence (generated compatibility matrix, weekly client-release replay, signed releases).

**Architecture:** Task 0 is conductor tooling only (`scripts/conductor/`, `.claude/`, conductor docs). Product work keeps the canonical pipeline: Task 2 is the only canonical change (URL images, documents, images in tool messages) and moves the `bg1.` envelope to a shared module so Anthropic and Gemini clients can carry foreign reasoning. Media URLs are resolved to bytes in the services, before encoding, guided by a per-adapter `MEDIA_SUPPORT` declaration. Same-format pass-through generalizes v1.4's Responses path to `anthropic` and `openai` providers that use a provider preset or `passthrough: true`; gap fixes are per-format patch functions in each adapter, selected only by the provider's `gaps` list.

**Tech Stack:** As v1.4 (TypeScript 5 strict, Express 5, Zod 4, pino, `yaml`, vitest 3, msw 2, supertest, `node:sqlite`, Preact + Vite UI, ts-node for scripts). **No new runtime dependencies.** Workflow-only tools (cosign, `npm sbom`) live in workflow patches.

**Spec:** `docs/superpowers/specs/2026-11-16-babelgate-v1.5-design.md`. Parents: `2026-10-26-babelgate-roadmap-design.md`, `2026-11-04-…`, `2026-11-16-babelgate-roadmap-revision-design.md`; previous: `2026-11-13-babelgate-v1.4-design.md`. Research: `docs/research/2026-11-16-market-analysis.md`.

**Decided with the owner (2026-11-16), spec §6:** D1 "the translator you can check"; D2 Opus stays conductor with less to do; D3 roadmap revision §2.2; D4 Task 0 first; D5 pre-approved test changes (exact list below); D6 reasoning mapping on by default, pass-through only with a provider preset or `passthrough: true`; D7 headless sessions with an explicit tool allow-list, no bypass; D8 gate B on Ollama's Anthropic endpoint.

**Conductor's calls in this plan (owner may object on the plan PR):** (a) on the canonical path, reasoning reaches Anthropic and Gemini **clients** always inside the `bg1.` envelope, also when it came from an Anthropic or Gemini provider — a raw signature carries no origin, so it could not be routed back safely; raw signatures reach clients only through pass-through (refines spec §3.1's "real one" column; logged in decisions in Task 4). (b) Chat and Ollama clients' returned reasoning text is dropped on decode with a `reasoning_dropped` note (it has no origin, so no encoder could send it). (c) A client-sent raw (non-`bg1.`) Anthropic signature or Gemini `thoughtSignature` on the canonical path is dropped with `reasoning_dropped`, as Responses does for foreign `encrypted_content`.

**Prerequisite (owner):** merge the spec, the roadmap revision, this plan, `docs/roadmap.md` and `docs/conductor/model-report-v1.5.md` before Task 0a.

## Global Constraints

- **Pre-approved test changes (D5), exactly:** in `src/transformers/adapters/anthropic.adapter.test.ts`, `"thinking request field records thinking_dropped"` (≈ l.1484, Task 3) and `"thinking content block records thinking_dropped with its path"` (≈ l.1633, Task 4); any test in `openai`/`gemini`/`ollama`/`anthropic` `*.adapter.test.ts` asserting that a non-Responses source's reasoning request field (`thinking`, `reasoning_effort`, `thinkingConfig`, `think`) is dropped (Task 3); `"image block in tool_result throws ValidationError naming the type"` (≈ l.634, Task 7); any test pinning the `[Image: <url>]` placeholder (Task 6). Each changed test asserts the new behaviour at least as exactly as the old one asserted the old. Observe tests using `thinking_dropped` as sample data stay unchanged. **No fixture or contract snapshot changes.** Anything else → STOP and escalate.
- **Defaults:** no existing default changes except D6. New config keys and defaults: provider `reasoning` (default `true`), `passthrough` (default: `true` when `preset` is set, else `false`), `preset` (none), `gaps` (from the preset, else `[]`); top-level `media: {fetch: true, allow_private: false}` (env `MEDIA_FETCH`, `MEDIA_ALLOW_PRIVATE`); media caps **20 MB** and **15 s** (constants, not config); envelope cap stays 1 MB.
- **`reasoning: false` reproduces v1.4 exactly** for that provider: same notes (code and path) as v1.4, byte-identical upstream bodies on the v1.4 reasoning fixtures.
- **Adapters stay independent.** No adapter imports another, routing or config. Per-provider behaviour comes only from config (`type`, `preset`, `gaps`, `reasoning`, `passthrough`, …), never a hostname. No client branches (`if client === …`). Gap fixes are keyed by gap name, never by provider pair.
- **Canonical changes in Task 2 only** (`canonical.types.ts` + `canonical.schema.ts` together, logged in decisions). A later task needing one STOPs.
- **Reasoning never crosses origin** (unchanged from v1.4): encoded only when its origin equals `currentAttempt()`'s.
- **Media privacy:** bytes of images and documents never reach logs, `/metrics`, OTel, `/ui/api/live`, `/ui/api/routing` or the `requests` table; URLs may be logged. Privacy canary gains a PDF and a URL image.
- **URL fetching:** `http:`/`https:` only; every resolved address (and every redirect hop, max 3) checked against private, loopback, link-local, CGNAT, ULA and metadata ranges unless `allow_private`; the connection uses the checked address (no second lookup).
- **Wire-format evidence:** every field or event name added for reasoning, media, pass-through relays, gaps and embeddings cites the provider's doc URL in a comment and in the task's decisions entry; mocks cite a doc or a Task 1 recording.
- **No network in `npm test`.** URL fetches in tests go through msw or an injected resolver.
- **Workflow files** (`.github/workflows/*`) are never edited in a PR: the change is written as `docs/conductor/patches/v1.5-task<N>-<name>.patch` (`git diff` format) for the owner to apply.
- **Owner-only:** `package.json`/`package-lock.json` change only in Task 11 (`scripts.matrix` entry) and Task 18 (version); fixture/snapshot changes; workflows; gate runs; tagging; publishing; merging.

## Review Focus

1. **A URL that redirects to a private address, or a host whose DNS answers public then private** (rebinding). Expected: 400 in the source's dialect naming the URL's host, no connection to the private address. → Task 6 (`redirect to private address is refused`, `rebinding resolver is refused`).
2. **Claude Code sends back an envelope from provider X after a fallback moved the turn to provider Y.** Expected: 200; X's reasoning dropped with `reasoning_dropped`; Anthropic thinking turned off by the continuity guard when Y is Anthropic; nothing of X in Y's body. → Task 4 (`fallback mid-session drops foreign envelope`).
3. **Client disconnects mid-stream on Anthropic or Chat pass-through** (Ctrl-C in Claude Code). Expected: one trace, `status: "aborted"`, upstream aborted, no second emit. → Task 8 (`aborted anthropic pass-through emits one trace`).
4. **An oversized or slow media URL** (25 MB PDF; a host that trickles bytes). Expected: 400 (size) or 504-mapped error (time) in the source's dialect within ~15 s, no unbounded buffering. → Task 6 (`over-cap download aborted`, `slow host times out`).
5. **`judge.sh` meets a diff it can't parse** (binary file, rename-only, 5k-line diff). Expected: a FLAG naming the check that could not run, exit 1, never a silent PASS. → Task 0a (`unparseable diff flags, never passes`).

Each line is pinned by a named test in the owning task.

---

## File Map

```
scripts/conductor/judge.ts, judge.sh, judge.test.ts, fixtures/judge/*.diff   NEW (T0a)
scripts/conductor/wait-ci.sh, usage-report.ts, usage-report.test.ts           NEW (T0a)
scripts/conductor/devin.sh                                                     stdout trimming (T0a)
scripts/conductor/run-plan.sh, headless-tools.txt                              NEW (T0b)
.claude/settings.json, .claude/agents/log-reader.md, .claude/commands/{conduct,run-plan}.md   (T0b)
CLAUDE.md, docs/conductor/standing-notes.md, docs/conductor/usage-baseline-2026-11-16.md     (T0a, T0b)
src/types/canonical.types.ts, canonical.schema.ts                              media (T2)
src/transformers/reasoning-envelope.ts                                         NEW: envelope moved from responses.envelope.ts (T2)
src/services/reasoning-policy.ts                                               NEW: `reasoning: false` (T3)
src/transformers/adapters/*.adapter.ts / *.messages.ts / *.stream.ts           reasoning (T3–T5), media (T6, T7), MEDIA_SUPPORT (T6), patchGaps (T9)
src/services/media-fetch.ts, media-inline.ts                                   NEW (T6)
src/services/passthrough.ts, passthrough-relay.ts                              anthropic + openai (T8)
src/config/gateway.schema.ts, yaml-config.ts, env-config.ts, provider-presets.ts (NEW)   (T3, T6, T8, T9)
src/services/gap-fixes.ts                                                      NEW (T9)
src/types/embeddings.types.ts, src/transformers/embeddings/{openai,gemini,ollama}.ts, src/services/embeddings.service.ts   NEW (T10)
tests/matrix/matrix-report.ts, scripts/matrix.ts, docs/compatibility.md        NEW (T11)
scripts/gates/client-replay.sh, shape-diff.ts                                  NEW (T12)
docs/conductor/patches/*.patch                                                 NEW (T11, T12, T13)
ui/src/screens/Inspector.tsx, inspector-display.ts                             media + pass-through/gap notes (T15)
docs/recipes/*, README.md, docs/architecture.md, docs/launch/v1.5-correct.md   (T16)
tests/live/*.live.test.ts, examples/claude-code-*.yaml                         (T17)
```

## Task Index

| # | Task | Depends on | Gate | Conductor | Why this model |
|---|---|---|---|---|---|
| 0a | `judge.ts`/`judge.sh`; `wait-ci.sh`; `devin.sh` trimming; `usage-report.ts`; baseline | — | OWNER REVIEW (process) | Opus | Encodes every judgment rule; a gap here weakens every later review |
| 0b | Lean context; `run-plan.sh` headless per task; log-reader helper; conductor docs | 0a | OWNER REVIEW (process, permissions D7) | Opus | Permission and context settings; must be checked against measurements |
| 1 | Recordings: Claude Code + Gemini SDK with thinking; Claude Code URL image + PDF; Ollama Anthropic gaps | 0b | | Sonnet | Evidence capture, no product code |
| 2 | Canonical media change; shared envelope module | 0b | OWNER REVIEW (interface) | Opus | Interface change |
| 3 | Reasoning request config for all sources; `reasoning: false` | 2 | D5 test change | Opus | Changes defaults for every user (D6) |
| 4 | Reasoning out/in for Anthropic and Gemini clients (envelope, streaming) | 1, 3 | D5 test change | Opus | Signatures and origin rules; wire formats |
| 5 | Reasoning out for Chat and Ollama clients | 3 | | Sonnet | Text-only, follows Task 4's pattern |
| 6 | Media decode/encode, `MEDIA_SUPPORT`, URL fetch with guard, refusals | 1, 2 | D5 test change | Opus | SSRF guard and wire formats |
| 7 | Images in tool messages, all adapters | 6 | D5 test change | Sonnet | Extends Task 6's mechanism |
| 8 | Pass-through for `anthropic` and `openai`; relays; `passthrough` key | 2 | | Opus | Changes routing path; trace/abort semantics |
| 9 | Gaps vocabulary, `patchGaps`, provider presets | 1, 8 | | Sonnet | Config vocabulary over Task 8's path; docs-cited values |
| 10 | Embeddings (OpenAI inbound only) | 0b | | Sonnet | Self-contained new endpoint |
| 11 | Matrix report, `npm run matrix`, `docs/compatibility.md`, staleness check | 5, 7, 9 | | Sonnet | Test plumbing and rendering |
| 12 | Weekly client replay (patch), shape diff, issue on failure | 11 | | Sonnet | Scripts and a workflow patch |
| 13 | Supply chain: provenance, cosign, SBOM (patch), SECURITY.md | 0b | OWNER GATE | Sonnet | Workflow patch; owner judges at the gate |
| 14 | Antigravity CLI spike (one day, report only) | 0b | | Sonnet | Research write-up |
| 15 | UI: inspector shows media and pass-through/gap notes | 6, 9 | | Sonnet | UI over existing data |
| 16 | Docs: README headline, recipes, architecture, launch draft | 11, 14 | | Sonnet | Copy |
| 17 | Live-suite cases; gates A, B, C | 12, 15, 16 | OWNER REVIEW | Opus | Judges release evidence |
| 18 | CHANGELOG, `1.5.0`; gate D at publish | 13, 17 | OWNER GATE | Sonnet | Release chore; owner gates it |

Devin implements every task on SWE-2 High. Tasks 2–10 and 13–14 can run in parallel where their dependencies allow (3 ∥ 6 ∥ 8 ∥ 10 after 2; 13 ∥ 14 any time after 0b). Opus 6 tasks + 2 Task 0, Sonnet 12 (see `docs/conductor/model-report-v1.5.md`).

---

### Task 0a: Judge script, waits, trimmed output, usage report · OWNER REVIEW

Spec §3.0.1, §3.0.2 (scripts), §3.0.5, E9–E11. **Build process only; no `src/` changes.**

**Files:**
- Create: `scripts/conductor/judge.ts`, `scripts/conductor/judge.sh`, `scripts/conductor/judge.test.ts`, `scripts/conductor/fixtures/judge/*.diff`, `scripts/conductor/wait-ci.sh`, `scripts/conductor/usage-report.ts`, `scripts/conductor/usage-report.test.ts`, `scripts/conductor/fixtures/usage/*.jsonl`, `docs/conductor/usage-baseline-2026-11-16.md`
- Modify: `scripts/conductor/devin.sh`, `docs/decisions.md`

**Interfaces:**
- Produces `judge.sh <PR> <version> <task>` → runs `npx ts-node scripts/conductor/judge.ts --pr <PR> --version <v> --task <N>`; `judge.ts` also accepts `--diff-file <path> --plan <path> --claimed <devin out.md>` (tests). Stdout ≤ 60 lines: one line per check `PASS|FLAG|N/A <check-id> <reason> [file:line…]`, then `JUDGE: PASS` or `JUDGE: FLAG (<n>)`; full report to `~/babelgate-conductor/<v>-task<N>/judge-<stamp>.md`. Exit 0 all pass, 1 any FLAG, 2 usage error.
- Check ids (spec §3.0.1 order): `fixtures`, `assertions`, `skips`, `files-block`, `adapter-independence`, `canonical-pair`, `secrets`, `diff-stat`, `owner-gate`. `files-block` parses the task's `**Files:**` block from the plan (`### Task <N>:` section) and passes when every extra file is named in a decisions.md hunk of the same diff. `adapter-independence` flags an import between `src/transformers/adapters/*` files of different formats and any added line matching `/(hostname|baseUrl|base_url)\s*(===|includes|match)/` outside config. `assertions` flags removed `expect(` lines without an added `expect(` in the same file hunk, and `toEqual|toStrictEqual|toBe(` → `toMatchObject|objectContaining|toContain|toBeTruthy` swaps.
- Produces `wait-ci.sh <PR>`: blocks on `gh pr checks <PR> --watch --fail-fast=false` with output to a file; prints the final table, and for failing checks the job name plus the last 40 log lines (`gh run view --log-failed`).
- `devin.sh`: stdout = the last 30 lines of the session plus any `PR_URL:`/`STOP:` line; the full `.out.md` unchanged.
- Produces `usage-report.ts [--since YYYY-MM-DD] [--version vX.Y] [--json]` (run via `scripts/conductor/usage-report.sh`): reads `~/.claude/projects/<repo-slug>/*.jsonl`; attributes a session to `<version>-task<N>` by the first `/conduct <v> <N>` or `<v>-task<N>` mention, else `unattributed`; per session and per task: turns, input/cache-read/cache-write/output tokens, API-equivalent `$` from one price table `{opus-5-5: {in: 4, out: 20, cacheRead: 0.20, cacheWrite1h: 8}, sonnet-5-5: {2, 10, 0.10, 4}, haiku-5-5: {0.10, 0.50, 0.01, 0.20}}` per 1M, first-turn and mean context, tool mix (classifier as E11); Opus-only and total columns.

- [ ] **Step 1: Tests.** `judge.test.ts`, one seeded diff each: `"fixture change flags"`, `"removed expect flags"`, `"exact matcher weakened flags"`, `"added .only flags"`, `"file outside Files block without decisions entry flags"`, `"file outside Files block with decisions entry passes"`, `"adapter importing another flags"`, `"canonical types without schema flags"`, `"api key literal flags"`, `"diff stat mismatch with claimed files flags"`, `"[OWNER GATE] title or workflow file flags owner-gate"`, `"clean task diff passes all"` (exit 0), and Review Focus 5: `"unparseable diff flags, never passes"` (binary + rename-only + truncated diff → FLAG naming the check, exit 1). `usage-report.test.ts`: `"attributes a session to its task"`, `"prices a session"` (synthetic 2-turn session with known usage → exact $), `"first-turn context is the first assistant turn's input+cache"`.
- [ ] **Step 2: Run** `npx vitest run scripts/conductor` → FAIL. **Step 3: Implement.** **Step 4:** run `usage-report.sh --since 2026-11-04` and commit its output as `docs/conductor/usage-baseline-2026-11-16.md` (per-task medians for v1.3 and v1.4, first-turn context median ≈ 48.9k, totals ≈ E9). `./scripts/check.sh` → PASS. PR `[OWNER REVIEW] chore(conductor): judge script, waits, usage report`. **Commit** `chore(conductor): judge script, waits, usage report`.

### Task 0b: Lean context, headless per-task runs, log reader, conductor docs · OWNER REVIEW

Spec §3.0.2 (helper, background waits), §3.0.3, §3.0.4, §3.0.6, D7.

**Files:**
- Create: `scripts/conductor/run-plan.sh`, `scripts/conductor/headless-tools.txt`, `.claude/agents/log-reader.md`
- Modify: `.claude/settings.json`, `.claude/commands/conduct.md`, `.claude/commands/run-plan.md`, `CLAUDE.md`, `docs/conductor/standing-notes.md`, `docs/decisions.md`

**Interfaces:**
- Consumes: `judge.sh`, `wait-ci.sh`, `usage-report.sh` (Task 0a).
- Produces `run-plan.sh <version> <from> <to>`: for each task id in plan Task Index order (ids like `0b`, `7`), reads its **Conductor** column (`Opus` → `--model opus`, `Sonnet` → `--model sonnet`), runs `claude -p "/conduct <version> <id>" --model <m> --allowedTools "$(paste -sd, headless-tools.txt)"` with output to `~/babelgate-conductor/<v>-task<id>/headless-<stamp>.out`, then reads the task's `conductor-log.md` last line: `RESULT: READY <PR>` → waits in bash (`gh pr view <PR> --json state`, every 300 s, no Claude calls) until `MERGED`, then the next task; `RESULT: ESCALATED|GATE|FAILED` or a missing line → stops and runs `notify.sh`. Never merges.
- `headless-tools.txt`: one tool spec per line, mirroring `.claude/settings.json` `allow` plus `Bash(scripts/conductor/judge.sh:*)`, `Bash(scripts/conductor/wait-ci.sh:*)`, `Bash(scripts/conductor/usage-report.sh:*)`, `Agent(log-reader)`, `Write(~/babelgate-conductor/**)`; the settings `deny` list stays in force. No `--dangerously-skip-permissions`, no `bypassPermissions`.
- `/conduct` ends by appending `RESULT: <READY <PR>|ESCALATED|GATE|FAILED>` to the conductor log.
- `.claude/agents/log-reader.md`: frontmatter `model: haiku`, tools `Read, Bash(grep:*), Bash(tail:*), Bash(gh run view:*)`; returns ≤ 15 lines with file:line pointers; never judges.
- `.claude/settings.json`: turns off MCP servers, claude.ai connectors and plugins the conductor never uses (at least Atlassian, Claude Data, Meetings, Claude Docs, graphify); exact keys per the Claude Code settings docs (URL in decisions).

- [ ] **Step 1: Measure before.** Start one conductor session in this repo, send `/context` (or read its first turn from the session log), record first-turn tokens per source (system, tools, MCP, skills, CLAUDE.md) in decisions.
- [ ] **Step 2: Settings.** Apply the removals; start a fresh session and measure again. Target ≤ 30k first-turn tokens (spec §3.0.3); record what each removal saved and what T3 Code injects that can't be removed. Under target is not a STOP; record the number.
- [ ] **Step 3: `run-plan.sh`, `headless-tools.txt`, `log-reader.md`, the `RESULT:` line.** Dry run: `run-plan.sh v1.4 15 15` with `DRY_RUN=1` prints the `claude -p` command it would run with model `sonnet` (from a test copy of the v1.4 index with a Conductor column) and exits 0.
- [ ] **Step 4: Docs.** CLAUDE.md "The loop": step 3 review ∥ CI uses `wait-ci.sh` in the background with one blocking wait; step 4 runs `judge.sh` first and reads its FLAGs instead of hand greps (judgment rules text unchanged); long logs go to `log-reader`; `run-plan.sh` for ranges. `conduct.md`, `run-plan.md` (now: "run `scripts/conductor/run-plan.sh`"), standing notes accordingly.
- [ ] **Step 5:** `./scripts/check.sh` → PASS. PR `[OWNER REVIEW] chore(conductor): lean context, headless per-task runs`. **Commit** `chore(conductor): lean context, headless per-task runs`.

### Task 1: Recordings — thinking round trips, media, Ollama Anthropic gaps

Spec §3.1 "Evidence first", §3.2, §3.3, E7, D8. **No product code.**

**Files:**
- Create: `scripts/gates/record-claude-code.sh`, `scripts/gates/record-gemini-sdk.ts`, `scripts/gates/probe-ollama-anthropic.sh`, `tests/fixtures/recordings/claude-code-thinking.jsonl`, `tests/fixtures/recordings/gemini-sdk-thinking.jsonl`, `tests/fixtures/recordings/claude-code-media.jsonl` (all shapes-only, as `record-shapes.ts` writes them)
- Modify: `docs/decisions.md`, spec §1.2 (append E13+)

**Interfaces:**
- Consumes: `scripts/gates/record-shapes.ts <listenPort> <forwardBaseUrl> <outJsonl>`.
- Produces: `record-claude-code.sh thinking|media` (Claude Code → recorder → OpenRouter's Anthropic `/messages`, `anthropic/claude-haiku-4.5`, thinking on; `media` gives Claude Code a PNG URL and a 2-page PDF on disk to read). `record-gemini-sdk.ts` (`@google/generative-ai` devDependency, thinking on, a 3-turn function-calling loop against the Gemini API). `probe-ollama-anthropic.sh [baseUrl]` sends one request per probe to `<base>/v1/messages` (`tool_choice: {type:"any"}`, `POST /v1/messages/count_tokens`, `cache_control`, URL image, base64 PDF, `stream: true` usage) and prints `probe status note`.

- [ ] **Step 1:** Write the three scripts. Missing `claude`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` or a local Ollama (`ollama list` with a tool-capable model) → STOP: `Owner decision needed: run <script> and attach the output`.
- [ ] **Step 2: Record** and write in decisions (E13+): Claude Code version; whether thinking blocks (text **and** `signature`) come back byte-identical on the next request; whether Claude Code ever edits or drops them (e.g. on compaction); the Gemini SDK's handling of `thought` parts and `thoughtSignature` on the next turn; how Claude Code sends a URL image and a PDF (block types, `source.type`); Ollama version and each probe's status.
- [ ] **Step 3: Scope check.** If a client rewrites or strips reasoning blocks, STOP with an owner decision (spec §3.1: that client gets text-only reasoning; criterion 2 amended). If Ollama supports a probed feature the preset was going to fix, note it for Task 9.
- [ ] **Step 4:** `./scripts/check.sh` → PASS. **Commit** `docs: v1.5 client and ollama recordings`.

### Task 2: Canonical media change; shared envelope module · OWNER REVIEW

Spec §3.2.1, E2, E3. **Interface change.**

**Files:**
- Create: `src/transformers/reasoning-envelope.ts`
- Modify: `src/types/canonical.types.ts`, `src/types/canonical.schema.ts`, `src/transformers/adapters/responses.envelope.ts` (re-export only), `docs/decisions.md`
- Test: `tests/contracts/canonical.schema.test.ts`, `src/transformers/adapters/responses.envelope.test.ts` (imports unchanged and passing)

**Interfaces:**
- Produces: `CanonicalImage = {data: string; mimeType: "image/jpeg"|"image/png"|"image/gif"|"image/webp"; url?: never} | {url: string; mimeType?: <same union>; data?: never}`; `CanonicalContentPart.type` gains `"document"` with `document?: CanonicalDocument = {data?: string; url?: string; mimeType: "application/pdf"|"text/plain"; name?: string}` (exactly one of `data`/`url`); messages with `role: "tool"` may have `content: CanonicalContentPart[]` with `text` and `image` parts (schema already allows arrays: the refinement now permits `image` there).
- Produces `reasoning-envelope.ts`: `ENVELOPE_PREFIX`, `ENVELOPE_CAP_BYTES`, `EnvelopePayload`, `packEnvelope`, `unpackEnvelope` (moved verbatim); `responses.envelope.ts` re-exports them.

- [ ] **Step 1: Tests.** `"url image valid"`, `"image with both data and url invalid"`, `"document pdf by data valid"`, `"document with neither data nor url invalid"`, `"tool message with image part valid"`, `"document part on assistant message invalid"`, `"existing requests still valid"` (every request in `tests/fixtures/*.json`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS (no fixture change). Decisions entry with the type diff. PR `[OWNER REVIEW] feat(canonical): url images, documents, tool-message images`. **Commit** `feat(canonical): url images, documents, tool-message images`.

### Task 3: Reasoning request config for all sources; `reasoning: false` · D5

Spec §3.1 (request table), D6.

**Files:**
- Create: `src/services/reasoning-policy.ts`
- Modify: `anthropic.adapter.ts`, `openai.adapter.ts`, `gemini.adapter.ts`, `ollama.adapter.ts` (decoders), `src/transformers/reasoning-effort.ts`, `src/config/gateway.schema.ts`, `yaml-config.ts`, `src/services/chat.service.ts`, `chat-stream.service.ts`, `attempt-targets.ts`, `docs/decisions.md`
- Test: each `*.adapter.test.ts`, `reasoning-effort.test.ts`, `src/services/reasoning-policy.test.ts`

**Interfaces:**
- Produces `effortForBudget(budgetTokens: number): Effort` in `reasoning-effort.ts` (highest ladder level whose `budgetFor` ≤ budget; `< 1024` → `"minimal"`).
- Decoders: Anthropic `thinking {type:"enabled", budget_tokens}` → `{effort: effortForBudget(b), budgetTokens: b}`; `{type:"adaptive"}` + `output_config.effort` → `{effort}`; `{type:"disabled"}` → `{effort: "none"}`. Chat `reasoning_effort` → `{effort}`. Gemini `thinkingConfig.thinkingLevel` → `{effort}`, `thinkingBudget` → `{effort: effortForBudget, budgetTokens}`, `includeThoughts` → `summary`. Ollama `think: true` → `{effort: "medium"}`, a level string → `{effort}`, `false` → `{effort: "none"}`.
- Produces `applyReasoningPolicy(req: CanonicalRequest, entry: ProviderEntry, source: Provider, sourceBody: unknown): CanonicalRequest` — when `entry.reasoning === false` and `source !== "responses"`: removes `config.reasoning` and records exactly the v1.4 note(s) for that source (code and path). Called per attempt, before encode.
- Config: `reasoning: z.boolean().optional()` on provider entries (absent = true).

- [ ] **Step 1: Tests.** Per decoder: one case per row above with exact `config.reasoning`. D5: rewrite `"thinking request field records thinking_dropped"` as `"thinking request field maps to config.reasoning"` (`budget_tokens: 8192` → `{effort: "medium", budgetTokens: 8192}`, no note); same for the other sources' drop tests. `reasoning-policy.test.ts`: `"reasoning:false reproduces v1.4 note and body"` — for each source, a request with its reasoning field, routed to each target with `reasoning: false`, gives the same notes and byte-identical upstream body as the v1.4 fixtures/expectations; `"responses source unaffected by reasoning:false"`. `reasoning-effort.test.ts`: `"budget 24576 → high"`, `"budget 500 → minimal"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: reasoning request config for every source`.

### Task 4: Reasoning out/in for Anthropic and Gemini clients · D5

Spec §3.1 (out/in tables), conductor's calls (a) and (c), Task 1 recordings.

**Files:**
- Modify: `anthropic.adapter.ts`, `anthropic.messages.ts`, `anthropic.stream.ts`, `gemini.adapter.ts`, `gemini.stream.ts`, `docs/decisions.md`
- Test: `anthropic.adapter.test.ts`, `gemini.adapter.test.ts`, `tests/contracts/stream-decoders.test.ts`, `tests/contracts/stream-reasoning-drop.test.ts` (new cases only), `tests/integration/claude-code.test.ts` (new cases)

**Interfaces:**
- Consumes: `packEnvelope`/`unpackEnvelope` (Task 2), `signatureMatchesCurrent`, continuity guard (v1.4).
- Anthropic client replies: per assistant turn, reasoning parts become `thinking` blocks in original order (redacted → `redacted_thinking`, `data` = envelope); each block's `signature` = `packEnvelope({v:1, reasoning: [that part + its signature], signatures: [tool-call and text signatures up to the next reasoning part]})`; a turn with signatures but no reasoning part gets one `thinking` block with `thinking: ""` first. Streaming: `content_block_start {type:"thinking"}`, `thinking_delta`s, one `signature_delta` with the envelope before `content_block_stop`. Over the cap → block without signature + `reasoning_dropped`.
- Gemini client replies: reasoning parts → `{text, thought: true}` parts; the turn's envelope (all reasoning parts and signatures) in `thoughtSignature` of the first thought part, or of the first `functionCall` part when there is no thought part.
- Decoders of client requests: an envelope in a `thinking.signature` / `redacted_thinking.data` / any part's `thoughtSignature` unpacks to its canonical parts and signatures in place; a raw signature → dropped with `reasoning_dropped` (path); thinking text without an envelope → dropped with `reasoning_dropped`.

- [ ] **Step 1: Tests.** `"anthropic client receives thinking with envelope signature"`; `"envelope round-trips to identical canonical parts"` (reply → client's next request → decode equals the original parts, signatures and tool-call signatures); `"gemini client receives thought parts with envelope"`; same round trip for Gemini; `"raw anthropic signature from client dropped with note"`; `"thinking_delta and signature_delta encoded in order"`; D5: `"thinking content block records thinking_dropped with its path"` becomes `"thinking content block with envelope decodes to reasoning"`. Review Focus 2: `"fallback mid-session drops foreign envelope"` (turn 2 routes to another provider → `reasoning_dropped`, continuity guard turns Anthropic thinking off, upstream body has no X content). Integration: Claude Code three-turn loop on a mocked Gemini thinking upstream (Task 1 shapes) → no `reasoning_dropped` on same-provider turns.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Decisions: conductor's calls (a) and (c), with the Task 1 evidence. **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: reasoning for anthropic and gemini clients`.

### Task 5: Reasoning out for Chat and Ollama clients

Spec §3.1, conductor's call (b).

**Files:**
- Modify: `openai.adapter.ts`, `openai.stream.ts`, `ollama.adapter.ts`, `ollama.stream.ts`, `docs/decisions.md`
- Test: `openai.adapter.test.ts`, `ollama.adapter.test.ts`, `tests/contracts/stream-decoders.test.ts` (new cases)

**Interfaces:**
- Chat client replies: reasoning text (non-redacted parts, joined `\n\n`) → `message.reasoning_content`; stream → `delta.reasoning_content` chunks before content. Ollama client replies: → `message.thinking`; stream NDJSON `message.thinking` per chunk. Signatures never emitted.
- Client requests: `reasoning_content` / `thinking` on assistant messages → dropped with `reasoning_dropped` (path).

- [ ] **Step 1: Tests.** `"chat client receives reasoning_content"`, `"chat stream emits reasoning_content deltas first"`, `"ollama client receives thinking"`, `"ollama stream emits thinking"`, `"returned reasoning_content dropped with note"`, `"redacted reasoning not emitted as text"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: reasoning for chat and ollama clients`.

### Task 6: Media: URL images, documents, fetch guard, refusals · D5

Spec §3.2.2, E4, Review Focus 1 and 4.

**Files:**
- Create: `src/services/media-fetch.ts`, `src/services/media-inline.ts`, `src/services/media-fetch.test.ts`, `src/services/media-inline.test.ts`
- Modify: all five `*.adapter.ts` / `*.messages.ts` / `responses.items.ts` (decode + encode + `MEDIA_SUPPORT`), `src/services/chat.service.ts`, `chat-stream.service.ts`, `src/config/gateway.schema.ts`, `yaml-config.ts`, `env-config.ts`, `tests/integration/privacy-canary.test.ts`, `docs/decisions.md`

**Interfaces:**
- Each adapter exports `MEDIA_SUPPORT: MediaSupport`, with `type MediaSupport = {imageUrl: boolean; documentData: boolean; documentUrl: boolean; toolMessageImages: boolean}` defined in `media-inline.ts` (values from its provider docs, URL in a comment; `toolMessageImages` set in Task 7).
- Produces `fetchMedia(url: string, opts: {allowPrivate: boolean; maxBytes?: number /*20 MB*/; timeoutMs?: number /*15 000*/; resolve?: (host: string) => Promise<string[]>}): Promise<{data: string; mimeType: string}>`; throws `MediaFetchError {reason: "scheme"|"private"|"size"|"timeout"|"status"|"type", host}`.
- Produces `inlineMediaForTarget(req: CanonicalRequest, support: MediaSupport, media: {fetch: boolean; allowPrivate: boolean}): Promise<CanonicalRequest>` — URL images/documents the target can't take by URL are fetched and inlined; called per attempt before encode. A part the target can't take at all, or `fetch: false` when bytes are needed, or a `MediaFetchError` → `ValidationError` naming the field path and target (rendered in the source's dialect by the existing error handler).
- Decode/encode per format (field names verified against each doc): OpenAI Chat `image_url.url` (http(s) → `url`, `data:` → `data`), `file {file_data, filename}`; Responses `input_image.image_url`, `input_file {file_data|file_url, filename}`; Anthropic `image.source {type:"url"|"base64"}`, `document.source {type:"url"|"base64"|"text"}`; Gemini `inlineData` (images, PDF), `fileData.fileUri` decode → `url`; Ollama `images[]` (base64 only). `text/plain` documents become text parts on encode for every target.

- [ ] **Step 1: Tests.** `media-fetch.test.ts` (msw + injected resolver): `"fetches a public png"`, `"non-http scheme refused"`, `"loopback refused"`, `"metadata address refused"`; Review Focus 1: `"redirect to private address is refused"`, `"rebinding resolver is refused"`; Review Focus 4: `"over-cap download aborted"` (25 MB → `size`, memory bounded), `"slow host times out"` (→ `timeout`); `"allow_private permits 10.0.0.5"`. `media-inline.test.ts`: `"url image kept for url-capable target"`, `"url image inlined for ollama"`, `"pdf to ollama refused naming the field"`, `"fetch:false refuses when bytes needed"`. Per adapter: decode/encode one URL image and one PDF (D5: the `[Image: <url>]` test, if any, becomes `"http image_url decodes to url image"`). Privacy canary: a PDF and a URL image → bytes absent from every sink, URL allowed.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: url images and documents across formats`.

### Task 7: Images in tool messages · D5

Spec §3.2.1, §3.2.2.

**Files:**
- Modify: `anthropic.messages.ts`, `responses.items.ts`, `gemini.adapter.ts`, `openai.adapter.ts`, `ollama.adapter.ts` (`MEDIA_SUPPORT.toolMessageImages` + decode/encode), `src/services/media-inline.ts`, `docs/decisions.md`
- Test: each `*.adapter.test.ts`, `media-inline.test.ts`

**Interfaces:**
- Consumes `inlineMediaForTarget` (Task 6): when a tool message has an image part and the target's `toolMessageImages` is false → `ValidationError` naming the path and target.
- Anthropic `tool_result.content` image blocks ↔ tool message image parts; Responses `function_call_output.output` array with `input_image`; Gemini `functionResponse` multimodal parts only if its docs support them for the target model family (else false); OpenAI Chat and Ollama per docs (expected false).

- [ ] **Step 1: Tests.** D5: `"image block in tool_result throws ValidationError naming the type"` becomes `"image block in tool_result decodes to a tool image part"`; `"tool image reaches anthropic target"`; `"tool image reaches responses target"`; `"tool image to chat target refused naming the path"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: images in tool results`.

### Task 8: Pass-through for `anthropic` and `openai`

Spec §3.3 (pass-through), D6, Review Focus 3.

**Files:**
- Modify: `src/services/passthrough.ts`, `passthrough-relay.ts`, `chat.service.ts`, `chat-stream.service.ts`, `proxy.service.ts` (count_tokens forward), `src/config/gateway.schema.ts`, `yaml-config.ts`, `docs/decisions.md`
- Test: `src/services/passthrough.test.ts`, `tests/integration/observe.test.ts`, `tests/integration/claude-code.test.ts` (new cases)

**Interfaces:**
- `isPassthrough(source, entry)`: `source === entry.type && (entry.type === "responses" || entry.passthrough === true)`; the config loader sets `passthrough: true` when `preset` is set and `passthrough` is absent (Task 9 adds `preset`; this task adds the `passthrough` key).
- Produces `relayAnthropicStream(opts)` and `relayChatStream(opts)` beside `relayResponsesStream`, same `PassthroughObservation` contract: usage from `message_start`/`message_delta` (Anthropic) and the final chunk's `usage` (Chat, `stream_options.include_usage` honoured if the client sent it); first-byte rule for fallbacks as v1.4.
- Pass-through Anthropic `POST /v1/messages/count_tokens` is forwarded unless the entry's `gaps` include `count_tokens` (Task 9).

- [ ] **Step 1: Tests.** `"anthropic pass-through forwards bytes unchanged"`, `"chat pass-through forwards bytes unchanged"`, `"no preset and no flag keeps canonical path"`, `"passthrough:true opts in"`, `"usage and cost recorded on anthropic pass-through"`, `"usage recorded on chat pass-through stream"`; Review Focus 3: `"aborted anthropic pass-through emits one trace"` and the Chat twin; `"fallback before first byte to a canonical target"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: anthropic and chat pass-through`.

### Task 9: Gaps vocabulary, `patchGaps`, provider presets

Spec §3.3 (gaps, presets), E5, E7, Task 1 probes.

**Files:**
- Create: `src/config/provider-presets.ts`, `src/services/gap-fixes.ts`, `src/services/gap-fixes.test.ts`
- Modify: `anthropic.adapter.ts`, `openai.adapter.ts` (`patchGaps`), `src/services/passthrough.ts`, `proxy.service.ts`, `src/config/gateway.schema.ts`, `yaml-config.ts`, `docs/decisions.md`

**Interfaces:**
- `GAPS = ["tool_choice","count_tokens","prompt_cache","url_images","documents","stream_usage"] as const`; provider keys `gaps: z.array(z.enum(GAPS)).optional()`, `preset: z.enum(PRESET_NAMES).optional()`.
- `PROVIDER_PRESETS: Record<PresetName, {type: "anthropic"; base_url: string; api_key_env?: string; gaps: Gap[]; docs: string; verified: string /*date*/}>` for `ollama-anthropic`, `lmstudio-anthropic`, `deepseek-anthropic`, `glm-anthropic`, `kimi-anthropic`; explicit entry keys override preset values; gap lists from each provider's docs (Ollama from Task 1 probes).
- Each pass-through-capable adapter exports `patchGaps(body: Record<string, unknown>, gaps: readonly Gap[]): {body: Record<string, unknown>; notes: Note[]; needsMedia: string[] /*JSON paths of URL images to inline*/}` — format knowledge only.
- `applyGapFixes(source: Provider, body, gaps, media): Promise<{body; notes}>` in `gap-fixes.ts`: calls the source adapter's `patchGaps`, inlines `needsMedia` paths via `fetchMedia`, refuses documents (`documents` gap) with `ValidationError`. `count_tokens` gap → `proxy.service` answers with `estimateInputTokens` (flagged estimated) instead of forwarding. `stream_usage` gap → usage estimated with `estimateOutputTokens` and marked estimated in the trace.

- [ ] **Step 1: Tests.** One per gap: `"tool_choice removed with note"`, `"count_tokens answered locally"`, `"cache_control stripped with note"`, `"url image inlined in pass-through body"`, `"document refused in source dialect"`, `"stream usage estimated and flagged"`; presets: `"ollama-anthropic preset fills type, base_url, gaps and passthrough"`, `"explicit gaps override preset"`, `"unknown preset rejected at config load"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Decisions: each preset's doc URL and verification date. **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: provider presets and gap fixes`.

### Task 10: Embeddings (OpenAI format inbound)

Spec §3.6.

**Files:**
- Create: `src/types/embeddings.types.ts`, `src/transformers/embeddings/openai.ts`, `gemini.ts`, `ollama.ts`, `src/services/embeddings.service.ts`, tests beside each, `tests/integration/embeddings.test.ts`
- Modify: `src/routes/proxy.ts`, `src/routing/detect-source.ts`, `docs/decisions.md`

**Interfaces:**
- `EmbeddingRequest {model: string; input: string[]; dimensions?: number; encodingFormat: "float"|"base64"}`; `EmbeddingResponse {model: string; vectors: number[][]; usage: {inputTokens: number}}`. Not canonical types (no interface change).
- `POST /v1/embeddings` and `POST /embeddings`: routing, aliases, fallbacks as chat. Targets: `openai` → forwarded body; `gemini` → `batchEmbedContents` (`outputDimensionality`); `ollama` → `/api/embed` (`dimensions` per its docs); `anthropic`/`responses` → 501 in OpenAI's error envelope. `encoding_format: "base64"` → little-endian float32 base64 encoded by babelgate. Usage and cost recorded.

- [ ] **Step 1: Tests.** `"string input normalized to array"`, `"gemini target maps dimensions"`, `"ollama target maps"`, `"anthropic target 501 in openai envelope"`, `"base64 encoding matches float32 LE"`, `"alias and fallback route embeddings"`, `"usage recorded"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: embeddings endpoint`.

### Task 11: Compatibility matrix

Spec §3.4 (matrix).

**Files:**
- Create: `tests/matrix/matrix-report.ts`, `scripts/matrix.ts`, `scripts/matrix.test.ts`, `docs/compatibility.md`
- Modify: `tests/integration/pairs.test.ts`, `stream-pairs.test.ts` (record cells; add reasoning, URL image, document, tool image, pass-through cases), `vitest.config.ts` (`globalTeardown`), `scripts/check.sh` (`npm run matrix -- --check` after tests in full mode), `package.json` (`"matrix": "ts-node scripts/matrix.ts"` only), `.gitignore` (`tests/matrix/.out/`), `README.md` (link near top)

**Interfaces:**
- `recordMatrixCell(source: Provider, target: Provider, feature: MatrixFeature, status: "pass"|"note"|"fail", note?: string): void`; `MatrixFeature = "plain"|"stream"|"tools"|"stream_tools"|"structured"|"reasoning"|"url_image"|"document"|"tool_image"|"passthrough"`; teardown writes `tests/matrix/.out/matrix.json`.
- `scripts/matrix.ts [--check]` renders `docs/compatibility.md` (one table per feature, rows = source, columns = target; `✓`, `✓ <note code>` or `✗ <reason>`; header with the replay badge `![client replay](…/actions/workflows/live.yml/badge.svg?event=schedule)` and a link to the latest run); `--check` exits 1 with a unified diff when the committed file differs in cells.
- Workflow: none (check.sh is what CI runs).

- [ ] **Step 1: Tests.** `"renders a pass, a note and a fail cell"`, `"--check passes on identical cells"`, `"--check fails with a diff on a changed cell"`, `"header-only change is not a failure"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; generate and commit `docs/compatibility.md`. **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: generated compatibility matrix`.

### Task 12: Weekly client-release replay

Spec §3.4 (replay), E8.

**Files:**
- Create: `scripts/gates/client-replay.sh`, `scripts/gates/shape-diff.ts`, `scripts/gates/shape-diff.test.ts`, `docs/conductor/patches/v1.5-task12-client-replay.patch`
- Modify: `docs/decisions.md`

**Interfaces:**
- `client-replay.sh`: installs `@anthropic-ai/claude-code@latest` and `@openai/codex@latest` into a temp prefix; runs `claude-code-edit.sh config examples/claude-code-openrouter.yaml` and `codex-edit.sh config examples/codex-openrouter.yaml` (bridge); records each client's requests via `record-shapes.ts`; runs `shape-diff.ts`; writes a markdown summary (versions, gate results, shape diff) to `$GITHUB_STEP_SUMMARY` when set; exit 1 on any failure or new shape.
- `shape-diff.ts <new.jsonl> <fixture.jsonl>` prints added/removed request keys, tool types, input item types and SSE event types; exit 1 when anything was added.
- The patch adds to `live.yml` a `schedule: cron "0 6 * * 1"` job `client-replay` (secrets `OPENROUTER_API_KEY`; `permissions: issues: write`) that runs `client-replay.sh` and on failure runs `gh issue create --label client-replay --title "Client replay failed: <versions>" --body-file <summary>`.

- [ ] **Step 1: Tests.** `"identical shapes exit 0"`, `"new request key reported, exit 1"`, `"new SSE event type reported"`, `"removed field reported, exit 0"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; write the patch (`git diff` of `live.yml`, not applied). **Step 4:** `./scripts/check.sh` → PASS; PR body says "Owner: apply `docs/conductor/patches/v1.5-task12-client-replay.patch`". **Commit** `feat: weekly client-release replay`.

### Task 13: Supply chain · OWNER GATE

Spec §3.5.

**Files:**
- Create: `docs/conductor/patches/v1.5-task13-supply-chain.patch`
- Modify: `SECURITY.md` (Verifying releases), `docs/decisions.md`

**Interfaces:**
- The patch changes `release.yml`: `permissions: id-token: write, packages: write, contents: write`; `npm publish --provenance --access public`; `sigstore/cosign-installer` + `cosign sign --yes ghcr.io/<owner>/babelgate@<digest>` (keyless); `npm sbom --sbom-format cyclonedx --omit dev > babelgate-<version>.cdx.json` attached to the GitHub release; release notes gain `Runtime dependencies: <n>` from `npm ls --omit=dev --all --parseable | tail -n +2 | wc -l`.
- `SECURITY.md`: `npm audit signatures`, `cosign verify ghcr.io/… --certificate-identity-regexp … --certificate-oidc-issuer https://token.actions.githubusercontent.com`, SBOM location.

- [ ] **Step 1:** Write the patch; check it applies: `git apply --check docs/conductor/patches/v1.5-task13-supply-chain.patch`. **Step 2:** `SECURITY.md`. **Step 3:** `./scripts/check.sh` → PASS. PR `[OWNER GATE] chore: signed releases, provenance, SBOM (patch)`. **Commit** `chore: supply-chain release patch`.

### Task 14: Antigravity CLI spike (time-boxed, one day)

Spec §3.7. **Report only, no product code.**

**Files:**
- Create: `docs/research/<date>-antigravity-spike.md`
- Modify: `docs/recipes/gemini-cli.md` (frozen note: works with paid API keys and enterprise licences; Google moved individuals to Antigravity CLI on 2026-05-19, source linked)

- [ ] **Step 1:** Install Antigravity CLI (missing install or account → STOP with an owner decision). Find: custom endpoint setting and env vars, API format(s) it speaks, models it allows, whether it runs through babelgate on a non-Google model (try `babelgate` with the matching source format), licence/terms on third-party endpoints. Sources with dates.
- [ ] **Step 2:** Write the report: findings, a recommendation (adopt as entry point in v1.6 / not / wait), estimated size. **Step 3:** `./scripts/check.sh` → PASS. **Commit** `docs: antigravity cli spike`.

### Task 15: UI — media and pass-through/gap notes in the inspector

**Files:**
- Modify: `ui/src/screens/Inspector.tsx`, `ui/src/screens/inspector-display.ts`, `ui/src/screens/Inspector.test.tsx`

**Interfaces:**
- Media parts display as `image (url: <host>/…)` / `image (<mimeType>, <KB> KB)` / `document (<mimeType>, <name>, <KB> KB)`, never content; the pass-through marker shows the preset name; gap notes (`tool_choice_dropped`, `cache_control_dropped`, estimated count/usage) listed with the existing notes.

- [ ] **Step 1: Tests.** `"url image shows host only"`, `"pdf shows size not bytes"`, `"pass-through row shows preset"`, `"gap notes listed"`. **Step 2:** FAIL → implement → `./scripts/check.sh` PASS. **Commit** `feat(ui): media and shim in the inspector`.

### Task 16: Docs and positioning

Roadmap revision §2.1, spec §2.1.

**Files:**
- Create: `docs/recipes/native-endpoints.md` (presets, gaps, what babelgate adds), `docs/launch/v1.5-correct.md`
- Modify: `README.md` (headline "The translator you can check"; proof points in the revision's order; compatibility link; Gemini CLI out of the headline), `docs/recipes/claude-code.md` (thinking carried; `reasoning: false`; envelope note: history made through babelgate keeps babelgate signatures), `docs/recipes/openai-sdk.md` (embeddings, media), `docs/architecture.md` (media inlining, shim, envelope module), `docs/decisions.md`

- [ ] **Step 1:** Write; every config snippet is copied from a file under `examples/` that `src/config/examples.test.ts` loads and validates (add the new examples there). **Step 2:** `./scripts/check.sh` → PASS. **Commit** `docs: v1.5 positioning, recipes, launch draft`.

### Task 17: Live-suite cases; gates A, B, C · OWNER REVIEW

Spec §4 (live, gates), D8.

**Files:**
- Create: `tests/live/reasoning.live.test.ts`, `tests/live/media.live.test.ts`, `examples/claude-code-gemini-thinking.yaml`, `examples/claude-code-ollama-anthropic.yaml`
- Modify: `tests/live/live.helpers.ts`, `scripts/gates/observe-check.ts` (`--expect-preset <name>`), `docs/decisions.md`

- [ ] **Step 1: Live tests** (skipped without keys/Ollama): `"claude code shape on gemini, three-turn reasoning loop"`, `"gemini sdk shape on claude with thinking"`, `"url image and pdf per capable provider"`, `"ollama-anthropic preset pass-through with tools"`. Owner runs `npm run test:live` and pastes the summary.
- [ ] **Step 2: Gates** (owner; recorded in decisions with client versions, models, duration, cost):
  - **A:** `OBSERVE_CHECK="--expect-cost --expect-no-note reasoning_dropped" scripts/gates/claude-code-edit.sh config examples/claude-code-gemini-thinking.yaml` → `GATE PASS` + `OBSERVE PASS`.
  - **B:** `OBSERVE_CHECK="--expect-passthrough --expect-preset ollama-anthropic" scripts/gates/claude-code-edit.sh config examples/claude-code-ollama-anthropic.yaml` on a tool-capable local model → `GATE PASS` + `OBSERVE PASS`.
  - **C:** the latest scheduled `client-replay` run is green on the current Claude Code and Codex, and `npm run matrix -- --check` passes on main.
- [ ] **Commit** `docs: v1.5 release gate results`.

### Task 18: CHANGELOG, `1.5.0` · OWNER GATE

**Files:**
- Modify: `CHANGELOG.md` (`## [1.5.0]` + compare link), `package.json`/`package-lock.json` (version, root entries only), `docs/roadmap.md` (status: v1.5 released, next v1.6), `src/cost/prices.json` (refresh), `docs/conductor/model-report-v1.5.md` (measured usage per task from `usage-report.sh --version v1.5`), `docs/decisions.md`

- [ ] **Step 1:** `npm run update:prices -- <latest LiteLLM commit>`; commit separately `chore: refresh bundled prices`.
- [ ] **Step 2:** CHANGELOG: Added (reasoning for every client format, URL images, documents, tool-result images, pass-through for Anthropic and Chat, provider presets and gaps, embeddings, compatibility matrix, client replay, signed releases); Changed (**reasoning requests from Claude Code, Chat, Gemini and Ollama clients now reach the provider — set `reasoning: false` to keep 1.4 behaviour**); Known limitations (spec §2.2; envelope signatures; tool images refused on Chat/Ollama targets).
- [ ] **Step 3:** `./scripts/check.sh` → PASS. **Commit** `chore: release 1.5.0`. Owner: apply the Task 13 patch if not yet, tag `v1.5.0`; gate D: `npm audit signatures`, `cosign verify`, SBOM attached.
