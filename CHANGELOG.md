# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-11-20

"Correct everywhere": reasoning and media now travel in every client
format — Claude Code, Chat, Gemini, Ollama and Codex clients send and
receive thinking — and URL images, PDFs and tool-result images cross
every boundary. Where a provider already speaks the client's format,
babelgate passes the request through and fixes the gaps that endpoint
leaves. The evidence is public: a compatibility matrix generated from
the tests, a weekly replay of each new Claude Code and Codex release,
and signed releases.

### Added

- **Reasoning for every client format.** Anthropic `thinking`
  (`enabled`/`adaptive`/`disabled`, `budget_tokens`,
  `output_config.effort`), Chat `reasoning_effort`, Gemini
  `thinkingConfig` (`thinkingLevel`/`thinkingBudget`,
  `includeThoughts`) and Ollama `think` decode into canonical
  `config.reasoning`, so a client's thinking request now reaches the
  provider instead of being dropped. Replies carry reasoning back in
  the client's own shape: Anthropic `thinking`/`redacted_thinking`
  blocks (streamed as `thinking_delta`/`signature_delta`), Gemini
  `{text, thought: true}` parts, Chat `reasoning_content`, Ollama
  `message.thinking`. Foreign signatures travel inside the `bg1.`
  envelope — now a shared module — packed into Anthropic `signature`
  or Gemini `thoughtSignature`; Chat and Ollama clients get reasoning
  text only. Reasoning still never crosses origins: a signature
  belongs to the provider and model that issued it; anything else is
  dropped with a `reasoning_dropped` note, and the continuity guard
  keeps Anthropic tool loops valid.
- **`reasoning: false`** on a provider entry restores the exact 1.4
  behaviour for requests routed to it (same notes, byte-identical
  upstream bodies).
- **Media across all five formats.** URL images (OpenAI `image_url`,
  Anthropic `source.type: "url"`, Responses `input_image`, Gemini
  `fileData.fileUri`) stay URLs on URL-capable targets and are fetched
  and inlined where bytes are needed; documents (`application/pdf`,
  `text/plain` — Anthropic `document`, OpenAI `file`, Responses
  `input_file`, Gemini `inlineData`) map the same way, and images in
  tool results (`tool_result.content`, `function_call_output`,
  `functionResponse`) survive. Fetching is guarded: `http:`/`https:`
  only; every resolved address — and every redirect hop, max 3 — is
  checked against private, loopback, link-local, CGNAT, ULA and
  metadata ranges; 20 MB and 15 s caps; `media:` YAML section or
  `MEDIA_FETCH`/`MEDIA_ALLOW_PRIVATE` env. Media bytes never reach
  logs, `/metrics`, OTel, the Inspector or the requests store — URLs
  may be logged. A target that can't take a part refuses with a 400 in
  the source's dialect naming the field, never a silent drop; the
  Inspector shows media as type, size and URL host only.
- **Same-format pass-through for Anthropic and Chat** (`type:
  anthropic` / `type: openai`): when the routed provider speaks the
  client's format the request is forwarded without the canonical
  round trip — still routed, traced, priced and shown in the
  Inspector marked pass-through, streams relayed byte for byte,
  client aborts propagated upstream. Automatic for providers on a
  shim `preset`; any other provider opts in with `passthrough: true`.
  `type: responses` is unchanged.
- **Provider presets and declared gaps.** `preset:` fills `type`,
  `base_url` and `gaps` for native Anthropic endpoints —
  `ollama-anthropic`, `lmstudio-anthropic`, `deepseek-anthropic`,
  `glm-anthropic`, `kimi-anthropic` — each gap list verified against
  the provider's docs (Ollama's measured by probe, not just doc-read).
  A provider may also declare `gaps:` directly from the fixed
  vocabulary `tool_choice`, `count_tokens`, `prompt_cache`,
  `url_images`, `documents`, `stream_usage`; each gap has exactly one
  fix applied to the body before forwarding (or to the reply), with a
  note — e.g. `count_tokens` is answered locally with a flagged
  estimate, `url_images` are fetched and inlined, `documents` are
  refused in the client's dialect.
- **Embeddings, minimal.** `POST /v1/embeddings` (and `/embeddings`)
  in OpenAI format routes by model with aliases and fallbacks:
  OpenAI-compatible targets get the body as-is, Gemini maps to
  `batchEmbedContents` (`outputDimensionality`), Ollama to
  `/api/embed`; Anthropic and Responses targets get a 501 in OpenAI's
  error envelope. `dimensions` maps where the target supports it;
  `encoding_format: "base64"` is produced by babelgate (float32
  little-endian). Usage and cost are recorded.
- **Published compatibility matrix.** `docs/compatibility.md` is
  rendered from the pair-test results (`npm run matrix`) — source ×
  target per feature (plain, stream, tools, stream × tools,
  structured output, reasoning, URL image, document, tool-result
  image, pass-through) — and CI fails when the committed cells go
  stale.
- **Weekly client-release replay.** A scheduled `live.yml` job
  installs the latest Claude Code and Codex, runs the edit-task gates
  through babelgate, diffs each client's request shape against the
  committed fixtures and opens a `client-replay` issue on a failure
  or a new shape. First green run on release candidates: Claude Code
  2.1.329, Codex CLI 0.171.0 (gate C).
- **Signed releases.** `release.yml` signs the GHCR image keyless
  with cosign; npm registry signatures verify with `npm audit
  signatures`; a CycloneDX SBOM of the runtime dependencies is
  attached to each GitHub release. Verification steps are in
  `SECURITY.md`.

### Changed

- **Reasoning requests from Claude Code, Chat, Gemini and Ollama
  clients now reach the provider** — Anthropic `thinking`, Chat
  `reasoning_effort`, Gemini `thinkingConfig` and Ollama `think` were
  dropped with a note in 1.4; they now map to `config.reasoning` and
  the target's thinking controls. Set `reasoning: false` on a provider
  to keep 1.4 behaviour.

### Known limitations

- **Embeddings is OpenAI-format inbound only** — no Gemini or Ollama
  embedding dialects; no audio or image generation (spec §2.2).
- **No same-format pass-through for Gemini and Ollama sources** —
  `type: gemini`/`ollama` traffic always takes the canonical path;
  revisit on user demand.
- **No PDF text extraction** — a document for a target that can't
  read documents is refused (400 in the source's dialect), never
  flattened to text.
- **Foreign reasoning travels in `bg1.` envelope signatures** —
  Anthropic and Gemini clients see foreign reasoning inside
  `signature`/`thoughtSignature` fields (raw provider signatures only
  survive on pass-through); a client that does not return those fields
  verbatim loses the reasoning, dropped with `reasoning_dropped`.
  Chat and Ollama clients carry reasoning as plain text with no
  signature — `reasoning_content`/`thinking` sent back on an
  assistant message is dropped with `reasoning_dropped` (no origin,
  so no encoder could send it on).
- **Tool-result images refused on Chat and Ollama targets** — those
  dialects carry no image in tool results; refused with a 400 naming
  the field and target.
- **Stateless Responses only** — as 1.4: `previous_response_id`,
  `store: true` and `conversation` get a 400 naming the field;
  `GET`/`DELETE /v1/responses/{id}` and `POST /v1/responses/compact`
  get a 404.
- **Reasoning never translates across providers** by design: a part
  from another provider or model is dropped with `reasoning_dropped`,
  never reinterpreted.

## [1.4.0] - 2026-11-16

"Codex on any model": the OpenAI Responses API becomes the fifth client
and provider format, so Codex CLI runs through babelgate on Gemini,
Claude and Chat-only backends — with streaming, custom tools, reasoning
carried between turns and structured output across all five formats.
Responses-native upstreams get a byte-preserving pass-through that is
still routed, traced and priced.

### Added

- **OpenAI Responses API as a fifth adapter**, source and target.
  `POST /v1/responses` (and `/responses` for clients whose base URL
  already ends in `/v1`) is detected like the other dialects, with the
  full SSE event set in both directions. `type: responses` names an
  upstream that speaks Responses natively (OpenRouter, Ollama, vLLM, LM
  Studio, Groq, Together, DeepSeek, OpenAI); `TARGET_API=responses` in
  env-only mode. `GET /v1/models` keeps its OpenAI shape.
- **Codex CLI entry point.** A `[model_providers.babelgate]` block with
  `wire_api = "responses"` in `~/.codex/config.toml` runs Codex through
  babelgate on any backend — recipe in `docs/recipes/codex.md`, working
  configs in `examples/codex-*.yaml`, release-gated on Gemini and Claude
  bridges plus an OpenRouter pass-through (tested: codex-cli 0.169.0).
  A Codex live suite (`tests/live/codex.live.test.ts`) replays the
  recorded session shapes against real upstreams.
- **Pass-through to Responses-native upstreams.** A Responses request
  routed to `type: responses` is forwarded with only `model` rewritten
  and relayed byte for byte, stream included — still routed, traced and
  priced from `response.completed`, shown in the Inspector marked
  "pass-through". Fallbacks behave as before: to any target before the
  first byte, bridged when the fallback doesn't speak Responses.
- **Reasoning carried between turns for Codex.** Anthropic `thinking`
  blocks (with real signatures), Gemini `thoughtSignature` on calls and
  text, OpenAI-compatible `reasoning_content` and Ollama `thinking`
  decode into canonical reasoning parts bound to their provider and
  model. Next turn they return to the same provider/model — or are
  dropped with a `reasoning_dropped` note: reasoning never crosses
  origins, so a mid-session fallback or model switch stays clean. On
  the wire they travel as a `bg1.` `reasoning.encrypted_content`
  envelope (capped at 1 MB per item; over the cap the item ships
  without it, noted). `reasoning.effort`/`summary`/`budgetTokens` map
  to each target's thinking controls, and a continuity guard turns
  Anthropic thinking off for a request whose current tool loop lacks a
  signature of this origin, since Anthropic rejects those loops.
- **Custom tools.** Responses `custom` tools — grammars like Codex's
  `apply_patch` — lower to a function tool plus one required string
  `input` parameter on non-Responses targets (grammar verbatim in the
  description) and raise back to `custom_tool_call` items on the way
  out; Responses→Responses keeps them native. Custom input is a raw
  string: never parsed as JSON, never diagnosed, never repaired.
- **Structured output across all five formats.** Responses
  `text.format` ↔ OpenAI `response_format` ↔ Anthropic
  `output_config.format` ↔ Gemini `responseJsonSchema` /
  `responseMimeType` ↔ Ollama `format` — `json_schema` and
  `json_object` where the dialect has both. The schema is forwarded
  unchanged: babelgate never strips or rewrites keywords. A target
  without schemaless JSON mode (Anthropic `json_object`) gets a 400
  `unsupported_response_format` in the source's own error shape; an
  upstream that rejects the schema returns its 400 through the normal
  error mapping, streamed requests included.
- **`reasoning_passback`** per-provider flag (default off): sends
  `reasoning_content` back upstream on assistant messages for
  OpenAI-compatible providers whose thinking mode needs it (DeepSeek
  tool loops). Also new: canonical `parallel_tool_calls`, honoured on
  targets that support it (OpenAI Chat, Responses, Anthropic
  `disable_parallel_tool_use`), noted as dropped elsewhere.
- **Reasoning in the Inspector.** Reasoning parts, signatures and
  pass-through stages show in `/ui`; stream masking covers
  `redacted_thinking` bytes and cut-off wire lines, so thinking content
  follows the same privacy rules as everything else.

### Changed

- **Gemini thinking tokens are now counted in `output_tokens`** and
  priced (`thoughtsTokenCount` was previously dropped), matching the
  OTel convention and OpenAI/Anthropic billing. Canonical usage gains
  `reasoningTokens`, carried to replies and stored per request in the
  usage store.

### Known limitations

- **Stateless Responses only.** `previous_response_id`, `store: true`
  and `conversation` get a 400 naming the field; `GET`/`DELETE
  `/v1/responses/{id}` and `POST /v1/responses/compact` get a 404 — in
  the Responses error envelope, before routing, on both the bridge and
  pass-through paths.
- **Built-in OpenAI tools are dropped on the bridge** (`web_search`,
  `file_search`, `code_interpreter`, `computer_use`,
  `image_generation`, `tool_search`, MCP server tools) with a
  `builtin_tool_dropped` note — they are forwarded unchanged on
  pass-through. The recipe sets `web_search = "disabled"`.
- **Reasoning is carried only for Responses clients.** Claude Code or
  Gemini CLI receiving another provider's thinking keeps v1.3
  behaviour (dropped with a note); mapped across in v1.5.
- **Responses Lite / `additional_tools`** (GPT-5.6 tool hoisting) is
  not translated; OpenAI-model-only.
- **Reasoning never translates across providers** by design: a part
  from another provider or model is dropped with `reasoning_dropped`,
  never reinterpreted.

## [1.3.0] - 2026-11-13

"See what's happening": every chat request produces one request trace —
route, hops, usage, cached tokens, cost, client, translation notes and
tool-call diagnostics — that reaches the log, a SQLite usage store,
Prometheus and OpenTelemetry, and a built-in `/ui` shows it live. Agent
CLIs gain an output-token cap, prompt caching that survives translation,
and Gemini CLI as a tested entry point.

### Added

- **One request trace per chat request.** Routed provider/model, hops
  and fallbacks, token usage, cached tokens, cost, client identity,
  translation notes and tool-call diagnostics — emitted exactly once,
  also on failure and client disconnect, and fanned out to isolated
  sinks: the log line, the usage store, the in-memory body ring,
  Prometheus and OpenTelemetry. A failing sink never affects a response.
- **Built-in UI at `/ui`.** One static bundle, no extra service: a live
  Requests feed, a per-request Inspector that shows the request in
  source, canonical and target form side by side, Usage (cost and
  tokens per day/model/client, "saved ≈ $X" for local rows), the
  Routing table, and a Playground that streams up to four models side
  by side — backed by a JSON API under `/ui/api`. Loopback only by
  default (`UI`, `UI_ALLOW_REMOTE`, `UI_ALLOWED_HOSTS`; defaults `on` /
  `false` / empty); `PROXY_API_KEY` opens it to the network when set.
- **SQLite usage store.** Every traced request lands in a `node:sqlite`
  database — tokens, latency, model, route and fallback hops, client
  and cost — with daily retention pruning (`USAGE_STORE`, `USAGE_DB`,
  `USAGE_RETENTION_DAYS`; defaults `on` / `~/.babelgate/usage.db` /
  `30`; `/data/usage.db` in the Docker image). An unusable database
  logs one warning, disables itself and never breaks serving.
- **Cost per request.** The winning hop's `(provider, model)` is priced,
  never the alias or the requested string: top-level `prices:` overrides
  in `babelgate.yaml` first, `local` / `type: ollama` providers at $0,
  `live_prices: true` for providers that report pricing in their model
  list, then the bundled LiteLLM table (refreshed at release with
  `npm run update:prices -- <commit>`). Local rows get a "would have
  cost" against `observe.would_cost_reference`; unknown models keep
  `costUsd: null` and count `babelgate_unpriced_requests_total`.
- **`/metrics` and OpenTelemetry.** A Prometheus endpoint (`METRICS`,
  default `on`; requires `PROXY_API_KEY` when set) with request, token
  and cost counters, duration and TTFB histograms, tool-call failure
  and repair counters, and sink-error counters — labels only, never
  content. GenAI-convention OTel spans when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Tool-call diagnostics and opt-in repair.** Every response's tool
  calls are checked against the request's tools — `invalid_json`,
  `fenced_json`, `not_object`, `unknown_tool`, `missing_required` — on
  the trace, in the Inspector and on
  `babelgate_tool_call_failures_total`. `repair_tool_calls: true` per
  provider applies the three mechanical fixes (strip one markdown
  fence, keep the single balanced `{…}`, drop trailing commas); repairs
  are recorded and counted. With repair on, streamed argument deltas
  are held and released as one delta per call — repaired, or released
  unrepaired with a diagnostic when the stream ends mid-call.
- **Output-token cap.** `max_output_tokens` per provider in
  `babelgate.yaml` (`TARGET_MAX_OUTPUT_TOKENS` in env-only mode) clamps
  `max_tokens`, so Claude Code's large default no longer needs
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` set by hand. Off by default.
- **Prompt caching survives translation.** Canonical cache hints on
  system parts, messages, tools and tool results — the tool-result
  carry (PR #82) is where Claude Code's moving breakpoint lands, so
  its agent loop now reads the cache across turns. Providers with
  `cache_hints: true` get Anthropic-style `cache_control` markers
  upstream; prefixes are kept byte-stable so automatic prefix caches
  (OpenAI, DeepSeek, Ollama) hit. Cached tokens are counted in
  canonical usage and priced at cache prices.
- **Gemini CLI entry point.** `GOOGLE_GEMINI_BASE_URL` +
  `GEMINI_API_KEY` runs Gemini CLI through babelgate on any backend,
  streaming and tools intact — recipe in `docs/recipes/gemini-cli.md`,
  release-gated on a non-Gemini model. Gemini `:countTokens` is
  answered locally with the `ceil(chars/4)` estimate and
  `x-babelgate-token-estimate: true`, like the other dialects' count
  endpoints.
- **New configuration.** The `observe:` YAML block (`usage_store`,
  `usage_db`, `retention_days`, `inspector_buffer`, `log_bodies`,
  `would_cost_reference`), the provider keys `max_output_tokens`,
  `cache_hints`, `live_prices`, `repair_tool_calls` and `local`, and
  top-level `prices:` overrides. Env vars and defaults: `USAGE_STORE`
  `on`, `USAGE_DB` `~/.babelgate/usage.db`, `USAGE_RETENTION_DAYS` `30`,
  `INSPECTOR_BUFFER` `50`, `LOG_BODIES` `false`, `METRICS` `on`, `UI`
  `on`, `UI_ALLOW_REMOTE` `false`, `UI_ALLOWED_HOSTS` empty,
  `OTEL_EXPORTER_OTLP_ENDPOINT` unset, `TARGET_MAX_OUTPUT_TOKENS` unset.
  Every behaviour that changes client-visible output (cap, cache hints,
  repair) is opt-in and defaults off.

### Changed

- **Node `>=22.13` is required** (`engines`) for `node:sqlite`.
- **Replies carry cached-token usage fields** when the provider reports
  them — `cache_read_input_tokens` / `cache_creation_input_tokens`
  (Anthropic), `prompt_tokens_details.cached_tokens` (OpenAI),
  `cachedContentTokenCount` (Gemini) — emitted only when non-zero, so
  replies without caching are byte-identical to before.
- **Unsupported Gemini methods return 501** naming the method
  (`embedContent is not supported`) instead of falling through to the
  chat flow.

### Known limitations

- **No explicit Gemini caching** — `cachedContents` is not translated,
  and OpenAI's `prompt_cache_key` / `prompt_cache_breakpoint` are not
  emitted.
- **No content in OTel** — prompt and completion text never leaves in
  spans (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` is ignored), and
  `traceparent` is not injected toward upstreams.
- **The UI is single-user** — no users, roles or per-user keys.
- **No runtime price fetches** — the bundled table only refreshes via
  `npm run update:prices`; live prices come from providers' own model
  lists (`live_prices`).

## [1.2.0] - 2026-11-03

"One endpoint, many providers": one babelgate instance serves every client
format on one port and routes each request to one of several configured
providers by model name — with aliases, a long-context condition, fallbacks
before the first byte and a merged model list.

### Added

- **All four client formats on one port.** OpenAI, Anthropic, Gemini and
  Ollama paths are all live at once; the request itself decides the source
  format (the path, plus the `anthropic-version` header on `GET /v1/models`).
  A Gemini URL-path model — including percent-encoded names like
  `/v1beta/models/openrouter%2Fqwen%2Fqwen3-coder:generateContent` —
  resolves exactly like a body model.
- **Model-name routing.** Resolution order: explicit `provider/model` →
  exact, case-sensitive alias → ordered glob `routes` → `default`
  provider. Model names keep `/` and `:` (`openrouter/qwen/qwen3-coder`,
  `ollama/qwen3-coder:30b`), and replies keep the name the client asked
  for. `MODEL_MAP` in env-only mode builds the equivalent routes against
  the default provider, identical to v1.1.
- **Long-context rule.** `when: { min_input_tokens: N }` on a route holds
  when the `ceil(chars/4)` input-token estimate reaches N — short prompts
  can go to a small local model and long ones to a bigger context.
- **Fallback chains.** A route's `fallback` list is tried in order on
  transport failure, connect/response-header timeout, or upstream `429`,
  `500`, `502`, `503`, `504` or `529` — only before the first byte; once
  2xx headers arrive the target is committed. If every target fails, the
  last target's error is rendered in the client's dialect; a client
  disconnect ends the loop.
- **Routing response headers.** Every proxied chat reply carries
  `x-babelgate-provider`, `x-babelgate-model` and `x-babelgate-attempts`;
  an error reply after one or more attempts carries
  `x-babelgate-attempts`; a partial model list carries
  `x-babelgate-partial: true`.
- **Merged model list.** `GET /v1/models`, `GET /v1beta/models` and
  `GET /api/tags` return, in the client's format: aliases as bare names,
  then the default provider's models bare, then every other provider's
  models as `<provider>/<model>`. Provider lists are fetched in parallel
  and cached in memory for 60 s (successful fetches only); a provider
  whose list fails is omitted with a `warn` and
  `x-babelgate-partial: true`.
- **`babelgate.yaml` for multiple providers.** Discovery:
  `--config <path>` → `BABELGATE_CONFIG` → `./babelgate.yaml` → env-only
  mode. Providers declare `type`, `base_url`, `api_key_env` (env var
  names only — keys never live in the file) and optional
  `context_window`, `timeout_ms` and `stream_idle_ms`; plus `aliases`,
  ordered `routes` with `when` and `fallback`, and a required `default`.
  The schema is strict: an unknown key, a `default` that is not a
  provider, a target without a registered provider prefix, an unset or
  empty `api_key_env` variable, a duplicate alias, or an alias that is
  also a provider name is a startup error naming the YAML path.
  OpenAI-compatible backends (Groq, Together, DeepSeek, OpenRouter,
  LM Studio, vLLM, llama.cpp) are `type: openai` with their own
  `base_url`.
- **CLI `--config` and endpoints block.** `babelgate --config <path>`
  loads a YAML file; with a config file loaded, `--target`, `--model` and
  `--base-url` are errors ("defined by the config file"). Without a
  preset, startup prints the four client endpoints (OpenAI `…/v1`,
  Anthropic, Gemini, Ollama) and the routing table.
- **Route log line.** One `info` record per chat request replaces
  "Forwarding request to upstream": requestId, source format, requested
  model, route reason, per-hop outcome (`ok | http_error | timeout |
  transport`), winner and token counts — never prompt bodies, completions
  or keys.
- **Examples, recipes and a GPU gate runbook.**
  `examples/claude-code-hybrid.yaml` (Claude Code on a GPU Ollama host
  with an OpenRouter long-context fallback),
  `examples/multi-provider.yaml`, `docs/recipes/claude-code-hybrid.md`,
  `docs/recipes/openai-compatible-providers.md` and
  `docs/gates/gpu-ollama.md`.

### Changed

- **The other three formats' paths now answer instead of returning 404** —
  the only wire-visible change for an existing env-only setup. An env-only
  proxy started with `SOURCE_API=anthropic` that used to 404
  `POST /v1/chat/completions` now answers it in OpenAI format, and
  likewise for every other format.
- **`POST /v1/messages/count_tokens` is answered on every instance,
  whatever the configured target** — the local `ceil(chars/4)` estimate
  marked `x-babelgate-token-estimate: true`. Previously it was served
  only when `SOURCE_API` was `anthropic` (404 otherwise).
- The new `x-babelgate-*` response headers above are additive.

### Deprecated

- **`SOURCE_API`** is ignored — the request path decides the client
  format. Setting it still starts the proxy but logs one startup warning;
  it will be removed in 2.0.

### Known limitations

- **No config hot reload** — restart to pick up `babelgate.yaml` changes.
- **No overall request deadline across fallback hops** — the worst case is
  the sum of per-attempt timeouts.
- **Ollama endpoints other than `/api/chat` and `/api/tags` are not
  served** (`/api/version`, `/api/show`, `/api/generate`).

## [1.1.2] - 2026-10-29

Milestone 2: the full streaming × tools matrix and live coverage for the
remaining source dialects.

### Added

- **All 16 source × target pairs pass the streaming × tools matrix** —
  text, tool call, parallel calls and tool-result round trip, streamed
  and non-streamed.
- **Gemini and Ollama sources covered by the live suite.**
  `npm run test:live` now streams text and sends tool definitions
  through `POST /v1beta/models/<model>:streamGenerateContent?alt=sse`
  (SSE `GenerateContentResponse` frames) and `POST /api/chat` (NDJSON,
  token counts on the `done: true` line) against local Ollama, and adds
  a Gemini forced tool call (`functionCallingConfig.mode: "ANY"`)
  against OpenRouter. Ollama has no tool-choice wire field, so no
  forced-tool-call case exists for that source.

### Fixed

- **Ollama-format clients that omit `stream` now get an NDJSON stream**,
  matching the Ollama API: `POST /api/chat` streams unless `stream:
  false` is sent (api.md, default true). Previously the proxy answered
  a single JSON object, so Ollama clients that rely on the documented
  default never saw streaming. Send `stream: false` for the old
  single-object behaviour.

## [1.1.1] - 2026-10-28

### Fixed

- **`npx babelgate` crashed on start** with
  `Error: unable to determine transport target for "pino-pretty"` unless
  `NODE_ENV=production`. The logger always configured the `pino-pretty`
  transport outside production, but `pino-pretty` is a devDependency and
  is absent in an npm/npx install. The pretty transport is now used only
  when it is actually resolvable; otherwise the logger writes plain JSON
  to stdout. The Docker image (`NODE_ENV=production`) was unaffected.
- **dotenv startup banner removed.** `dotenv.config({ quiet: true })`
  stops dotenv 17's `◇ injected env …` line from polluting the CLI's
  printed `export` lines.

### Added

- **Packed-install smoke test** (`scripts/ci/smoke-pack.sh`) in the full
  check gate: builds, `npm pack`s, installs the tarball with
  `--omit=dev` in a clean directory, and runs the `babelgate` bin the
  way `npx` does — `--help` must print usage and a real start must bind
  and answer `/health`, both free of the dotenv banner.
- **`prepublishOnly` runs the full check** (`./scripts/check.sh`,
  including the smoke test) so a broken pack can't reach npm again.

## [1.1.0] - 2026-10-28

Public launch — "Claude Code on anything": Anthropic-format clients
(Claude Code) and OpenAI-SDK apps run against Ollama and OpenAI-compatible
backends with streaming and tools, from one `npx babelgate` command.

### Added

- **Streaming end to end in all four adapters.** `stream: true` — and
  Gemini's `:streamGenerateContent?alt=sse` — now flows chunk-by-chunk in
  each side's own wire protocol (SSE for OpenAI, Anthropic and Gemini;
  NDJSON for Ollama) instead of returning 501. Streams are typed
  `CanonicalStreamEvent`s through a provider-agnostic pipeline: a client
  disconnect aborts the upstream request, an upstream that dies mid-stream
  produces an in-stream error in the client's dialect, and
  `UPSTREAM_STREAM_IDLE_MS` (default 300 000) cuts stalled streams.
- **Tool calling end to end in all four adapters.** Tool definitions,
  `tool_choice`/`toolChoice`, parallel calls, streamed tool-call deltas
  and tool results map through canonical. Arguments that aren't valid
  JSON reach the model as `{ "_invalid_arguments": "<raw>" }`; empty
  arguments become `{}`; calls keep their own IDs (`call_<n>` generated
  where the provider has none).
- **Claude Code essentials.** `POST /v1/messages` (any query) and
  `POST /v1/messages/count_tokens` on the Anthropic source; count_tokens is
  a local `ceil(chars/4)` estimate marked `x-babelgate-token-estimate: true`.
  `MODEL_MAP` (ordered `glob=model` rules) rewrites model names upstream
  while replies keep the name the client asked for;
  `TARGET_CONTEXT_WINDOW` sets Ollama's `num_ctx`. `thinking` blocks,
  `cache_control` and `metadata` are dropped safely.
- **`babelgate` CLI.** `npx babelgate` parses flags with `node:util`,
  honours user env over preset values, starts the server and prints the
  client `export` lines. Presets `claude-code` (prints
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`) and `openai-apps` (prints
  `OPENAI_BASE_URL`/`OPENAI_API_KEY`); flags `--preset`, `--target`,
  `--model`, `--base-url`, `--port`, `--help`.
- **Docker image on GHCR.** Release tags (`v*`) publish
  `ghcr.io/dorrabbkhan/babelgate:<version>` and `:latest` via
  `.github/workflows/release.yml`. npm publishing stays a manual step.
- **Release gate + live streaming suite.**
  `scripts/gates/claude-code-edit.sh <ollama|openrouter> [model]` runs
  Claude Code through the proxy on a real edit task and prints
  `GATE PASS`/`GATE FAIL`; `npm run test:live` gained streaming and tool
  cases plus an `openrouter` target (`OPENROUTER_API_KEY`).
- **Stream fixture corpus and stream contract tests** — recorded wire
  bytes per provider, decoded identically at every chunk split, parsed
  back with the providers' own SDKs, plus property tests over the stream
  event-ordering rules.

### Changed

- **Renamed llm-proxy → babelgate** — package name (npm `babelgate`),
  repository docs and the OpenAI `owned_by` fallback.
- **`stream: true` no longer returns 501** in any dialect (spec F1) —
  the one intentional wire-behaviour change of this release. Ollama
  requests that omit `stream` still get a single JSON reply.

### Known limitations

- The launch-verified streaming × tools pairs are `anthropic → ollama`,
  `anthropic → openai` (incl. OpenAI-compatible backends) and
  `openai → ollama`; the full 16-pair matrix is milestone 2.
- The Claude Code ↔ Ollama path was not gate-tested on a capable model
  before release (accepted risk); local models may call tools
  unreliably, and CPU-only machines can hit the
  `UPSTREAM_STREAM_IDLE_MS` stream idle timeout.
- Reasoning/thinking is not mapped (dropped); `parallel_tool_calls` is
  ignored; `count_tokens` is an estimate; the Gemini target and
  Gemini/Ollama sources have not had a clean live run.

## [1.0.1] - 2026-10-27

Correctness patch and public-repo hygiene: makes v1.0's claims true against
real upstreams, renders every error in the client's own provider format, and
gets the repository ready for outside contributors.

### Fixed

- **Ollama chat requests failed with a 500 (E1).** Ollama's own API
  streams NDJSON by default; when the client omitted `stream`, the
  streamed upstream reply crashed the proxy's JSON response path and the
  client got a 500 `TRANSFORM_ERROR` instead of a reply. The Ollama
  adapter now sends `stream: false` upstream when the client omitted
  `stream`.
- **Non-JSON upstream bodies failed confusingly (E2).** A 2xx upstream
  reply that isn't JSON now returns 502
  `Upstream returned a non-JSON response (content-type: <type>)` instead of
  a transform crash.
- **Gemini clients' model was ignored (E10).** The proxy now takes the
  model from `POST /v1beta/models/<m>:generateContent` (URL-decoded,
  slashes kept) instead of sending a hard-coded model upstream.
- **Unsupported Gemini methods were silently answered as chat (E11).**
  `:countTokens`, `:embedContent` and other non-chat methods now return
  501 `<method> is not supported` in the Gemini dialect.

### Changed

- **Errors on configured provider routes are rendered in the client's
  provider format** — OpenAI, Anthropic, Gemini and Ollama error bodies —
  so client SDKs raise their native exceptions. This covers upstream
  failures, auth rejections, malformed JSON and oversized bodies on those
  routes; non-provider paths (unknown routes, `/health`) keep the generic
  `{error:{message,code,status}}` shape.
  **Compatibility note:** the old `{error:{message,code,status}}` shape is
  gone on provider routes; clients that parsed it must switch to their
  SDK's error types.
- **Upstream status mapping is honest about who failed:** 400/422 → 400,
  404 → 404, 413 → 413, 429 → 429 with `Retry-After` passed through,
  503/529 → 503, other 5xx → 502. Upstream 401/403 — including Gemini's
  `400 API_KEY_INVALID` — becomes 502
  `Upstream <provider> rejected the proxy's credentials (<status>)`,
  because the proxy's upstream key failed, not the client's.
- **`PROXY_API_KEY` works with each provider's native auth header:**
  `Authorization: Bearer` (case-insensitive scheme), `x-api-key`,
  `x-goog-api-key` and the `?key=` query parameter. Client credentials are
  never forwarded upstream.
- **Ollama-format requests that omit `stream` get a single JSON reply.**
  This differs from Ollama's own API, which streams by default — send
  `"stream": false` explicitly. `"stream": true` returns 501 until v1.1.
- **Request logs redact credentials**: client auth headers and `?key=`
  query parameters no longer appear in request log lines.
- **Live suite default Ollama model is `qwen2.5:0.5b`** (a small
  non-thinking model; `LIVE_OLLAMA_MODEL` overrides, e.g. for
  `qwen3:0.6b`).

### Added

- **Opt-in live suite** (`npm run test:live`, `tests/live/`): the real app
  against real upstreams — Ollama always, paid providers when their API
  keys are set. Asserts response shapes only. Nightly GitHub Actions job
  against a fresh Ollama.
- **CI** (`.github/workflows/ci.yml`): `./scripts/check.sh` plus a Docker
  build on every PR and push to main.
- **Apache-2.0 licence** (`LICENSE`, `NOTICE`) and a Contributor License
  Agreement (`CLA.md`) enforced by CLA Assistant on PRs.
- **Contributor docs**: `CONTRIBUTING.md`, `SECURITY.md`, issue templates
  (bug, provider request, feature) and a PR template.

### Known limitations

- **Streaming is not transformed.** `stream: true` in any dialect — and
  Gemini's `:streamGenerateContent` — returns 501
  `Streaming is not supported yet (planned for v1.1). Send "stream":
  false.` until v1.1.
- **Ollama `thinking` output is dropped** by the proxy (the canonical
  format has no field for it); planned for v1.1.

[Unreleased]: https://github.com/dorrabbkhan/babelgate/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/dorrabbkhan/babelgate/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/dorrabbkhan/babelgate/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/dorrabbkhan/babelgate/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/dorrabbkhan/babelgate/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/dorrabbkhan/babelgate/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/dorrabbkhan/babelgate/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/dorrabbkhan/babelgate/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/dorrabbkhan/babelgate/releases/tag/v1.0.1
