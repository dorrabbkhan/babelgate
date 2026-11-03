# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  `TARGET_API=ollama` proxy that used to 404 `POST /v1/chat/completions`
  now answers it in OpenAI format, and likewise for every other format.
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

[Unreleased]: https://github.com/dorrabbkhan/babelgate/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/dorrabbkhan/babelgate/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/dorrabbkhan/babelgate/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/dorrabbkhan/babelgate/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/dorrabbkhan/babelgate/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/dorrabbkhan/babelgate/releases/tag/v1.0.1
