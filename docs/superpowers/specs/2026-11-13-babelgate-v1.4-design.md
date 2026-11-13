# babelgate v1.4 — Design Spec ("Codex on any model")

**Date:** 2026-11-13 · **Status:** design approved section by section by the owner on 2026-11-13; this
written spec awaits owner review · **Roadmap:** `docs/roadmap.md` (Phase 2, v1.4) ·
**Parent specs:** `2026-10-26-babelgate-roadmap-design.md`, `2026-11-04-babelgate-roadmap-revision-design.md` ·
**Previous version:** `2026-11-04-babelgate-v1.3-design.md`

## 1. Purpose

Codex CLI works through babelgate on models that don't speak OpenAI's Responses API — Gemini and Claude
first — with streaming, tools (including Codex's freeform `apply_patch`) and the model's own reasoning
carried from turn to turn. Where an upstream already serves Responses, babelgate forwards it unchanged and
still routes, traces, prices and shows it in `/ui`. Structured output (JSON schema) works across all five
formats.

### 1.1 Why this shape
The 2026-11-04 roadmap revision made Codex a launch-sized entry point: Codex CLI speaks only Responses
(`wire_api = "chat"` removed February 2026). The competitor check (2026-11-13, §1.2) found that most
backends Codex users pick now serve `/v1/responses` themselves (Ollama, LM Studio, vLLM, OpenRouter, Groq,
Together, DeepSeek). The ones that still need a translator are **Gemini, Anthropic, Bedrock and Chat-only
servers**. So v1.4 is two things (D1): a **bridge** (the Responses adapter, through canonical) for those,
and a **pass-through** for native upstreams, where babelgate's value is routing, fallbacks and the v1.3
observability, not translation. The headline is "Codex on Gemini and Claude"; recipes name the native
paths and say what babelgate adds on them.

Codex runs long tool loops. Dropping the model's reasoning between turns degrades those loops on thinking
models (Gemini 3, Claude with thinking), so v1.4 carries reasoning opaquely (D2), pulling part of v1.5's
"reasoning" forward.

### 1.2 Evidence (read from the code on main, Codex source and provider docs, 2026-11-13)
| # | Finding | Where | Effect |
|---|---|---|---|
| E1 | Codex sends `stream:true`, `store:false`, `tool_choice:"auto"`, `parallel_tool_calls`, `reasoning{effort,summary}`, `include:["reasoning.encrypted_content"]`, `prompt_cache_key`, `text{verbosity,format?}`; no `previous_response_id` over HTTP (WebSocket only, off for custom providers); every turn resends the full input, reasoning items included | `openai/codex` `codex-rs/core/src/client.rs` (`build_responses_request`) | Stateless Responses is enough; reasoning items must round-trip |
| E2 | Codex's SSE parser handles `response.created/in_progress/completed/failed/incomplete`, `output_item.added/done`, `content_part.*`, `output_text.delta/done`, `function_call_arguments.delta/done`, `custom_tool_call_input.delta/done`, `reasoning_summary_part.*`, `reasoning_summary_text.*`, `reasoning_text.delta`, `refusal.delta` | `codex-rs/codex-api/src/sse/responses.rs` | The event set the stream encoder must produce and be tested against |
| E3 | `apply_patch` is a freeform **custom tool** with a grammar (or absent, by model metadata); shell is function tools; Codex also sends `web_search`, `tool_search`, MCP and multi-agent tools, which non-OpenAI upstreams reject | Codex source; opper.ai codex-router write-up | Custom tools need a canonical form; built-in tools need a defined fate |
| E4 | Native `/v1/responses`: Ollama (stateless), LM Studio, vLLM, OpenRouter (beta, stateless), Groq (beta), Together, DeepSeek; **not** Gemini's OpenAI endpoint, **not** Anthropic | provider docs (competitor check) | Pass-through for these; bridge for the rest |
| E5 | Anthropic has native structured output (`output_config.format`, `type:"json_schema"`, GA); Gemini `responseJsonSchema` (JSON Schema) or `responseSchema` (OpenAPI subset) with `responseMimeType`; Ollama `format`; OpenAI Chat `response_format` | provider docs | Native mapping everywhere; no tool-call emulation |
| E6 | The canonical format has no structured output, reasoning or custom-tool fields | `src/types/canonical.types.ts` | Interface change (§3.2), owner review |
| E7 | The Anthropic adapter drops the `thinking` request field and `thinking`/`redacted_thinking` blocks (`thinking_dropped` note) | `anthropic.adapter.ts`, `anthropic.messages.ts` | Claude with thinking needs the reasoning config and parts |
| E8 | The Gemini request encoder puts the placeholder `thoughtSignature: "skip_thought_signature_validator"` on every outgoing `functionCall`; real signatures in canonical were deferred (v1.3 Task 17, decision 1b) | `gemini.adapter.ts`, `gemini.tools.ts` | Real signatures replace the placeholder when present |
| E9 | Gemini usage ignores `thoughtsTokenCount`, so output tokens and cost for thinking models are undercounted | `gemini.adapter.ts` `geminiUsageToCanonical` | Fixed with reasoning-token usage (§3.2) |
| E10 | Client identity already maps a `codex` User-Agent to `client=codex` | `src/observe/client-id.ts` | Observability for Codex needs no new identity work |
| E11 | Source detection is pure method + path + headers; four formats today | `src/routing/detect-source.ts` | `POST /v1/responses` becomes the fifth source |
| E12 | Codex picks a request shape per model from the models-manager catalog: longest-prefix `slug` match, then a single `namespace/` suffix retry, else fallback metadata — which sets `apply_patch_tool_type: None`, no default reasoning effort, `support_verbosity: false`, `use_responses_lite: false`; a catalog slug (`gpt-6-luna`) gets the responses-lite shape (E15) | `codex-rs/models-manager/src/manager.rs` (`find_model_by_longest_prefix`, `find_model_by_namespaced_suffix`), `model_info.rs` (`model_info_from_slug`), `models.json`; `tests/fixtures/codex/recording.jsonl` | v1.4 targets the fallback shape — what every non-OpenAI model name sends; a `model_catalog_json` entry (Task 14) can turn effort and `apply_patch` on |
| E13 | Codex sends a `namespace` tool — `{type:"namespace", name, description, tools:[…function tools]}` — `multi_agent_v1` nesting `spawn_agent`, `send_input`, `wait_agent`, `resume_agent`, `close_agent` | `tests/fixtures/codex/recording.jsonl` | Bridge flattens nested function tools on decode and raises them back on encode (Tasks 3/5; owner decision A) |
| E14 | `web_search` arrives as a top-level tool `{type:"web_search", external_web_access}` on every fallback request | `tests/fixtures/codex/recording.jsonl` | Covered by §2.2: `builtin_tool_dropped` on the bridge, forwarded on pass-through |
| E15 | A catalog slug sends **responses-lite**: `x-openai-internal-codex-responses-lite` header; no top-level `tools` — an `additional_tools` input item instead (`functions`/`collaboration`/`clock` namespaces; `functions.exec` is `type:"custom"`, `format:{type:"grammar",syntax:"lark"}`); calls are `custom_tool_call{namespace}`/`custom_tool_call_output`; message `phase`; `reasoning{effort,context}`; `text{verbosity}`; `reasoning` items resent with `encrypted_content` | `tests/fixtures/codex/recording-responses-lite.jsonl` | Pass-through only in v1.4 (owner decision A); a Task 14 catalog entry must select the classic shape or STOP |
| E16 | `include` is `["reasoning.encrypted_content"]` on every request of both shapes | `tests/fixtures/codex/recording.jsonl`, `recording-responses-lite.jsonl` | Reasoning items must round-trip through pass-through and the envelope (§3.3) |
| E17 | Codex calls only `POST /v1/responses` — 21 requests across three runs; no `GET /v1/models`, no other path, no query params | `tests/fixtures/codex/recording.jsonl`, `recording-responses-lite.jsonl` | Source detection stays the one path (E11); no models endpoint needed for Codex |
| E18 | OpenRouter's Anthropic `/messages` returns a signed `thinking` block (`signature` present) for `anthropic/claude-haiku-4.5` | `scripts/gates/check-openrouter-anthropic.sh` run (decisions.md, v1.4 Task 1) | Gate B can run through OpenRouter; signature handling per §3.3 |
| E19 | OpenRouter's Responses SSE has no `event:` lines — the event type lives only in each `data:` payload's `type` | `tests/fixtures/codex/recording.jsonl` (`sseEvents` counted from payload types) | SSE tooling and any type-dependent relay must read the payload, like Codex's own parser (E2) |

### 1.3 Success criteria
1. Codex CLI completes the edit task through babelgate on **Gemini 3.x** (bridge, reasoning on) and on
   **Claude** (bridge, thinking on), and on **OpenRouter `qwen/qwen3-coder`** (pass-through) — gates A, B,
   C (§4.5).
2. On the bridge, the provider's reasoning survives every turn: no `reasoning_dropped` note in the
   inspector for same-provider turns, and Gemini receives real signatures, not the placeholder.
3. Every source × target pair, 5 × 5, passes the pair matrix for plain, streaming, tools and streaming ×
   tools; structured output passes for every target.
4. No existing expected value, fixture or contract snapshot changes, except the two Gemini stream fixtures
   the owner approved in advance (D7). New fields are emitted only when present.

## 2. Scope

### 2.1 In v1.4
- The **Responses adapter**: source and target; requests, replies, stream decoder and encoder; function
  tools and custom (freeform) tools; reasoning items; usage; errors.
- **Pass-through** of Responses requests to upstreams that speak Responses (§3.4).
- **Canonical changes** (§3.2): reasoning config, reasoning parts and signatures, custom tools, response
  format, reasoning-token usage.
- **Reasoning carried** on the Anthropic, Gemini, OpenAI(-compatible) and Ollama adapters as targets, and on
  the Responses adapter as a source (§3.3).
- **Structured output** across all five formats (§3.5).
- **Codex recipe**, examples, gate script, gates A, B, C, launch-post draft.

### 2.2 Not in v1.4
- **Stateful Responses:** `previous_response_id`, `store: true`, `GET/DELETE /v1/responses/{id}`,
  `/v1/responses/compact`, conversations. A request that needs them gets a 400 naming the field (as
  OpenRouter does). Codex doesn't send them over HTTP (E1).
- **Built-in OpenAI tools on the bridge** (`web_search`, `file_search`, `code_interpreter`, `computer_use`,
  `image_generation`, `tool_search`, MCP server tools): dropped with a `builtin_tool_dropped` note on the
  bridge; forwarded unchanged on pass-through. The recipe tells users to set `web_search = "disabled"`.
- **Reasoning carried for the other source formats** (Claude Code receiving Gemini thinking, Gemini CLI
  receiving Claude thinking): unchanged from v1.3 (dropped with a note). v1.5.
- **Responses Lite / `additional_tools`** (GPT-5.6 tool hoisting): OpenAI-model-only; unless the Task 1
  recording shows Codex sending it to a custom provider.
- Embeddings, media, audio — v1.5.

### 2.3 Non-goals
- Translating reasoning across providers. Reasoning from provider X is never sent to provider Y.
- Weakening a schema to fit a target. babelgate never strips schema keywords from a response format.
- A Codex-specific code path. Codex is a client of the Responses adapter like any other; no client branches.

## 3. Design

### 3.1 Architecture (the Responses API as a fifth adapter)
`src/transformers/adapters/responses.adapter.ts` (+ `responses.stream.ts`, `responses.tools.ts`,
`responses.reasoning.ts` as needed, `src/types/responses.types.ts`) implements `ProviderAdapter` like the
other four. It imports no other adapter (AGENTS.md rule). Source detection adds `POST /v1/responses`
(also `/responses` for clients whose base URL already ends in `/v1`). `GET /v1/models` keeps its OpenAI
shape, which Codex reads; Task 1's recording confirms what else Codex calls.

Provider config gains `type: responses` (an upstream that speaks Responses: OpenRouter, Ollama, vLLM, LM
Studio, Groq, Together, DeepSeek, OpenAI). Any source reaches it through the Responses adapter as a target;
a Responses source reaching it is **passed through** (§3.4). Env-only mode: `TARGET_API=responses`.
*(Builder's call, recorded: one provider type rather than a flag on `type: openai`, so a single OpenRouter
entry serves Claude Code and Codex alike.)*

Rejected alternatives (D1 discussion): chaining Responses → Chat → the OpenAI adapter (breaks adapter
independence; forces reasoning and custom tools into Chat's shape before canonical sees them); making
Responses the canonical format (rewrites four adapters and every contract test).

### 3.2 Canonical changes (interface change, OWNER REVIEW)
`canonical.types.ts` and `canonical.schema.ts` change together, in one task, logged in `docs/decisions.md`.

```ts
export interface CanonicalRequest {
  /* existing */
  responseFormat?: CanonicalResponseFormat;
  parallelToolCalls?: boolean;   // false honoured where the target supports it (§3.6)
}
export type CanonicalResponseFormat =
  | { type: "json_schema"; name: string; schema: Record<string, unknown>; strict?: boolean; description?: string }
  | { type: "json_object" };

export interface CanonicalConfig {
  /* existing */
  reasoning?: {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";   // Codex's full range; a target without
    summary?: boolean;                                                 // a level uses the nearest lower one, noted
    budgetTokens?: number;
  };
}

/** Where reasoning came from: the configured provider NAME and the upstream model that produced it. */
export interface CanonicalReasoningOrigin { provider: string; model: string }
/** An opaque reasoning artefact. Never interpreted, never sent to another provider or model. */
export interface CanonicalReasoningSignature { origin: CanonicalReasoningOrigin; data: string }

export interface CanonicalContentPart {
  type: "text" | "image" | "reasoning";          // "reasoning" new; assistant messages only
  /* existing */
  reasoning?: { text?: string; redacted?: boolean; origin: CanonicalReasoningOrigin };   // origin always set
  signature?: CanonicalReasoningSignature;      // on reasoning parts, and on text parts (Gemini)
}
export interface CanonicalToolCall { /* existing */ signature?: CanonicalReasoningSignature; custom?: boolean }

export type CanonicalTool =
  | { type: "function"; function: CanonicalFunction; cache?: CanonicalCacheHint }
  | { type: "custom"; name: string; description?: string; format?: { type: "text" } | { type: "grammar"; syntax: string; definition: string }; cache?: CanonicalCacheHint };

export interface CanonicalUsage { /* existing */ reasoningTokens?: number }   // included in outputTokens
```

Stream events gain `reasoning_delta { index, text }` and `reasoning_signature { index, signature }`;
the exact event shapes are the builder's, consistent with the existing stream rules (one content block
per index, deltas in order).

**Origin.** Every reasoning part and every signature carries `origin {provider, model}`: the configured
provider **name** (not type, so two Anthropic providers with different keys never exchange signatures) and
the upstream model (Gemini and Claude signatures are model-bound; a routing rule or alias can send the next
turn to another model on the same provider). Encoders keep reasoning parts and signatures only when both
match the current attempt's provider and model; otherwise they drop them with a `reasoning_dropped` note.
Reasoning without a signature (DeepSeek `reasoning_content`, Ollama `thinking`) is tagged the same way.

**How adapters know the attempt's provider and model.** A per-attempt ambient context, like v1.3's
`recordNote` (`src/observe/context.ts`): the services set `{providerName, upstreamModel}` before each
attempt's encode and decode, fallbacks included. The `ProviderAdapter` interface does not change. Adapters
may import only this accessor from `observe/`, as they import `recordNote` today. Recorded in
`docs/decisions.md`.

**`outputTokens` includes reasoning tokens** on every adapter (OTel convention, matches OpenAI and
Anthropic billing). Gemini's decoder adds `thoughtsTokenCount` (fixes E9: Gemini thinking-model cost was
low). `reasoningTokens` is emitted only when present and non-zero.

**Approved fixture changes (D7, exactly this scope).** `tests/fixtures/streams/gemini/text.json` and
`tests/fixtures/streams/gemini/parallel_tool_calls.json`: expected `outputTokens` 1 → 34 and 54 → 131, the
new `reasoningTokens` (33, 77), and in `parallel_tool_calls` the first function call's real
`thoughtSignature` as a canonical signature. Only Task 2 (usage) and Task 7 (signature) may touch them;
the `.sse` recordings never change. Each PR shows CI red with "FIXTURE GUARD FAILED … all other checks
passed" and the owner sets `ALLOW_FIXTURE_CHANGE`. Any other fixture or snapshot change is still an owner
gate.

### 3.3 Reasoning (D2: carried opaquely)

**Which sources turn reasoning on.** In v1.4 the reasoning config is mapped **only when the source is
Responses**, the one source that carries reasoning back (§2.2). Other sources keep v1.3 behaviour exactly:
Anthropic `thinking` and Chat `reasoning_effort` are still dropped with their existing notes, so Claude
Code → Claude and Claude Code → Gemini change nothing (no new thinking cost, no new failure mode).

**Request config.** `reasoning.effort` maps per target:
| Target | Encoding |
|---|---|
| Responses | `reasoning: {effort, summary: "auto" when summary}`, `include: ["reasoning.encrypted_content"]` |
| OpenAI Chat | `reasoning_effort` |
| Anthropic | Per Anthropic's current docs for the target model, verified in Task 6: adaptive thinking with an effort level where the model supports it, else `thinking: {type: "enabled", budget_tokens}` (starting budgets minimal 1024 / low 2048 / medium 8192 / high 24576 / xhigh 32000, or `budgetTokens` when given); `max_tokens` raised above the budget when needed, with a note. **Continuity guard:** if the request's last assistant turn with `tool_use` has no reasoning part of this origin (e.g. the previous turn was served by a fallback on another provider), thinking is turned off for this request with a `reasoning_dropped` note, since Anthropic rejects thinking-enabled tool loops whose last tool turn lacks a thinking block |
| Gemini | `thinkingConfig: {thinkingLevel, includeThoughts: summary}` for 3.x-style models, `thinkingBudget` from the same table otherwise; the choice is driven by which field the request decoder saw, else `thinkingLevel` |
| Ollama | `think: true` (or the level string where Ollama accepts one) |
The budget table is a starting point; the task verifies it against provider docs and records the source.
Only the Responses decoder produces `config.reasoning` in v1.4; the other decoders keep dropping their
reasoning fields exactly as in 1.3.

**Reasoning out of the upstream (decoders).** Anthropic `thinking` blocks → reasoning part (`text`,
signature = `{provider, data: block.signature}`); `redacted_thinking` → reasoning part `redacted: true`,
signature data = the block's `data`. Gemini parts with `thought: true` → reasoning text; `thoughtSignature`
on any part → that part's `signature`. OpenAI-compatible `reasoning_content` / `reasoning` (DeepSeek,
OpenRouter, vLLM) → reasoning part, no signature. Ollama `thinking` → reasoning part. Responses `reasoning`
items → reasoning parts with signature = `encrypted_content`.

**Reasoning into the upstream (encoders).** Each part goes back to the place it came from: Anthropic
blocks in their original position before the tool_use they preceded; Gemini signatures on the part they
came on (a `functionCall` with a real signature uses it; the placeholder stays only for calls with none);
`reasoning_content` back on the assistant message only for providers with the new flag
`reasoning_passback: true` (DeepSeek's thinking-mode tool loops need it; other OpenAI-compatible servers
may reject the field). Off by default, like v1.3's other per-provider flags. Signatures from another provider are dropped with a note (§3.2).

**The envelope (Responses source).** The Responses encoder emits one `reasoning` output item per
reasoning part group, with `summary` = visible reasoning text and `encrypted_content` =
`"bg1." + base64url(JSON{ p: providerName, parts: [...] })` — the canonical reasoning parts and the
tool-call/text signatures of that turn, verbatim. The Responses decoder recognises the `bg1.` prefix,
unpacks the parts back into canonical. Any other `encrypted_content` came from a native upstream through
pass-through; it is forwarded untouched when the request is passed through again, and dropped with a
`reasoning_dropped` note on the bridge (its origin can't be known, and it can't be useful elsewhere). Not encrypted: the data already
belongs to the client (it is the client's own conversation); integrity is the upstream's — a tampered
signature is rejected upstream as it would be without babelgate. Size: the envelope is capped at 1 MB per
item; over it, the item is emitted without `encrypted_content` and a `reasoning_dropped` note says why.
Reasoning summary text streams as `response.reasoning_summary_text.delta` (E2).

### 3.4 Pass-through (Responses → `type: responses`)
When the source is Responses and the routed target is `type: responses`, the request body is forwarded
with only `model` rewritten to the routed upstream model (and `max_output_tokens` clamped by the
provider's `max_output_tokens` cap, as v1.3 does for other formats). The reply or SSE stream is relayed
byte for byte, with `model` in `response.created`/`response.completed` restored to the name the client
asked for (as other formats do today).

Observability is unchanged in kind: the trace records route, hops, client, timings; usage and cost come
from `response.completed.response.usage` (`input_tokens`, `output_tokens`,
`input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`); the inspector shows source
and target stages (no canonical stage, marked "pass-through"); tool-call diagnostics run on the relayed
function calls (repair is off on pass-through — it would alter bytes). Fallbacks behave as today: before
the first byte, to any target; a non-`responses` fallback gets the bridged request.

Stateful fields are rejected **before** routing on both paths (§2.2), so pass-through and bridge agree.

### 3.5 Structured output (D3: native everywhere, never weakened)
| Format | Decode | Encode |
|---|---|---|
| Responses | `text.format {type:"json_schema", name, schema, strict}` / `{type:"json_object"}` | same |
| OpenAI Chat | `response_format {type:"json_schema", json_schema:{name, schema, strict}}` / `{type:"json_object"}` | same |
| Anthropic | `output_config.format {type:"json_schema", schema}` | same (name → not sent); `json_object` → a 400 `unsupported_response_format` (Anthropic has no schemaless JSON mode) |
| Gemini | `generationConfig.responseJsonSchema` (+ `responseMimeType:"application/json"`); `responseSchema` decoded too | `responseJsonSchema` + `responseMimeType`; `json_object` → `responseMimeType` only |
| Ollama | `format` (schema object or `"json"`) | same |
The schema is passed through unchanged; babelgate never strips or rewrites keywords (unlike tool
parameters for Gemini, which v1.2 sanitises). An upstream that rejects a schema returns its 400 through
the existing error mapping. Field names are checked against each provider's docs in the task (E5).

### 3.6 Custom tools and built-in tools
- **Custom tools on non-Responses targets** become a function tool with the same name, the description
  plus the grammar (Lark/regex definition, verbatim, in a fenced block) and one required string parameter
  `input`. The decoded call is marked `custom: true`, and the Responses encoder emits it as a
  `custom_tool_call` with `input` = the string (streamed as `custom_tool_call_input.delta`). Tool-call
  diagnostics treat a custom call's `input` as a string, never as JSON.
- **Responses → Responses (bridge, non-pass-through cases such as fallbacks)** keeps custom tools native.
- **Built-in tools** (§2.2) on the bridge: dropped with `builtin_tool_dropped`; a `tool_choice` naming a
  dropped tool becomes `auto` with a note.
- **`parallel_tool_calls`**: canonical `parallelToolCalls` (§3.2); `false` is honoured on targets that
  support it (OpenAI Chat, Responses, Anthropic `disable_parallel_tool_use`), noted as dropped elsewhere.
- **Where the custom-tool conversion lives:** in the services, not the adapters — `canonicalForTarget`
  lowers custom tools to function tools for non-Responses targets, and the decoded reply (or stream) is
  raised back to custom calls before the client encoder. The four existing adapters need no custom-tool
  code.

### 3.7 Errors and stream end
Responses errors use the OpenAI error envelope (`{error:{message,type,code,param}}`) on non-streaming
replies. Mid-stream errors emit `response.failed` with `response.error {code, message}`, then end the
stream; truncation emits `response.incomplete` with `incomplete_details.reason`
(`max_output_tokens` / `content_filter`). Names verified against the Responses API reference and Codex's
parser (E2).

### 3.8 Recipe, examples, launch draft
- `docs/recipes/codex.md`: `~/.codex/config.toml` `[model_providers.babelgate]` with `base_url =
  "http://localhost:3000/v1"`, `wire_api = "responses"`, `env_key`; `web_search = "disabled"`; which
  backends are native (and that babelgate adds routing, fallbacks, cost and the inspector there) vs bridged.
- `examples/codex-gemini.yaml`, `examples/codex-anthropic.yaml`, `examples/codex-openrouter.yaml`.
- `docs/launch/v1.4-codex.md` — draft for the owner; not published by the conductor.

## 4. Testing

### 4.1 Unit (no network)
Responses adapter round trips (request, reply, stream) against new fixtures in `tests/fixtures/responses.json`
(new file, not an existing fixture); reasoning envelope pack/unpack, size cap, foreign-provider drop;
custom-tool mapping both ways; every adapter's reasoning decode/encode (Anthropic thinking + redacted,
Gemini thought parts + signatures on function calls and text, DeepSeek `reasoning_content`, Ollama
`thinking`); response-format mapping per format; usage with reasoning tokens; stateful fields → 400.
The encoder-stability property test (v1.3) covers the Responses encoder and reasoning parts.

### 4.2 Integration (msw, mocked upstreams)
Pair matrix 5 × 5 (plain, stream, tools, stream × tools) plus structured output per target; pass-through
relays bytes and records usage/cost; Codex request recorded in Task 1 replayed against Gemini and
Anthropic mocks over three turns, asserting the signature reaches the upstream on turn 2 and 3.
**Mocks are ours** (judgment rule): every event and field name in the mocks cites the provider's doc or
Codex's parser in a comment.

### 4.3 Backwards compatibility
No existing expected value changes. The four existing formats behave as in 1.3 when no reasoning, custom
tool or response format is present. Non-Responses sources keep v1.3's reasoning behaviour exactly (§3.3):
their reasoning config is dropped as today, reasoning parts are not emitted to Anthropic, Gemini, OpenAI or
Ollama clients, and `thinking_dropped` notes stay where they are.

### 4.4 Live suite (opt-in)
Responses source → Gemini 3.x, Anthropic, OpenRouter (pass-through): plain, stream, tools, a three-turn
tool loop with reasoning on (expected 200 every turn), structured output (reply parses and matches the
schema).

### 4.5 Release gates (owner, OWNER REVIEW)
`scripts/gates/codex-edit.sh <config>` runs `codex exec` on the edit task with `OBSERVE_CHECK=1` support,
like `claude-code-edit.sh`.
| Gate | Run | Passes when |
|---|---|---|
| **A** | Codex → Gemini 3.x via the bridge, `reasoning.effort: medium` (`examples/codex-gemini.yaml`) | `GATE PASS`; `OBSERVE PASS --client codex --expect-cost`; no `reasoning_dropped` note on any row |
| **B** | Codex → Claude via the bridge, thinking on (`examples/codex-anthropic.yaml`; the cheapest current Claude model with thinking, recorded at gate time) | Same as A. Needs a working Anthropic key, or OpenRouter's Anthropic endpoint proven in Task 1 |
| **C** | Codex → OpenRouter `qwen/qwen3-coder`, `type: responses` (`examples/codex-openrouter.yaml`) | `GATE PASS`; `OBSERVE PASS --client codex --expect-cost`; inspector marks pass-through |

## 5. Task outline (the plan will detail these)
| # | Task | Gate |
|---|---|---|
| 1 | Codex traffic recording (Codex → a recording proxy → OpenRouter Responses): requests, SSE, models call; proves E1–E3 on the installed Codex version; checks OpenRouter's Anthropic endpoint for gate B | |
| 2 | Canonical changes §3.2 (types + schema + contract tests), Gemini `thoughtsTokenCount` | OWNER REVIEW (interface change; D7 fixture change) |
| 3 | Responses types, request/response decode + encode, errors, stateful 400s, source detection, `type: responses` config | |
| 4 | Responses stream decoder + encoder (full event set, E2) | |
| 5 | Custom tools and built-in tools (§3.6) across all adapters | |
| 6 | Reasoning config mapping (§3.3 table) on all adapters | |
| 7 | Reasoning parts + signatures: Anthropic and Gemini (decode, encode, stream; Gemini placeholder only as fallback) | D7 fixture change |
| 8 | Reasoning parts: OpenAI-compatible and Ollama; Responses envelope (pack/unpack, cap) | |
| 9 | Structured output (§3.5) on all five adapters | |
| 10 | Pass-through (§3.4) with trace, usage, cost, inspector stages | |
| 11 | Pair matrix 5 × 5 + structured output; multi-turn reasoning integration from the Task 1 recording | |
| 12 | UI: inspector shows reasoning parts (redacted signatures), pass-through marker; usage store `reasoning_tokens` column (migration) | |
| 13 | Codex recipe, examples, README, architecture doc, launch draft | |
| 14 | Live-suite cases; `codex-edit.sh`; gates A, B, C | OWNER REVIEW |
| 15 | CHANGELOG, roadmap, `1.4.0` | OWNER GATE |

## 6. Owner decisions (2026-11-13)
| # | Decision | Chosen |
|---|---|---|
| D1 | Which backends Codex reaches | Bridge (Gemini, Anthropic, Chat-only) **and** pass-through to native Responses upstreams |
| D2 | Reasoning on the bridge | Carried opaquely in `encrypted_content`; real Gemini signatures; part of v1.5's reasoning pulled forward |
| D3 | Structured output | Native per provider, schema never weakened (proposed by the conductor, not objected to) |
| D4 | Release gates | Codex on Gemini (A), on Claude (B), pass-through on OpenRouter (C) |
| D5 | Architecture | Responses as a fifth canonical adapter + separate pass-through path |
| D6 | Size | L (about 15 tasks) |
| D7 | Fixture changes | Pre-approved, exactly §3.2's two Gemini stream fixtures (usage in Task 2, signature in Task 7) |

**Owner actions:** review the canonical change (Task 2); provide a working Anthropic key (or accept
OpenRouter's Anthropic endpoint if Task 1 proves it) and keep `OPENROUTER_API_KEY` and `GEMINI_API_KEY`
funded; install Codex CLI for Task 1 and the gates; run the gates; tag `v1.4.0` and publish.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Codex changes its wire format mid-version (weekly releases) | Task 1 pins the Codex version used; gates record it; event set checked against Codex's parser source at that version |
| Mocks share our misunderstanding of reasoning events | Every mock event cites a doc or Codex source line; live three-turn cases; gates A and B |
| The canonical change breaks a pair | Fields optional and emitted only when present; 5 × 5 matrix; existing expected values unchanged |
| Reasoning envelopes bloat requests | 1 MB cap per item; Anthropic signatures are small; Gemini signatures bounded per part |
| Custom-tool grammar is too much for small models | The function description includes the grammar verbatim; gate C uses a capable model; noted in the recipe |
| Anthropic thinking budget table is wrong for some models | Budgets verified against docs in Task 6; `budgetTokens` passes through when the source has one |
| Pass-through hides a translation bug behind "native" | Pair matrix still covers Responses → canonical → Responses; gate C is pass-through only, A and B are bridge only |
| No working Anthropic key for gate B | Task 1 tests OpenRouter's Anthropic endpoint as the fallback; otherwise gate B is an owner decision before Task 14 |
