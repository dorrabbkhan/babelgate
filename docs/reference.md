# babelgate reference

The long-form reference that the README keeps short: the CLI flags,
every environment variable, endpoint kinds, authentication, error
shapes, and the developer sections (running from source, testing,
project layout). User-facing walkthroughs live in
[docs/recipes/](recipes/); internals in
[docs/architecture.md](architecture.md).

## The `babelgate` CLI

`npx babelgate` (or the installed `babelgate` binary) parses flags with
`node:util`, sets environment defaults that **your own env always
overrides** (a stderr line, `babelgate: your environment overrides
<keys>`, tells you which preset values lost), starts the server, and
prints the client `export` lines to paste. Upstream API keys come only
from the environment — never from flags.

```
Usage: babelgate [--preset <claude-code|codex|openai-apps>] [--target <provider>]
                 [--provider <preset>] [--model <name>] [--base-url <url>]
                 [--port <n>] [--config <path>] [--help] [--version]
       babelgate presets

Config file discovery: --config, then BABELGATE_CONFIG,
then ./babelgate.yaml. Upstream API keys come only from the environment
(OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OLLAMA_API_KEY,
RESPONSES_API_KEY, or the env var TARGET_API_KEY_ENV names).
```

| Flag          | Effect                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| `--preset`    | `claude-code`, `codex` or `openai-apps` — picks which client setup to print (`export` lines, or the `config.toml` block + model catalog for codex); with no config file it also sets the env routing for that client |
| `--provider`  | A provider preset name from `babelgate presets` — fills the target type, base URL, key env var (through `TARGET_API_KEY_ENV`, so no secret is copied between variables) and any preset `max_output_tokens`. Cannot be combined with `--target`, `--base-url` or `--config` |
| `--target`    | `ollama`, `openai`, `anthropic`, `gemini` or `responses` — sets `TARGET_API` (env-only mode) |
| `--model`     | `claude-code` preset: `MODEL_MAP=claude-*=<model>`; `codex` preset: `MODEL_MAP=*=<model>` |
| `--base-url`  | Sets `{TARGET}_API_BASE_URL` (e.g. `https://openrouter.ai/api` for OpenRouter)  |
| `--config`    | Path to a `babelgate.yaml` — `--target`, `--model`, `--provider` and `--base-url` are then defined by the file |
| `--port`      | Listen port (default `3000`)                                                    |
| `--version`   | Print the version                                                             |
| `--help`      | Usage                                                                         |
| `presets`     | Subcommand: one row per provider preset — name, tier (`free`/`cheap`/`shim`), key env var name, suggested client models, and the provider doc URL with its verification date |

If the listen port is taken, babelgate prints one line naming the port
and `--port` and exits 1 — no stack trace. If a `--provider` preset's
key env var is missing, it names the variable and the provider's
sign-up page and exits before listening.

The `claude-code` preset also sets `TARGET_CONTEXT_WINDOW=32768` and, for
`--target ollama`, `UPSTREAM_TIMEOUT_MS=600000` — local models are slow.
Without `--model` (and no preset suggestion) it warns `babelgate: no
--model given; claude-* model names are forwarded to the target
unchanged` on stderr.

Presets are just env values. Everything below works without them.

## Configuration

Two modes. A **`babelgate.yaml`** (found via `--config`, `BABELGATE_CONFIG`
or `./babelgate.yaml`) defines ≥ 1 providers, aliases and ordered routes —
see the README's routing example and [examples/](../examples/). With no
file, **env-only mode** is exactly the v1.1 setup: one provider named
after `TARGET_API`, `MODEL_MAP` entries become its routes.

| Variable                  | What it's for                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `BABELGATE_CONFIG`        | Path to a `babelgate.yaml` (same as `--config`)                                               |
| `SOURCE_API`              | **Deprecated** — ignored in 1.2 (the request path decides the client format); removed in 2.0  |
| `TARGET_API`              | Format to translate to upstream — `openai`, `anthropic`, `gemini`, `ollama` or `responses` (env-only mode; ignored when a YAML file is loaded) |
| `TARGET_PRESET`           | The provider preset the env describes (set by `--provider`; merges preset `gaps`, `max_output_tokens` and `reasoning_passback` onto the provider entry) |
| `TARGET_API_KEY_ENV`      | Names the environment variable holding the upstream key (set by `--provider` from the preset's `api_key_env`) — the key itself is never copied between variables |
| `PORT`                    | Listen port (default `3000`)                                                                 |
| `{PROVIDER}_API_BASE_URL` | Upstream base URL for the target provider, e.g. `OLLAMA_API_BASE_URL=http://localhost:11434` (env-only; YAML providers use `base_url`) |
| `{PROVIDER}_API_KEY`      | API key for the target provider (Ollama doesn't need one). With YAML, keys are whichever env vars `api_key_env` names |
| `UPSTREAM_TIMEOUT_MS`     | Per-request upstream timeout (default `30000`)                                               |
| `UPSTREAM_RETRIES`        | Retries for transport failures / 429 / 503 (default `1`)                                     |
| `UPSTREAM_STREAM_IDLE_MS` | Longest gap allowed between chunks mid-stream (default `300000`)                             |
| `MAX_BODY_SIZE`           | JSON body limit (default `10mb` — base64 images need it)                                     |
| `PROXY_API_KEY`           | Optional client auth — when set, callers send the key in their provider's native auth header (see Authentication) |
| `MODEL_MAP`               | Ordered `glob=model` rules, comma-separated — e.g. `claude-*haiku*=qwen2.5-coder:7b,claude-*=qwen3-coder:30b`. First match wins; replies still carry the name the client asked for (env-only; YAML has `routes`) |
| `TARGET_CONTEXT_WINDOW`   | Minimum context window the target should allocate (Ollama `options.num_ctx`; env-only — YAML has per-provider `context_window`) |
| `TARGET_MAX_OUTPUT_TOKENS` | Clamp the model's output budget (env-only — YAML has per-provider `max_output_tokens`) |
| `CACHE`                   | `on` enables the opt-in exact-match response cache (default off — wins over the YAML `cache.enabled` key) |
| `CIRCUIT_BREAKER`         | `off` disables the per-provider passive circuit breaker (default on) |
| `USAGE_STORE` / `USAGE_DB` / `USAGE_RETENTION_DAYS` | Request-trace store: `on` / `~/.babelgate/usage.db` / `30` days (YAML `observe.*`) |
| `INSPECTOR_BUFFER`      | Traces kept in the in-memory body ring (default `50`; `0` disables body capture) |
| `LOG_BODIES`            | `true` persists body snapshots to the `bodies` table (default `false`) |
| `METRICS`               | `/metrics` Prometheus endpoint (default `on`)                             |
| `UI` / `UI_ALLOW_REMOTE` / `UI_ALLOWED_HOSTS` | `/ui` + `/ui/api`: `on` / remote clients without a key (`false`) / extra `Host`s (empty) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Set to emit GenAI-convention spans (never content); unset = no OTel |
| `MEDIA_FETCH` / `MEDIA_ALLOW_PRIVATE` | URL media fetching: `true` / `false` (YAML `media:` section) — private/loopback/link-local targets always need `allow_private` |

Provider YAML keys `max_output_tokens`, `cache_hints`, `live_prices`,
`repair_tool_calls`, `local`, `reasoning_passback` and the
`observe:`/`prices:` blocks are in
[docs/recipes/observability.md](recipes/observability.md) and
[docs/recipes/codex.md](recipes/codex.md). The shim keys — `preset`,
`gaps`, `passthrough` — are in
[docs/recipes/native-endpoints.md](recipes/native-endpoints.md);
`reasoning: false` restores v1.4's drop behaviour for that provider
([docs/recipes/claude-code.md](recipes/claude-code.md)).

### Circuit breaker (`circuit_breaker:`)

Each provider gets a passive in-memory circuit breaker (on by default;
`circuit_breaker: false` or `CIRCUIT_BREAKER=off` disables it). After
`failures` consecutive upstream failures (default `3`) the provider's
breaker opens for `cooldown_ms` (default `30000`, doubling to
`max_cooldown_ms` `300000` while failures continue) and route planning
skips it — a route with no closed provider still tries the first
target, so the breaker never refuses locally. Breaker state shows in
the `/ui` Routing table. Per provider:

```yaml
providers:
  openrouter:
    type: openai
    base_url: https://openrouter.ai/api
    api_key_env: OPENROUTER_API_KEY
    circuit_breaker: { failures: 3, cooldown_ms: 30000, max_cooldown_ms: 300000 }
```

### Response cache (`cache:`)

An opt-in, in-memory, exact-match cache (`cache.enabled: true` or
`CACHE=on`; defaults `ttl_ms: 300000`, `max_entries: 500`,
`ignore_temperature: false`) — built for CI runs and test suites. The
key is the canonical request plus the target: two requests that differ
only in `tool_choice`, tools, `response_format` or reasoning config
miss. A hit replays the stored response — streamed responses replay as
the same event sequence — in the asking client's own format and prices
at `$0` (`cache hit` in Requests, never written to logs or metrics).
Entries live in memory only.

Routing and upstream endpoints are conventions, not configuration: each
provider's routes (`kind`, `method`, `pathPrefix`, `requestPath`) live in
`PROVIDER_ROUTES` in `src/transformers/adapters/index.ts`.

## Request flow

The actual request flow:

1. Request hits the Express app.
2. The request path decides the client's format (`/v1/chat/completions`
   is OpenAI, `/v1/messages` Anthropic, `/v1beta/models` Gemini,
   `/api/chat` Ollama, `/v1/responses` Responses); the route table picks it
   up. Unknown paths fall through to a 404.
3. The body is converted to canonical, routed to a provider (config
   file, or the single `TARGET_API` in env-only mode), then encoded in
   the target's format — unless the provider already speaks the client's
   format and pass-through applies (`preset`/`passthrough` and `type:
   responses` below), in which case the body is forwarded with only its
   declared gap fixes.
4. It's forwarded upstream to the provider's `base_url` + the target's
   endpoint, with the right auth headers.
5. The response comes back through the same path in reverse.

## Client endpoints and headers

Started without `--preset`, babelgate prints a client-facing endpoint
per dialect — each is the **base URL the SDK expects**, which differs
from the raw request paths:

```
OpenAI     http://localhost:3000/v1
Anthropic  http://localhost:3000
Gemini     http://localhost:3000
Ollama     http://localhost:3000
UI         http://localhost:3000/ui
```

Responses clients — Codex CLI among them — use the same `/v1` base URL:
`POST /v1/responses` is the fifth source dialect.

```python
# OpenAI SDK (Python) — base_url includes /v1
OpenAI(base_url="http://localhost:3000/v1", api_key="babelgate")

# google-genai (Python) — http_options.base_url excludes it; the SDK
# appends /v1beta itself (a /v1beta base URL double-appends and 404s)
genai.Client(api_key="babelgate",
             http_options={"base_url": "http://localhost:3000"})
```

```ts
// @google/genai (JS) — same, via httpOptions.baseUrl
new GoogleGenAI({ apiKey: "babelgate",
                  httpOptions: { baseUrl: "http://localhost:3000" } })
```

Raw-HTTP callers use the real paths instead: `/v1/chat/completions`,
`/v1/messages`, `/v1beta/models/<model>:generateContent`, `/api/chat`,
`/v1/responses`.
Every proxied reply carries `x-babelgate-provider`, `x-babelgate-model`
and `x-babelgate-attempts`, and `GET …/models` returns one merged list
across all providers.

## Request and endpoint kinds

- **Chat** — request/response translation through canonical (OpenAI
  `/v1/chat/completions`, Gemini `/v1beta/models/{m}:generateContent`,
  Ollama `/api/chat`, Anthropic `/v1/messages`, Responses
  `/v1/responses`).
- **Streaming chat** — `stream: true` (and Gemini's
  `:streamGenerateContent?alt=sse`) flows chunk-by-chunk in each side's own
  wire protocol: SSE for OpenAI, Anthropic, Gemini and Responses, NDJSON
  for Ollama.
  A client disconnect aborts the upstream request; an upstream that dies
  mid-stream produces an in-stream error in the client's dialect, and a
  stream that stalls longer than `UPSTREAM_STREAM_IDLE_MS` is cut rather
  than left hanging.
- **Tools** — tool definitions, `tool_choice`, parallel calls, streamed
  tool-call deltas and tool results map through canonical. Calls with
  arguments that aren't valid JSON reach the model wrapped as
  `{ "_invalid_arguments": "<raw>" }` instead of crashing the turn.
- **Model list** — GET endpoints (`/v1/models`, `/v1beta/models`,
  `/api/tags`) transform the upstream catalog into the source format,
  so client SDKs and dropdowns work unchanged.
- **`count_tokens`** (Anthropic source only) — answered locally as a
  chars/4 estimate, marked by the `x-babelgate-token-estimate: true`
  response header. Claude Code calls it constantly; the estimate keeps
  it happy without a fake upstream.
- **Media** — URL images, documents (PDF, plain text) and images inside
  tool results translate through canonical. A target that needs bytes
  gets them fetched under a guard (`http:`/`https:` only, private
  addresses refused, 20 MB / 15 s caps — `media:` YAML section or
  `MEDIA_FETCH`/`MEDIA_ALLOW_PRIVATE` env); a target that can't take a
  document or tool image gets a 400 in the client's dialect, never a
  silent drop.
- **Embeddings** — `POST /v1/embeddings` (OpenAI format) routes to
  OpenAI-compatible, Gemini and Ollama targets; aliases and fallbacks
  apply.
- **Pass-through / the shim** — when the routed provider speaks the
  client's format (`type: responses` always; `type: anthropic` /
  `type: openai` with a shim `preset` or `passthrough: true`), the body
  is relayed without the canonical round trip, with each declared
  `gaps` entry's fix applied:
  [docs/recipes/native-endpoints.md](recipes/native-endpoints.md).

Every completed chat request logs token usage (`inputTokens`,
`outputTokens`, `finishReason`, upstream latency) via pino — grep for
`"Request completed"`. Model-list requests log `modelCount` instead
(`"Models list completed"`).

## Authentication

Set `PROXY_API_KEY` and every proxied endpoint requires it, in whichever
native auth style the client SDK already sends — any one match
authenticates, and every comparison is timing-safe:

- `Authorization: Bearer <key>` — OpenAI and Ollama SDKs, Codex CLI, Anthropic's
  `ANTHROPIC_AUTH_TOKEN` (the `Bearer` scheme is case-insensitive)
- `x-api-key: <key>` — Anthropic SDK
- `x-goog-api-key: <key>` — Gemini SDK
- `?key=<key>` query parameter — Gemini's other auth style

A wrong or missing key gets a `401` in the source provider's error format.
The client key is never forwarded upstream — the upstream sees only the
proxy's own `{TARGET}_API_KEY`. Leave `PROXY_API_KEY` unset to disable
client auth (local dev — the CLI's printed `export …_TOKEN=babelgate`
lines are placeholders in that mode), and note `/health` stays open either
way.

## Errors

Errors on provider routes are rendered in the **source** provider's error
format, so client SDKs raise their native exceptions:

| Source | Error body |
|---|---|
| OpenAI | `{"error":{"message","type","param","code"}}` |
| Anthropic | `{"type":"error","error":{"type","message"}}` |
| Gemini | `{"error":{"code","message","status"}}` |
| Ollama | `{"error":"<message>"}` |
| Responses | `{"error":{"message","type","param","code"}}` (the OpenAI envelope) |

The same holds inside a stream: an upstream that fails mid-stream produces
the source dialect's in-stream error event, never silence or half a JSON
object.

When the upstream provider itself fails, the status the client sees is:

| Upstream | Client | Notes |
|---|---|---|
| 400, 422 | 400 | The upstream message passes through |
| 404 | 404 | Almost always "model not found" — the client can fix it |
| 413 | 413 | Request too large |
| 429 | 429 | `Retry-After` passed through when present |
| 401, 403 | 502 | `Upstream <provider> rejected the proxy's credentials (<status>)` — the *proxy's* upstream key failed, not the client's. Gemini's `400 API_KEY_INVALID` maps here too |
| 503, 529 | 503 | Unavailable |
| Other 5xx | 502 | Upstream failure |
| Timeout | 504 | After `UPSTREAM_TIMEOUT_MS` |
| Transport failure | 502 | Upstream unreachable |
| Non-JSON 2xx body | 502 | `Upstream returned a non-JSON response (content-type: <type>)` |

A provider whose circuit breaker is open is skipped during route
planning rather than producing an error of its own — the client's
error is whichever fallback (or sole target) answered.

Error privacy in detail: proxy-generated messages contain no prompt text
or API keys, and client credentials are redacted from request logs. An
upstream 401/403 — including Gemini's `400 API_KEY_INVALID` — reaches
neither the client nor the logs; every other upstream error message is
passed through to the client and logged truncated to 200 characters.
Outside production, an error's `details` may include the first 200
characters of a non-JSON upstream body. Unknown paths and `/health` keep
a small generic error shape rather than any provider's.

## Running from source

```bash
npm ci
cp .env.example .env
```

For a local Ollama target, `.env` needs two lines:

```bash
TARGET_API=ollama
OLLAMA_API_BASE_URL=http://localhost:11434
```

Pull a small model and start the proxy:

```bash
ollama pull qwen2.5:0.5b
npm run dev
```

Then send an OpenAI-style request at the proxy:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen2.5:0.5b", "messages": [{"role": "user", "content": "Hello"}]}'
```

That gets translated to an Ollama `/api/chat` call upstream (the proxy
sends `stream: false` when you don't ask for a stream), and the response
comes back in OpenAI `chat.completion` shape. Add `"stream": true` and
the same call comes back as SSE.

## Testing

```bash
npm test
```

All fast, no network. Layers:

- **Adapter unit tests** (`src/transformers/adapters/*.test.ts`) — each
  adapter's to/from canonical functions.
- **Contract tests** (`tests/contracts/`) — the interesting part. Every
  adapter's canonical output is validated against Zod schemas, fixture-driven
  golden tests cover realistic payloads, stream decoders are run against a
  corpus of recorded wire bytes (and re-fed byte-by-byte at every split
  point) and parsed back with the providers' own SDKs, and property tests
  hammer the event-ordering rules.
- **HTTP integration tests** (`tests/integration/`) — real requests against
  the Express app via supertest, with upstream providers mocked by msw. No
  actual network calls happen. `pairs.test.ts` generates end-to-end tests
  per provider pair — chat and model list, so all 25 combinations get
  exercised — `stream-pairs.test.ts` runs the streaming × tools matrix
  over every pair, and `errors.test.ts` runs every pair through the
  upstream-error mapping table.
- **Process tests** (`tests/process/`, `npm run test:process`) — the
  release binary (and other gateways, in the conformance harness) run
  as separate processes against a local mock upstream that replays
  recorded provider responses; 127.0.0.1 only, still no external
  network.

The contract tests are what make the adapter approach hold up: you don't need
N×N tests if every adapter produces schema-valid canonical data, because then
any pair composes by construction.

## Live tests

`npm test` never touches the network, so it can't catch upstream-format
drift. The opt-in live suite runs the real app against real upstreams:

```bash
npm run test:live
```

- **Ollama always runs**: `OLLAMA_API_BASE_URL` (default
  `http://localhost:11434`) must be reachable or the suite fails loudly —
  it never silently passes. Model from `LIVE_OLLAMA_MODEL` (default
  `qwen2.5:0.5b`).
- **Paid providers are opt-in**: OpenAI, Anthropic and Gemini cases run
  only when `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` are
  set, with cheap defaults `gpt-4o-mini`, `claude-haiku-5-5` and
  `gemini-3.8-flash` respectively — `LIVE_<PROVIDER>_MODEL` overrides.
  **OpenRouter** runs as an extra OpenAI-style target when
  `OPENROUTER_API_KEY` is set (model `LIVE_OPENROUTER_MODEL`, default
  `qwen/qwen3-coder`). Skipped targets are listed in the output.
- Cases per available target, driven through every source format: a chat
  round trip, the model list, an unknown model → 404 (400 on OpenRouter —
  it answers bad model IDs differently), and a streamed chat asserted on
  chunks, terminal event and usage — all on response *shape*, never on
  generated text.

A Codex live suite (`tests/live/codex.live.test.ts`) replays recorded
Codex session shapes against real upstreams the same way.

A nightly GitHub Actions job (`.github/workflows/live.yml`) runs the
suite against a fresh Ollama; paid-provider secrets are off until the
owner adds them.

**The release gate** — `scripts/gates/claude-code-edit.sh <ollama|openrouter>
[model]` — is the end-to-end proof: it copies a fixture repo with a failing
test, starts `babelgate --preset claude-code`, lets Claude Code fix the bug
through the proxy (file edits and `npm test` only), then runs the test
itself. Prints `GATE PASS`/`GATE FAIL`, the `claude --version`, model and
duration. It makes real network calls. A weekly `client-replay` job in
the same workflow installs the newest Claude Code and Codex releases and
replays their recorded shapes through the gates; a drift opens an issue.

## Project structure

```
src/
├── cli.ts                  npx babelgate / the binary — flags, presets, printed export lines
├── cli-first-run.ts        --provider env mapping, key guidance, codex config.toml + catalog
├── app.ts                  Express app wiring (middleware → routes → errors)
├── index.ts                Server startup
├── config/                 Env-only config + babelgate.yaml loader (zod-validated) + provider presets
├── middleware/             Source detection, client auth, pino logging, error handler
├── routes/proxy.ts         Thin HTTP adapter — writes streams, aborts on close
├── services/
│   ├── http-client.ts      Upstream transport: timeout, retry, logging, postStream
│   ├── stream-pipeline.ts  Provider-agnostic stream plumbing (abort, idle timeout)
│   ├── response-cache.ts   Opt-in exact-match response cache (memory only)
│   ├── token-estimate.ts   chars/4 estimate behind count_tokens
│   └── proxy.service.ts    Orchestration: validate → transform → forward
├── routing/                Provider registry, aliases/rules, planRoute, MODEL_MAP, circuit breaker
├── observe/                RequestTrace + sinks (log, store, ring, metrics, OTel)
├── cost/                   Bundled price table, overrides, live prices, compute
├── ui-api/                 /ui/api JSON routes + access control
├── transformers/
│   ├── index.ts            transformRequest/transformResponse entry points
│   └── adapters/           One adapter per provider (+ stream codecs, helpers) + PROVIDER_ROUTES
├── types/
│   ├── canonical.types.ts  The canonical format + CanonicalStreamEvent
│   ├── canonical.schema.ts Zod schemas for runtime validation
│   └── *.types.ts          Provider types (mostly SDK re-exports)
└── utils/                  logger (pino), error classes, SSE/NDJSON parsers,
                            ID generators, stream reassembly, MODEL_MAP
ui/                         The /ui single-page app (Preact + Vite, Playwright e2e)
```

## Adding a provider

Adding a provider means one adapter plus registration, env typing and
fixtures/tests — see
[CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-provider).

## Docker

```bash
docker build -t babelgate .
docker run -p 3000:3000 --env-file .env babelgate
```

Release tags also publish `ghcr.io/dorrabbkhan/babelgate:<version>` and
`:latest` via `.github/workflows/release.yml` — the image is signed
with keyless cosign in CI, the npm package is published by hand
(without provenance), and a maintainer-generated CycloneDX SBOM is
attached to each GitHub release. Verification steps:
[SECURITY.md](../SECURITY.md).

Multi-stage build: provider SDKs are `devDependencies` (type-only imports),
so the runtime image ships `dist/` (server and built UI) plus the
runtime dependencies from `package.json` — `express`, `pino`,
`pino-http`, `zod`, `yaml`, `dotenv`, `prom-client` and the
OpenTelemetry packages. The usage store uses Node's built-in
`node:sqlite` and lives on the `/data` volume (`USAGE_DB=/data/usage.db`).

## Stack

Node ≥ 22.13 (release binaries embed Node 24), Express 5, TypeScript,
pino (logging), zod (schema
validation), yaml (config), `node:sqlite` (usage store), prom-client and
OpenTelemetry (metrics, traces), Preact + Vite (the `/ui`), vitest + msw +
supertest + Playwright (tests). Provider types come from the official SDKs
wherever possible.
