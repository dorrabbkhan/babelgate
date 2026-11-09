# Architecture

babelgate is a TypeScript / Express 5 proxy that translates between LLM
API formats — OpenAI, Anthropic, Gemini, Ollama — through a **canonical
intermediate format**: one adapter per provider, never one transformer
per provider pair. This document is the map; `docs/roadmap.md` is the
direction and `docs/decisions.md` is the journal.

## Request pipeline

```
request
  → requestLogger → detectSource → body parser → /ui/api · /ui · requireApiKey
  → /metrics → observeMiddleware        (chat requests only: opens the ALS trace scope)
  → proxy service
       · snapshot "source"              (raw client body — only while the ring is on)
       · decode: source dialect → canonical request
       · planRoute: explicit provider/model → aliases → rules (when. conditions)
         → default provider
       · per hop: canonicalForTarget (max_output_tokens clamp)
         → snapshot "target[hop]" → encode: canonical → target dialect
         → upstream call (timeout, retry, fallback before the first byte)
       · decode response → tool-call diagnostics (+ optional repair)
       · snapshot "response"           (canonical + wire body/stream bytes)
       · encode response → client
  → finishTrace → emitTrace             (usage, cache tokens, cost, status)
      → sinks: log · usage-store · body-ring · metrics · otel
```

The middleware order is deliberate: `/health`, `/ui/api` and `/ui` sit
before auth so the UI can gate itself, `/metrics` sits after auth so a
set `PROXY_API_KEY` covers it, and `observeMiddleware` sits after both —
pre-route rejections are never traced. Only chat requests open a trace;
`count_tokens`/`countTokens` and model-list calls only count in
`/metrics` (`babelgate_aux_requests_total`).

## Translation: the canonical format

`src/types/canonical.types.ts` is the contract — messages (text, images,
tool calls/results), tools, system parts, cache hints, usage (incl.
cache read/write tokens), errors and stream events.
`canonical.schema.ts` is its Zod mirror; the two move together and every
change is an interface change recorded in `docs/decisions.md`.

`src/transformers/adapters/` holds one file per provider (plus a
`.stream.ts` codec each): a decoder (wire → canonical), encoders
(canonical → wire), and `PROVIDER_ROUTES` entries describing the
provider's endpoints. **Adapters stay independent** — no adapter imports
another, and nothing special-cases a provider pair. If a pair needs
special handling, canonical is missing something: that is a spec-level
change, not an adapter branch.

Unsupported features fail with a clear error shaped like the *source*
provider's errors (Gemini's gRPC status object, Anthropic's
`error.type`, OpenAI's `error` envelope, Ollama's `{"error": …}`) — the
`detectSource` middleware records the request's dialect so even
body-parse and 404 errors render correctly.

## Routing

`babelgate.yaml` (`--config`, `BABELGATE_CONFIG`, or `./babelgate.yaml`)
defines providers, aliases and ordered `routes`; without a file,
env-only mode builds one provider from `TARGET_API` and turns
`MODEL_MAP` globs into routes. `planRoute` resolves
explicit `<provider>/<model>` → alias → first matching rule (with
optional `when.min_input_tokens`) → the default provider. A rule's
`fallback` list is tried on transport failure, header/connect timeout,
or an upstream `429/5xx` — only before the first byte; a mid-stream
death is an in-stream error, never a silent switch. Per-provider flags
(`max_output_tokens`, `context_window`, `timeout_ms`, `cache_hints`,
`live_prices`, `repair_tool_calls`, `local`) carry all provider
differences — never a hostname check.

Replies keep the model name the client asked for;
`x-babelgate-provider`, `x-babelgate-model` and `x-babelgate-attempts`
headers say who actually served it.

## The observe layer (v1.3)

One **request trace** per chat request that reaches `planRoute`,
emitted exactly once — success, upstream failure and client abort —
inside an `AsyncLocalStorage` scope that also collects translation
notes (`recordNote(code, path)` — codes and field paths, never
content).

**Sinks** are `{ name, accept(trace) }`, fanned out by `emitTrace`
behind per-sink try/catch: a throwing sink is counted
(`babelgate_sink_errors_total`), warned once a minute, and never
reaches the client or the other sinks. `emitTrace` strips `bodies`
before the trace reaches any sink that isn't `body-ring` or
`usage-store` — that one rule is the privacy model's enforcement point.

| Sink | What it does with a trace |
|---|---|
| `log` | the `"Request completed"` line (the v1.2 route log, extended) |
| `body-ring` | keeps the last `INSPECTOR_BUFFER` traces' four body snapshots in memory (1 MB cap each, 256 KB stream bytes) |
| `usage-store` | batches one `requests` row per trace into `node:sqlite` (`USAGE_DB`, 250 ms / 100 rows); `bodies` rows only with `LOG_BODIES=true`; hourly retention deletes |
| `metrics` | `prom-client` registry behind `GET /metrics` — counters/histograms with label cap 100 → `other` |
| `otel` | SERVER `babelgate {source}` + per-hop CLIENT `chat {model}` spans, built after the fact; only exists when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (OTel packages load lazily) |
| `live` | SSE `started`/`finished` events for `/ui/api/live` |
| `playground` | resolves per-request waiters for the playground's multiplexed stream |

Cost lands on the trace between finish and emit: the **winning hop's**
`(provider, model)` is priced by override (`prices:`) → `local` →
`live_prices` → bundled `src/cost/prices.json` (a pinned LiteLLM
snapshot; unknown is `null`, never $0), and `observe
.would_cost_reference` prices local rows against a paid model for the
"saved ≈ $X" figure.

## `/ui/api` and the SPA

`src/ui-api/` is a thin JSON API over the store, the ring and the
routing config — `/requests` (+`:id` inspector detail), `/live` (SSE),
`/usage`, `/routing` (+`/routing/plan` dry run), `/playground`. Access
control is standalone (D2 — solo developer): `UI=off` 404s the whole
tree; without `PROXY_API_KEY` only loopback sockets pass; every call
needs `x-babelgate-ui: 1` (a header no plain web page can send without
a CORS preflight) and a `Host` that is loopback or in
`UI_ALLOWED_HOSTS`. Keys and key env names are never returned.

`ui/` is a Preact + Vite SPA built to `dist/ui` and served at `/ui`
with an SPA fallback — hand-written SVG charts, no chart library.

## Testing

Unit tests live beside their units (`src/**/*.test.ts`);
`tests/contracts/` holds schema, fixture-golden and wiring tests that
guarantee provider pairs compose through canonical; `tests/integration/`
drives the real app with `supertest` against `msw`-mocked upstreams —
**no network in `npm test`**. `tests/integration/privacy-canary.test.ts`
plants sentinel strings in a prompt, a tool argument and a completion
(plus a fake key) and asserts they reach only the ring (and `bodies`
with `LOG_BODIES=true`). Real providers are exercised only by the
opt-in `tests/live/` suite and `scripts/gates/`.
