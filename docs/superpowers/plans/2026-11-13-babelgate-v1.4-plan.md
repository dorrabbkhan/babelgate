# babelgate v1.4 ("Codex on any model") Implementation Plan

> **For agentic workers (Devin):** Run each task in its own session with `/babelgate-task v1.4 <N>`. One task → one branch (`v1.4/task-<N>-<short-name>`) → one PR. Steps use checkbox (`- [ ]`) syntax. Read `AGENTS.md`, this plan's Global Constraints and Review Focus, and the spec sections each task names. Use `./scripts/check.sh quick` while iterating and `./scripts/check.sh` before pushing. Verify every write with `git diff`.

**Goal:** Codex CLI works through babelgate on Gemini, Claude and Chat-only backends via a fifth adapter (OpenAI Responses), with custom tools, reasoning carried between turns and structured output across all five formats; Responses-native upstreams get a byte-preserving pass-through that is still routed, traced and priced.

**Architecture:** `responses` becomes the fifth key of `PROVIDER_ROUTES`/adapters, so it is at once a source format (`POST /v1/responses`), a provider `type` and a target. Requests flow through canonical as today, except a Responses source routed to a `type: responses` provider, which takes a pass-through path inside the same services (trace, usage, cost, inspector). Canonical gains reasoning config, reasoning parts and model-bound signatures, custom tools, a response format and reasoning-token usage (Task 2, owner review). Adapters learn the current attempt's provider and model from an ambient accessor beside `recordNote`.

**Tech Stack:** As v1.3 (TypeScript 5 strict, Express 5, Zod 4, pino, `yaml`, vitest 3, msw 2, supertest, `node:sqlite`, Preact + Vite UI). **No new dependencies.** Codex CLI (owner-installed) for Task 1 and the gates.

**Spec:** `docs/superpowers/specs/2026-11-13-babelgate-v1.4-design.md`. Parents: `2026-10-26-babelgate-roadmap-design.md`, `2026-11-04-babelgate-roadmap-revision-design.md`; previous: `2026-11-04-babelgate-v1.3-design.md`.

**Decided with the owner (2026-11-13), spec §6:** D1 bridge + pass-through; D2 reasoning carried opaquely, real Gemini signatures; D3 structured output native, never weakened; D4 gates A (Gemini), B (Claude), C (OpenRouter pass-through); D5 fifth adapter + pass-through path; D6 size L; D7 two Gemini stream fixtures pre-approved (Task 2 usage, Task 7 signature).

**Prerequisite (owner):** merge the spec and this plan before Task 1.

## Global Constraints

- **No existing expected value changes** and no edits to existing fixtures or contract snapshots, **except D7, exactly:** `tests/fixtures/streams/gemini/text.json` and `tests/fixtures/streams/gemini/parallel_tool_calls.json` — expected `outputTokens` 1 → 34 and 54 → 131, new `reasoningTokens` 33 and 77 (Task 2), and in `parallel_tool_calls` the first function call's real `thoughtSignature` as a canonical signature (Task 7). `.sse` recordings never change. Any other fixture/snapshot change → STOP and escalate. New fixture **files** are allowed.
- **No existing default changes.** `UPSTREAM_TIMEOUT_MS` 30 000, `UPSTREAM_RETRIES` 1, `UPSTREAM_STREAM_IDLE_MS` 300 000, model-list cache 60 000 ms, every v1.3 observe default. New per-provider flag `reasoning_passback` defaults **off**.
- **Non-Responses sources behave exactly as in 1.3** (spec §3.3, §4.3): their reasoning config is dropped with today's notes, no reasoning parts reach Anthropic, Gemini, OpenAI or Ollama clients. A test in each touched adapter pins this.
- **Adapters stay independent.** No adapter imports another, routing or config. From `observe/` an adapter may import only `recordNote` and `currentAttempt` from `src/observe/context.ts`. No provider-pair branches, no Codex branches (no `if client === "codex"`). Per-provider behaviour comes only from config (`type`, `cache_hints`, `reasoning_passback`, …), never from a hostname.
- **Canonical changes happen in Task 2 only**, `canonical.types.ts` and `canonical.schema.ts` together, logged in `docs/decisions.md`. A later task that needs a canonical change STOPs.
- **Reasoning never crosses origin.** A reasoning part or signature is encoded only when its `origin {provider, model}` equals `currentAttempt()`'s; otherwise dropped with a `reasoning_dropped` note. No exceptions.
- **Schemas are never weakened.** A response-format schema is forwarded unchanged; babelgate never strips or rewrites its keywords.
- **Stateful Responses is rejected before routing** with a 400 in the Responses error envelope naming the field: `previous_response_id`, `store: true`, `conversation`; `GET`/`DELETE /v1/responses/{id}` and `POST /v1/responses/compact` → 404 in the same envelope.
- **Wire-format evidence:** every Responses field and SSE event name used in code or mocks cites, in a comment, the OpenAI Responses API reference or the Codex source file (`codex-rs/codex-api/src/sse/responses.rs`, `codex-rs/core/src/client.rs`) at the version recorded in Task 1. Same for Anthropic thinking, Gemini thought/`thoughtSignature`, structured-output fields: provider doc URL in the decisions entry.
- **Privacy:** reasoning text, signatures, custom-tool input and response schemas are content: never in the log, `/metrics`, OTel, `/ui/api/live`, `/ui/api/routing` or the `requests` table; only in the body ring (and `bodies` with `LOG_BODIES=true`). The privacy canary (v1.3) gains these.
- **No network in `npm test`.** Real upstreams only in `tests/live/` and `scripts/gates/`.
- **Owner-only:** `package.json`/`package-lock.json` change only in Task 15 (version); fixture/snapshot changes beyond D7; `.github/workflows/*`; gate runs; tagging; publishing; merging.

## Review Focus

1. **A Codex session that changes provider or model mid-way** (a fallback wins on turn 3, or an alias/rule sends turn 4 to another model on the same provider). Expected: 200 every turn; foreign reasoning dropped with `reasoning_dropped` notes; Anthropic thinking turned off for that request by the continuity guard; nothing from provider X ever in provider Y's upstream body. → Task 8 (`provider switch mid-session drops foreign reasoning`).
2. **Client disconnects mid-stream on pass-through** (Ctrl-C in Codex). Expected: exactly one trace, `status: "aborted"`, usage absent unless `response.completed` already arrived, upstream request aborted, no second emit. → Task 10 (`aborted pass-through emits one trace`).
3. **Long sessions resend every reasoning item** (60 turns, each with an envelope; one envelope over 1 MB). Expected: each envelope ≤ 1 MB or emitted without `encrypted_content` plus a note; request size bounded only by `MAX_BODY_SIZE` as today; the ring cap holds. → Task 8 (`envelope over cap is omitted with a note`).
4. **Custom-tool input that looks like broken JSON** (an `apply_patch` body containing ```` ``` ```` fences and `{`), with `repair_tool_calls: true`. Expected: the input reaches Codex byte-identical; no `invalid_json`/`fenced_json` diagnostic, no repair. → Task 5 (`custom tool input is never diagnosed or repaired`).
5. **An upstream rejects a structured-output schema while streaming** (Gemini or Anthropic 400 before the first byte, for a streaming Responses request). Expected: the Responses client gets an HTTP error in the Responses envelope (not a half-open SSE), the trace records the error, no fallback loop beyond the configured hops. → Task 9 (`schema rejected upstream surfaces as a responses error`).

Each line is pinned by a named test in the owning task.

---

## File Map

```
src/types/responses.types.ts            NEW: Responses wire types (T3, T4, T5, T8, T9)
src/types/canonical.types.ts, canonical.schema.ts   reasoning, signatures, custom tools, responseFormat, reasoningTokens (T2)
src/observe/context.ts                  currentAttempt / runWithAttempt (T2)
src/transformers/adapters/responses.adapter.ts      NEW (T3); custom tools (T5); reasoning (T6, T8); responseFormat (T9)
src/transformers/adapters/responses.stream.ts       NEW (T4); custom tool events (T5); reasoning events (T8)
src/transformers/adapters/responses.envelope.ts     NEW: bg1 envelope pack/unpack (T8)
src/transformers/adapters/index.ts      PROVIDER_ROUTES.responses (T3)
src/transformers/adapters/{anthropic,gemini,openai,ollama}.*   parallelToolCalls (T5), reasoning config (T6), reasoning parts (T7, T8), responseFormat (T9), usage (T2)
src/transformers/custom-tools.ts        NEW: lower/raise custom tools in the services (T5)
src/transformers/reasoning-effort.ts    NEW: shared effort ladder helpers, no provider knowledge (T6)
src/routing/detect-source.ts            /v1/responses, /responses (T3)
src/routing/registry.ts, src/config/{gateway.schema,yaml-config,env-config}.ts   type responses, reasoning_passback (T3, T8)
src/services/attempt-targets.ts, chat.service.ts, chat-stream.service.ts, proxy.service.ts   runWithAttempt (T2); stateful 400s (T3); pass-through (T10)
src/services/passthrough.ts             NEW (T10)
src/observe/tool-diagnostics.ts, tool-repair-stream.ts   skip custom calls (T5)
src/observe/sinks/usage-store.ts        migration 2: reasoning_tokens (T12)
ui/src/screens/Inspector.tsx, Requests.tsx           reasoning parts, pass-through marker (T12)
scripts/gates/record-codex.sh           NEW (T1); codex-edit.sh NEW (T14)
docs/recipes/codex.md, docs/launch/v1.4-codex.md, examples/codex-*.yaml   NEW (T13)
tests/fixtures/responses.json, tests/fixtures/streams/responses/*   NEW (T3, T4)
tests/integration/codex.test.ts         NEW (T1 shapes replayed in T11)
tests/integration/pairs.test.ts, stream-pairs.test.ts   5×5 (T11)
tests/live/codex.live.test.ts           NEW (T14)
```

## Task Index

| # | Task | Depends on | Gate |
|---|---|---|---|
| 1 | Codex traffic recording; proven shapes; OpenRouter Anthropic endpoint check | — | |
| 2 | Canonical changes; `currentAttempt`; Gemini thinking-token usage | — | OWNER REVIEW (interface); D7 fixture change |
| 3 | Responses adapter: types, request/response, errors, source detection, `type: responses`, stateful 400s | 1, 2 | |
| 4 | Responses stream decoder + encoder | 3 | |
| 5 | Custom tools and built-in tools, all adapters | 4 | |
| 6 | Reasoning config mapping, all adapters | 3 | |
| 7 | Reasoning parts + signatures: Anthropic, Gemini | 2, 6 | D7 fixture change |
| 8 | Reasoning: OpenAI-compatible, Ollama, Responses envelope; continuity guard | 4, 7 | |
| 9 | Structured output, all five adapters | 4 | |
| 10 | Pass-through | 4 | |
| 11 | Pair matrix 5×5; structured output per target; multi-turn Codex replay | 5, 8, 9, 10 | |
| 12 | UI inspector + usage store `reasoning_tokens` | 8, 10 | |
| 13 | Codex recipe, examples, README, architecture doc, launch draft | 11, 12 | |
| 14 | Live-suite cases; `codex-edit.sh`; gates A, B, C | 13 | OWNER REVIEW |
| 15 | CHANGELOG, roadmap, `1.4.0` | 14 | OWNER GATE |

Tasks 1 and 2 run in parallel; 4 and 6 in parallel after 3; 5, 9, 10 in parallel after 4.

---

### Task 1: Codex traffic recording; proven shapes; OpenRouter Anthropic endpoint check

Spec §1.2 E1–E3, §3.1, §4.5 (gate B fallback). **Evidence first:** no product code in this task.

**Files:**
- Create: `scripts/gates/record-codex.sh`, `tests/fixtures/codex/recording.jsonl` (shapes only, as `record-shapes.ts` writes them), `tests/fixtures/codex/turns.json` (three consecutive Codex request bodies with every string value replaced by `record-shapes`' `"<string:len>"` form except keys, `type` values, tool names and event names)
- Modify: `docs/decisions.md`, spec §1.2 (append E12+)

**Interfaces:**
- Consumes: `scripts/gates/record-shapes.ts <listenPort> <forwardBaseUrl> <outJsonl>` (v1.3).
- Produces: `record-codex.sh [--upstream <baseUrl>]` (default `https://openrouter.ai/api/v1`): runs `record-shapes.ts` in front of the upstream, then `codex exec` with a temp `CODEX_HOME` whose `config.toml` has `[model_providers.rec] base_url = "http://localhost:<port>/v1"`, `wire_api = "responses"`, `env_key = "OPENROUTER_API_KEY"`, model `qwen/qwen3-coder`, on a temp copy of `scripts/gates/fixtures/edit-task`; prints the JSONL path and `codex --version`.
- Produces for later tasks: `tests/fixtures/codex/turns.json` shape `{codexVersion: string, turns: object[]}`.

- [ ] **Step 1: Write `record-codex.sh`** per Interfaces. No babelgate in the loop (Codex → recorder → OpenRouter's native Responses).
- [ ] **Step 2: Record.** If `codex` isn't installed or `OPENROUTER_API_KEY` is absent, STOP: `Owner decision needed: run scripts/gates/record-codex.sh and attach the JSONL`. Record in `docs/decisions.md`: Codex version; every distinct `method path` with count (does Codex call `GET /v1/models`? anything else?); top-level request keys; `tools[].type` values and names; whether `apply_patch` is `custom` (with `format.type`/`syntax`) or `function` for this model; `include`, `reasoning`, `text`, `store`, `previous_response_id` presence; input item `type`s seen across turns (is `reasoning` with `encrypted_content` sent back?); the SSE event types in each reply; User-Agent pattern. Append as E12+.
- [ ] **Step 3: OpenRouter Anthropic endpoint.** With `OPENROUTER_API_KEY`, one non-streaming `POST https://openrouter.ai/api/v1/messages` (Anthropic format, `anthropic/claude-haiku-4.5`, `thinking: {type: "enabled", budget_tokens: 1024}`, `max_tokens: 2048`) and record status, whether the reply has a `thinking` block with `signature`. Result decides gate B's config (Task 14). Key redacted, no body text in the record.
- [ ] **Step 4: Scope check.** If the recording shows anything the spec does not cover and that Codex needs for the edit task (an extra endpoint, `additional_tools`, a new input item type), STOP with an owner decision (options: add to Task 3/5, separate task, limitation).
- [ ] **Step 5:** `./scripts/check.sh` → PASS (no code changed). **Commit** `docs: codex traffic recording`.

### Task 2: Canonical changes; `currentAttempt`; Gemini thinking-token usage · OWNER REVIEW

Spec §3.2, E6, E9, D7. **Interface change.**

**Files:**
- Modify: `src/types/canonical.types.ts`, `src/types/canonical.schema.ts`, `src/observe/context.ts`, `src/services/chat.service.ts`, `src/services/chat-stream.service.ts`, `src/services/stream-attempt.ts` (wrap each attempt), `src/transformers/adapters/gemini.adapter.ts`, `gemini.stream.ts` (usage only), `src/utils/stream-reassemble.ts` (carry `reasoningTokens`), `tests/fixtures/streams/gemini/text.json`, `tests/fixtures/streams/gemini/parallel_tool_calls.json` (D7 usage values only), `docs/decisions.md`
- Test: `tests/contracts/canonical.schema.test.ts`, `src/observe/context.test.ts`, `src/transformers/adapters/gemini.adapter.test.ts` (new cases)

**Interfaces:**
- Produces exactly spec §3.2: `CanonicalRequest.responseFormat?: CanonicalResponseFormat`; `CanonicalConfig.reasoning?: {effort?: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"; summary?: boolean; budgetTokens?: number}`; `CanonicalReasoningOrigin {provider: string; model: string}`; `CanonicalReasoningSignature {origin; data: string}`; `CanonicalContentPart.type` gains `"reasoning"` with `reasoning?: {text?: string; redacted?: boolean; origin: CanonicalReasoningOrigin}` and `signature?: CanonicalReasoningSignature` (allowed on `text` and `reasoning` parts); `CanonicalToolCall.signature?`, `CanonicalToolCall.custom?: boolean`; `CanonicalTool` becomes the union `{type: "function", …} | {type: "custom"; name; description?; format?: {type: "text"} | {type: "grammar"; syntax: string; definition: string}; cache?}`; `CanonicalUsage.reasoningTokens?: number` (included in `outputTokens`); `CanonicalRequest.parallelToolCalls?: boolean`.
- Produces stream events `{type: "reasoning_delta"; index: number; text: string}` and `{type: "reasoning_signature"; index: number; signature: CanonicalReasoningSignature}`, plus `tool_call_start` gains optional `custom?: boolean`; reasoning content blocks use their own `index` like text blocks (stream rule: one block per index, deltas in order).
- Produces in `context.ts`: `type AttemptContext = {providerName: string; upstreamModel: string}`; `runWithAttempt<T>(ctx: AttemptContext, fn: () => T): T`; `currentAttempt(): AttemptContext | undefined`. Services wrap every attempt's encode, upstream call and decode (fallback hops included) in `runWithAttempt`.
- Gemini usage: `outputTokens = candidatesTokenCount + thoughtsTokenCount`, `reasoningTokens = thoughtsTokenCount` when > 0; encode back: `candidatesTokenCount = outputTokens − reasoningTokens`, `thoughtsTokenCount = reasoningTokens` when present.

- [ ] **Step 1: Tests.** Schema: `"reasoning part needs origin"`; `"reasoning part only on assistant messages"`; `"custom tool with grammar is valid"`; `"responseFormat json_schema needs name and schema"`; `"parallelToolCalls is optional boolean"`; `"effort xhigh valid, 'max' invalid"`; `"existing requests still valid"` (every request in `tests/fixtures/*.json` parses). Context: `"currentAttempt inside runWithAttempt"`, `"undefined outside"`, `"nested attempts restore the outer"`. Gemini: `"thoughtsTokenCount added to output"` — `{promptTokenCount: 11, candidatesTokenCount: 1, thoughtsTokenCount: 33}` → `{inputTokens: 11, outputTokens: 34, reasoningTokens: 33, totalTokens: 45}`; `"no thoughts, no reasoningTokens field"`; `"encode splits back"`. Services: `"each fallback hop runs in its own attempt"` (two hops → two distinct contexts observed by a spy adapter).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Update the two D7 fixtures' expected usage exactly as Global Constraints say; nothing else in them.
- [ ] **Step 4: Verify.** `./scripts/check.sh` → only "FIXTURE GUARD FAILED … all other checks passed" (D7; the owner sets `ALLOW_FIXTURE_CHANGE`). `git diff --stat origin/main -- tests/fixtures tests/contracts/__snapshots__` lists only the two D7 files. Decisions entry "v1.4 Task 2": the type diff, `thoughtsTokenCount` doc URL. PR titled `[OWNER REVIEW] feat(canonical): reasoning, custom tools, response format`. **Commit** `feat(canonical): reasoning, custom tools, response format`.

### Task 3: Responses adapter: types, request/response, errors, source detection, `type: responses`, stateful 400s

Spec §3.1, §3.7, §2.2. Field names from the Responses API reference and Task 1's recording.

**Files:**
- Create: `src/types/responses.types.ts`, `src/transformers/adapters/responses.adapter.ts`, `tests/fixtures/responses.json`
- Modify: `src/transformers/adapters/index.ts`, `src/routing/detect-source.ts`, `src/config/gateway.schema.ts` (enum gains `responses`), `src/config/env-config.ts` (`TARGET_API=responses`; `RESPONSES_API_BASE_URL` by the existing `{PROVIDER}_API_BASE_URL` convention; key env `RESPONSES_API_KEY` in the key map), `src/routing/registry.ts`, `src/services/proxy.service.ts` (stateful rejections), `docs/decisions.md`
- Test: `src/transformers/adapters/responses.adapter.test.ts`, `src/routing/detect-source.test.ts`, `tests/contracts/fixtures.test.ts` (new fixture file wired in), `tests/integration/codex.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 types; `tests/fixtures/codex/turns.json`.
- Produces: `PROVIDER_ROUTES.responses = {chat: {method: "POST", path: "/v1/responses"}, …}` (also `/responses`), so `Provider` gains `"responses"`; `responsesAdapter: ProviderAdapter<ResponsesRequest, ResponsesResponse>`.
- Request decode: `instructions` and `role: "system"|"developer"` messages → `systemPrompt`; `input` string → one user message; `message` items with `input_text`/`output_text`/`input_image` (data URL → `CanonicalImage`; remote URL → 400 `unsupported_image_url`, as the other adapters); `function_call {call_id, name, arguments}` → assistant `toolCalls`; `function_call_output {call_id, output}` → tool message; `tools[{type: "function", name, description, parameters}]`; `tool_choice` (`auto`/`none`/`required`/`{type:"function", name}`); `max_output_tokens`, `temperature`, `top_p`; `stream`. Ignored with a `field_dropped` note: `prompt_cache_key`, `service_tier`, `metadata`, `client_metadata`, `safety_identifier`, `user`, `text.verbosity`, `include` (Task 8 reads it), `prompt_cache_options`.
- Response encode: `{id: "resp_<id>", object: "response", created_at, status: "completed"|"incomplete", model: <client's model>, output: [message{id: "msg_…", role: "assistant", content: [{type: "output_text", text, annotations: []}]}, function_call{id: "fc_…", call_id, name, arguments, status: "completed"}…], usage: {input_tokens, input_tokens_details: {cached_tokens}, output_tokens, output_tokens_details: {reasoning_tokens}, total_tokens}, incomplete_details}`; finish `length` → `status: "incomplete"`, `incomplete_details.reason: "max_output_tokens"`; `content_filter` → `"content_filter"`.
- Errors: `toCanonicalError`/`fromCanonicalError` use `{error: {message, type, code, param}}`.
- Stateful: `previous_response_id` (any value), `store: true`, `conversation` → 400 `{error: {type: "invalid_request_error", code: "unsupported_parameter", param: <field>, message: "babelgate is stateless: <field> is not supported"}}`, before routing; `GET|DELETE /v1/responses/:id`, `POST /v1/responses/compact` → 404, same envelope, `code: "not_found"`.

- [ ] **Step 1: Tests.** `responses.adapter.test.ts`: `"string input is one user message"`; `"instructions and developer messages become the system prompt"`; `"function_call and output round-trip"` (call_id preserved both ways); `"tool_choice forms"` (4 cases); `"length finish is incomplete max_output_tokens"`; `"usage with cached and reasoning tokens"` — canonical `{inputTokens: 1000, cacheReadTokens: 900, outputTokens: 50, reasoningTokens: 20, totalTokens: 1050}` → `{input_tokens: 1000, input_tokens_details: {cached_tokens: 900}, output_tokens: 50, output_tokens_details: {reasoning_tokens: 20}, total_tokens: 1050}`; `"dropped fields are noted, never sent"`; `"request encode round-trips the fixture"` (Responses → canonical → Responses deep-equals `tests/fixtures/responses.json` request minus dropped fields). detect-source: `"POST /v1/responses is responses"`, `"/responses is responses"`, `"GET /v1/models stays openai"`. codex.test.ts: `"previous_response_id rejected before routing"` (no upstream call; 400 body above); `"store true rejected"`; `"store false accepted"`; `"GET /v1/responses/abc is a responses 404"`; `"recorded codex turn 1 decodes"` (each `turns.json` body → `toCanonicalRequest` doesn't throw; custom tools and reasoning items noted as dropped until Tasks 5 and 8).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Config: `type: responses` behaves like `openai` for `base_url`/key/model list (`GET <base>/models`). **Step 4:** `./scripts/check.sh` → PASS; PR shows one real `curl` Responses request through `npm run dev` to a mocked or OpenRouter target, keys redacted. **Commit** `feat: responses adapter`.

### Task 4: Responses stream decoder + encoder

Spec §3.1, §3.7, E2. Event names from Codex's `sse/responses.rs` at Task 1's version and the Responses streaming reference.

**Files:**
- Create: `src/transformers/adapters/responses.stream.ts`, `tests/fixtures/streams/responses/text.json`, `tools.json`, `parallel_tool_calls.json`, `incomplete.json`, `failed.json` (+ `.sse`, written by hand from the reference, each event citing its source in `decisions.md`)
- Modify: `src/transformers/adapters/responses.adapter.ts` (wire `createStreamDecoder`/`createStreamEncoder`), `tests/contracts/stream-fixtures.test.ts`, `tests/contracts/stream-decoders.test.ts`, `tests/contracts/stream-properties.test.ts` (register the adapter), `tests/contracts/encoder-stability.test.ts` (register), `docs/decisions.md`
- Test: as above, `src/transformers/adapters/responses.adapter.test.ts`

**Interfaces:**
- Encoder emits, in order: `response.created` (`response.status: "in_progress"`, `output: []`), `response.in_progress`; per text block `response.output_item.added` (message) → `response.content_part.added` (`output_text`) → `response.output_text.delta`* → `response.output_text.done` → `response.content_part.done` → `response.output_item.done`; per tool call `output_item.added` (`function_call`, `arguments: ""`) → `response.function_call_arguments.delta`* → `.done` → `output_item.done`; end `response.completed` with the full response object and usage, or `response.incomplete` (`incomplete_details.reason`), or on canonical `error` `response.failed` with `response.error {code, message}`. Every event has `sequence_number` (0-based, +1 per event) and `output_index`/`item_id`/`content_index` as the reference defines. SSE framing: `event: <type>\ndata: <json>\n\n`.
- Decoder: the inverse; unknown event types ignored with a debug line; `error` event → canonical `error`.
- Interleaved parallel calls (canonical rule 5) are serialised per `output_index`; the encoder never interleaves deltas of two items.

- [ ] **Step 1: Tests.** Fixture round trips for the five fixtures; `"sequence_number is contiguous"`; `"parallel calls each get their own output_index"`; `"interleaved canonical deltas are not interleaved on the wire"`; `"failed stream ends with response.failed and no response.completed"`; `"model in response.created and response.completed is the client's"`; property tests from `stream-properties.test.ts` pass for the new decoder/encoder; encoder stability registered.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; PR shows a streamed `curl -N` through `npm run dev`. **Commit** `feat: responses streaming`.

### Task 5: Custom tools and built-in tools, all adapters

Spec §3.6, E3.

**Files:**
- Create: `src/transformers/custom-tools.ts`
- Modify: `responses.adapter.ts`, `responses.stream.ts`, `openai.adapter.ts`, `anthropic.adapter.ts` (`parallelToolCalls` only), `src/services/attempt-targets.ts`, `src/services/chat.service.ts`, `src/services/chat-stream.service.ts`, `src/observe/tool-diagnostics.ts`, `src/observe/tool-repair-stream.ts`, `docs/decisions.md`
- Test: `src/transformers/custom-tools.test.ts`, `responses.adapter.test.ts`, `openai.adapter.test.ts`, `anthropic.adapter.test.ts`, `src/observe/tool-diagnostics.test.ts`, `tool-repair-stream.test.ts`, `tests/integration/codex.test.ts`

**Interfaces:**
- Responses decode: `tools[{type: "custom", name, description, format}]` → canonical custom tool; `custom_tool_call {call_id, name, input}` → `toolCalls[{…, custom: true, arguments: input}]` (raw string); `custom_tool_call_output` → tool message. Built-in tool types (`web_search`, `web_search_preview`, `file_search`, `code_interpreter`, `computer_use_preview`, `image_generation`, `tool_search`, `mcp`, `local_shell`) → dropped with `builtin_tool_dropped` (path `tools[i]`); a `tool_choice` naming one → `auto` with a note. Unknown input item types → dropped with `field_dropped`.
- Responses encode: a `custom: true` call → `custom_tool_call` item (`input`); streaming → `response.custom_tool_call_input.delta`/`.done`.
- Produces in `src/transformers/custom-tools.ts` (no adapter imports): `lowerCustomTools(req: CanonicalRequest): CanonicalRequest` — each custom tool → function `{name, description: <description> + "\n\nInput format (" + syntax + "):\n```\n" + definition + "\n```", parameters: {type: "object", properties: {input: {type: "string"}}, required: ["input"]}}` (`format.type: "text"` or none → no suffix); each `custom: true` call in history → `arguments: JSON.stringify({input: arguments})`, `custom` removed. `raiseCustomCalls(resp: CanonicalResponse, req: CanonicalRequest): CanonicalResponse` — a call whose name is a custom tool of `req` → `custom: true`, `arguments` = parsed `.input`; unparseable or no string `input` → raw arguments kept + `custom_input_unparsed` note. `createCustomCallTransform(req: CanonicalRequest): (e: CanonicalStreamEvent) => CanonicalStreamEvent[]` — holds start/deltas of custom-named calls and releases `tool_call_start {custom: true}`, one delta with the raised input, then `tool_call_end`.
- Services: `canonicalForTarget` applies `lowerCustomTools` when `entry.type !== "responses"`; the services apply `raiseCustomCalls` / the transform (before the repair transform) for the same targets. The four existing adapters gain no custom-tool code.
- `parallelToolCalls: false` → OpenAI Chat `parallel_tool_calls: false`, Anthropic `tool_choice.disable_parallel_tool_use: true`, Responses `parallel_tool_calls: false`; Gemini, Ollama: `field_dropped` note. Decoded only by the Responses decoder (other decoders unchanged).
- Diagnostics and repair skip `custom: true` calls.

- [ ] **Step 1: Tests.** `custom-tools.test.ts`: `"custom tool becomes a one-string function"` (exact description and parameters above); `"custom call history lowers to {input}"`; `"function call for a custom tool raises to custom"`; `"unparsed custom input kept raw with a note"`; `"stream transform raises a split {input} across deltas"`. Integration: `"custom tool reaches a gemini upstream as a function and returns as custom_tool_call"`. Responses: `"web_search dropped with builtin_tool_dropped"`; `"tool_choice naming a dropped tool becomes auto"`; `"custom_tool_call round-trips"`; stream `"custom input streams as custom_tool_call_input deltas"`. Observe: `"custom tool input is never diagnosed or repaired"` (Review Focus 4: input ```` "*** Begin Patch\n```\n{\n```" ```` with repair on → client receives it byte-identical, zero diagnostics, zero repairs). Non-Responses: `"anthropic source unchanged"` (an Anthropic request with only function tools encodes byte-identical to 1.3 for every target).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: custom and built-in tools`.

### Task 6: Reasoning config mapping, all adapters

Spec §3.3 (first table), D2. Each target's field names and limits from its docs, URL per field in decisions.

**Files:**
- Create: `src/transformers/reasoning-effort.ts`
- Modify: `responses.adapter.ts` (decode `reasoning`, `include`), `openai.adapter.ts`, `anthropic.adapter.ts`, `gemini.adapter.ts`, `ollama.adapter.ts` (encode only), `docs/decisions.md`
- Test: each `*.adapter.test.ts`, `src/transformers/reasoning-effort.test.ts`

**Interfaces:**
- Produces `EFFORT_LADDER = ["none","minimal","low","medium","high","xhigh"] as const`; `nearestSupported(effort, supported: readonly Effort[]): Effort` (nearest **lower** supported level; `none` if none lower); `budgetFor(effort): number` = `{minimal: 1024, low: 2048, medium: 8192, high: 24576, xhigh: 32000}` (`none` → 0). Pure, no provider names.
- Only the Responses decoder produces `config.reasoning`; the other four decoders keep dropping their reasoning fields with today's notes (1.3 behaviour, spec §3.3).
- Encoders: Responses `reasoning: {effort, summary: "auto" when summary}` and `include: ["reasoning.encrypted_content"]`; OpenAI `reasoning_effort` (levels per docs, `nearestSupported`); Anthropic per the target model's docs — adaptive thinking + effort where supported, else `thinking: {type: "enabled", budget_tokens: budgetTokens ?? budgetFor(effort)}` with `max_tokens` raised to `budget + 1024` when lower (`max_tokens_raised` note); `none` → no thinking field; Gemini `thinkingConfig.thinkingLevel` (`includeThoughts: summary`); Ollama `think` per its docs. Which Anthropic models take adaptive is a list in `anthropic.adapter.ts` with the doc URL, never a hostname rule.
- A non-supported level → `nearestSupported` + `reasoning_effort_lowered` note.

- [ ] **Step 1: Tests.** `reasoning-effort.test.ts`: `"xhigh on a high-max target becomes high"`; `"minimal on low-min target becomes none"`; budgets as above. Per adapter: one case per effort level present in that target's table. `"responses decoder produces config.reasoning"`; per non-Responses decoder `"reasoning fields still dropped"` (an Anthropic request with `thinking`, a Chat request with `reasoning_effort`, a Gemini request with `thinkingConfig`, an Ollama request with `think` → no `config.reasoning`, today's note; the encoded upstream body for each, to every target, byte-identical to 1.3). `"max_tokens raised above the budget with a note"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: reasoning effort mapping`.

### Task 7: Reasoning parts + signatures: Anthropic, Gemini · D7 fixture change

Spec §3.3 (decoders, encoders), E7, E8.

**Files:**
- Modify: `anthropic.adapter.ts`, `anthropic.messages.ts`, `anthropic.stream.ts`, `gemini.adapter.ts`, `gemini.tools.ts`, `gemini.stream.ts`, `tests/fixtures/streams/gemini/parallel_tool_calls.json` (D7 signature only), `docs/decisions.md`
- Test: `anthropic.adapter.test.ts`, `gemini.adapter.test.ts`, `tests/contracts/stream-decoders.test.ts`

**Interfaces:**
- Consumes: `currentAttempt()`; Task 2 types.
- Decoders (target replies): Anthropic `thinking {thinking, signature}` → reasoning part `{text, origin}` + `signature {origin, data: signature}`; `redacted_thinking {data}` → `{redacted: true, origin}` + `signature.data = data`; stream `thinking_delta` → `reasoning_delta`, `signature_delta` → `reasoning_signature`. Gemini part `thought: true` → reasoning part text; `thoughtSignature` on a `functionCall` → that tool call's `signature`; on a text part → that text part's `signature`; on a thought part → that reasoning part's `signature`. `origin = {provider: currentAttempt().providerName, model: currentAttempt().upstreamModel}`; outside an attempt (unit tests) `origin = {provider: "", model}` and encoders drop it.
- Encoders (target requests): reasoning parts and signatures with matching origin go back in place — Anthropic blocks before the `tool_use`/text they preceded, in original order; Gemini signatures on the part they came on; a `functionCall` with no matching signature keeps the v1.3 placeholder; non-matching → `reasoning_dropped` note.
- Anthropic/Gemini as **source**: unchanged (thinking blocks from clients still dropped with today's notes; no reasoning parts emitted to these clients — encoders of client replies skip reasoning parts).

- [ ] **Step 1: Tests.** `"thinking block round-trips with its signature"`; `"redacted_thinking round-trips"`; `"thinking before tool_use keeps its position"`; `"gemini signature returns on its functionCall"`; `"gemini text-part signature returns on its text part"`; `"placeholder only when no signature"`; `"foreign origin dropped with a note"` (same provider, other model → dropped); `"anthropic client never receives thinking"`; `"gemini client never receives thought parts"`; stream: `"thinking_delta and signature_delta decoded"`. The D7 fixture: expected first function call gains `signature: {origin: {provider: "", model: "gemini-2.5-flash"}, data: "<the recording's thoughtSignature>"}` — the exact `origin` the fixture harness produces; nothing else changes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → only the D7 fixture guard failure; `git diff --stat origin/main -- tests/fixtures` lists only `parallel_tool_calls.json`. **Commit** `feat: anthropic and gemini reasoning signatures`.

### Task 8: Reasoning: OpenAI-compatible, Ollama, Responses envelope; continuity guard

Spec §3.3 (envelope, passback, guard), §3.2 (origin).

**Files:**
- Create: `src/transformers/adapters/responses.envelope.ts`
- Modify: `responses.adapter.ts`, `responses.stream.ts`, `openai.adapter.ts`, `openai.stream.ts`, `ollama.adapter.ts`, `ollama.stream.ts`, `anthropic.adapter.ts` (continuity guard), `src/routing/registry.ts`, `src/config/gateway.schema.ts`, `src/config/yaml-config.ts` (`reasoning_passback`), `src/services/attempt-targets.ts` (strip `reasoning_content` passback unless the entry has it), `docs/decisions.md`
- Test: `responses.envelope.test.ts`, `responses.adapter.test.ts`, `openai.adapter.test.ts`, `ollama.adapter.test.ts`, `anthropic.adapter.test.ts`, `tests/integration/codex.test.ts`

**Interfaces:**
- Produces `packEnvelope(parts: EnvelopePayload): string | undefined` (`"bg1." + base64url(JSON)`, undefined when > 1 048 576 bytes) and `unpackEnvelope(s: string): EnvelopePayload | undefined` (undefined unless `bg1.` and valid), `EnvelopePayload = {v: 1; reasoning: CanonicalContentPart[]; signatures: {toolCallId?: string; textIndex?: number; signature: CanonicalReasoningSignature}[]}`.
- Responses encoder: one `reasoning` output item per assistant turn that has reasoning parts or signatures: `{type: "reasoning", id: "rs_…", summary: [{type: "summary_text", text}] (when text), encrypted_content: packEnvelope(...)}`, before the message/function_call items; over the cap → item without `encrypted_content` + `reasoning_dropped` (`envelope_too_large`). Stream: `output_item.added` (reasoning) → `response.reasoning_summary_part.added` → `response.reasoning_summary_text.delta`* → `.done` → `reasoning_summary_part.done` → `output_item.done` (with `encrypted_content`).
- Responses decoder: `reasoning` input items → `unpackEnvelope` → reasoning parts/signatures re-attached to the following assistant turn; a non-`bg1.` `encrypted_content` → dropped with `reasoning_dropped` on the bridge (the pass-through path never decodes, Task 10).
- OpenAI decode `message.reasoning_content` / `message.reasoning` (and stream deltas) → reasoning part, no signature; encode back as `reasoning_content` whenever the canonical request carries such parts; `canonicalForTarget` removes reasoning parts for `openai`/`ollama` targets unless `entry.reasoningPassback` (adapters stay config-free). Produces `ProviderEntry.reasoningPassback?: boolean` (YAML `reasoning_passback`, default off). Ollama `message.thinking` ↔ reasoning part (encode back only with `reasoning_passback`).
- Anthropic continuity guard: thinking enabled AND the last assistant message containing tool calls has no reasoning part of the current origin → omit `thinking`, `reasoning_dropped` note `thinking_disabled_no_prior_block`.

- [ ] **Step 1: Tests.** Envelope: `"pack/unpack round-trip"`; `"not bg1 → undefined"`; `"corrupt base64 → undefined, no throw"`; `"envelope over cap is omitted with a note"` (Review Focus 3: a 1.2 MB reasoning text → item without `encrypted_content`, note present, request still 200). Responses: `"reasoning item precedes the call it explains"`; `"summary text streams as reasoning_summary_text deltas"`. OpenAI: `"reasoning_content decoded"`; `"passback only with reasoning_passback"`. Ollama: `"thinking decoded; passback only with the flag"`. Anthropic: `"continuity guard disables thinking after a foreign turn"`. codex.test.ts: `"provider switch mid-session drops foreign reasoning"` (Review Focus 1: three turns, turn 2 served by a fallback provider (mock Gemini 500 → Anthropic), turn 3 back on Gemini; every turn 200; turn-3 Gemini upstream body has turn-1's Gemini signature and nothing from Anthropic; turn 2's Anthropic body has no Gemini data and no `thinking`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: reasoning envelope and passback`.

### Task 9: Structured output, all five adapters

Spec §3.5, E5. Field names per provider doc, URL per field in decisions.

**Files:**
- Modify: `responses.adapter.ts`, `openai.adapter.ts`, `anthropic.adapter.ts`, `gemini.adapter.ts`, `ollama.adapter.ts`, matching `src/types/*.types.ts`, `docs/decisions.md`
- Test: each `*.adapter.test.ts`, `tests/integration/codex.test.ts`

**Interfaces:**
- Decode/encode exactly the spec §3.5 table. Anthropic encode of `json_object` → throw the canonical `invalid_request` error with `code: "unsupported_response_format"` (400 in the client's dialect). Gemini decode accepts `responseSchema` too (→ the same canonical schema, unchanged); Gemini encode always uses `responseJsonSchema` + `responseMimeType: "application/json"`.
- The schema object is passed by reference-equal value: encoders must not clone-and-edit it (test with `Object.freeze` deep).

- [ ] **Step 1: Tests.** Per adapter: `"json_schema round-trips unchanged"` (a frozen schema with `$ref`, `anyOf`, `minimum` → upstream body deep-equals it); `"json_object mapping"`; Anthropic `"json_object is a 400 unsupported_response_format"`. Integration: `"schema rejected upstream surfaces as a responses error"` (Review Focus 5: streaming Responses request, Gemini mock answers 400 before the first byte → client HTTP 400 in the Responses envelope, not SSE; trace status error; one hop).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS. **Commit** `feat: structured output across formats`.

### Task 10: Pass-through

Spec §3.4.

**Files:**
- Create: `src/services/passthrough.ts`
- Modify: `src/services/proxy.service.ts`, `src/services/chat.service.ts`, `src/services/chat-stream.service.ts`, `src/observe/trace.ts` (`passthrough: boolean`), `docs/decisions.md`
- Test: `src/services/passthrough.test.ts`, `tests/integration/codex.test.ts`, `tests/integration/observe.test.ts`

**Interfaces:**
- Produces `isPassthrough(source: Provider, entry: ProviderEntry): boolean` (`source === "responses" && entry.type === "responses"`).
- Request: body forwarded with only `model` → upstream model and `max_output_tokens` clamped by `entry.maxOutputTokens` (same clamp record as v1.3). Reply/stream: bytes relayed; in `response.created`, `response.in_progress`, `response.completed`, `response.incomplete`, `response.failed` (stream) and the non-stream body, `response.model` restored to the client's model by a JSON round-trip of **those events only**; every other event's bytes are untouched.
- Trace: `passthrough: true`; usage from `response.completed.response.usage` (Task 3 mapping); snapshots `source`, `target`, `response.wire` (no canonical stages); tool-call diagnostics on the `function_call` items of the final response; repair never applied.
- Fallback to a non-`responses` entry → the bridged path via the Responses adapter, unchanged.

- [ ] **Step 1: Tests.** `"only model is rewritten in the forwarded body"` (byte compare after replacing model); `"stream relayed byte-identical except model in lifecycle events"`; `"usage and cost from response.completed"`; `"inspector stages for pass-through"`; `"fallback to a gemini entry is bridged"`; `"aborted pass-through emits one trace"` (Review Focus 2: client closes after 2 deltas → one trace, `status: "aborted"`, no usage, upstream aborted). `"repair_tool_calls ignored on pass-through"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS; PR shows Codex-shaped `curl -N` through `npm run dev` to a `type: responses` OpenRouter entry (keys redacted). **Commit** `feat: responses pass-through`.

### Task 11: Pair matrix 5×5; structured output per target; multi-turn Codex replay

Spec §4.2.

**Files:**
- Modify: `tests/integration/pairs.test.ts`, `tests/integration/stream-pairs.test.ts`, `tests/mocks/upstreams.ts` (Responses upstream mock; reasoning and structured-output replies opt-in per test, each event/field citing its doc in a comment), `tests/integration/codex.test.ts`, `tests/integration/privacy-canary.test.ts` (reasoning text, signature, custom input, schema sentinels), `docs/decisions.md`
- Test: as above

**Interfaces:**
- Consumes: everything above; `tests/fixtures/codex/turns.json`.

- [ ] **Step 1: Tests.** `"every pair: plain, stream, tools, stream × tools"` for 25 source × target pairs (existing 16 unchanged); `"structured output reaches every target"` (5 sources × 5 targets, schema deep-equal upstream); `"codex replay three turns on gemini"` and `"… on anthropic"` (the recorded turns with reasoning on: turn 2 and 3 upstream bodies carry turn 1's signatures; no `reasoning_dropped` notes); privacy canary: the four new sentinels never reach log, `/metrics`, OTel, `/ui/api/live`, `/ui/api/routing`, `requests`.
- [ ] **Step 2: Run**; fix only test wiring/mocks here. A failure caused by an adapter → fix in the adapter with the test that shows it, listed in the decisions entry; if it would change an existing expected value, STOP. **Step 3:** `./scripts/check.sh` → PASS. **Commit** `test: 5x5 pairs and codex replay`.

### Task 12: UI inspector + usage store `reasoning_tokens`

Spec §3.4 (inspector), §1.3.

**Files:**
- Modify: `src/observe/sinks/usage-store.ts` (migration 2: `ALTER TABLE requests ADD COLUMN reasoning_tokens INTEGER`), `src/observe/sinks/usage-queries.ts`, `src/ui-api/requests.ts`, `ui/src/screens/Inspector.tsx`, `ui/src/screens/Requests.tsx`, `ui/src/api.ts`, `docs/decisions.md`
- Test: `usage-store.test.ts`, `ui/src/screens/Inspector.test.tsx`, `Requests.test.tsx`

**Interfaces:**
- Store: `reasoning_tokens` written from `trace.usage.reasoningTokens` (NULL when absent); a v1 DB migrates to v2 on open without data loss.
- Inspector: reasoning parts shown as collapsible "reasoning" blocks; signatures and envelope data rendered as `<signature: N bytes, origin provider/model>`, never the bytes; pass-through requests show the source and target stages and a "pass-through" badge; Requests list shows the badge.

- [ ] **Step 1: Tests.** `"v1 database migrates to v2"`; `"reasoning_tokens stored"`; `"signature bytes never rendered"` (sentinel signature absent from the DOM); `"pass-through badge"`. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4:** `./scripts/check.sh` → PASS (UI smoke included). **Commit** `feat(ui): reasoning parts and pass-through in the inspector`.

### Task 13: Codex recipe, examples, README, architecture doc, launch draft

Spec §3.8.

**Files:**
- Create: `docs/recipes/codex.md`, `docs/launch/v1.4-codex.md`, `examples/codex-gemini.yaml`, `examples/codex-anthropic.yaml`, `examples/codex-openrouter.yaml`
- Modify: `README.md` (Codex in the entry-point list; five formats), `docs/architecture.md` (fifth adapter, pass-through, reasoning origin), `docs/recipes/README.md` (if it indexes recipes), `tests/contracts/test-config.test.ts` (examples parse), `docs/decisions.md`

- [ ] **Step 1: Test** `"codex examples parse"` (each example loads through the YAML config loader). **Step 2: Write.** Recipe: `~/.codex/config.toml` block (`model_provider = "babelgate"`, `[model_providers.babelgate] name, base_url = "http://localhost:3000/v1", wire_api = "responses", env_key = "BABELGATE_KEY"`), `web_search = "disabled"`, native vs bridged table (spec E4) saying what babelgate adds on native paths, reasoning carried on Gemini/Claude, `reasoning_passback` for DeepSeek, limitations (§2.2). Examples: Gemini 3.x with `reasoning` effort medium; Anthropic (direct key, or OpenRouter's Anthropic endpoint if Task 1 proved it); OpenRouter `type: responses`, `qwen/qwen3-coder`, `live_prices: true`. Launch draft: ≤ 600 words, headline "Codex on Gemini and Claude". **Step 3:** `./scripts/check.sh` → PASS. **Commit** `docs: codex recipe, examples, launch draft`.

### Task 14: Live-suite cases; `codex-edit.sh`; gates A, B, C · OWNER REVIEW

Spec §4.4, §4.5, D4. Owner runs the gates; conductor supports.

**Files:**
- Create: `tests/live/codex.live.test.ts`, `scripts/gates/codex-edit.sh`
- Modify: `tests/live/live.helpers.ts`, `scripts/gates/observe-check.ts` (`--expect-no-note <code>`, `--expect-passthrough`), `scripts/gates/observe-check.test.ts`, `docs/decisions.md`

**Interfaces:**
- `codex-edit.sh config <yaml>`: starts babelgate with the YAML, writes a temp `CODEX_HOME/config.toml` pointing at it, runs `codex exec` on a temp copy of `scripts/gates/fixtures/edit-task`, verifies the edit as `claude-code-edit.sh` does → `GATE PASS`/`GATE FAIL`; with `OBSERVE_CHECK=<flags>` runs `observe-check.ts --client codex <flags>`.
- `observe-check.ts --expect-no-note reasoning_dropped` fails if any row since start has that note; `--expect-passthrough` requires every row to be pass-through.

- [ ] **Step 1: Live tests** (skipped without keys): Responses source → Gemini 3.x, Anthropic (or OpenRouter Anthropic per Task 1), OpenRouter `type: responses`: `"plain"`, `"stream"`, `"tools"`, `"three-turn tool loop with reasoning"` (200 every turn), `"structured output parses and matches"`. Owner runs `npm run test:live` and pastes the summary.
- [ ] **Step 2: Gates** (owner, recorded in decisions: Codex version, models, duration, cost):
  - **A:** `OBSERVE_CHECK="--expect-cost --expect-no-note reasoning_dropped" scripts/gates/codex-edit.sh config examples/codex-gemini.yaml` → `GATE PASS` + `OBSERVE PASS`.
  - **B:** same with `examples/codex-anthropic.yaml` (the cheapest current Claude model with thinking, recorded). No working Anthropic path → STOP: owner decision.
  - **C:** `OBSERVE_CHECK="--expect-cost --expect-passthrough" scripts/gates/codex-edit.sh config examples/codex-openrouter.yaml` → `GATE PASS` + `OBSERVE PASS`.
- [ ] **Commit** `docs: v1.4 release gate results`.

### Task 15: CHANGELOG, roadmap, `1.4.0` · OWNER GATE

**Files:**
- Modify: `CHANGELOG.md` (`## [1.4.0]` + compare link), `package.json` / `package-lock.json` (version, root entries only), `docs/roadmap.md` (status: v1.4 released, next v1.5; v1.4 size M → L; v1.5 entry notes that reasoning for non-Responses sources moved there from v1.4's scope), `src/cost/prices.json` (refresh), `docs/decisions.md`

- [ ] **Step 1:** `npm run update:prices -- <latest LiteLLM commit>`; commit separately as `chore: refresh bundled prices`.
- [ ] **Step 2:** CHANGELOG: Added (Responses API source and target, Codex entry point, pass-through to Responses-native upstreams, reasoning carried for Codex, custom tools, structured output across formats, `type: responses`, `reasoning_passback`, inspector reasoning view); Changed (Gemini thinking tokens now counted in output tokens and cost; `reasoning_tokens` in the usage store); Known limitations (spec §2.2: stateless only, built-in OpenAI tools dropped on the bridge, reasoning carried only for Responses clients).
- [ ] **Step 3:** `./scripts/check.sh` → PASS. **Commit** `chore: release 1.4.0`. Owner: tag `v1.4.0`, `npm publish --access public` (staged-version visibility can take ~20 min), GHCR image via the tag, verify `npx -y babelgate@1.4.0 --help` and `/ui` loads.
