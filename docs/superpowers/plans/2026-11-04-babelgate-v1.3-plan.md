# babelgate v1.3 ("See what's happening") Implementation Plan

> **For agentic workers (Devin):** Run each task in its own session with `/babelgate-task v1.3 <N>`. One task → one branch (`v1.3/task-<N>-<short-name>`) → one PR. Steps use checkbox (`- [ ]`) syntax. Read `AGENTS.md`, this plan's Global Constraints and Review Focus, and the spec sections each task names. Use `./scripts/check.sh quick` while iterating and `./scripts/check.sh` before pushing. Verify every write with `git diff`.

**Goal:** Every chat request produces one trace (route, hops, usage, cached tokens, cost, client, translation notes, tool-call diagnostics, optional body snapshots) that reaches the log, a SQLite usage store, an in-memory body ring, Prometheus and OpenTelemetry, and a built-in `/ui` shows it; agent CLIs gain an output-token cap, prompt caching that survives translation, and Gemini CLI as a tested entry point.

**Architecture:** An `observe` layer beside the unchanged v1.2 routing pipeline: middleware opens an `AsyncLocalStorage` scope holding a `RequestTrace`; the services record snapshots, notes and timings into it at points they already pass through and call `finishTrace` where they call `logRoute` today; `emitTrace` fans the finished trace out to isolated sinks. Prompt caching is an interface change to the canonical format (cache hints on parts and tools, a part-array system prompt, cached-token usage). The UI is a Preact + Vite SPA in `ui/`, served from `dist/ui`, over a JSON API under `/ui/api`.

**Tech Stack:** As v1.2 (TypeScript 5 strict, Express 5, Zod 4, pino, `yaml`, vitest 3, msw 2, supertest). Node **≥ 22.13** (`node:sqlite`). Added: `prom-client` (Task 10); `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources` (Task 11); dev: `preact`, `vite`, `@preact/preset-vite`, `happy-dom`, `@playwright/test` (Task 13). Latest stable of each, versions recorded in the task's decisions entry.

**Spec:** `docs/superpowers/specs/2026-11-04-babelgate-v1.3-design.md`. Parents: `2026-10-26-babelgate-roadmap-design.md`, `2026-11-04-babelgate-roadmap-revision-design.md`; previous: `2026-10-29-babelgate-v1.2-design.md`.

**Decided with the owner (2026-11-04), spec §6:** D1 full scope, size L; D2 solo developer on localhost; D3 in-memory body ring, disk only with `LOG_BODIES`; D4 `node:sqlite`, `engines >=22.13`; D5 tool calls diagnosed always, repaired opt-in; D6 Preact + Vite; D7 trace + internal sinks; D8 bundled LiteLLM prices + overrides + live prices; D9 cache hints and usage, no Gemini explicit cache; D10 gates A, A-cache, B, C.

**Prerequisite (owner):** merge the spec and this plan before Task 1.

## Global Constraints

- **No existing expected value changes** and no edits to existing fixtures or contract snapshots (`scripts/ci/fixture-guard.sh`). New usage fields are emitted only when present and non-zero (spec §3.2), so none should be needed; if one is, STOP and escalate.
- **No existing default changes.** `UPSTREAM_TIMEOUT_MS` 30 000, `UPSTREAM_RETRIES` 1, `UPSTREAM_STREAM_IDLE_MS` 300 000, model-list cache 60 000 ms. New behaviour that changes client-visible output (cap, `cache_hints`, `repair_tool_calls`) is opt-in and defaults off.
- **New defaults, verbatim (spec §3.11):** `USAGE_STORE` `on`; `USAGE_DB` `~/.babelgate/usage.db` (`/data/usage.db` in Docker); `USAGE_RETENTION_DAYS` `30`; `INSPECTOR_BUFFER` `50`; `LOG_BODIES` `false`; `METRICS` `on`; `UI` `on`; `UI_ALLOW_REMOTE` `false`; `UI_ALLOWED_HOSTS` empty. Store flush: every 250 ms or at 100 rows. Snapshot cap 1 MB, stream bytes 256 KB. User-Agent cut to 200 chars. Metric label cap 100 values → `other`.
- **Adapters stay independent.** No adapter imports `observe/`, routing or config, except `recordNote` from `src/observe/context.ts` (Task 6). No provider-pair branches. Per-provider behaviour comes only from config flags (`cache_hints`, `live_prices`, `repair_tool_calls`, `local`, `max_output_tokens`); never from a base-URL hostname.
- **Canonical changes happen in Task 3 only**, `canonical.types.ts` and `canonical.schema.ts` together, logged in `docs/decisions.md`.
- **Traces:** one per chat request that reaches `planRoute` (the requests the v1.2 route log line covers); emitted exactly once, also on failure and client abort. Pre-route rejections (auth, validation, 404) are not traced.
- **Privacy:** prompt text, completion text, tool arguments, headers and keys never reach the log, `/metrics`, OTel, `/ui/api/live`, `/ui/api/routing` or the `requests` table. Bodies reach only the ring and, with `LOG_BODIES=true`, the `bodies` table. `emitTrace` strips `bodies` before every other sink.
- **A sink never affects a response**: exceptions are caught in `emitTrace`; no sink awaits I/O on the request path.
- **No network in `npm test`.** Real upstreams only in `tests/live/` and `scripts/gates/`. No runtime fetch of LiteLLM data.
- **Owner-only:** `package.json`/`package-lock.json` changes are made only in the tasks that name them (1, 8, 10, 11, 13) and flagged in the PR; new dependencies; fixture/snapshot changes; `.github/workflows/*` (the app cannot push them — if CI needs a workflow change, the PR says exactly what, and the owner applies it); gate runs; tagging; publishing; merging.

## Review Focus

1. **Client disconnects mid-stream** (Claude Code's Esc, a closed browser tab in the playground). Expected: exactly one trace, `status: "aborted"`, partial usage if any arrived, totals computed, no second emit when the pipeline's `finally` also fires. → Task 5 (`aborted stream emits one trace`).
2. **The usage DB can't be used:** directory not writable, a file that isn't SQLite, the DB locked by a second babelgate on the same file. Expected: babelgate starts and serves; the store sink logs one warning naming the path and the fix, disables itself, and `babelgate_sink_errors_total{sink="usage-store"}` counts; a locked DB waits up to the `timeout` option (200 ms — `DatabaseSync` is synchronous, so a longer wait blocks the event loop) per flush, then drops that batch with a warning. → Task 7 (`unusable db never breaks serving`).
3. **Very large bodies:** a request carrying a 10 MB base64 image, or a 2 MB streamed response. Expected: each snapshot ≤ 1 MB (stream bytes ≤ 256 KB) with `truncated: true`; the ring never holds more than `INSPECTOR_BUFFER × (4 + hops) × 1 MB`; the request itself is unaffected. → Task 6 (`large bodies are truncated in the ring`).
4. **Price lookup with routed names:** an alias (`fast`), explicit syntax (`openrouter/qwen/qwen3-coder`), a fallback hop winning, a model id with `:` (`qwen3-coder:30b`). Expected: cost is looked up for the **winning hop's** `(provider, model)`, never the alias or the requested string; a fallback winner is priced as itself. → Task 8 (`prices the winning hop`).
5. **Parallel tool calls whose argument deltas interleave** (canonical stream rule 5), and a stream that ends mid-tool-call, with repair on. Expected: held arguments are released per call index, in each call's own order; on early end the held arguments are released unrepaired with a diagnostic before the `error`/`message_end` event — never lost. → Task 9 (`interleaved and truncated calls with repair on`).

Each line is pinned by a named test in the owning task.

---

## File Map

```
src/transformers/system-text.ts         NEW: systemText (T3)
src/types/canonical.types.ts, canonical.schema.ts   cache hints, system parts, cached usage (T3)
src/transformers/adapters/*             cache decode/encode (T3, T4); recordNote instead of drop debug lines (T6)
src/services/attempt-targets.ts         canonicalForTarget applies max_output_tokens (T2)
src/routing/registry.ts                 ProviderEntry gains maxOutputTokens, cacheHints, livePrices, repairToolCalls, local (T2, T4, T8, T9)
src/config/gateway.schema.ts, yaml-config.ts, env-config.ts   new provider keys (T2, T4, T8, T9), observe:, prices: (T7, T8)
src/observe/trace.ts, client-id.ts, emit.ts, context.ts        NEW (T5, T6)
src/observe/middleware.ts               NEW: observeMiddleware (T5)
src/observe/sinks/log.ts                NEW: replaces routing/route-log logRoute (T5)
src/observe/sinks/body-ring.ts          NEW (T6)
src/observe/sinks/usage-store.ts, src/observe/retention.ts, src/observe/sqlite.ts   NEW (T7)
src/observe/tool-diagnostics.ts, src/observe/tool-repair-stream.ts   NEW (T9)
src/observe/sinks/metrics.ts            NEW (T10)
src/observe/sinks/otel.ts               NEW (T11)
src/cost/prices.json, price-table.ts, compute.ts, live-prices.ts      NEW (T8)
scripts/update-prices.ts                NEW (T8)
src/ui-api/router.ts, access.ts, requests.ts, live.ts, usage.ts, routing.ts, playground.ts   NEW (T12, T15)
ui/                                     NEW: Preact + Vite SPA (T13–T15)
src/app.ts                              observeMiddleware (T5); /metrics (T10); /ui, /ui/api (T12, T13)
src/services/chat.service.ts, chat-stream.service.ts, proxy.service.ts   snapshots, finishTrace, countTokens (T1, T5, T6, T9)
src/transformers/adapters/index.ts      gemini count_tokens route (T1)
scripts/gates/record-shapes.ts          NEW: shape-recording reverse proxy (T1)
scripts/gates/gemini-cli-edit.sh        NEW (T17); claude-code-edit.sh observe checks (T17)
scripts/ci/ui-smoke.sh, ui/e2e/smoke.spec.ts   NEW (T13)
Dockerfile                              VOLUME /data, USAGE_DB, ui build (T7, T13)
docs/recipes/gemini-cli.md, observability.md   NEW (T16, T1 draft)
tests/integration/observe.test.ts       NEW (T5–T12)
tests/integration/privacy-canary.test.ts   NEW (T16)
tests/integration/stream-pairs.test.ts, pairs.test.ts   cached-usage cases added (T4)
tests/contracts/encoder-stability.test.ts   NEW (T4)
tests/live/observe.live.test.ts         NEW (T17)
```

## Task Index

| # | Task | Depends on | Gate |
|---|---|---|---|
| 1 | Node ≥ 22.13; Gemini CLI shape recording; `:countTokens` and proven gaps | — | `package.json` (engines) |
| 2 | Per-provider output-token cap | — | |
| 3 | Canonical cache hints, system parts, cached usage; decoders/encoders | — | OWNER REVIEW (interface change) |
| 4 | Cache-hint encoding flags; encoder-stability property test; pair matrix with cached usage | 3 | |
| 5 | `RequestTrace`, client id, middleware, `emitTrace`, log sink | 2, 3 | |
| 6 | Translation notes, body snapshots, body ring | 5 | |
| 7 | Usage store, migrations, retention, `observe:` config, Docker volume | 5 | |
| 8 | Prices: table, update script, NOTICE; cost, live prices, would-have-cost | 5 | OWNER GATE (bundled data; `package.json` script) |
| 9 | Tool-call diagnostics and opt-in repair | 5 | |
| 10 | `/metrics` | 8, 9 | OWNER GATE (`prom-client`) |
| 11 | OpenTelemetry traces | 5 | OWNER GATE (OTel dependencies) |
| 12 | `/ui/api` + access control | 6, 7, 8 | |
| 13 | UI scaffold, build, smoke test; Requests + Inspector | 12 | OWNER GATE (dev dependencies, scripts) |
| 14 | UI Usage + Routing screens | 13 | |
| 15 | Playground (API + screen) | 13 | |
| 16 | Privacy canary across every sink; recipes, examples, README, architecture doc | 1, 4, 10, 11, 14, 15 | |
| 17 | Live-suite cases; release gates A, A-cache, B, C | 16 | OWNER REVIEW |
| 18 | CHANGELOG, roadmap, `1.3.0` | 17 | OWNER GATE |

Tasks 1, 2 and 3 run in parallel; 6–9 and 11 in parallel after 5; 14 and 15 in parallel after 13; 16 waits for 10 and 11 as well (privacy canary).

---

### Task 1: Node ≥ 22.13; Gemini CLI shape recording; `:countTokens` and proven gaps

Spec §3.10, E4, E7, E9, §3.4 (Node). **Evidence first:** no product code until Step 2 is recorded.

**Files:**
- Create: `scripts/gates/record-shapes.ts`, `scripts/gates/record-gemini-cli.sh`
- Modify: `package.json` (`engines.node` → `">=22.13"` only), `src/transformers/adapters/index.ts` (gemini `count_tokens` route), `src/services/proxy.service.ts` (gemini count reply), `docs/decisions.md`, spec §1.2 (append rows E10+ with the findings)
- Test: `src/routing/detect-source.test.ts`, `tests/integration/claude-code.test.ts` (new cases only; file name kept), `tests/integration/gemini-cli.test.ts` (new)

**Interfaces:**
- Produces: `record-shapes.ts <listenPort> <forwardBaseUrl> <outJsonl>` — a reverse proxy that forwards every request unchanged and appends one JSON line per request: `{method, path, queryKeys: string[], headerNames: string[], bodyShape, status, contentType}`. `bodyShape` replaces every string with `"<string:len>"`, numbers with `"<number>"`, booleans with `"<bool>"`, and keeps keys and array lengths. No values, no header values.
- Produces: `PROVIDER_ROUTES.gemini` entry `{kind: "count_tokens", method: "POST", pathPrefix: "/v1beta/models", ...}` matched when `geminiPathParts(path)?.method === "countTokens"`; reply `{totalTokens: <estimate>}` with header `x-babelgate-token-estimate: true`, no upstream call.

- [ ] **Step 1: Write the recording scripts.** `record-gemini-cli.sh` starts babelgate (target from args, as `claude-code-edit.sh`: `ollama [model]` or `openrouter [model]`), starts `record-shapes.ts` in front of it, runs `GEMINI_API_KEY=dummy GOOGLE_GEMINI_BASE_URL=http://localhost:<recorderPort> gemini -p "<the edit-task prompt>" --yolo` in a temp copy of `scripts/gates/fixtures/edit-task`, and prints the JSONL path plus `gemini --version`. The dummy key works because babelgate only checks `PROXY_API_KEY`.
- [ ] **Step 2: Record.** Run it against Ollama or OpenRouter (whichever is available; if neither, or Gemini CLI can't be installed, STOP: `Owner decision needed: run scripts/gates/record-gemini-cli.sh and attach the JSONL`). Record in `docs/decisions.md`: Gemini CLI version; every distinct `method path` with count; for chat bodies, the top-level keys of `generationConfig`, `tools[].functionDeclarations[]` (does it use `parameters` or `parametersJsonSchema`?), any `thinkingConfig`, `thoughtSignature` in history parts; the User-Agent pattern (from `headerNames` + one manual look at the value, recorded as a pattern, e.g. `GeminiCLI/<v>`); whether the run completed. Append these to spec §1.2 as E10+.
- [ ] **Step 3: Scope check.** Only `countTokens` is pre-approved. Each other gap found becomes a Step 4 sub-item **only if** it fits in an adapter's existing decode/encode (e.g. accepting `parametersJsonSchema` as an alias of `parameters`) and touches no canonical type; anything else → STOP with an owner decision (options: fix in this task, separate task, document as a limitation).
- [ ] **Step 4: Tests.** `detect-source.test.ts`: `"gemini countTokens path is gemini"` → `gemini`. `gemini-cli.test.ts`: `"countTokens answered locally"` — `POST /v1beta/models/gemini-2.5-pro:countTokens` with a `contents` body → 200, `{totalTokens: n}` with `n > 0`, header `x-babelgate-token-estimate: true`, no upstream call; `"unsupported gemini method is a gemini 501"` — `:embedContent` (unless the recording shows Gemini CLI needs it for the edit task) → 501 with a Gemini-format error body; one test per gap approved in Step 3, built from the recorded shape.
- [ ] **Step 5: Run** → FAIL. **Step 6: Implement.** `engines.node` `">=22.13"`. Gemini `count_tokens` route and reply per Interfaces; the unsupported-method check now returns 501 (`not_implemented`, Gemini dialect) instead of today's response for methods other than `generateContent`, `streamGenerateContent`, `countTokens` — if today's response for such a path is asserted by an existing test, STOP (named expected-value change).
- [ ] **Step 7: Verify.** `./scripts/check.sh` → PASS. Re-run `record-gemini-cli.sh`; the PR shows the edit task completing (or the exact remaining failure). Decisions entry "v1.3 Task 1". **Commit** `feat: gemini countTokens and node 22.13 floor`.

### Task 2: Per-provider output-token cap

Spec §3.3.

**Files:**
- Modify: `src/routing/registry.ts`, `src/config/gateway.schema.ts`, `src/config/yaml-config.ts`, `src/config/env-config.ts`, `src/services/attempt-targets.ts`, `docs/decisions.md`
- Test: `src/services/attempt-targets.test.ts`, `src/config/yaml-config.test.ts`, `src/config/env-config.test.ts` (new cases only)

**Interfaces:**
- Produces: `ProviderEntry.maxOutputTokens?: number`; YAML provider key `max_output_tokens` (positive int); env `TARGET_MAX_OUTPUT_TOKENS` (env-only provider). `canonicalForTarget(canonical, entry, target): CanonicalRequest` unchanged in signature; with `entry.maxOutputTokens` set, the copy's `config.maxTokens = min(requested, cap)`, or `cap` when unset. Produces `maxTokensClampOf(canonical, entry): {from?: number; to: number} | undefined` (undefined when no cap or `requested ≤ cap`) for Task 5.

- [ ] **Step 1: Tests.** `"cap clamps a larger request"` — requested 32 000, cap 8 000 → `maxTokens` 8 000, clamp `{from: 32000, to: 8000}`; `"cap fills an unset maxTokens"` → 8 000, clamp `{to: 8000}`; `"smaller request untouched"` — 4 000 → 4 000, clamp undefined; `"no cap, no change"` — output deep-equals today's; `"decoded canonical never mutated"`. Config: `max_output_tokens: 0` and `"8k"` → startup error naming the key; `TARGET_MAX_OUTPUT_TOKENS=8000` → entry has `maxOutputTokens: 8000`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. PR shows Claude Code's request through `npm run dev` with a cap and the upstream body's `max_tokens`. **Commit** `feat: per-provider max_output_tokens`.

### Task 3: Canonical cache hints, system parts, cached usage · OWNER REVIEW

Spec §3.2, E2, E3, D9. **Interface change.** Field names checked against provider documentation; record URL and date per field in the decisions entry.

**Files:**
- Create: `src/transformers/system-text.ts`
- Modify: `src/types/canonical.types.ts`, `src/types/canonical.schema.ts`, all four `*.adapter.ts` plus `anthropic.messages.ts`, `anthropic.stream.ts`, `openai.stream.ts`, `gemini.stream.ts`, `ollama.stream.ts` (usage only), `src/utils/stream-reassemble.ts` (carry the new usage fields), `src/types/anthropic.types.ts`, `src/types/openai.types.ts`, `src/types/gemini.types.ts`, `docs/decisions.md`
- Test: each `*.adapter.test.ts` (new cases), `tests/contracts/canonical.schema.test.ts` (new cases), `tests/contracts/stream-decoders.test.ts` (new cases)

**Interfaces:**
- Produces exactly the types in spec §3.2: `CanonicalCacheHint { ttl?: "5m" | "1h" }`; `cache?` on `CanonicalContentPart` and `CanonicalTool`; `CanonicalRequest.systemPrompt?: string | CanonicalContentPart[]` (parts text-only, schema-enforced); `CanonicalUsage.cacheReadTokens?`, `cacheWriteTokens?`; `inputTokens` = all input, cached included.
- Produces: `systemText(system: string | CanonicalContentPart[] | undefined): string | undefined` — parts' `text` joined with `"\n"` (the same separator the Anthropic decoder uses for system arrays today; confirm and keep).
- Decoders produce `systemPrompt` as parts **only** when a system block carries `cache_control`; otherwise the string they produce today.

- [ ] **Step 1: Tests (per adapter, new cases only).**
  - Anthropic: `"cache_control decoded onto parts, tools and system"` (`ttl: "1h"` kept, absent ttl → `{}`); `"usage sums cached input"` — `{input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 5}` → `{inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 90, outputTokens: 5, totalTokens: 1005}`; `"usage encode splits back"` → the same four wire fields; `"split never negative"` — canonical `{inputTokens: 5, cacheReadTokens: 9}` → `input_tokens: 0`; stream: `"message_start cache usage"` carried to the canonical `usage` event; `"cache_control encoded on blocks, tools, system"`; `"no hints → request bytes identical to today"`.
  - OpenAI: `"cached_tokens decoded"` (`prompt_tokens_details.cached_tokens: 512`, `cache_write_tokens: 64`); `"deepseek hit tokens decoded"` (`prompt_cache_hit_tokens: 300` with no `prompt_tokens_details`) → `cacheReadTokens: 300`; `"cached usage encoded only when non-zero"`.
  - Gemini: `"cachedContentTokenCount decoded and encoded"`; Ollama: `"no cache fields ever emitted"`.
  - Schema: `"image part with cache is valid"`, `"system parts must be text"` (an image system part → invalid).
  - `"existing fixtures unchanged"`: `./scripts/check.sh` with the fixture guard and `tests/contracts/fixtures.test.ts` untouched is the assertion.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Encoders call `systemText(req.systemPrompt)` wherever they read `systemPrompt` today, except the Anthropic encoder, which emits a system block array (with `cache_control`) when it gets parts and the string when it gets a string. Hints on requests to OpenAI, Gemini and Ollama targets are dropped in this task (Task 4 adds `cache_hints`). The Anthropic adapter's `cache_control` drop line goes; the debug line stays only where a hint is dropped (beyond 4, Task 4).
- [ ] **Step 4: Verify.** `./scripts/check.sh` → PASS with zero fixture/snapshot changes (`git diff --stat origin/main -- tests/fixtures tests/contracts/__snapshots__` empty). Decisions entry "v1.3 Task 3" lists the type diff, each wire field with its doc URL, and the `cachedContentTokenCount` confirmation (live response or doc). **Commit** `feat(canonical): cache hints and cached-token usage`.

### Task 4: Cache-hint encoding flags; encoder stability; pair matrix with cached usage

Spec §3.2 (table, byte-stable prefixes), §4.1, §4.2.

**Files:**
- Create: `tests/contracts/encoder-stability.test.ts`
- Modify: `src/routing/registry.ts`, `src/config/gateway.schema.ts`, `src/config/yaml-config.ts`, `src/services/attempt-targets.ts`, `src/transformers/adapters/anthropic.adapter.ts`, `src/transformers/adapters/openai.adapter.ts`, `tests/integration/pairs.test.ts`, `tests/integration/stream-pairs.test.ts` (new cases only), `tests/mocks/upstreams.ts` (cached-usage replies, opt-in per test), `docs/decisions.md`
- Test: as above, plus `openai.adapter.test.ts`, `anthropic.adapter.test.ts`

**Interfaces:**
- Consumes: Task 3 types.
- Produces: `ProviderEntry.cacheHints?: boolean` (YAML `cache_hints`). Adapters stay config-free: `canonicalForTarget` **removes** every `cache` hint from the copy unless the target is `anthropic` or `entry.cacheHints === true`. The OpenAI encoder emits `cache_control: {type: "ephemeral", ttl?}` on a content part, on the system message (as a one-part content array) and on tools when the canonical carries a hint. The Anthropic encoder keeps at most 4 breakpoints — the **last** 4 in order tools → system → messages — and calls the Task 6 note hook later (for now `logger.debug`) for the rest.

- [ ] **Step 1: Tests.**
  - `attempt-targets.test.ts`: `"hints stripped for openai without cache_hints"`, `"hints kept with cache_hints"`, `"hints always kept for anthropic"`.
  - `anthropic.adapter.test.ts`: `"more than 4 breakpoints keeps the last 4"` — 6 hinted blocks → hints on the last 4 only.
  - `encoder-stability.test.ts` (property, fast-check style seeded generator already used in `stream-properties.test.ts`; reuse its generator helpers): for each of the 4 encoders, `"deterministic"` — `JSON.stringify(encode(r)) === JSON.stringify(encode(structuredClone(r)))`; `"earlier messages stable when a turn is appended"` — `encode(r).messages[0..n-1]` (Gemini: `contents`) deep-equals `encode(r + one message).messages[0..n-1]`, including tool-call/tool-result pairs.
  - `pairs.test.ts` / `stream-pairs.test.ts`: `"cached usage survives every pair"` — for all 16 source × target pairs, the mock returns cached usage in its own dialect (Ollama: none) and the client receives it in its own dialect with the same read/write numbers (Ollama-source: inputTokens only); the existing cases are unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** If the stability test finds non-determinism in an encoder (e.g. generated ids), fix it in that encoder and list it in the decisions entry; if the fix would change an existing expected value, STOP.
- [ ] **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: cache hints to anthropic and cache_hints providers`.

### Task 5: `RequestTrace`, client id, middleware, `emitTrace`, log sink

Spec §3.1, §3.1.1, §3.4 (client identity). Behaviour-neutral for clients; the log line gains fields.

**Files:**
- Create: `src/observe/trace.ts`, `src/observe/client-id.ts`, `src/observe/context.ts`, `src/observe/middleware.ts`, `src/observe/emit.ts`, `src/observe/sinks/log.ts`, `tests/integration/observe.test.ts`
- Modify: `src/app.ts`, `src/services/chat.service.ts`, `src/services/chat-stream.service.ts`, `src/routing/route-log.ts` (keeps `Hop`, `RouteLogRecord`; `logRoute` removed), `docs/decisions.md`
- Test: `src/observe/*.test.ts`, `tests/integration/observe.test.ts`

**Interfaces:**
- Produces (`trace.ts`): `RequestTrace` exactly as spec §3.1 (with `notes`, `diagnostics`, `repairs` as empty arrays until Tasks 6/9; `bodies` optional); `type ClientId = "claude-code" | "codex" | "gemini-cli" | "openai-sdk" | "anthropic-sdk" | "google-genai" | "ollama-sdk" | "playground" | "other" | string` (header override); `newTrace(init: {requestId: string; startedAt: number; client: ClientId; userAgent?: string; sourceApi: Provider}): RequestTrace`.
- Produces (`client-id.ts`): `clientId(headers: IncomingHttpHeaders): {client: ClientId; userAgent?: string}` per spec §3.4 (patterns from Task 1's record for Gemini CLI; Claude Code `claude-cli/`).
- Produces (`context.ts`): `runWithTrace<T>(trace: RequestTrace, fn: () => T): T`; `currentTrace(): RequestTrace | undefined`. Task 6 adds `recordNote`, `snapshot`.
- Produces (`middleware.ts`): `observeMiddleware(): RequestHandler` — after `detectSource`, for requests with a source: builds the trace and calls `next()` inside `runWithTrace`.
- Produces (`emit.ts`): `interface TraceSink { name: string; accept(trace: RequestTrace): void }`; `registerSink(sink)`, `resetSinks()` (tests); `finishTrace(update: TraceFinish): Promise<void>` where `TraceFinish = Pick<RequestTrace, "reason" | "requestedModel" | "hops" | "winner" | "stream" | "status" | "httpStatus"> & Partial<Pick<RequestTrace, "errorType" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "finishReason" | "maxTokensClamp" | "ttfbMs">>` — merges into `currentTrace()`, sets `totalMs`, (Task 8 adds cost), then `emitTrace`; a second call for the same trace is a no-op. `emitTrace(trace)`: strips `bodies` for every sink except `body-ring` and `usage-store`; each `accept` in try/catch; failure → one `warn` per sink per 60 s.
- Produces (`sinks/log.ts`): the `"Request completed"` info line with every `RouteLogRecord` field plus `client`, `status`, `httpStatus`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd`, `ttfbMs`, `totalMs`, `diagnostics` (codes only).
- Services: replace each `logRoute(...)` with `await finishTrace(...)` (streams: when the stream ends, errors or is aborted; `status: "aborted"` when `opts.signal?.aborted`); set `ttfbMs` when the first chunk is yielded to the client (JSON replies: when the body is ready).

- [ ] **Step 1: Tests.** `client-id.test.ts`: a table of real UAs — `claude-cli/2.1.3 (external, cli)` → `claude-code`; the Task 1 Gemini CLI pattern → `gemini-cli`; `OpenAI/JS 7.30.1` → `openai-sdk`; `Anthropic/JS 0.132.1` → `anthropic-sdk`; `google-genai-sdk/…` → `google-genai`; `ollama-js/0.6.4` → `ollama-sdk`; `curl/8` → `other`; header `x-babelgate-client: my-bot` → `my-bot`; `x-babelgate-client: "Bad Name!"` → falls through to UA; a 500-char UA kept at 200. `emit.test.ts`: `"throwing sink does not stop others"`, `"bodies reach only ring and store"`, `"warns once per minute per sink"` (injected clock). `observe.test.ts`: `"one trace per chat request, json and stream"`; `"failed request still traced"` (400 from upstream → `status: "error"`, `httpStatus: 400`); `"fallback hops on the trace"`; `"aborted stream emits one trace"` (Review Focus 1: abort after the first chunk → exactly one `accept`, `status: "aborted"`); `"count_tokens and model list are not traced"`; `"log line has no prompt text"` (sentinel, as v1.2).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; existing route-log tests now target `sinks/log.ts` with the same assertions (moving a test file is allowed; assertions unchanged — show `git diff -M` of the move). **Commit** `feat: request trace and sinks`.

### Task 6: Translation notes, body snapshots, body ring

Spec §3.5, D3.

**Files:**
- Create: `src/observe/sinks/body-ring.ts`
- Modify: `src/observe/context.ts`, `src/observe/trace.ts` (`BodySnapshots`, `TranslationNote`), the 8 `logger.debug` drop sites in `src/transformers/adapters/` (E6) plus the Task 4 breakpoint-limit line, `src/services/proxy.service.ts`, `chat.service.ts`, `chat-stream.service.ts`, `src/services/stream-pipeline.ts` (tap the upstream bytes; no behaviour change), `src/config/env-config.ts` (`INSPECTOR_BUFFER`), `docs/decisions.md`
- Test: `src/observe/context.test.ts`, `src/observe/sinks/body-ring.test.ts`, `tests/integration/observe.test.ts`

**Interfaces:**
- Produces (`trace.ts`): `TranslationNote` exactly as spec §3.5; codes: `thinking_dropped`, `metadata_dropped`, `cache_control_dropped`, `cache_limit`, `stream_block_dropped`, plus one per remaining drop site (named in the decisions entry). `interface BodySnapshot { value: unknown; truncated?: true }`; `interface BodySnapshots { source?: BodySnapshot; canonical?: BodySnapshot; target: BodySnapshot[]; response?: { canonical?: BodySnapshot; wire?: BodySnapshot } }`.
- Produces (`context.ts`): `recordNote(note: Omit<TranslationNote, "adapter"> & {adapter: Provider}): void` (also writes today's debug line; outside a scope only logs); `snapshot(stage: "source" | "canonical" | "target" | "response.canonical" | "response.wire", value: unknown): void` — no-op unless the ring is enabled; values over 1 MB serialized (`response.wire` for streams: 256 KB of text) are replaced by the first N bytes as a string with `truncated: true`.
- Produces (`body-ring.ts`): `createBodyRing(size: number): TraceSink & { get(id: string): BodySnapshots | undefined }`; `getBodyRing()` singleton for Task 12.

- [ ] **Step 1: Tests.** `"notes recorded in scope and logged outside"`; `"each drop site records its code"` (one adapter test per site, asserting the note's `code` and `path`); `"four stages captured"` (JSON and stream, with a fallback → two `target` snapshots); `"ring keeps the last N"` (N = 3, 5 requests → first 2 gone); `"INSPECTOR_BUFFER=0 captures nothing"` (no `bodies` on the trace); `"large bodies are truncated in the ring"` (Review Focus 3: 10 MB image request → `source` ≤ 1 MB + marker; 2 MB stream → `wire` ≤ 256 KB + marker; client still receives the full stream byte-identical).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: translation notes and inspector body ring`.

### Task 7: Usage store, migrations, retention, `observe:` config, Docker volume

Spec §3.4 (store), §3.11, D4.

**Files:**
- Create: `src/observe/sqlite.ts`, `src/observe/sinks/usage-store.ts`, `src/observe/retention.ts`
- Modify: `src/config/env-config.ts`, `src/config/gateway.schema.ts` (`observe:`), `src/config/yaml-config.ts`, `src/index.ts`, `src/cli.ts` (warning filter, shutdown flush), `Dockerfile` (`VOLUME /data`, `ENV USAGE_DB=/data/usage.db`, `/data` owned by `node`), `docs/decisions.md`
- Test: `src/observe/sinks/usage-store.test.ts`, `src/observe/retention.test.ts`, `src/config/yaml-config.test.ts` (new cases)

**Interfaces:**
- Produces (`sqlite.ts`): `openDatabase(path: string): DatabaseSync` — lazy `require("node:sqlite")` after installing a one-shot `process.on("warning")` filter that swallows only a `name === "ExperimentalWarning"` whose message mentions SQLite; `mkdir -p` the parent; `PRAGMA journal_mode=WAL`; `timeout: 200`. Record in decisions whether `DatabaseSync` warns as deprecated on the newest Node available.
- Produces (`usage-store.ts`): `createUsageStore(opts: {path: string; logBodies: boolean; now?: () => number}): TraceSink & UsageQueries & { flush(): void; close(): void }` with the schema of spec §3.4 at `schema_version = 1`; `interface UsageQueries { listRequests(q: {cursor?: string; limit: number; client?: string; model?: string; provider?: string; status?: string}): {rows: RequestRow[]; nextCursor?: string}; getRequest(id: string): (RequestRow & {bodies?: BodySnapshots}) | undefined; usage(q: {from: number; to: number; group: "day" | "model" | "provider" | "client"}): UsageGroup[] }`; `RequestRow` = the table's columns camelCased with JSON columns parsed; `UsageGroup = {key: string; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; wouldCostUsd: number; unpriced: number; errors: number; fallbacks: number}`. `getUsageStore()` singleton (undefined when off or disabled).
- Produces (`retention.ts`): `startRetention(store, days: number, everyMs = 3_600_000): () => void`.
- Config: `ObserveConfig { usageStore: boolean; usageDb: string; retentionDays: number; inspectorBuffer: number; logBodies: boolean; wouldCostReference?: string; metrics: boolean; ui: boolean; uiAllowRemote: boolean; uiAllowedHosts: string[] }` on `GatewayConfig.observe`; env wins over YAML `observe:` keys (`usage_store`, `usage_db`, `retention_days`, `inspector_buffer`, `log_bodies`, `would_cost_reference`).

- [ ] **Step 1: Tests** (`:memory:` and a temp dir). `"row per trace with every column"`; `"batched flush at 100 rows or 250 ms"` (fake timers); `"bodies only with logBodies"`; `"migration from an empty file creates schema v1"`; `"list is newest first and cursor-paged"`; `"usage groups by day/model/provider/client"`; `"retention deletes old rows and their bodies"`; `"USAGE_STORE=off never loads node:sqlite"` (spy on the lazy loader); `"unusable db never breaks serving"` (Review Focus 2: unwritable dir; a text file at the path; a second connection holding an exclusive lock → app answers chat 200, one warning, `getUsageStore()` undefined or batch dropped); `"no ExperimentalWarning printed"` (child process `node dist/cli.js --help`-style start with the store on; stderr has no `ExperimentalWarning`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; `docker build .` and `docker run -v bg:/data` shows `/data/usage.db` created (PR output). **Commit** `feat: sqlite usage store`.

### Task 8: Prices, cost, live prices, would-have-cost · OWNER GATE

Spec §3.6, D8. Owner approves bundling LiteLLM data and the new `package.json` script.

**Files:**
- Create: `scripts/update-prices.ts`, `src/cost/prices.json`, `src/cost/price-table.ts`, `src/cost/compute.ts`, `src/cost/live-prices.ts`
- Modify: `NOTICE` (LiteLLM MIT notice), `tsconfig.json` (`resolveJsonModule: true`), `package.json` (`"update:prices": "ts-node scripts/update-prices.ts"`), `src/routing/registry.ts` (`livePrices`, `local`), `src/config/gateway.schema.ts` (`live_prices`, `local`, top-level `prices:`), `src/config/yaml-config.ts`, `src/services/models.service.ts` (raw body cached), `src/observe/emit.ts` (cost in `finishTrace`), `docs/decisions.md`
- Test: `src/cost/*.test.ts`, `src/services/models.service.test.ts`, `tests/integration/observe.test.ts`

**Interfaces:**
- Produces (`prices.json`): `{source: {url: string; commit: string; fetchedAt: string}; models: Record<string, {input: number; output: number; cacheRead?: number; cacheWrite?: number}>}` — USD per 1M tokens; keys as LiteLLM's (`gpt-4o`, `claude-sonnet-4-5`, `gemini/gemini-2.5-pro`, `openrouter/qwen/qwen3-coder`, `deepseek/deepseek-chat`, …), chat-mode only.
- Produces (`price-table.ts`): `type Price = {input: number; output: number; cacheRead?: number; cacheWrite?: number}`; `lookupPrice(provider: ProviderEntry, model: string, config: GatewayConfig): Promise<{price: Price; source: "override" | "local" | "live" | "bundled"} | undefined>` — order of spec §3.6; bundled step tries `model`, then `<litellmPrefix>/<model>` with prefix by type: `gemini` → `gemini/`, others none.
- Produces (`compute.ts`): `computeCost(usage: CanonicalUsage, price: Price): {usd: number; estimated: boolean}` — spec §3.6 formula; missing cache price → input price, `estimated: true`.
- Produces (`live-prices.ts`): `livePrice(entry: ProviderEntry, model: string, config: GatewayConfig, requestId: string): Promise<Price | undefined>` — reads `getRawModelList(entry, config, requestId)` from `models.service.ts` (new export, same 60 s cache, which now stores the raw body and decodes on read), finds `data[].id === model`, converts string USD/token × 1e6.
- `finishTrace` sets `costUsd`, `costEstimated`, `priceSource`, `wouldCostUsd` (`local` rows with `observe.wouldCostReference` = `provider/model` resolved through the registry and `lookupPrice`). Usage missing on a successful stream → `estimateInputTokens` + output chars/4, `costEstimated: true`.

- [ ] **Step 1: Tests.** `compute.test.ts`: `"formula with cache"` — usage `{inputTokens: 1_000_000, cacheReadTokens: 400_000, cacheWriteTokens: 100_000, outputTokens: 200_000}`, price `{input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}` → `500k×3 + 400k×0.3 + 100k×3.75 + 200k×15` per 1M = `1.5 + 0.12 + 0.375 + 3.0` = **4.995**; `"missing cache price uses input and marks estimated"`. `price-table.test.ts`: `"override beats everything"` (glob `openrouter/qwen/*`); `"ollama is local $0"`; `"local: true is $0"`; `"live price used when flagged"`; `"live failure falls back to bundled"`; `"bundled exact then prefixed"`; `"unknown model → undefined"`. `observe.test.ts`: `"unknown price is null, never 0"`; `"prices the winning hop"` (Review Focus 4: alias `fast` → `ollama/qwen3-coder:30b` fails 503 → fallback `openrouter/qwen/qwen3-coder` wins → priced as that, `priceSource` recorded); `"would-have-cost on local rows"`. `update-prices.test.ts`: on a 5-model sample of LiteLLM JSON (checked-in under `tests/fixtures/prices/`, new file) → the expected `models` map; non-chat models dropped.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; run `npm run update:prices -- <commit>` at the latest LiteLLM `main` commit; record it. **Step 4:** `./scripts/check.sh` → PASS; `npm pack --dry-run` lists `dist/cost/prices.json`. **Commit** `feat: cost from bundled, override and live prices`.

### Task 9: Tool-call diagnostics and opt-in repair

Spec §3.7, D5.

**Files:**
- Create: `src/observe/tool-diagnostics.ts`, `src/observe/tool-repair-stream.ts`
- Modify: `src/routing/registry.ts` (`repairToolCalls`), `src/config/gateway.schema.ts` (`repair_tool_calls`), `src/config/yaml-config.ts`, `src/services/chat.service.ts`, `src/services/chat-stream.service.ts`, `src/observe/trace.ts`, `docs/decisions.md`
- Test: `src/observe/tool-diagnostics.test.ts`, `src/observe/tool-repair-stream.test.ts`, `tests/integration/observe.test.ts`

**Interfaces:**
- Produces: `type ToolCallDiagnostic = {toolCallId: string; name: string; code: "invalid_json" | "fenced_json" | "not_object" | "unknown_tool" | "missing_required"; detail?: string}` (`detail` = the missing property name; never argument text); `type ToolCallRepair = {toolCallId: string; steps: ("strip_fence" | "extract_object" | "trailing_comma")[]}`.
- Produces: `diagnoseToolCalls(calls: CanonicalToolCall[], tools: CanonicalTool[] | undefined): ToolCallDiagnostic[]`; `repairArguments(args: string): {args: string; steps: ToolCallRepair["steps"]} | undefined` (undefined = nothing applied or the result isn't an object); `createRepairTransform(): (event: CanonicalStreamEvent) => CanonicalStreamEvent[]` — holds `tool_call_delta` per index, releases one delta (repaired if possible) before that index's `tool_call_end`, and releases every held call unrepaired before `message_end`/`error`.
- Services: non-stream — diagnose on the decoded response; with `entry.repairToolCalls`, repair arguments before encoding to the client; diagnostics/repairs into `finishTrace`. Stream — insert the transform between decoder and encoder only when `entry.repairToolCalls`; diagnose on the reassembled response at the end either way.

- [ ] **Step 1: Tests.** Diagnostics: one case per code; `"valid call has no diagnostics"`; `"diagnostics never contain argument text"` (sentinel). Repair: ```` "```json\n{\"a\":1}\n```" ```` → `{"a":1}`, `["strip_fence"]`; `'Sure: {"a":1} done'` → `["extract_object"]`; `'{"a":1,}'` → `["trailing_comma"]`; `'{"a":1} {"b":2}'` → undefined (two objects); `"names and fields never changed"` (property: for valid JSON input, repair is undefined). Stream: `"text streams while a call is held"`; `"interleaved and truncated calls with repair on"` (Review Focus 5); `"repair off leaves the stream byte-identical"`. Integration: `"repair on: client receives fixed arguments; trace records repair"`; `"repair off: client receives original; trace records fenced_json"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: tool-call diagnostics and opt-in repair`.

### Task 10: `/metrics` · OWNER GATE

Spec §3.8 (metrics). New dependency `prom-client`.

**Files:**
- Create: `src/observe/sinks/metrics.ts`
- Modify: `package.json`, `package-lock.json`, `src/app.ts`, `src/services/proxy.service.ts` (aux counter), `src/observe/emit.ts` (sink-error counter), `docs/decisions.md`
- Test: `src/observe/sinks/metrics.test.ts`, `tests/integration/observe.test.ts`

**Interfaces:**
- Produces: `createMetricsSink(): TraceSink & { registry: Registry; incAux(source: Provider, kind: "count_tokens" | "models"): void; incSinkError(sink: string): void }`; metric names and labels exactly as spec §3.8; histogram buckets: duration `[0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]` s, ttfb `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]` s; `capLabel(name: string, value: string): string` (100 distinct values per label, then `other`). `GET /metrics` → text exposition; requires `PROXY_API_KEY` when set; 404 with `METRICS=off`.

- [ ] **Step 1: Tests.** `"counters and histograms move per trace"`; `"cost and tokens by kind"`; `"label cap → other"` (101st model); `"model label is the routed model"`; `"/metrics requires key when set"`; `"no prompt text in /metrics"` (sentinel). **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS (packed-install smoke still starts). **Commit** `feat: prometheus metrics`.

### Task 11: OpenTelemetry traces · OWNER GATE

Spec §3.8 (OTel). New OTel dependencies, loaded lazily.

**Files:**
- Create: `src/observe/sinks/otel.ts`, `src/observe/genai-attributes.ts` (every attribute name in one module, with the pinned semconv commit in a comment)
- Modify: `package.json`, `package-lock.json`, `src/index.ts` (register when `OTEL_EXPORTER_OTLP_ENDPOINT` set; shutdown flush), `src/observe/middleware.ts` (store an incoming `traceparent` on the trace as `parentTraceparent?: string`), `src/observe/trace.ts`, `docs/decisions.md`
- Test: `src/observe/sinks/otel.test.ts`

**Interfaces:**
- Produces: `createOtelSink(exporter?: SpanExporter): Promise<TraceSink & { shutdown(): Promise<void> }>` — dynamic `import()` of the OTel packages; one SERVER span `babelgate {source}` and one CLIENT span `chat {model}` per hop with explicit start/end times from the trace and hops; attributes exactly as spec §3.8; `gen_ai.provider.name` from type (`openai`, `anthropic`, `gcp.gemini`, `ollama`).
- Step 0: pick the latest commit of `open-telemetry/semantic-conventions-genai` `docs/gen-ai/` on the task date; verify each attribute name in spec §3.8 there; record commit and any renamed attribute in decisions (a rename → use the pinned name, note it).

- [ ] **Step 1: Tests** (in-memory exporter). `"server span plus a client span per hop"`; `"genai attributes on the client span"`; `"traceparent becomes the parent"`; `"no content attributes even with OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=true"` (sentinel); `"otel packages not loaded without endpoint"` (module-load spy). **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; PR shows spans in a local OTel collector or Jaeger (`docker run jaegertracing/all-in-one`). **Commit** `feat: opentelemetry traces`.

### Task 12: `/ui/api` + access control

Spec §3.9 (API, access), D2.

**Files:**
- Create: `src/ui-api/router.ts`, `src/ui-api/access.ts`, `src/ui-api/requests.ts`, `src/ui-api/live.ts`, `src/ui-api/usage.ts`, `src/ui-api/routing.ts`
- Modify: `src/app.ts` (mount `/ui/api` before the proxy router, after `requestLogger`; not behind `requireApiKey` — `access.ts` does it), `src/observe/emit.ts` (a `started` hook for `/live`), `src/config/env-config.ts` (`UI`, `UI_ALLOW_REMOTE`, `UI_ALLOWED_HOSTS`), `docs/decisions.md`
- Test: `src/ui-api/*.test.ts`

**Interfaces:**
- Consumes: `UsageQueries` (T7), `getBodyRing()` (T6), `lookupPrice` (T8), `planRoute`, `formatRoutingTable` data.
- Produces: routes and payloads exactly as spec §3.9 table (except `/playground`, Task 15). `GET /requests/:id` → `{row: RequestRow; bodies: BodySnapshots | null; reason?: "not_retained"}`. `GET /live` SSE: `event: started` `data: {id, client, sourceApi, requestedModel, startedAt}`; `event: finished` `data: RequestRow` (no bodies); 15 s `:keepalive` comments. `GET /routing` → `{providers: {name, type, baseUrl, maxOutputTokens?, cacheHints, livePrices, repairToolCalls, local}[]; aliases; rules; defaultProvider; prices: {target: string; price?: Price; source?: string}[]}`. Errors: `{error: {code, message}}` with 400/403/404.
- Produces (`access.ts`): `uiAccess(config: GatewayConfig): RequestHandler` — order: `UI=off` → 404; Host not loopback (`localhost`, `127.0.0.1`, `[::1]`, any port) and not in `UI_ALLOWED_HOSTS` → 403; missing `x-babelgate-ui: 1` → 403; key set → require Bearer/`x-api-key` (constant-time compare, as `requireApiKey`); no key → socket address must be loopback unless `UI_ALLOW_REMOTE` → else 403 with the hint text `"The UI answers only this machine. Set PROXY_API_KEY, or UI_ALLOW_REMOTE=true, to open it to the network."`. No CORS headers are ever sent.

- [ ] **Step 1: Tests.** Access: one test per rule above, including `"DNS rebinding host is refused"` (`Host: evil.example:3000` from loopback → 403) and `"preflight is never approved"` (`OPTIONS` → no `access-control-allow-*`). Payloads: list/detail/usage/routing against a seeded `:memory:` store and ring; `"not_retained when ring evicted and no LOG_BODIES"`; `"routing never contains keys"` (fake key value and the `api_key_env` value absent from the JSON); `"live streams started and finished, no bodies"` (sentinel); `"plan dry run makes no upstream call"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: ui api and access control`.

### Task 13: UI scaffold, build, smoke test; Requests + Inspector · OWNER GATE

Spec §3.9 (build, screens 1–2), D6, §4.4. New dev dependencies and scripts.

**Files:**
- Create: `ui/index.html`, `ui/vite.config.ts` (`base: "/ui/"`, `outDir: "../dist/ui"`, `emptyOutDir: true`), `ui/tsconfig.json`, `ui/vitest.config.ts` (happy-dom), `ui/src/main.tsx`, `ui/src/api.ts`, `ui/src/auth.ts`, `ui/src/screens/Requests.tsx`, `ui/src/screens/Inspector.tsx`, `ui/src/components/JsonTree.tsx`, `ui/src/diff.ts`, `ui/src/*.test.ts(x)`, `ui/e2e/smoke.spec.ts`, `ui/playwright.config.ts`, `scripts/ci/ui-smoke.sh`
- Modify: `package.json` (`build`: `tsc -p tsconfig.build.json && vite build ui`; `test`: `vitest run && vitest run --config ui/vitest.config.ts`; `typecheck` adds `tsc -p ui`; dev deps), `package-lock.json`, `vitest.config.ts` (exclude `ui/**`), `scripts/check.sh` (full mode runs `scripts/ci/ui-smoke.sh` after the build), `src/app.ts` (static `dist/ui` at `/ui` with SPA fallback; 404 with `UI=off`), `Dockerfile` (copy `ui/` into the build stage), `docs/decisions.md`
- Test: as above

**Interfaces:**
- Consumes: Task 12 routes.
- Produces (`api.ts`): typed fetchers for every Task 12 route, each sending `x-babelgate-ui: 1` and the key from `auth.ts` (`sessionStorage["babelgate-key"]`, try/catch around storage); a 401/403 shows the key prompt or the access hint text.
- Produces (`diff.ts`): `structuralDiff(a: unknown, b: unknown): {path: string; kind: "added" | "removed" | "changed"}[]` — JSON paths (`messages[3].content[1]`), used to highlight between adjacent stages.
- Screens per spec §3.9 items 1–2; `#/requests` and `#/requests/:id` hash routes; live updates from `/ui/api/live` (reconnect with backoff).
- `ui-smoke.sh`: `npx playwright install chromium` if missing (no `--with-deps`); start `node dist/index.js` with a mocked upstream (reuse `tests/mocks/upstreams.ts` through a tiny `ui/e2e/mock-server.ts`); run `smoke.spec.ts`: send an OpenAI chat request, open `/ui`, see the row, open it, see four stage columns with content. If CI lacks system libraries, the PR states the exact `ci.yml` change for the owner.

- [ ] **Step 1: Tests.** `diff.test.ts`: `"added, removed, changed paths"`; `Requests.test.tsx`: `"renders rows and live inserts"`, `"filters"`; `Inspector.test.tsx`: `"four stages and a tab per hop"`, `"not retained message"` (exact copy from spec §3.9), `"notes and diagnostics at top"`; `auth.test.ts`: `"storage throwing still works for the session"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS (smoke included); `npm pack --dry-run` lists `dist/ui/index.html`; PR has a screenshot of both screens. **Commit** `feat: ui requests log and translation inspector`.

### Task 14: UI Usage + Routing screens

Spec §3.9 (screens 3–4).

**Files:**
- Create: `ui/src/screens/Usage.tsx`, `ui/src/screens/Routing.tsx`, `ui/src/components/BarChart.tsx`, `ui/src/components/LineChart.tsx` (hand-written SVG, CSS-variable colours for light and dark), tests beside them
- Modify: `ui/src/main.tsx` (nav), `docs/decisions.md`

**Interfaces:**
- Consumes: `GET /usage`, `GET /routing`, `GET /routing/plan`.
- Produces: Usage — date range (7/30 days), group by model or client, stacked bars of cost per day, totals, "saved ≈ $X" (sum of `wouldCostUsd`), cache-hit ratio `cacheRead / input`, unpriced count shown as "N requests without a price". Routing — the tables and the "where would `<model>` go?" box.

- [ ] **Step 1: Tests.** `"empty store shows an empty state, not NaN"`; `"unpriced requests are never summed as $0"`; `"saved only from local rows"`; `"plan box shows targets and reason"`; charts: `"bars scale to max"`, `"zero-height series renders"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; PR screenshots light and dark. **Commit** `feat: ui usage and routing screens`.

### Task 15: Playground (API + screen)

Spec §3.9 (`POST /playground`, screen 5).

**Files:**
- Create: `src/ui-api/playground.ts`, `ui/src/screens/Playground.tsx`, tests beside them
- Modify: `src/ui-api/router.ts`, `src/services/chat-stream.service.ts` (export an internal entry that takes a canonical request directly — `streamCanonical(canonical: CanonicalRequest, requestedModel: string, config: GatewayConfig, ctx: {requestId: string; signal?: AbortSignal; client: "playground"}): AsyncIterable<CanonicalStreamEvent>`), `docs/decisions.md`

**Interfaces:**
- Produces: `POST /ui/api/playground` body `{messages: {role: "user" | "assistant"; content: string}[]; system?: string; models: string[]; params?: {maxTokens?: number; temperature?: number}}` validated with Zod (`models` length 2–4, `maxTokens` ≤ 4096, default 512); response SSE `event: delta data: {model, text}`, `event: done data: {model, usage, costUsd, ms}`, `event: error data: {model, message}` (canonical error message only); each model runs through `planRoute` → attempts → its own trace with `client: "playground"` (a fresh trace scope per model). Client disconnect aborts all.

- [ ] **Step 1: Tests.** `"three models stream in parallel, one fails"`; `"each model gets its own row with client playground"`; `"abort cancels all upstreams"`; `"5 models → 400"`; screen: `"columns render deltas per model"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: ui playground`.

### Task 16: Privacy canary; recipes, examples, README, architecture doc

Spec §4.1 (privacy canary), §3.10 (recipe), §3.11.

**Files:**
- Create: `tests/integration/privacy-canary.test.ts`, `docs/recipes/gemini-cli.md`, `docs/recipes/observability.md`
- Modify: `docs/recipes/claude-code.md`, `docs/recipes/claude-code-hybrid.md`, `docs/recipes/openai-compatible-providers.md`, `examples/*.yaml`, `README.md`, `docs/architecture.md`, `src/cli.ts` (endpoints block adds `UI         http://localhost:<port>/ui`), `src/cli.test.ts` (new case), `docs/decisions.md`
- Test: `src/config/examples.test.ts` (unchanged; new example keys must load)

- [ ] **Step 0: Privacy canary** (spec §4.1, all sinks on, OTel with an in-memory exporter, `LOG_BODIES` off then on). `"canary reaches only the ring"`: a unique string in a prompt, a tool argument and a completion, plus a fake key value in config → absent from captured log output, `/metrics`, exported spans, `/ui/api/live`, `/ui/api/routing`, `/ui/api/requests` rows and the `requests` table; present in `getBodyRing()`; present in the `bodies` table only with `LOG_BODIES=true`. Run → it should PASS on arrival; a failure is a bug in the owning sink's task code, fixed here and listed in the decisions entry.
- [ ] **Step 1:** `gemini-cli.md` per spec §3.10 item 3 with the Task 1 version and endpoint list. `observability.md`: the privacy model in one table (what goes where; D3), every §3.11 setting, `/metrics` scrape config, OTel env example, Docker (`-v`, `PROXY_API_KEY` or `UI_ALLOW_REMOTE`). `claude-code.md`: `max_output_tokens` replaces `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; OpenRouter `cache_hints: true` and `live_prices: true`. `examples/claude-code-hybrid.yaml`: `openrouter` gains `max_output_tokens: 8000`, `cache_hints: true`, `live_prices: true`; `observe: { would_cost_reference: openrouter/anthropic/claude-sonnet-4.5 }` (use an id present in OpenRouter's `/models` on the task date). README: "See what's happening" section with a Task 13/14 screenshot. `cli.test.ts`: `"endpoint lines include the UI"`.
- [ ] **Step 2:** `./scripts/check.sh` → PASS. **Commit** `docs: v1.3 recipes, examples and README`.

### Task 17: Live-suite cases; release gates A, A-cache, B, C · OWNER REVIEW

Spec §4.5, D10. Owner runs the gates; conductor supports.

**Files:**
- Create: `tests/live/observe.live.test.ts`, `scripts/gates/gemini-cli-edit.sh`, `scripts/gates/observe-check.ts` (asserts against a running instance's `/ui/api` and `/metrics`)
- Modify: `scripts/gates/claude-code-edit.sh` (after the edit task, run `observe-check.ts` when `OBSERVE_CHECK=1`), `tests/live/live.helpers.ts`, `docs/gates/gpu-ollama.md` → marked retired (one line pointing to D10), `docs/decisions.md`

**Interfaces:**
- Produces: `observe-check.ts --base <url> --client <id> [--expect-cost] [--expect-cache-read] [--expect-providers a,b] [--expect-saved]` → exit 0 with `OBSERVE PASS` or 1 naming the failed expectation. Checks: a row exists for `--client` since start; `costUsd` not null (`--expect-cost`); the latest row's inspector has four stages; `babelgate_requests_total` > 0; per flag as named.

- [ ] **Step 1: Live tests.** `"gemini countTokens against babelgate"` (no upstream needed); with `OPENROUTER_API_KEY`: `"openrouter anthropic model reports cache reads"` — two identical requests with a ≥ 4 096-token hinted system prompt to `anthropic/claude-haiku-4.5` (an id present on the task date) through `cache_hints: true` → second response `cache_read_input_tokens > 0`. Owner runs `npm run test:live` and pastes the summary.
- [ ] **Step 2: Gates** (owner, recorded in decisions: client versions, models, duration, cost):
  - **A:** `OBSERVE_CHECK=1 scripts/gates/claude-code-edit.sh config examples/claude-code-openrouter.yaml` (create this example: one OpenRouter provider, `max_output_tokens: 8000`, `live_prices: true`, default model `qwen/qwen3-coder`), `CLAUDE_CODE_MAX_OUTPUT_TOKENS` unset → `GATE PASS` + `OBSERVE PASS` with `--client claude-code --expect-cost`.
  - **A-cache:** same with the model `anthropic/claude-haiku-4.5` and `cache_hints: true` → `--expect-cache-read`.
  - **B:** `scripts/gates/gemini-cli-edit.sh openrouter qwen/qwen3-coder` → `GATE PASS` + `OBSERVE PASS --client gemini-cli`.
  - **C:** `OBSERVE_CHECK=1 scripts/gates/claude-code-edit.sh config examples/claude-code-hybrid.yaml` with haiku routed to CPU Ollama `qwen2.5-coder:3b` → `--expect-providers ollama,openrouter --expect-saved`.
- [ ] **Commit** `docs: v1.3 release gate results`.

### Task 18: CHANGELOG, roadmap, `1.3.0` · OWNER GATE

**Files:**
- Modify: `CHANGELOG.md` (`## [1.3.0]` + compare link), `package.json` / `package-lock.json` (version, root entries only), `docs/roadmap.md` (status: v1.3 released, next v1.4; v1.3 size M → L; gates carried-over line removed), `docs/decisions.md`

- [ ] **Step 1:** Run `npm run update:prices -- <latest LiteLLM commit>` (release-checklist step, spec §3.6); commit separately as `chore: refresh bundled prices`.
- [ ] **Step 2:** CHANGELOG: Added (UI, inspector, usage store, cost, metrics, OTel, tool-call diagnostics and repair, output cap, cache mapping, Gemini CLI `countTokens`); Changed (`engines >=22.13`; new usage fields in replies when providers report cached tokens; unsupported Gemini methods return 501); Known limitations (spec §2.2 items users will hit: no Gemini explicit cache, no content in OTel, UI single-user).
- [ ] **Step 3:** `./scripts/check.sh` → PASS. **Commit** `chore: release 1.3.0`. Owner: tag `v1.3.0`, `npm publish --access public`, GHCR image, verify `npx -y babelgate@1.3.0 --help` and `/ui` loads.
