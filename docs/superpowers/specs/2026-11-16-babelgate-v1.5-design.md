# babelgate v1.5 — Design Spec ("Correct everywhere")

**Date:** 2026-11-16 · **Status:** direction and D1–D8 approved by the owner in conversation on 2026-11-16; this
written spec awaits owner review · **Roadmap:** `docs/roadmap.md` (Phase 2, v1.5) ·
**Parent specs:** `2026-10-26-babelgate-roadmap-design.md`, `2026-11-04-babelgate-roadmap-revision-design.md`,
`2026-11-16-babelgate-roadmap-revision-design.md` · **Previous version:** `2026-11-13-babelgate-v1.4-design.md`
· **Research:** `docs/research/2026-11-16-market-analysis.md`

## 1. Purpose

Make babelgate the translator people can check. Every client format carries the model's reasoning and
its media (URL images, PDFs, images in tool results) to every provider. Where a provider already speaks
the client's format, babelgate passes the request through and fixes the gaps that endpoint leaves. The
evidence is public: a compatibility matrix generated from the tests, a weekly replay of the newest
Claude Code and Codex releases, and signed, provenance-attested releases.

Before any of that, the build process gets cheaper (§3.0): the owner hits the weekly and 5-hour Claude
limits on heavy weeks, and runs stall until the limits renew.

### 1.1 Why this shape
The 2026-11-16 market analysis (roadmap revision §1) found that "Claude Code / Codex on any model" is
crowded, that native Anthropic and Responses endpoints keep spreading but leave gaps, and that
competitors' open issues are exactly the failures babelgate's pair tests catch (lost thinking blocks,
corrupted streamed tool arguments, dropped features). So v1.5 spends its effort on **depth and proof**:
finish reasoning and media across all five formats, make same-format traffic a first-class shim, and
publish the evidence. Breadth that competitors already have (provider count, embeddings in every format)
is kept small.

### 1.2 Evidence (read from the code on main and the conductor logs, 2026-11-16)
| # | Finding | Where | Effect |
|---|---|---|---|
| E1 | Anthropic-source `thinking` is dropped (`thinking_dropped`); Chat `reasoning_effort`, Gemini `thinkingConfig` and Ollama `think` from non-Responses sources are dropped too; only the Responses decoder sets `config.reasoning` (v1.4 §3.3) | `anthropic.adapter.ts:86`, `anthropic.messages.ts:267`, v1.4 spec §2.2 | §3.1 maps them for every source |
| E2 | Reasoning parts carry `origin` and opaque `signature`; the `bg1.` envelope packs foreign reasoning for Responses clients only | `canonical.types.ts` (`CanonicalReasoningOrigin`, `CanonicalReasoningSignature`), `responses.envelope.ts` | The envelope generalizes to Anthropic `signature` and Gemini `thoughtSignature` fields |
| E3 | Canonical images are base64 only (`jpeg/png/gif/webp`); no document part; tool results carry no images | `canonical.types.ts:103`, `anthropic.messages.ts:127` | Canonical change (§3.2.1) |
| E4 | An OpenAI `image_url` that isn't a `data:` URL becomes the text `[Image: <url>]` | `openai.adapter.ts:296` | URL images are silently lost today |
| E5 | `count_tokens` is answered locally with an estimate | `utils/token-estimate.ts`, `proxy.service.ts` | Reused as the shim's fix for upstreams without it |
| E6 | Same-format pass-through exists only for Responses (`type: responses`) | `services/passthrough.ts`, `passthrough-relay.ts` | §3.3 extends it to Anthropic and OpenAI Chat |
| E7 | Ollama's Anthropic endpoint lacks `tool_choice`, `count_tokens`, prompt caching, URL images and PDFs | docs.ollama.com/api/anthropic-compatibility | First shim preset; each gap verified against provider docs in its task |
| E8 | Workflows: `ci.yml`, `cla.yml`, `live.yml`, `release.yml`; the conductor app has no Workflows permission | `.github/workflows/`, CLAUDE.md | Workflow changes (§3.4, §3.5) are applied by the owner |
| E9 | Conductor usage, 57 sessions (v1.3–v1.4): 5,926 Opus turns; 645M cache-read, 22.0M cache-write, 3.84M output tokens ≈ **$380 API-equivalent, ≈ $10 per task**; output is ≈ $77 of it | `~/.claude/projects/-home-dorrabb-babelgate/*.jsonl` | Re-reading context, not thinking, is the cost (§3.0) |
| E10 | First-turn context median **48.9k** tokens; per-session average median **96k**; one `run-plan` session ran 793 turns in one context | same | Lean context and a fresh session per task |
| E11 | Tool mix: 743 grep calls, 254 diff reads, 226 file reads, 232 CI/Devin wait calls; 324 Devin calls | same | Mechanical checks and waits are most of the turns |
| E12 | All 183 Devin sessions on this repo ran `swe-2-high` (free on the owner's plan) | `~/.local/share/devin/cli/sessions.db` | Moving implementation work onto Opus would raise cost; Devin keeps implementing |
| E13 | Claude Code 2.1.322 (`claude -p`, `ANTHROPIC_BASE_URL` → recorder → OpenRouter `/api/v1/messages`, `anthropic/claude-haiku-4.5`, `MAX_THINKING_TOKENS=1024`): the first request (a tools-less side request) sends `thinking:{type:"disabled"}`; every later request sends `thinking:{type:"enabled",budget_tokens,display:"<string:7>"}` (`display` is an extra, undocumented-in-E-fields field Claude Code sends — a 7-char string) and carries each prior assistant turn's `{type:"thinking",thinking:"" (0 chars),signature:"<string:N>"}` back: signature lengths 804, 660, 544, 536, 736, 564 across six turns, one block per assistant turn, none dropped as messages grow 3→13; per-turn signature length is constant across requests. Shapes-only: proves presence, order and length, **not** byte-identity (response bodies are not recorded); no compaction occurred in this run — "never edits or drops on compaction" is not observed | `tests/fixtures/recordings/claude-code-thinking.jsonl` | §3.1 keeps thinking blocks and `signature` opaque end-to-end; Task 4 tests must not claim byte-identity from this recording; the `display` key must pass through |
| E14 | Claude Code 2.1.322 media run (same setup): no URL image and no `document` block was ever sent — Claude Code read the PDF and PNG with its Read tool and sent them as base64 `image` blocks inside `tool_result` content. The 2-page PDF became two images of 22,980 and 22,916 base64 chars beside `text` blocks (`messages[4].content[1].content[1..2]`); the PNG became one image of 92 chars (`messages[10].content[0].content[0]`). `tool_reference` blocks also appear inside `tool_result` content | `tests/fixtures/recordings/claude-code-media.jsonl` | Images in tool results (§3.2.1, Task 7) matter more for Claude Code than URL images/documents; not a reasoning rewrite — no Task 1 Step 3 STOP; noted for Tasks 6/7 |
| E15 | `@google/generative-ai` 0.24.1 vs the Gemini API: `gemini-2.5-flash` answers 404 (retired); on `gemini-3.8-flash`, `startChat()`'s function-response turn goes out with `role:"function"` → 400 `Role 'function' is not supported` (valid roles are `user`/`model`). Real run on `gemini-3.8-flash` (the script keeps `contents` itself): three `POST /v1beta/models/gemini-3.8-flash:generateContent`, all 200, `generationConfig.thinkingConfig {thinkingBudget, includeThoughts}` on every request. Each model turn comes back as exactly ONE part — `functionCall {name,args,id}` (`id` 25 chars, then 23 on the second call) with a `thoughtSignature` sibling field (200 chars both times) — and the functionResponse goes back in a `role:"user"` turn echoing that `id`. NO `thought:true` text part came back in any turn even with `includeThoughts:true` (the script appends the candidate content unchanged, so this is what the API returned; caveat: one short run on `gemini-3.8-flash`) | `tests/fixtures/recordings/gemini-sdk-thinking.jsonl`; https://ai.google.dev/api/generate-content | `record-gemini-sdk.ts` keeps `contents` itself (model parts appended unchanged — keeps `thoughtSignature` and the call `id`; functionResponse as `role:"user"` echoing `id`) because `chat()` sends `role:"function"` → 400; Task 4 must pass `thoughtSignature` through on functionCall parts — no text `thought` part was observed; default model moved to `gemini-3.8-flash` |
| E16 | Ollama 0.40.11 Anthropic-endpoint probes (conductor's Dockerised Ollama, `PROBE_MODEL=qwen3:0.6b` — the live suite's model; single run 2026-11-16): `tool_choice:{type:"any"}` → 200, `stop_reason=tool_use`, content types `thinking,tool_use`; `POST /v1/messages/count_tokens` → **404** (not served); ephemeral `cache_control` on a system block → 200, usage keys `input_tokens\|cache_read_input_tokens\|output_tokens` (no `cache_creation_input_tokens`); image `source.type:"url"` → **400** `invalid_request_error`; base64 `document` block → 200 — *accepted is not supported*: the 0.6B text model's reply (a `thinking` block, `stop_reason=max_tokens`) cannot show the PDF was used, so the document may be silently dropped; `stream:true` → 200, events `message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop`, `usage` rides the stream. A `thinking` block came back although the probe did not ask for thinking (qwen3 thinks by default on this endpoint); caveat: one run on a 0.6B model — a larger model's tool/thinking output may differ | `scripts/gates/probe-ollama-anthropic.sh` (conductor run, `tmp/ollama-probe.txt`); https://docs.ollama.com/api/anthropic-compatibility | **Note for Task 9** — candidate `ollama-anthropic` preset gaps from this measurement: `count_tokens` (404 → answer locally with E5's estimate) and `url_images` (400 → the gateway must fetch URL images to base64); `tool_choice` (`any` accepted) and `prompt_cache` (`cache_control` accepted) need no gap fix; `documents` needs a decision (accepted but unproven); `stream_usage` is not a gap (usage rides the stream). Doc: https://docs.ollama.com/api/anthropic-compatibility |

### 1.3 Success criteria
1. **Conductor:** on the first three v1.5 product tasks run with the new flow, the median **total
   Claude usage per task** (API-equivalent across all models, every session of the task counted: task,
   review, fix rounds, waits) is **at least 40% below** the v1.4 per-task median, with the target of 50%.
   The report also shows the Opus-only figure, so savings from the model column and from Task 0's
   tooling can be told apart. No judgment rule is weakened (§3.0.1).
2. **Reasoning:** Claude Code on Gemini (thinking on) and Gemini SDK on Claude (thinking on) complete a
   multi-turn tool loop with reasoning carried every turn: no `reasoning_dropped` note for same-provider
   turns.
3. **Media:** a URL image and a PDF reach every target that supports them, from every source that can send
   them; unsupported targets refuse in the source's dialect, never silently.
4. **Shim:** Claude Code completes the edit task through a native Anthropic endpoint in pass-through with
   its preset's gaps fixed (gate B).
5. **Proof:** `docs/compatibility.md` is generated from the tests and CI fails when it is stale; the
   weekly replay ran green on the current Claude Code and Codex releases; the `1.5.0` npm package carries
   provenance, the image is signed and an SBOM is attached.
6. No existing expected value, fixture or contract snapshot changes except the ones pre-approved in D5,
   in the tasks D5 names.

## 2. Scope

### 2.1 In v1.5
- **Task 0: conductor efficiency** (§3.0), merged before Task 1.
- **Reasoning for every source** (§3.1): request config and reasoning out/in for Anthropic, OpenAI Chat,
  Gemini and Ollama sources.
- **Media** (§3.2): URL images, documents (PDF, plain text), images in tool results; canonical change.
- **Native-endpoint shim** (§3.3): same-format pass-through for Anthropic and OpenAI Chat; per-provider
  `gaps` with presets.
- **Compatibility matrix and client-release replay** (§3.4).
- **Supply-chain trust** (§3.5): npm provenance, signed image, SBOM.
- **Embeddings, minimal** (§3.6).
- **Gemini CLI frozen; Antigravity CLI spike** (§3.7).
- **Positioning:** README headline, `docs/roadmap.md` rewritten per the 2026-11-16 revision, launch-post
  draft.
- **Model breakdown report** (§5.1).

### 2.2 Not in v1.5
- Embeddings inbound in Gemini or Ollama format; audio; image generation; stored Responses state.
- Same-format pass-through for Gemini and Ollama sources (rare; revisit on user demand).
- Text extraction from PDFs for targets that can't read documents (refused instead, §3.2).
- The single binary, provider presets and other v1.6 items.

### 2.3 Non-goals
- Sending reasoning from provider X to provider Y. Signatures and envelopes go back only to their origin
  (unchanged from v1.4).
- Client-specific or provider-pair code paths. Shim gaps are a per-provider declaration with one fix per
  gap, applied to whatever client format arrives.
- Fetching URLs from private networks by default (§3.2.2).
- Opus doing Devin's implementation work. Devin keeps implementing; Opus judges (§3.0).

## 3. Design

### 3.0 Task 0 — conductor efficiency (build process, not product)
Owner's choice: **Opus stays the conductor, with less to do.** Devin keeps implementing on free SWE-2.
Nothing here changes what the conductor must judge or escalate; it changes how much context and how
many turns that judgment costs.

#### 3.0.1 One judge script instead of hand checks
`scripts/conductor/judge.sh <PR> <version> <task>` runs every mechanical rule from CLAUDE.md's
"Judgment rules" against `gh pr diff` and prints one compact report (≤ 60 lines; full detail written to
`~/babelgate-conductor/<version>-task<N>/judge-<stamp>.md`). Each check prints `PASS`, `FLAG <reason,
file:line>` or `N/A`:
1. Fixture, contract-snapshot or timeout/retry-default files changed.
2. Removed or weakened assertions: removed `expect` lines; exact matchers turned partial
   (`toEqual`/`toStrictEqual` → `toMatchObject`/`objectContaining`/`toContain`); removed fields from
   expected objects (best effort; a FLAG, never a silent PASS on parse failure).
3. `.skip`, `.only`, `.todo`, `it.skipIf`, `describe.skip` added.
4. Files outside the task's Files block (parsed from the plan) and whether `docs/decisions.md` changed in
   the same PR.
5. One adapter importing another; provider-name or pair-specific branches outside adapters (pattern list).
6. `canonical.types.ts` and `canonical.schema.ts` changed together, named in the task, logged in
   decisions.md.
7. Secrets/privacy: obvious keys, `console.log` of request/response bodies added.
8. `git diff --stat` of the PR vs. the file list the Devin session claimed (from its saved output).
9. Owner-gate triggers: PR title tags, LICENSE/CLA/publishing config/workflow files touched.

Exit code 0 when every check passes, 1 when any FLAG. The conductor reads the FLAGs and decides; a FLAG
is never auto-waived. The script has tests: seeded diffs for each check, one passing and one flagging
case each. Wire-format evidence (checking field names against provider docs) stays the conductor's own
judgment.

#### 3.0.2 Waiting without spending
- `scripts/conductor/wait-ci.sh <PR>` blocks until checks finish and prints only the final table plus,
  on failure, the failing job names and the last 40 lines of each failing log.
- `devin.sh` prints only the session's last 30 lines and the `PR_URL:`/`STOP:` line to stdout; the full
  output stays in its saved `.out.md` (the conductor reads more only when needed).
- The conductor runs a Devin session and the CI wait in the background and waits with **one** blocking
  call each (`t3_background_wait` or the harness's equivalent), never a polling loop.
- When a long CI or Devin log must be read, a **Haiku** subagent reads it and returns a ≤ 15-line summary
  with file:line pointers.

#### 3.0.3 A lean starting context
Conductor sessions in this repo load only what the loop uses. The project's `.claude/settings.json`
(and `settings.local.json` where per-user) turns off MCP servers, claude.ai connectors and plugins the
conductor never calls (Atlassian, Claude Data, Meetings, graphify, unused skills). Target: first-turn
context **≤ 30k tokens** (from 48.9k); the task measures what each removal saves and records which items
the host (T3 Code) injects and cannot be removed.

#### 3.0.4 A fresh session per task, with a model per task
`run-plan` stops being one long conversation. `scripts/conductor/run-plan.sh <version> <from> <to>`
starts one headless Claude Code session per task (`claude -p "/conduct <version> <N>" --model <model>`)
with an **explicit tool allow-list** (D7): `--allowedTools` mirroring `.claude/settings.json`'s allow
list plus the new conductor scripts and the helper subagent, and its deny list kept; no bypass mode. A
tool call outside the list fails, and the session escalates instead of improvising. The model comes
from the plan's Task Index **Conductor** column (§5.1). The script stops at the first escalation, owner
gate or failure. Each session writes its summary to the task's conductor log; the next session reads
only that file, not the previous conversation. `/conduct` keeps working interactively.

#### 3.0.5 Measuring it
`scripts/conductor/usage-report.sh [--since DATE] [--version vX.Y]` reads the Claude Code session logs
and prints per session and per task: turns, input/cache-read/cache-write/output tokens, API-equivalent
cost at current prices (prices in one table in the script), first-turn and average context, and the
tool-call mix. The v1.3–v1.4 baseline (E9–E11) is committed as
`docs/conductor/usage-baseline-2026-11-16.md`. After the first three product tasks, the conductor posts
the comparison on the Task 3 PR status comment.

#### 3.0.6 Docs
CLAUDE.md, `.claude/commands/conduct.md`, `run-plan.md` and `docs/conductor/standing-notes.md` describe
the new flow: run `judge.sh` instead of grep checks, the wait scripts, the Haiku log reader, the model
column. Judgment rules themselves are unchanged.

### 3.1 Reasoning for every source
Extends v1.4 §3.3 (unchanged: origins, signatures to origin only, the continuity guard, the budget
table) from Responses to the other four sources.

**Request config (decoders).** Each source's reasoning request maps to `config.reasoning`:
| Source | Field | Canonical |
|---|---|---|
| Anthropic | `thinking: {type: "enabled", budget_tokens}` / `{type: "adaptive"}` with `output_config.effort` | `effort` from the level or nearest budget bucket; `budgetTokens` kept |
| OpenAI Chat | `reasoning_effort` | `effort` |
| Gemini | `thinkingConfig.thinkingLevel` / `thinkingBudget`, `includeThoughts` | `effort` / `budgetTokens`, `summary` |
| Ollama | `think: true` or a level string | `effort` (`medium` for `true`) |
The existing `thinking_dropped` / `reasoning_dropped` request notes disappear for these fields. A
provider can turn reasoning off with `reasoning: false` in `babelgate.yaml`, which restores the v1.4
behaviour for that provider (dropped with a note).

**Reasoning out to the client (encoders).**
| Source | Emitted as | Signature field |
|---|---|---|
| Anthropic | `thinking` block (or `redacted_thinking`), streamed as `thinking_delta` / `signature_delta` | `signature`: the real one when the origin is an Anthropic-type provider, else the `bg1.` envelope |
| Gemini | part `{text, thought: true}` | `thoughtSignature`: real when origin is Gemini, else the envelope |
| OpenAI Chat | `message.reasoning_content` / `delta.reasoning_content` | none (text only) |
| Ollama | `message.thinking` | none (text only) |

**Reasoning back from the client (decoders).** Anthropic `thinking` blocks and Gemini thought parts with
an envelope unpack to their original canonical parts (as the Responses decoder does today); real
signatures attach to their origin. Chat `reasoning_content` and Ollama `thinking` on assistant turns
decode to reasoning text with no signature; for signature-requiring targets the continuity guard then
applies (thinking off for that request, with a note).

**Evidence first.** Task 1 records Claude Code (thinking on) and the Gemini SDK (thinking on) against a
recording proxy to prove the clients return thinking blocks / thought parts, signatures included,
unchanged on the next turn. If a client rewrites or strips them, that client gets text-only reasoning
out and a note, and the spec's §1.3 criterion 2 is amended by the owner.

The envelope code moves from `responses.envelope.ts` to a shared module; the Responses behaviour and its
1 MB cap are unchanged.

### 3.2 Media

#### 3.2.1 Canonical change (interface change, OWNER REVIEW)
- `CanonicalImage` gains `url?: string` as an alternative to `data` (exactly one of the two).
- New content part `type: "document"` with `document: {data?: string; url?: string; mimeType:
  "application/pdf" | "text/plain"; name?: string}`.
- Tool results (`role: "tool"` messages) use the existing `content: CanonicalContentPart[]` form for
  images, so screenshots returned by tools survive; no new field. Adapters stop assuming tool content
  is a string (conductor's call: one place to read, not two).
Types and schema move together; fields are optional and emitted only when present.

#### 3.2.2 Behaviour
- **Decode:** each source keeps URLs as URLs (OpenAI `image_url`, Anthropic `source.type: "url"`,
  Responses `input_image`/`input_file`, Gemini `fileData.fileUri`) and documents as documents (Anthropic
  `document`, OpenAI `file`, Responses `input_file`, Gemini `inlineData` with a PDF type).
- **Encode:** a target that accepts URLs gets the URL; a target that needs bytes gets them fetched and
  inlined. Fetching: `http`/`https` only; addresses resolving to private, loopback or link-local ranges
  refused unless `media.allow_private: true`; 20 MB and 15 s caps; `media.fetch: false` turns fetching off
  (the request is then refused if the target needs bytes). The URL is logged, the bytes never are.
- **Unsupported:** a target that cannot take a document or a tool-result image gets a 400 in the source's
  dialect naming the field and the target (never a silent drop). Text documents become text parts for
  every target.
- The inspector shows media as type, size and URL, never content.

### 3.3 Native-endpoint shim
**Pass-through (D6: narrow by default).** When the source format equals the routed provider's type
(`anthropic` or `openai`), the request is forwarded without the canonical round trip, keeping trace,
usage, cost and inspector stages (the inspector marks it pass-through) — **automatically only for
providers configured with a shim preset**; any other provider opts in with `passthrough: true`.
Existing configs therefore keep the canonical path (and v1.3's tool-call repair) unchanged, and existing
pair tests need no new setting. `type: responses` keeps its v1.4 behaviour.

**Gaps.** A provider may declare `gaps:` from a fixed vocabulary; each gap has exactly one fix, applied in
the source format's JSON before forwarding (or to the reply):
| Gap | Fix |
|---|---|
| `tool_choice` | Remove it; `required`/named choice adds a `tool_choice_dropped` note |
| `count_tokens` | Answer locally with the estimate (E5), flagged as estimated |
| `prompt_cache` | Strip `cache_control` with a note |
| `url_images` | Fetch and inline (§3.2.2) |
| `documents` | Refuse in the source's dialect (§3.2.2) |
| `stream_usage` | Request it where the format allows; else estimate and flag |
**Presets:** `preset: ollama-anthropic`, `lmstudio-anthropic`, `deepseek-anthropic`, `glm-anthropic`,
`kimi-anthropic` set base URL, type and gaps. Each preset's gap list is verified against that provider's
docs in its task and cites them (wire-format evidence rule). The vocabulary is per gap, never per
provider pair.

### 3.4 Compatibility matrix and client-release replay
- **Matrix.** The pair tests write a JSON report (source × target × feature: plain, stream, tools,
  stream × tools, structured output, reasoning, URL image, document, tool-result image, pass-through).
  `npm run matrix` renders `docs/compatibility.md` (✓, a note code, or ✗ with the reason). CI
  regenerates it and fails when the committed cells differ. The file's header carries the replay job's
  status badge and a link to its latest run summary (which lists the replayed versions), so a new client
  release never makes main's CI red by itself (conductor's call).
  The README links it near the top.
- **Replay.** A weekly scheduled job in `live.yml` installs the latest Claude Code and Codex, runs the
  existing edit-task gate scripts through babelgate on a cheap OpenRouter model (bridge for both), and
  records each release's request shape through the v1.4 recording proxy, diffing it against the committed
  fixtures (new fields, tools or event types are reported). Failure or a shape change opens a GitHub
  issue labelled `client-replay`. The job's last green versions show in that badge and run summary.
- **Workflow files:** the app cannot push workflow changes (E8). The task writes the change as a patch
  under `docs/conductor/patches/`, the owner applies and pushes it.

### 3.5 Supply-chain trust (OWNER GATE: publishing config)
`release.yml` publishes with npm provenance (`--provenance`, `id-token: write`), signs the GHCR image with
keyless cosign, and attaches a CycloneDX SBOM (`npm sbom`) to the GitHub release. `SECURITY.md` explains
how to verify each. The runtime dependency count is reported in the release notes. Delivered as a patch
the owner applies (§3.4).

### 3.6 Embeddings, minimal
`POST /v1/embeddings` (OpenAI format) only. Targets: OpenAI-compatible (pass-through), Gemini
(`batchEmbedContents`), Ollama (`/api/embed`); Anthropic → 501 in OpenAI's dialect. Model-name routing,
aliases and fallbacks apply; usage and cost are recorded. `dimensions` maps where the target supports it
(else a note); `encoding_format: "base64"` is encoded by babelgate.

### 3.7 Gemini CLI frozen; Antigravity CLI spike
The Gemini CLI recipe gets a short note (works with paid API keys and enterprise licences; Google moved
individuals to Antigravity CLI) and leaves the README headline and launch copy; no new live gate. A
time-boxed spike (one day) installs Antigravity CLI, finds whether it accepts a custom endpoint and which
format it speaks, tries it through babelgate and writes `docs/research/<date>-antigravity-spike.md` with a
recommendation. No product code in the spike; adoption is an owner decision.

## 4. Testing and gates
- **Unit:** every new mapping (reasoning per source, media per adapter, gap fixes, URL guard including
  DNS-rebinding and redirect-to-private cases, embeddings), envelope round trips per signature field.
- **Integration (msw):** multi-turn reasoning loops per source from the Task 1 recordings; media from each
  source to each target; pass-through with each preset; every mock event cites a doc or recording.
- **Pair matrix:** 5 × 5 extended with the §3.4 features; it is the matrix's data source.
- **Backwards compatibility:** existing expected values unchanged; `reasoning: false` reproduces v1.4
  output byte-for-byte on the v1.4 reasoning fixtures.
- **Live (opt-in):** reasoning loops on Gemini and Claude; one URL image and one PDF per capable provider;
  each preset whose key or local install is available.
- **Release gates (OWNER REVIEW):** A — Claude Code on Gemini with thinking, edit task, reasoning carried;
  B — Claude Code through **Ollama's** native Anthropic endpoint in pass-through with the
  `ollama-anthropic` preset (D8), on a tool-capable local model; C — the replay job green on the current Claude Code and Codex releases and the matrix
  current; D — at publish, provenance, signature and SBOM verify.

## 5. Task outline (the plan will detail these)
| # | Task | Gate | Conductor |
|---|---|---|---|
| 0a | `judge.sh` with tests; `wait-ci.sh`; `devin.sh` output trimming; `usage-report.sh` + committed baseline | OWNER REVIEW (process change) | Opus |
| 0b | Lean context settings + measurement; `run-plan.sh` per-task sessions with model column; Haiku log reader; CLAUDE.md / commands / standing notes | OWNER REVIEW | Opus |
| 1 | Recordings: Claude Code and Gemini SDK with thinking on; Claude Code with a URL image and a PDF; Ollama's Anthropic endpoint gaps | | Sonnet |
| 2 | Canonical change §3.2.1 (types + schema + contract tests); envelope moved to a shared module | OWNER REVIEW (interface change) | Opus |
| 3 | Reasoning request config for Anthropic, Chat, Gemini, Ollama sources; `reasoning: false` | | Opus |
| 4 | Reasoning out/in for Anthropic and Gemini sources (envelope in signature fields, streaming) | | Opus |
| 5 | Reasoning out/in for Chat and Ollama sources | | Sonnet |
| 6 | Media decode/encode on all adapters; URL fetch with guard; refusals in the source's dialect | | Opus |
| 7 | Tool-result images on all adapters | | Sonnet |
| 8 | Pass-through for Anthropic and OpenAI Chat; `passthrough: false` | | Opus |
| 9 | Gaps vocabulary and fixes; presets with cited docs | | Sonnet |
| 10 | Embeddings (§3.6) | | Sonnet |
| 11 | Pair matrix extension + JSON report + `npm run matrix` + `docs/compatibility.md` + CI staleness check (patch) | | Sonnet |
| 12 | Weekly replay job (patch) + issue creation + recording diff | | Sonnet |
| 13 | Supply chain: provenance, cosign, SBOM, SECURITY.md (patch) | OWNER GATE | Sonnet |
| 14 | Antigravity CLI spike (time-boxed, report only) | | Sonnet |
| 15 | UI: inspector shows media and pass-through/gap notes | | Sonnet |
| 16 | Docs: README headline, roadmap.md, recipes (shim presets, Gemini CLI note), architecture, launch draft | | Sonnet |
| 17 | Live-suite cases; gates A, B, C | OWNER REVIEW | Opus |
| 18 | CHANGELOG, `1.5.0`; gate D at publish | OWNER GATE | Sonnet |

The **Conductor** column is a first proposal; the plan confirms or changes it per task with a reason
(§5.1). Devin implements every task on SWE-2 High (free); a task the plan expects to be too hard for it is
flagged for an owner decision instead of switching Devin to a paid model.

### 5.1 Model breakdown report
The plan's Task Index carries a **Conductor** column (Opus 5.5 or Sonnet 5.5) and a one-line reason per
task. Rule of thumb: **Opus** where the task changes an interface, a wire format or reasoning/signature
handling, or ends at an owner gate where the conductor must judge evidence; **Sonnet** for docs,
recipes, scripts, UI, config vocabulary and release chores; **Haiku** only as the log-reading helper
(§3.0.2), never as conductor. With the plan, `docs/conductor/model-report-v1.5.md` lists the breakdown,
the expected saving per task against the baseline, and after the release the measured usage per task
from `usage-report.sh`, so the next version's column can be set from data.

## 6. Owner decisions
| # | Decision | Chosen |
|---|---|---|
| D1 | Positioning | "The translator you can check" (roadmap revision §2.1) |
| D2 | Conductor | Opus stays the conductor with less to do (A), not a Sonnet- or script-run loop |
| D3 | Roadmap changes | All of roadmap revision §2.2, including the Gemini CLI freeze and the v1.6 reorder |
| D4 | Task 0 placement | Before any product task; spec and plan written now |
| D5 | Pre-approved test changes | Exactly: `anthropic.adapter.test.ts` "thinking request field records thinking_dropped" (≈ line 1484) and "thinking content block records thinking_dropped with its path" (≈ 1633) in Tasks 3–4; any test asserting that a non-Responses source's reasoning request field (`reasoning_effort`, `thinkingConfig`, `think`) is dropped, in the openai/gemini/ollama adapter tests, in Task 3; "image block in tool_result throws ValidationError naming the type" (`anthropic.adapter.test.ts` ≈ 634) in Task 7; any test pinning the `[Image: <url>]` placeholder in Task 6. Each change must assert the new behaviour at least as exactly; observe tests that use `thinking_dropped` only as sample data stay unchanged. Anything else escalates as usual |
| D6 | Defaults for existing configs | Reasoning mapping on (follows what the client asks for; `reasoning: false` per provider opts out). Same-format pass-through automatic only with a shim preset, else `passthrough: true` |
| D7 | Headless conductor permissions | Explicit `--allowedTools` mirroring settings.json (deny list kept); no bypass mode |
| D8 | Gate B endpoint | Ollama's Anthropic endpoint (`ollama-anthropic` preset); Task 1 records and verifies its gaps first |

**Owner actions:** review Task 0 and the canonical change; apply the workflow patches (Tasks 11–13); run
a local Ollama with a tool-capable model for gate B; keep `OPENROUTER_API_KEY`, `GEMINI_API_KEY` and an Anthropic route funded; install
Claude Code, Codex and Antigravity CLI where tasks need them; run the gates; tag `v1.5.0` and publish.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Task 0 saves less than 40% | Measured after three tasks; the roadmap revision keeps the Sonnet-run and script-run loops as the next step |
| `judge.sh` misses a case the hand checks caught | Seeded-diff tests per rule; FLAG on parse failure; the conductor still reads the diff stat and any FLAG in full |
| A client rewrites thinking blocks, breaking the envelope | Task 1 recording first; fall back to text-only reasoning with a note for that client |
| Mapping Claude Code's thinking to Gemini raises users' cost | On by default by owner decision (D6); `reasoning: false` per provider; CHANGELOG and recipes state the change |
| Headless sessions hit a tool outside the allow-list mid-task | Fails closed and escalates (D7); the first runs of `run-plan.sh` are watched and the list adjusted by PR |
| URL fetching becomes an SSRF vector | https/http only, private ranges refused after DNS resolution and on every redirect, size/time caps, `media.fetch: false` |
| Pass-through hides translation bugs | Pair tests keep the canonical path; the matrix marks pass-through cells separately |
| Preset gap lists go stale as providers ship features | Each preset cites its docs with a date; the replay and competitor-check scripts surface changes |
| Workflow patches wait on the owner | Tasks 11–13 can merge their code and patch while the owner applies the workflow separately; gate C waits for it |
