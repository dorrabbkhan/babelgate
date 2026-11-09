# Recipe: Observability — the UI, the usage store, metrics and OTel

v1.3 turns every chat request into a **request trace** (one per request,
emitted exactly once — success, upstream failure and client abort alike)
and fans it out to isolated **sinks**: the log line, the SQLite usage
store, the in-memory body ring, Prometheus metrics, and optional
OpenTelemetry spans. The UI at `/ui` is the front end: Requests +
Inspector, Usage, Routing, and a side-by-side Playground.

## The privacy model (D3)

Bodies — prompt text, completions, tool arguments — reach only the
in-memory ring (the last `INSPECTOR_BUFFER` traces, lost on restart) and,
with `LOG_BODIES=true`, the `bodies` table. Everything else carries
routing and usage facts; headers and keys are never captured anywhere.

| Data | Log | `requests` table | `bodies` table | In-memory ring | `/metrics` | OTel spans | `/ui/api` |
|---|---|---|---|---|---|---|---|
| Routing & usage facts — client id, source, requested → provider/model, status, tokens, cache tokens, cost, ttfb/total ms, hop outcomes | ✓ | ✓ | — | ✓ | ✓ (labels) | ✓ (attrs) | ✓ |
| Notes, diagnostics, repairs — codes and JSON paths only | ✓ | ✓ | — | ✓ | ✓ (code labels) | — | ✓ |
| Prompt text, completions, tool arguments | never | never | `LOG_BODIES=true` only | last N traces | never | never | inspector only |
| Headers | never | never | never | never | never | never | never |
| API keys | never | never | never | never | never | never | never |

A `tests/integration/privacy-canary.test.ts` sentinel asserts this on
every sink. `emitTrace` strips `bodies` before any non-body sink sees the
trace; a failing sink warns once a minute and never touches the response.

## Settings

All of these also have `observe:` / provider keys in `babelgate.yaml`;
env wins over YAML, as in v1.2.

| Env | YAML | Default | What it does |
|---|---|---|---|
| `USAGE_STORE` | `observe.usage_store` | `on` | SQLite usage store; `off` never loads `node:sqlite` |
| `USAGE_DB` | `observe.usage_db` | `~/.babelgate/usage.db` (`/data/usage.db` in Docker) | where the `requests`/`bodies` tables live |
| `USAGE_RETENTION_DAYS` | `observe.retention_days` | `30` | hourly delete of rows older than this |
| `INSPECTOR_BUFFER` | `observe.inspector_buffer` | `50` | traces kept in the body ring; `0` disables body capture entirely |
| `LOG_BODIES` | `observe.log_bodies` | `false` | persist body snapshots to the `bodies` table |
| — | `observe.would_cost_reference` | unset | `provider/model` used to price "what a local run would have cost" |
| `METRICS` | — | `on` | `/metrics` Prometheus endpoint |
| `UI` | — | `on` | `/ui` SPA and `/ui/api`; `off` answers 404 |
| `UI_ALLOW_REMOTE` | — | `false` | let non-loopback clients reach `/ui` without a key |
| `UI_ALLOWED_HOSTS` | — | empty | comma-separated extra `Host` values `/ui/api` accepts |
| `TARGET_MAX_OUTPUT_TOKENS` | provider `max_output_tokens` | unset | clamp the model's output budget per provider |
| — | provider `cache_hints` | `false` | encode canonical cache hints for providers that support them |
| — | provider `live_prices` | `false` | read `pricing` from the provider's model list (OpenRouter shape) |
| — | provider `repair_tool_calls` | `false` | mechanically repair broken tool-call arguments |
| — | provider `local` | `false` | treat a non-Ollama provider as free (`costUsd: 0`, `priceSource: "local"`) |
| — | top-level `prices:` | empty | USD-per-1M-token overrides by `provider/model` glob |

A store that can't be opened — unwritable directory, a file that isn't
SQLite, a DB locked by a second babelgate — logs one warning naming the
path and disables itself; serving is unaffected and
`babelgate_sink_errors_total{sink="usage-store"}` counts it.

## `/metrics`

Prometheus text exposition at `GET /metrics`. Open unless `PROXY_API_KEY`
is set (then the same key applies). Scrape config:

```yaml
scrape_configs:
  - job_name: babelgate
    static_configs:
      - targets: ["localhost:3000"]
    # bearer_token: <PROXY_API_KEY>   # only when PROXY_API_KEY is set
```

Series: `babelgate_requests_total{source,provider,model,client,status}`,
`babelgate_request_duration_seconds` and `babelgate_ttfb_seconds`
histograms `{source,provider,status}`,
`babelgate_tokens_total{provider,model,client,kind}`,
`babelgate_cost_usd_total{provider,model,client}`,
`babelgate_fallbacks_total{from_provider,outcome}`,
`babelgate_tool_call_failures_total` and
`babelgate_tool_call_repairs_total{provider,model,code}`,
`babelgate_unpriced_requests_total{model}`,
`babelgate_sink_errors_total{sink}`,
`babelgate_aux_requests_total{source,kind}`, plus the Node process
defaults. `model` is the routed model, never the requested string; each
label caps at 100 distinct values, then reports `other`.

## OpenTelemetry

Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set — the OTel packages are
never imported otherwise:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=babelgate \
  npx babelgate --config babelgate.yaml
```

One SERVER span `babelgate {source}` per request and one CLIENT span
`chat {model}` per hop, GenAI-convention attributes (provider, models,
token usage, finish reasons) plus `babelgate.*` routing/cost attributes.
An incoming `traceparent` parents the server span. **Content is never
exported** — `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` is ignored by
design.

## The UI

`http://localhost:3000/ui` (the CLI prints it in the endpoints block).
Requests is a live tail of the store; the Inspector diffs each trace's
four body stages; Usage shows cost/tokens per day, model, provider or
client; Routing renders the table and answers "where would this model
go?"; the Playground streams 2–4 models side by side.

**Access:** without `PROXY_API_KEY`, `/ui` and `/ui/api` answer loopback
clients only — everyone else gets a 403 with the hint. `/ui/api` also
requires the `x-babelgate-ui: 1` header (forces a CORS preflight no page
can pass) and a `Host` of `localhost`, `127.0.0.1`, `[::1]` or a
`UI_ALLOWED_HOSTS` entry.

## Docker

```bash
docker run --rm -p 3000:3000 \
  -v babelgate-data:/data \
  -e BABELGATE_CONFIG=/data/babelgate.yaml \
  -e OPENROUTER_API_KEY \
  ghcr.io/dorrabbkhan/babelgate
```

The config file must already exist in the volume — e.g. create the
volume first and copy `babelgate.yaml` into it — or bind-mount the file
directly instead of the named volume:
`-v ./babelgate.yaml:/data/babelgate.yaml:ro`.

- **`-v babelgate-data:/data`** persists the usage DB — the image sets
  `USAGE_DB=/data/usage.db` and declares `VOLUME /data`.
- The UI's loopback rule sees container clients as remote: set
  **`PROXY_API_KEY`** (then every proxied and `/ui/api` call needs it) or
  **`UI_ALLOW_REMOTE=true`**, plus `UI_ALLOWED_HOSTS` for a non-localhost
  `Host`.
- `LOG_BODIES=true` inside the container writes prompt/completion bodies
  to the volume — off by default.

## Files

| Thing | Where |
|---|---|
| Trace shape and sinks | `src/observe/` |
| Store schema & queries | `src/observe/sinks/usage-store.ts`, `usage-queries.ts` |
| Metrics registry | `src/observe/sinks/metrics.ts` |
| OTel sink | `src/observe/sinks/otel.ts` |
| UI API | `src/ui-api/` |
| SPA source | `ui/` |
