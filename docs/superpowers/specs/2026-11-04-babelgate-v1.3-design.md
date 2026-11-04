# babelgate v1.3 — Design Spec ("See what's happening")

**Date:** 2026-11-04 · **Status:** design approved section by section by the owner on 2026-11-04; this
written spec awaits owner review · **Roadmap:** `docs/roadmap.md` (Phase 2, v1.3) ·
**Parent specs:** `2026-10-26-babelgate-roadmap-design.md`, `2026-11-04-babelgate-roadmap-revision-design.md` ·
**Previous version:** `2026-10-29-babelgate-v1.2-design.md`

## 1. Purpose

A solo developer running babelgate locally can see every request: which client sent it, where it was
routed, what it cost, how it was translated at each stage, and where a model broke a tool call. Agent-CLI
users also get the fixes the 2026-11-04 roadmap revision added: a per-provider output-token cap, prompt
caching that survives translation, and Gemini CLI as a tested entry point.

### 1.1 Why this shape
The owner kept the full roadmap scope in one version and accepted the size: **L (about 2–3 months)**, not
the M the roadmap listed (D1). Tasks are ordered so user-visible pieces (Gemini CLI, the output cap,
caching) land first (§5). The audience is one developer on localhost (D2); network exposure is made safe
by default, and the multi-user shape waits for v2.x.

The competitor check (2026-11-04) found request logs, cost per request, Prometheus metrics, OTLP traces
with the GenAI conventions and usage charts to be table stakes (LiteLLM, Bifrost, Cloudflare AI Gateway).
**No competitor shows a request in source, canonical and target form side by side**, so the translation
inspector is the differentiator and gets the most design care.

### 1.2 Evidence (read from the code on main and from provider docs, 2026-11-04)
| # | Finding | Where | Effect |
|---|---|---|---|
| E1 | `RouteLogRecord` was designed as "the v1.3 usage-store row"; services fill hops and usage for every chat request, failures included | `routing/route-log.ts`, `services/attempt-targets.ts` | The trace extends it; no new collection path |
| E2 | The Anthropic adapter drops `cache_control` everywhere, including Anthropic → Anthropic | `anthropic.adapter.ts` | Cache breakpoints never reach any provider |
| E3 | `CanonicalUsage` has input/output/total only; `systemPrompt` is a plain string | `types/canonical.types.ts` | Cached tokens are lost; a system block can't carry a breakpoint |
| E4 | Gemini source routes serve `generateContent` and `streamGenerateContent` only | `PROVIDER_ROUTES` in `transformers/adapters/index.ts` | Gemini CLI calls `:countTokens`, so it likely fails today |
| E5 | The server listens on every interface (`app.listen(port)`, no host) | `src/index.ts` | A UI that shows prompts must not be open to the LAN by default |
| E6 | Adapters report lossy translation only through 8 `logger.debug` calls | `src/transformers/adapters/*` | The inspector can't explain why stages differ |
| E7 | `engines` is `>=20`; CI, release and Docker run Node 22; Node 20 reached end of life in April 2026 | `package.json`, `.github/workflows`, `Dockerfile` | `node:sqlite` (unflagged from 22.13) is available without a native dependency |
| E8 | v1.2 Gate 3 passed with Claude Code on OpenRouter `qwen/qwen3-coder`; users set `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000` by hand | `docs/decisions.md` (v1.2 Task 10) | The output cap and cloud-model gates follow from real use |
| E9 | Gemini CLI applies `GOOGLE_GEMINI_BASE_URL` only with `GEMINI_API_KEY` auth, sends the key in `x-goog-api-key`, and requires HTTPS unless the host is localhost | gemini-cli PR #25357 (merged 2026-04-15) and follow-up #26234 | Recipe constraints; the endpoint list must be recorded, not assumed |
| E10 | Gemini CLI 0.66.0 calls only `:generateContent` (non-streaming router/helper calls) and `:streamGenerateContent?alt=sse` (every chat turn); no `:countTokens` and no `embedContent` observed | `record-gemini-cli.sh` recording, 2026-11-04 | `:countTokens` stays implemented per plan pre-approval; `embedContent` stays 501 |
| E11 | The CLI's `functionDeclarations[]` use `parametersJsonSchema` (never `parameters`); history `functionCall` parts carry `id` + `thoughtSignature` (first parallel call only); `generationConfig` carries `thinkingConfig` | same recording | `parametersJsonSchema` alias decoded in Task 1; `thoughtSignature` needs a canonical slot → owner decision (see decisions.md v1.3 Task 1) |
| E12 | User-Agent is `GeminiCLI-tui/<version>/<model> (<os>; <arch>; terminal)` plus `x-goog-api-client: google-genai-sdk/<v>`; key travels in `x-goog-api-key` | same recording | §3.4's `GeminiCLI` pattern matches; recipe header list |
| E13 | With `thoughtSignature: "skip_thought_signature_validator"` on history `functionCall` parts, the same CLI run completes the edit task end-to-end against `gemini-3.8-flash` (the earlier run died on the first tool-history turn's 400) | `record-gemini-cli.sh` re-run, 2026-11-04 (`tmp/gemini-cli-records/20261104-165419.jsonl`) | Decision 1a validated live; real signature carry-through remains the follow-up |

### 1.3 Success criteria
- Every chat request (streaming and not, success and failure) produces one trace that reaches the log,
  the usage store, the body ring, `/metrics` and (when enabled) OTel. With the opt-in cap, cache hints and
  repair off, what the client receives changes only by the new cached-usage fields (§3.2).
- `/ui` shows the live request log, and for any of the last 50 requests the inspector shows all four stages
  plus translation notes, diagnostics and repairs.
- Cost is shown for every request whose model has a price, and as "unknown" (never $0) otherwise; local
  models show what they would have cost.
- Cached tokens round-trip through every source × target pair, and Claude Code → OpenRouter
  (Anthropic model) gets cache reads from the second turn on.
- The privacy canary (§4.1) passes: prompt text and keys appear only in the body ring, or in the `bodies`
  table with `LOG_BODIES=true`.
- The full existing suite, including the 16-pair streaming × tools matrix, passes with **no changed
  expected values**.
- Release gates A, A-cache, B and C (§4.5) pass.

## 2. Scope

### 2.1 In v1.3
1. Gemini CLI entry point: traffic recording, `:countTokens`, the gaps the recording proves, recipe (§3.10).
2. Per-provider output-token cap (§3.3).
3. Canonical cache hints and cached-token usage across all adapters; byte-stable prefixes (§3.2).
4. `RequestTrace`, client identity, sinks: log, usage store, body ring, metrics, OTel (§3.1, §3.4, §3.8).
5. Translation notes and body snapshots (§3.5).
6. Cost: bundled price table, overrides, live prices, would-have-cost (§3.6).
7. Tool-call diagnostics and opt-in repair (§3.7).
8. `/ui` and `/ui/api`: requests, inspector, usage, routing, playground; access control (§3.9).
9. Recipes, examples, README (§3.11); tests and gates (§4).

### 2.2 Not in v1.3
- Gemini explicit caching (`cachedContents`), OpenAI `prompt_cache_key`, GPT-5.6 `prompt_cache_options` /
  `prompt_cache_breakpoint`.
- Rollup tables for usage; Postgres; multi-instance aggregation (v2.1).
- Multiple users, roles or per-user keys in the UI (v2.0/v2.1).
- Exporting prompt content to OTel (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` is ignored).
- Injecting `traceparent` toward upstream providers.
- Fetching prices at runtime from LiteLLM's repository.
- Repairing tool calls beyond the three mechanical faults in §3.7; validating argument types against the
  schema.
- A public plugin API (v2.0). The sink list is internal.
- Gemini methods the recording in task 1 does not show Gemini CLI using (e.g. `embedContent` unless
  observed: embeddings are v1.5).

### 2.3 Non-goals
- Provider-pair special cases. The new behaviour is per adapter or per provider config flag.
- Changing any existing timeout, retry or token default. Caps, repair and cache hints are opt-in.
- Storing prompt bodies on disk by default.
- Hostname detection (e.g. "this base URL is OpenRouter"). Provider behaviour comes from config flags.

## 3. Design

### 3.1 Architecture (approach 1: request trace + sinks, D7)

```
request
  → requestLogger → detectSource → body parser → requireApiKey        (unchanged)
  → observe.begin(req)        trace: id, start, client, userAgent, source; ALS scope for notes
  → proxy service (unchanged flow from v1.2 §3.1), plus:
       · snapshot "source"     (raw client body, if the ring is enabled)
       · snapshot "canonical"  (decoded request)
       · per hop: canonicalForTarget applies the output cap (§3.3);
                  snapshot "target[hop]" (encoded upstream body)
       · ttfb when the first byte goes to the client
       · tool diagnostics / repair on the final canonical response (§3.7)
       · snapshot "response"   (reassembled canonical response + wire body/bytes)
  → observe.finish(trace)      usage, cache tokens, cost (§3.6), status, notes
  → emitTrace(trace)           → sinks: log · usage-store · body-ring · metrics · otel
```

Units:
| Unit | Job | Depends on |
|---|---|---|
| `src/observe/trace.ts` | `RequestTrace` type and builder; extends `RouteLogRecord` | `routing/route-log` |
| `src/observe/client-id.ts` | Pure: User-Agent → client id (§3.4) | none |
| `src/observe/context.ts` | `AsyncLocalStorage` scope per request; `recordNote`, `currentTrace` | `node:async_hooks` |
| `src/observe/emit.ts` | `emitTrace` fan-out; each sink isolated (§3.1.1) | sinks |
| `src/observe/sinks/log.ts` | The route log line (today's `logRoute`, extended) | logger |
| `src/observe/sinks/usage-store.ts` | SQLite store (§3.4) | `node:sqlite` |
| `src/observe/sinks/body-ring.ts` | In-memory body ring (§3.5) | none |
| `src/observe/sinks/metrics.ts` | Prometheus registry (§3.8) | `prom-client` |
| `src/observe/sinks/otel.ts` | Spans after the fact (§3.8) | OTel packages, loaded lazily |
| `src/observe/retention.ts` | Hourly deletion of old rows | usage store |
| `src/observe/tool-diagnostics.ts` | Diagnose and repair tool calls (§3.7) | `utils/tool-args` |
| `src/cost/price-table.ts`, `compute.ts`, `live-prices.ts`, `prices.json` | Cost (§3.6) | config, models service |
| `src/ui-api/*.ts` | `/ui/api` routes and access control (§3.9) | store, ring, registry, routing |
| `ui/` | Preact + Vite SPA, built to `dist/ui` (§3.9) | none at runtime |

```ts
export interface RequestTrace extends RouteLogRecord {
  startedAt: number;                       // epoch ms
  client: ClientId;                        // §3.4
  userAgent?: string;                      // truncated to 200 chars
  status: "ok" | "error" | "aborted";
  httpStatus: number;
  errorType?: string;                      // canonical error type, never a message body
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number | null;                  // null = unknown price
  wouldCostUsd?: number;
  costEstimated: boolean;
  priceSource?: "override" | "live" | "bundled" | "local";
  maxTokensClamp?: { from?: number; to: number };
  ttfbMs?: number;
  totalMs: number;
  notes: TranslationNote[];                // §3.5
  diagnostics: ToolCallDiagnostic[];       // §3.7
  repairs: ToolCallRepair[];               // §3.7
  bodies?: BodySnapshots;                  // only while the ring is enabled; read only by body-ring and usage-store
}
```

Only chat requests produce traces. `count_tokens` / `countTokens` and model-list calls only increment
`/metrics` counters.

#### 3.1.1 Sink isolation
Each sink is `{ name, accept(trace): void }`. `emitTrace` calls every sink inside try/catch. A failure
increments `babelgate_sink_errors_total{sink}` and logs one warning per sink per minute; it never reaches
the client and never stops other sinks. Sinks must not block: the usage store queues rows and flushes
in batches (§3.4); the OTel exporter batches on its own.

`bodies` is stripped from the trace before it reaches the log, metrics and OTel sinks (the stripped copy is
built once in `emitTrace`); only `body-ring` and, with `LOG_BODIES=true`, `usage-store` receive it.

### 3.2 Prompt caching: canonical change (interface change, D9)

`canonical.types.ts` and `canonical.schema.ts` change together; the change is logged in `docs/decisions.md`.

```ts
export interface CanonicalCacheHint { ttl?: "5m" | "1h" }

export interface CanonicalContentPart { /* existing */ cache?: CanonicalCacheHint }
export interface CanonicalTool        { /* existing */ cache?: CanonicalCacheHint }
export interface CanonicalRequest {
  /* existing */
  systemPrompt?: string | CanonicalContentPart[];   // was string; parts are text-only
}
export interface CanonicalUsage {
  inputTokens: number;          // ALL input tokens, cached included (OTel convention)
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

Every encoder flattens `systemPrompt` through one shared helper `systemText(systemPrompt)` in
`src/transformers/system-text.ts`; no other system-prompt behaviour changes. Decoders keep producing a
string unless a system block carries a cache hint.

Per adapter:
| Adapter | Decode usage | Encode request hints | Encode usage |
|---|---|---|---|
| Anthropic | `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; read/write from those fields (streaming: `message_start`) | `cache_control: {type:"ephemeral", ttl?}` on blocks, tools and system blocks; at most 4 breakpoints, the last 4 kept, a `cache_limit` note for any dropped | `input_tokens = inputTokens − read − write`, plus both cache fields |
| OpenAI (and OpenAI-compatible) | `prompt_tokens_details.cached_tokens` → read; `prompt_tokens_details.cache_write_tokens` → write; `prompt_cache_hit_tokens` → read when the former is absent | `cache_control` on content parts and the system message **only when the provider sets `cache_hints: true`**; otherwise hints are dropped with a note | `prompt_tokens_details.cached_tokens` (and `cache_write_tokens`) |
| Gemini | `usageMetadata.cachedContentTokenCount` → read | none (implicit caching); hints dropped with a note | `cachedContentTokenCount` |
| Ollama | none | none; hints dropped silently (Ollama reuses its KV cache by itself) | none |

**Rule:** new usage fields are emitted only when present and non-zero, so no existing fixture or snapshot
changes. If one would have to change, that is an owner gate. Field names are checked against provider
documentation in the task (Anthropic prompt-caching docs; OpenAI prompt-caching guide; OpenRouter
prompt-caching docs; DeepSeek KV-cache guide; Gemini caching docs). The Gemini `cachedContentTokenCount`
name is to be confirmed against a live response in task 3.

**Byte-stable prefixes.** Every request encoder is deterministic: the same canonical input yields
identical bytes, with no timestamps, random ids or unstable key order. Appending a turn leaves the encoded
form of every earlier message deep-equal, including Gemini's generated tool-call ids. Property test §4.1.

### 3.3 Output-token cap
`max_output_tokens` per provider in `babelgate.yaml`; `TARGET_MAX_OUTPUT_TOKENS` for the env-only setup.
In `canonicalForTarget`: with a cap, `config.maxTokens = min(requested, cap)`, or `cap` when the request
set none; the clamp is recorded in `trace.maxTokensClamp`. No cap → unchanged behaviour.

### 3.4 Client identity and the usage store

**Client identity** (`client-id.ts`), first match wins:
1. `x-babelgate-client` header, if it matches `^[a-z0-9][a-z0-9._-]{0,39}$`.
2. User-Agent patterns: `claude-cli/` → `claude-code`; `codex` → `codex`; `GeminiCLI` → `gemini-cli`;
   `OpenAI/JS`, `OpenAI/Python` → `openai-sdk`; `Anthropic/` → `anthropic-sdk`; `google-genai` → `google-genai`;
   `ollama-js`, `ollama-python` → `ollama-sdk`.
3. Otherwise `other`.
The exact patterns are confirmed against the real clients' User-Agent in tasks 1, 5 and 17 and listed in the
recipe. Playground requests are `playground`.

**Store:** `node:sqlite` `DatabaseSync`, WAL mode, opened lazily (with `USAGE_STORE=off` the module is never
loaded). Rows are queued and flushed every 250 ms or at 100 rows, one transaction per flush, and on shutdown.
A `schema_version` table drives forward-only migrations.

```sql
CREATE TABLE requests (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, client TEXT NOT NULL, user_agent TEXT,
  source_api TEXT NOT NULL, requested_model TEXT NOT NULL, route_reason TEXT NOT NULL,
  provider TEXT, model TEXT, stream INTEGER NOT NULL,
  status TEXT NOT NULL, http_status INTEGER NOT NULL, error_type TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd REAL, would_cost_usd REAL, cost_estimated INTEGER NOT NULL, price_source TEXT,
  ttfb_ms INTEGER, total_ms INTEGER NOT NULL, finish_reason TEXT,
  hops TEXT NOT NULL, notes TEXT NOT NULL, diagnostics TEXT NOT NULL, repairs TEXT NOT NULL  -- JSON
);
CREATE INDEX requests_started ON requests(started_at);
CREATE INDEX requests_model ON requests(model, started_at);
CREATE INDEX requests_client ON requests(client, started_at);
CREATE TABLE bodies (id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE, snapshots TEXT NOT NULL);
```
`bodies` rows are written only with `LOG_BODIES=true`. `notes` hold codes and field paths, never content.

**Retention:** every hour, delete rows with `started_at` older than `USAGE_RETENTION_DAYS`.

**Node:** `engines` becomes `>=22.13` (D4). The CLI and `index.ts` filter the one-time `node:sqlite`
`ExperimentalWarning` (that warning only, by its message) before importing the store. Use `DatabaseSync`,
which exists on 22 and 24; task 7 checks whether newer Node lines deprecate the name and records the result.

### 3.5 Translation notes and body snapshots

**Notes.** `context.ts` opens an `AsyncLocalStorage` scope per request. The adapters' existing
`logger.debug("Dropping …")` calls become `recordNote(code, detail)`, which also keeps the debug line.
Adapter signatures do not change; outside a scope (unit tests) `recordNote` only logs.
```ts
export interface TranslationNote {
  stage: "decode" | "encode";
  adapter: Provider;
  code: string;      // e.g. "thinking_dropped", "cache_control_dropped", "cache_limit"
  path?: string;     // JSON path of the affected field, e.g. "messages[3].content[1]"
}
```

**Snapshots** (only while the ring is enabled): `source` (the client body as parsed JSON), `canonical`,
`target[]` (one per hop, the encoded upstream body), and `response` (the reassembled canonical response,
plus the upstream JSON body or stream bytes). Headers are never captured. Each snapshot is capped at 1 MB
(stream bytes at 256 KB) with a `truncated: true` marker.

**Ring:** the last `INSPECTOR_BUFFER` traces (default 50; `0` disables snapshotting entirely), in memory
only, lost on restart.

### 3.6 Cost

**Bundled table.** `scripts/update-prices.ts` fetches LiteLLM's `model_prices_and_context_window.json` from a
**pinned commit URL** given on the command line, keeps chat-mode models, converts to USD per 1M tokens
(`input`, `output`, `cacheRead?`, `cacheWrite?`) and writes `src/cost/prices.json` with the source commit
and date. LiteLLM is MIT-licensed; the notice is added to `NOTICE`. Refreshing it is a release-checklist step
(`npm run update:prices -- <commit>`). Nothing is fetched at runtime from LiteLLM.

**Lookup** for the winning hop's `(provider, model)`, first hit wins:
1. Override: top-level `prices:` in `babelgate.yaml`, keyed by `provider/model` glob (same glob rules as
   routes), values in USD per 1M tokens.
2. Local: provider `type: ollama` or `local: true` → $0, `priceSource: "local"`.
3. Live: providers with `live_prices: true` read `pricing` (OpenRouter's schema: string USD per token for
   `prompt`, `completion`, `input_cache_read`, `input_cache_write`) from the v1.2 model-list fetch and its
   60 s cache. Failure → step 4, silently except for a debug line.
4. Bundled: exact model name, then the LiteLLM provider-prefixed key for the provider's type.
5. Unknown: `costUsd = null`; `babelgate_unpriced_requests_total{model}` increments.

**Formula:** `(input − cacheRead − cacheWrite) × in + cacheRead × readPrice + cacheWrite × writePrice +
output × out`. A missing cache price uses the input price and sets `costEstimated`. A stream that ended
without usage uses the local `token-estimate` and sets `costEstimated`. Failed hops cost nothing (no usage).

**Would have cost:** for `priceSource: "local"` rows, if `observe.would_cost_reference` (a
`provider/model`, e.g. `anthropic/claude-sonnet-4-5`) is set, the same token counts are priced against it.

**Aggregates** are SQL over `requests` (by day, model, provider, client). No rollup tables in v1.3; at
solo-developer volume (≈ 100k rows over 30 days) indexed queries are enough.

### 3.7 Tool-call diagnostics and repair

Runs on the final canonical response (or the reassembled stream) and checks each tool call against the
request's `tools`:
| Code | Condition |
|---|---|
| `invalid_json` | `arguments` does not parse |
| `fenced_json` | `arguments` is JSON inside markdown fences |
| `not_object` | parses, but not to an object |
| `unknown_tool` | `function.name` is not in the request's tools |
| `missing_required` | a top-level `required` property of the tool's `parameters` is absent |

Diagnostics go on the trace, the inspector and `babelgate_tool_call_failures_total{provider,model,code}`.

**Repair** (per provider `repair_tool_calls: true`, default off) applies only these, in order, and only if
the result parses to an object:
1. strip one surrounding markdown fence (```` ``` ```` or ```` ```json ````);
2. when the text contains exactly one balanced top-level `{…}`, keep only it;
3. remove trailing commas before `}` or `]`.
Names and fields are never changed or invented. Each applied repair is recorded
(`{toolCallId, steps[]}`) and counted in `babelgate_tool_call_repairs_total`. Diagnostics are computed on the
original arguments.

**Streaming with repair on:** argument deltas for a tool call are held back and released as one delta when
that call completes (next call starts, or the message ends), repaired if needed. Text and other events
stream as before. With repair off, streaming is unchanged.

### 3.8 Metrics and traces

**`/metrics`** (`prom-client`). On by default; `METRICS=off` disables. Requires `PROXY_API_KEY` when set;
otherwise open, because it holds no bodies and scrapers usually run in another container.
| Metric | Labels |
|---|---|
| `babelgate_requests_total` | source, provider, model, client, status |
| `babelgate_request_duration_seconds`, `babelgate_ttfb_seconds` (histograms) | source, provider, status |
| `babelgate_tokens_total` | provider, model, client, kind (`input`, `output`, `cache_read`, `cache_write`) |
| `babelgate_cost_usd_total` | provider, model, client |
| `babelgate_fallbacks_total` | from_provider, outcome |
| `babelgate_tool_call_failures_total`, `babelgate_tool_call_repairs_total` | provider, model, code |
| `babelgate_unpriced_requests_total` | model |
| `babelgate_sink_errors_total` | sink |
| `babelgate_aux_requests_total` | source, kind (`count_tokens`, `models`) |
| Node process defaults | none |
`model` is the routed model, never the raw requested string. Each label keeps at most 100 distinct values;
later values are reported as `other`.

**OpenTelemetry.** Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (standard `OTEL_*` variables apply).
`@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http` and
`@opentelemetry/resources` are dependencies loaded with a dynamic import only when enabled.
- One SERVER span `babelgate {source}` per request; one CLIENT child span `chat {model}` per hop. Both are
  built after the fact from trace timestamps (explicit start and end times).
- An incoming `traceparent` becomes the parent. Nothing is injected upstream.
- Attributes follow the GenAI conventions in `open-telemetry/semantic-conventions-genai`, **pinned to the
  commit recorded in task 11** (the conventions are in Development status with no tagged release):
  `gen_ai.operation.name` (`chat`), `gen_ai.provider.name` (from provider type: `openai`, `anthropic`,
  `gcp.gemini`, `ollama`; OpenAI-compatible providers report `openai`), `gen_ai.request.model`,
  `gen_ai.response.model`, `gen_ai.request.max_tokens`, `gen_ai.response.finish_reasons`,
  `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
  `gen_ai.usage.cache_write.input_tokens`, `error.type`, `server.address`; plus `babelgate.provider`,
  `babelgate.client`, `babelgate.route.reason`, `babelgate.cost_usd`, `babelgate.fallback_hops`.
- Content is never exported; `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` is ignored and documented as such.

### 3.9 The UI

**Build.** Preact + Vite in `ui/`, built to `dist/ui` (D6). `npm run build` builds server and UI;
`scripts/check.sh` adds the UI typecheck and tests (vitest + happy-dom). Charts are hand-written SVG; no chart
library. Express serves `dist/ui` at `/ui` with an SPA fallback to `index.html`. `UI=off` disables `/ui`
and `/ui/api`.

**API** (`/ui/api`, JSON):
| Route | Returns |
|---|---|
| `GET /requests?cursor&limit&client&model&provider&status` | Rows from `requests`, newest first, cursor-paged |
| `GET /requests/:id` | The row, `bodies` (ring first, then `bodies` table) or `bodies: null, reason: "not_retained"`, notes, diagnostics, repairs |
| `GET /live` (SSE) | `started` (id, client, source, requested model) and `finished` (the row) events; never bodies |
| `GET /usage?from&to&group=day\|model\|provider\|client` | Tokens, cost, would-have-cost, cache-hit ratio, error and fallback counts per group |
| `GET /routing` | Providers (name, type, base URL, flags, caps; **never keys**), aliases, ordered rules, fallbacks, default provider, price and price source per configured model |
| `GET /routing/plan?model=` | Dry-run `planRoute` result for a model name; no upstream call |
| `POST /playground` | `{messages, system?, models: string[2..4], params?}`; runs each model through plan → attempt → trace in parallel; multiplexed SSE `{model, delta}` … `{model, done, usage, costUsd, ms}` or `{model, error}`; rows recorded with `client=playground` |

**Access** (D2):
- With `PROXY_API_KEY` set, `/ui/api` requires it (Bearer or `x-api-key`); the SPA asks for it and keeps
  it in `sessionStorage`. Static `/ui` assets are served without the key (they contain no data).
- Without a key, `/ui` and `/ui/api` answer only clients whose socket address is loopback; others get `403`
  with a hint (`PROXY_API_KEY` or `UI_ALLOW_REMOTE=true`). Docker users need one of the two.
- Every `/ui/api` request must carry `x-babelgate-ui: 1` and a `Host` that is `localhost`, `127.0.0.1`,
  `[::1]` (any port) or listed in `UI_ALLOWED_HOSTS`. The custom header forces a CORS preflight, which is
  never approved, so a web page can't drive the playground; the Host check blocks DNS rebinding.

**Screens:**
1. **Requests:** live table (time, client, `requested → provider/model`, status, tokens, cache %, cost, ms,
   diagnostics badge, hop count); filters by client, model, provider, status.
2. **Inspector:** columns source | canonical | target (a tab per hop) | response; collapsible JSON; notes,
   diagnostics and repairs at the top; fields dropped or added between adjacent stages highlighted
   (computed by a structural diff in the UI). Without bodies: metadata plus "bodies not retained — the
   inspector keeps the last N requests in memory; set `LOG_BODIES=true` to keep them on disk".
3. **Usage:** cost and tokens per day, split by model or client; totals; "saved ≈ $X"; cache-hit ratio.
4. **Routing:** the `/routing` tables and a "where would `<model>` go?" box.
5. **Playground:** 2–4 columns streaming side by side; tokens, cost and latency under each.

### 3.10 Gemini CLI entry point
1. **Record first.** Task 1 runs Gemini CLI (latest release, version recorded) with
   `GOOGLE_GEMINI_BASE_URL=http://localhost:<port>` against babelgate with a recording middleware enabled by a
   test-only env var. It logs method, path, query keys, header names and the body's key structure (no values).
   Findings go in `docs/decisions.md` and update §1.2 of this spec before code changes.
2. **Then implement:** Gemini `:countTokens` from the local estimate (flagged as an estimate, as Anthropic
   `count_tokens` is), plus only what the recording proves is required (candidates: `parametersJsonSchema`
   in tool declarations, `thinkingConfig`, `thoughtSignature`, non-streaming helper calls). Unsupported
   Gemini methods return `501` in Gemini's error format.
3. **Recipe** `docs/recipes/gemini-cli.md`: `GEMINI_API_KEY` auth only; the key goes in `x-goog-api-key`;
   HTTPS is required unless the host is localhost (Docker / remote hosts: put babelgate behind TLS or on
   localhost); stray `GOOGLE_*` / `GEMINI_*` variables override the endpoint; the tested Gemini CLI version.

### 3.11 Configuration, docs and examples
New settings (env and `babelgate.yaml` `observe:` / provider keys; env wins, as in v1.2):
| Setting | Default |
|---|---|
| `USAGE_STORE` / `observe.usage_store` | `on` |
| `USAGE_DB` / `observe.usage_db` | `~/.babelgate/usage.db`; `/data/usage.db` in the Docker image (`VOLUME /data`) |
| `USAGE_RETENTION_DAYS` / `observe.retention_days` | `30` |
| `INSPECTOR_BUFFER` / `observe.inspector_buffer` | `50` |
| `LOG_BODIES` / `observe.log_bodies` | `false` |
| `observe.would_cost_reference` | unset |
| `METRICS`, `UI`, `UI_ALLOW_REMOTE`, `UI_ALLOWED_HOSTS` | `on`, `on`, `false`, empty |
| provider `max_output_tokens` / `TARGET_MAX_OUTPUT_TOKENS` | unset |
| provider `cache_hints`, `live_prices`, `repair_tool_calls`, `local` | `false` |
| top-level `prices:` | empty |
The strict schema in `gateway.schema.ts` gains these keys; unknown keys stay errors.

Docs: `docs/recipes/gemini-cli.md`, `docs/recipes/observability.md` (UI, privacy model, metrics, OTel),
updates to `claude-code.md` (cap in YAML instead of `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; `cache_hints` for
OpenRouter), `claude-code-hybrid.md` and `openai-compatible-providers.md`; examples updated
(`examples/*.yaml`); README section "See what's happening" with a screenshot; CLI endpoints block prints
the `/ui` URL; `docs/architecture.md` gains the observe layer.

## 4. Testing

### 4.1 Unit (no network)
- Every new unit has its own tests. The store uses `:memory:`; a migration test opens a v1 schema and
  migrates it.
- Adapter contract tests gain cache-hint and cached-usage cases per adapter, both directions, streaming
  and not.
- **Prefix-stability property test:** for all 4 request encoders, encoding is deterministic, and appending
  a turn leaves the encoding of every earlier message deep-equal.
- Tool diagnostics and repair: a corpus of broken calls per code; repair never changes names or fields;
  streaming with repair holds only that call's argument deltas.
- Client identity: a table of real User-Agent strings.
- Cost: lookup order, formula, missing cache prices, unknown models, would-have-cost.
- **Privacy canary:** a unique string in a prompt, a tool argument and a completion, plus a fake key in the
  config; assert that none appears in the log output, `/metrics`, the OTel in-memory exporter,
  `/ui/api/routing`, `/ui/api/live` or the `requests` table, and that it does appear in the ring (and the
  `bodies` table only with `LOG_BODIES=true`).
- Access control: loopback only without a key; key required when set; `Host` check; `x-babelgate-ui` header.

### 4.2 Integration (msw, mocked upstreams, one app)
- A trace per request reaches every sink, streaming and not, with fallbacks; a throwing sink does not change
  the response.
- The 16-pair matrix runs with cached usage and checks cache tokens survive every pair.
- Playground with three mocked models, one failing.

### 4.3 Backwards compatibility
The existing suite passes with no changed expected values. `USAGE_STORE=off`, `INSPECTOR_BUFFER=0`,
`METRICS=off`, `UI=off` together give v1.2 behaviour plus the new `/ui` 404.

### 4.4 UI
Component tests (vitest + happy-dom). **One Playwright smoke test in CI:** start the built app against a
mocked upstream, send a chat request, open `/ui`, see the row, open the inspector, see four stages.

### 4.5 Live suite and release gates
Live suite (opt-in, nightly): Gemini `countTokens`; cached usage from OpenRouter (Anthropic model, with
`cache_hints: true`).

Release gates replace v1.2 Gates 1–2 (D10); the reason is recorded in `docs/decisions.md`. They run on the
owner's machine, no GPU, results recorded per release (OWNER REVIEW).
| Gate | Run | Passes when |
|---|---|---|
| **A** | Claude Code edit task → OpenRouter `qwen/qwen3-coder` (`scripts/gates/claude-code-edit.sh`) | Task done; a row with `client=claude-code`; `cost_usd` not null (live prices); inspector shows all four stages; `/metrics` counters moved; the cap comes from YAML, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` unset |
| **A-cache** | Claude Code → OpenRouter `anthropic/claude-haiku-*`, `cache_hints: true` | `cache_read_tokens > 0` from the second turn on, and Claude Code receives `cache_read_input_tokens` |
| **B** | Gemini CLI edit task → OpenRouter `qwen/qwen3-coder` (`scripts/gates/gemini-cli-edit.sh`) | Task done; rows with `client=gemini-cli` |
| **C** | Hybrid YAML: Claude Code main calls → OpenRouter, haiku calls → CPU Ollama `qwen2.5-coder:3b` | Both providers in the store; would-have-cost shown on the Ollama rows |

## 5. Task outline (the plan will detail these)
| # | Task | Gate |
|---|---|---|
| 1 | `engines >=22.13`; Gemini CLI traffic recording; `:countTokens` and the gaps the recording proves | |
| 2 | Per-provider output-token cap | |
| 3 | Canonical cache hints + cached usage; all adapter decoders/encoders; `systemText` helper | OWNER REVIEW (interface change) |
| 4 | Cache-hint encoding per §3.2; prefix-stability property test; 16-pair matrix with cached usage | |
| 5 | `RequestTrace`, client identity, `emitTrace`, log sink (behaviour-neutral replacement of `logRoute`) | |
| 6 | `AsyncLocalStorage` scope, translation notes, body snapshots, body ring | |
| 7 | Usage store, migrations, retention, `observe:` config, Docker volume | |
| 8 | Price table + update script + NOTICE; cost, live prices, would-have-cost | OWNER GATE (bundled third-party data) |
| 9 | Tool-call diagnostics and opt-in repair (streaming included) | |
| 10 | `/metrics` | OWNER GATE (new dependency `prom-client`) |
| 11 | OpenTelemetry traces | OWNER GATE (new OTel dependencies) |
| 12 | `/ui/api` routes + access control | |
| 13 | UI scaffold (Vite build, `check.sh`, Playwright smoke) + Requests + Inspector | OWNER GATE (new dev dependencies) |
| 14 | UI Usage + Routing screens | |
| 15 | Playground (API + screen) | |
| 16 | Recipes, examples, README, architecture doc | |
| 17 | Live-suite cases; release gates A, A-cache, B, C | OWNER REVIEW |
| 18 | CHANGELOG, roadmap (v1.3 size M → L), `1.3.0` | OWNER GATE |

## 6. Owner decisions (2026-11-04)
| # | Decision | Chosen |
|---|---|---|
| D1 | Scope | Everything the roadmap lists for v1.3, in one version, sized L |
| D2 | Audience | Solo developer on localhost; UI loopback-only without `PROXY_API_KEY` |
| D3 | Bodies vs privacy | In-memory ring of the last N requests by default; on disk only with `LOG_BODIES=true` |
| D4 | Storage | `node:sqlite`; `engines >=22.13` (drops end-of-life Node 20) |
| D5 | Tool-call failures | Always diagnosed; mechanical repair opt-in per provider |
| D6 | UI stack | Preact + Vite, built into `dist/ui`; hand-written SVG charts |
| D7 | Architecture | Request trace + internal sinks (approach 1); no public plugin API before v2.0 |
| D8 | Prices | Bundled snapshot from LiteLLM (MIT) + YAML overrides + live OpenRouter-style prices; unknown ≠ $0 |
| D9 | Prompt caching | Hints and cached usage in canonical; pass-through to Anthropic and `cache_hints` providers; no Gemini explicit cache |
| D10 | Release gates | Gates A, A-cache, B, C on cloud models and CPU Ollama; the GPU gates are retired |

**Owner actions:** approve the new dependencies (`prom-client`; OTel packages; `preact`, `vite`,
`@preact/preset-vite`, `happy-dom`, `@playwright/test` as dev dependencies) and the bundled LiteLLM data;
review the canonical change (task 3); keep `OPENROUTER_API_KEY` funded for the live suite and gates;
install Gemini CLI and a small Ollama model for gates B and C; tag `v1.3.0` and publish.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Scope (L) drifts further | §2.2 stands; tasks ordered so 1–4 ship value on their own; re-plan after task 9 if behind |
| The canonical change breaks a pair | Usage fields emitted only when present; existing expected values asserted unchanged; 16-pair matrix extended |
| Gemini CLI needs more than `countTokens` | Recording first (§3.10); anything large becomes an owner decision before code |
| Gemini CLI's HTTPS rule blocks non-localhost setups | Recipe says so; localhost setup is the tested path |
| Prompts leak through a new sink | Bodies stripped centrally in `emitTrace`; privacy canary test across every sink |
| A web page drives the playground (spends money) | Loopback/`Host` check + required custom header (§3.9) |
| `node:sqlite` is still experimental / renamed on newer Node | `DatabaseSync` on 22 and 24; warning filtered by message; task 7 records newer-Node behaviour |
| Synchronous SQLite blocks the event loop | Batched writes off the request path; at most 100 rows per transaction |
| Bundled prices go stale | Release-checklist refresh; overrides; live prices for OpenRouter |
| Metric label explosion | Routed model only; 100 values per label, then `other` |
| GenAI conventions change names | Pinned commit; attribute names in one module |
| Repair hides model faults | Off by default; every repair recorded and counted; diagnostics on the original |
