# babelgate vs the alternatives

## The short answer

babelgate is **the translator you can check**. It translates between
five client formats and whatever providers you point it at — and unlike
the alternatives, the correctness claims are published evidence, not
marketing: a per-pair compatibility matrix generated from the tests, a
translation inspector that shows exactly what changed and what was
dropped, a small codebase with signed releases, and a shim that fixes
the gaps native endpoints leave.

## Feature comparison

Legend: **✓** yes · **◐** partial (one-line reason) · **✗** documented
as absent or unsupported · *not documented* — we could not confirm it
from the project's own docs or repository · *not verified* — a
secondary source claims it but we did not re-verify against a primary
source. Competitor columns were checked against each project's own
documentation **as of 2026-11-19**; babelgate's column reflects `main`
at v1.5 and every ✓ names the file or test that backs it. This table
can go stale — dates and sources are below.

| Feature | babelgate | LiteLLM (as of 2026-11-19) | Bifrost (as of 2026-11-19) | claude-code-router (as of 2026-11-19) | OpenRouter (as of 2026-11-19) | Cloudflare AI Gateway (as of 2026-11-19) |
|---|---|---|---|---|---|---|
| Published per-pair conformance matrix | ✓ — [docs/compatibility.md](compatibility.md), regenerated from the pair tests; CI fails on drift | not documented | not documented | not documented | not documented | not documented |
| Translation inspector (source / canonical / target side by side, dropped fields named) | ✓ — `ui/src/screens/Inspector.tsx`, `src/observe/` body ring | not documented | not documented | ◐ request logs, resolved routes, per-request cost | ◐ `debug.echo_upstream_body` returns the transformed request (streaming only) | ◐ per-request logs and analytics |
| Ollama `/api/*` as an inbound client format | ✓ — `PROVIDER_ROUTES` in `src/transformers/adapters/index.ts` (`/api/chat`, `/api/tags`) | ✗ — inbound documented as OpenAI, Anthropic and Google formats | ✗ — inbound integrations are an enumerated list without Ollama | not documented | not documented | not documented |
| Native-endpoint shim with declared per-provider gaps | ✓ — provider `preset` / `gaps` / `passthrough`: `src/config/provider-presets.ts`, `src/services/gap-fixes.ts` | ◐ generic pass-through endpoints exist; no gap vocabulary or per-endpoint fixes | not documented | not documented | not documented | not documented |
| Signed releases, SBOM | ✓ — `.github/workflows/release.yml` (cosign-signed GHCR image), maintainer-attached CycloneDX SBOM, `SECURITY.md` | not documented | not documented | not documented | n/a (hosted) | n/a (hosted) |
| Reasoning carried between turns across formats | ✓ — signed thinking/`thoughtSignature`s round-trip inside `bg1.` envelopes (`src/transformers/reasoning-envelope.ts`), origin-bound | ◐ Anthropic thinking_blocks with signatures are returned and must be re-sent by the client; documented as returned only for Anthropic models; cross-format signed round-trip not documented | ◐ signatures documented in responses (Anthropic/Bedrock, signature_delta in streams); carrying them back on later turns or across formats not documented | not verified | ◐ reasoning tokens returned; `reasoning` request parameter; signed-block round-trip across formats not documented | not verified |
| Replays each new Claude Code / Codex release | ✓ — weekly `client-replay` job in `.github/workflows/live.yml`, `scripts/gates/client-replay.sh`; result badge on the matrix | not documented | not documented | not documented | not documented | not documented |
| Claude Code on any model | ✓ — `docs/recipes/claude-code.md`, release-gate script | ✓ — Anthropic Messages endpoint documented for Claude Code | ✓ — Anthropic inbound integration | ✓ — its purpose | ✓ — Anthropic `/api/v1/messages` endpoint | ◐ documented for Anthropic / Bedrock / Vertex Claude models |
| Codex on any model | ✓ — `docs/recipes/codex.md` | ✓ — `/responses` endpoint | ✓ Codex CLI via a custom Responses API provider (`wire_api = "responses"`) | ✓ — Codex listed as a supported agent | ✓ — `/api/v1/responses` endpoint | not documented |
| Inbound client formats | ✓ five: OpenAI Chat, Anthropic, Gemini, Ollama, Responses | ✓ OpenAI, Anthropic, Google (+ SDK pass-throughs) | ✓ OpenAI, Anthropic, Google GenAI | ◐ agent-facing endpoints (Anthropic for Claude Code, Responses for Codex) | ✓ Chat Completions, Responses, Anthropic Messages | ◐ OpenAI-compat endpoint plus per-provider native endpoints |
| Streaming + tool calls translated | ✓ — every pair, contract-tested | ✓ | ✓ | ✓ | ✓ | ◐ provider-native endpoints; the compat endpoint translates |
| Routing, aliases, fallbacks | ✓ | ✓ | ✓ | ✓ | ✓ `models` array, `provider` routing, `fallbacks` | ✓ incl. dynamic routes |
| Load balancing / health / circuit breaker | planned (v1.6) | ✓ | ✓ | ◐ credential pools, key rotation, ordered fallback | ✓ automatic provider fallback | ✓ |
| Cache | planned (v1.6, opt-in exact-match) | ✓ | ✓ semantic cache | not documented | ◐ provider prompt-caching passthrough with sticky routing | ✓ |
| Cost / usage dashboard | ✓ SQLite usage store + `/ui` | ✓ | ✓ | ◐ per-request cost estimate in logs | ✓ hosted dashboard | ✓ analytics |
| Prometheus / OpenTelemetry | ✓ `/metrics` + OTel spans | ✓ | ✓ | not documented | n/a (hosted) | ◐ OTel trace export; analytics + Logpush |
| MCP gateway | ✗ not a feature — MCP calls pass through as content | ✓ MCP Gateway | ✓ MCP tools | ✓ ToolHub / MCP | not documented | not documented |
| Virtual keys / budgets / SSO / audit | planned | ✓ | ✓ keys + budgets in OSS; SSO/audit enterprise | not documented | ✓ keyed accounts + limits | ◐ rate limits, Access integration |
| Providers / models covered | ◐ five provider types; any OpenAI-compatible host via config | ✓ 100+ | ✓ | ✓ many presets | ✓ hundreds of models, one key | ✓ many providers |
| Hosted option | ✗ self-hosted only | ◐ self-host OSS; hosted enterprise offering | not documented | not documented — docs describe it running "locally or on your own server" | ✓ hosted | ✓ hosted |
| Install | ◐ `npx babelgate`, Docker image | Python service / Docker | Go binary, npx | Electron desktop app + CLI | n/a | n/a |
| Embeddings inbound | ◐ OpenAI `/v1/embeddings` only | ✓ | ✓ | not documented | ✓ embeddings endpoint | not documented |

## Where the others are better

- **Provider count and reach** — LiteLLM (100+ providers), OpenRouter
  (hundreds of models behind one key, plus a marketplace), Cloudflare
  (its network and many providers). If you need every provider under
  one roof tomorrow, **use LiteLLM or OpenRouter**.
- **Distribution and community** — tens of thousands of GitHub stars,
  tutorials, Discord servers, a desktop app (claude-code-router). If
  you want a large community and a one-click GUI, **use
  claude-code-router**.
- **MCP gateway** — LiteLLM, Bifrost and claude-code-router all govern
  MCP tool servers. If MCP governance is the requirement, **use
  LiteLLM or Bifrost**.
- **Semantic cache** — Bifrost ships one; LiteLLM and Cloudflare have
  cache features too. If semantic caching is the point, **use
  Bifrost**.
- **Load balancing / health / circuit breaking** — LiteLLM, Bifrost and
  Cloudflare are mature here; babelgate's is a planned minimal version.
  **Use LiteLLM or Cloudflare** if you need it today.
- **Team governance** — virtual keys, budgets, SSO, audit trails:
  LiteLLM and Bifrost (and Cloudflare Access) cover this now. **Use
  LiteLLM or Bifrost** for teams.
- **Raw performance** — Bifrost is a Go proxy built for low overhead.
  If microseconds matter, **use Bifrost**.
- **Hosted option** — if you don't want to run anything, **use
  OpenRouter or Cloudflare**.

## When to pick which

- **babelgate** — you run coding agents or SDK clients in several API
  dialects against several providers, and you need to *see and verify*
  every translation: the published matrix, the inspector, the shim.
- **LiteLLM** — a team needs breadth (100+ providers, governance,
  budgets, MCP) more than per-pair correctness evidence.
- **Bifrost** — a Go-native gateway where overhead microseconds,
  semantic caching and OSS virtual keys matter.
- **claude-code-router** — you live in Claude Code and friends and want
  a desktop app managing providers, keys and routing locally.
- **OpenRouter** — you want one hosted key and hundreds of models with
  zero infrastructure, and per-token pricing is acceptable.
- **Cloudflare AI Gateway** — you already run on Cloudflare and want
  hosted observability, caching and rate limiting at the edge.

## Method

Competitor cells were checked against each project's own documentation
and repositories on **2026-11-19**, starting from
`docs/research/2026-11-16-market-analysis.md` §4–§5; every `?` in the
analysis was re-verified against primary docs or left *not verified*
here. A `✗` appears only where the project's own docs enumerate the
feature space without it — the URLs are listed below. babelgate's own
column is generated behaviour: [docs/compatibility.md](compatibility.md)
is rendered from the pair tests by `npm run matrix`, and each ✓ above
names the file or test that backs it.

Corrections welcome — open an issue.

## Sources

babelgate (this repository):

- Compatibility matrix: `docs/compatibility.md` (generated by
  `npm run matrix`, `tests/matrix/`).
- Inspector: `ui/src/screens/Inspector.tsx`, `src/observe/` body ring.
- Ollama inbound: `src/transformers/adapters/index.ts`
  (`PROVIDER_ROUTES`: `/api/chat`, `/api/tags`).
- Shim: `src/config/provider-presets.ts`, `src/services/gap-fixes.ts`,
  `src/services/passthrough.ts`; recipe: `docs/recipes/native-endpoints.md`.
- Signed releases: `.github/workflows/release.yml`, `SECURITY.md`.
- Reasoning envelope: `src/transformers/reasoning-envelope.ts`,
  `tests/contracts/` reasoning fixtures.
- Client replay: `.github/workflows/live.yml` (`client-replay` job),
  `scripts/gates/client-replay.sh`.

Competitors — one row per `✗`/`◐` cell and each sourced `✓` (accessed
2026-11-19):

- LiteLLM, "Ollama inbound" `✗`: inbound formats are documented as
  OpenAI, Anthropic and Google — <https://docs.litellm.ai/docs/supported_endpoints>
- LiteLLM, "native-endpoint shim" `◐`: generic pass-through endpoints,
  no gap vocabulary — <https://docs.litellm.ai/docs/proxy/pass_through>
- LiteLLM, "hosted option" `◐`: LiteLLM is self-hosted OSS with a
  commercial hosted enterprise offering — <https://www.litellm.ai/>
- LiteLLM, "reasoning" `◐`: Anthropic thinking_blocks with signatures
  are returned and must be re-sent by the client; documented as
  returned only for Anthropic models; cross-format signed round-trip
  not documented — <https://docs.litellm.ai/docs/reasoning_content>
- Bifrost, "Ollama inbound" `✗`: the supported-integrations list
  enumerates inbound formats without Ollama — <https://docs.getbifrost.ai/integrations/what-is-an-integration>
- Bifrost, "reasoning" `◐`: signatures documented in responses
  (Anthropic/Bedrock, signature_delta in streams); carrying them back
  on later turns or across formats not documented —
  <https://docs.getbifrost.ai/providers/reasoning.md>
- Bifrost, "Codex on any model" `✓`: Codex CLI via a custom Responses
  API provider (`wire_api = "responses"`) —
  <https://docs.getbifrost.ai/cli-agents/codex-cli.md>
- claude-code-router, "translation inspector" `◐`, "load balancing"
  `◐`, "cost dashboard" `◐`, "inbound formats" `◐`: request logs,
  resolved routes and credential pools — <https://github.com/musistudio/claude-code-router>
- claude-code-router, "hosted option" *not documented*: the docs
  describe it running "locally or on your own server" —
  <https://ccrdesk.top/>, <https://github.com/musistudio/claude-code-router>
- OpenRouter, "translation inspector" `◐`: `debug.echo_upstream_body`
  — <https://openrouter.ai/docs/api/reference/overview>
- OpenRouter, "reasoning" `◐`: `reasoning` request parameter and
  reasoning tokens — <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- OpenRouter, "cache" `◐`: provider prompt-caching passthrough with
  sticky routing — <https://openrouter.ai/docs/guides/features/prompt-caching>
- OpenRouter, "embeddings inbound" `✓`: `POST /api/v1/embeddings`
  endpoint — <https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request>
- OpenRouter, "Claude Code" `✓`: Anthropic Messages endpoint —
  <https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message>
- Cloudflare AI Gateway, "translation inspector" `◐`: per-request
  logs (prompt, response, provider, tokens, cost) and dashboard
  analytics — <https://developers.cloudflare.com/ai-gateway/observability/logging/>,
  <https://developers.cloudflare.com/ai-gateway/observability/analytics/>
- Cloudflare AI Gateway, "Prometheus / OpenTelemetry" `◐`: OTel trace
  export to OTLP backends, plus analytics and Logpush —
  <https://developers.cloudflare.com/ai-gateway/observability/otel-integration/>,
  <https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/>
- Cloudflare AI Gateway, "Claude Code" `◐`: Anthropic endpoint serving
  Claude on Anthropic / Bedrock / Vertex — <https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/>
- Cloudflare AI Gateway, "streaming + tools" `◐` and "inbound formats"
  `◐`: per-provider endpoints plus an OpenAI-compat endpoint —
  <https://developers.cloudflare.com/ai-gateway/usage/providers/>
- Cloudflare AI Gateway, "governance" `◐`: rate limiting and Access —
  <https://developers.cloudflare.com/ai-gateway/features/rate-limiting/>, <https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/>
