# babelgate roadmap

**Status:** v1.2 released — one endpoint, many providers: all four client formats on one
port, model-name routing with aliases and fallbacks, a merged model list and `babelgate.yaml`.
**Next:** v1.3. Last revised 2026-11-03. Reasoning behind this roadmap: the
2026-10-26 roadmap design spec in `docs/superpowers/specs/`.

**Positioning:** a small, typed, contract-tested gateway that translates **any client format to any
provider** — not only "OpenAI in". Three experiences must be flawless:
- **Claude Code on anything.** Anthropic-format clients against Ollama, Gemini, OpenAI or any
  OpenAI-compatible backend, with streaming and tools.
- **Any OpenAI app, any backend.** Open WebUI, Cursor, LangChain, the OpenAI SDK — unchanged.
- **One endpoint, many providers.** Model-name routing, aliases and fallbacks behind a single URL.

**Business model:** open core. The core is Apache-2.0 with a CLA from the first outside contribution.
Team governance ships later as a separate commercial package on a public plugin API. The paid tier is
built only after 3 teams commit.

Each version is one spec → plan → agent cycle. Size, for part-time agent-driven work: **S** ≈ 2–3 weeks,
**M** ≈ 4–6 weeks, **L** ≈ 2–3 months. Every version ships with recipes for the clients it affects and the
same validation discipline: adapter contract tests, fixture corpora recorded from real SDKs, pair tests
across every source × target, and a live smoke run against real upstreams before release.

| Milestone | After | Meaning |
|---|---|---|
| 🚀 Public launch | **v1.1** | Claude Code and OpenAI apps work against any backend, streaming and tools included |
| 🟢 **POWERHOUSE** | **v1.5** | One endpoint, ~20 providers, 5 formats, cost dashboard, translation inspector, one-command install |
| 💰 Paid tier | **v2.1** | Only after 3 teams commit (LOI, pre-order or design-partner agreement) |
| ☁️ Hosted control plane | **v3.0** | Only if the paid tier shows demand for it |

---

## Phase 1: Make it correct and launch (v1.0.1–v1.1)

### v1.0.1 Correctness patch and public hygiene (S) · *urgent*
- **Ollama streaming default.** Ollama streams NDJSON when `stream` is omitted; the adapter omits it
  when the client did, and `http-client` calls `res.json()`. The README quick-start (OpenAI → Ollama)
  likely fails against a real Ollama; the msw mocks hide it. Send `stream: false` explicitly. Confirm
  against a live Ollama first.
- **Honest streaming refusal.** Until v1.1, `stream: true` returns a clear `501` instead of an opaque
  upstream parse failure.
- **Errors in the client's dialect.** Every proxy error is shaped like the *source* provider's error so
  SDKs raise their native exceptions.
- **Live smoke suite.** `npm run test:live`, opt-in: real Ollama always, paid providers when keys are
  present. Nightly in CI, never on PRs. Catches the class of bug mocks can't.
- **Public-repo hygiene.** Apache-2.0 LICENSE, CLA bot, CONTRIBUTING, SECURITY.md, issue templates,
  GitHub Actions CI running `./scripts/check.sh`, `package.json` license/author, drop `dist/` from the
  tree, fix `.gitignore` lines with trailing `# comments` (git treats them as part of the pattern, so
  `.vscode/`, `.idea/`, `.DS_Store` and `*.tsbuildinfo` aren't actually ignored).
- **Docs tree.** `docs/roadmap.md`, `docs/decisions.md`, `docs/architecture.md`,
  `docs/superpowers/{specs,plans}`.

### v1.1 Claude Code on anything (L) · 🚀 public launch
- **Streaming in all four adapters.** `toCanonicalStream` / `fromCanonicalStream` over the existing
  `CanonicalStreamChunk`, speaking each wire protocol: OpenAI SSE, Anthropic event-typed SSE
  (`message_start` → `content_block_delta` → `message_stop`), Gemini `streamGenerateContent?alt=sse`,
  Ollama NDJSON. Client disconnect aborts upstream. Usage on the final chunk.
- **Tool calling end to end in all four adapters.** Definitions, `tool_choice` (wire up the unused
  `CanonicalToolChoice`), parallel calls, tool results, and streamed tool-call deltas (partial JSON
  arguments). An ID-mapping layer for Gemini, which has no call IDs. Today only the OpenAI adapter
  handles tools; Gemini drops them and Anthropic/Ollama only map the finish reason. Riskiest item.
- **Claude Code essentials.** Anthropic `system` arrays; `thinking` blocks degrade to text or are dropped,
  never crash; `count_tokens` (estimated, flagged as such); `cache_control` ignored safely; `MODEL_MAP`
  so Claude Code's big/fast model names map to real targets (`claude-sonnet-*` → `qwen3-coder`).
- **Zero-friction install.** `npx babelgate --preset claude-code --target ollama`; Docker image on GHCR;
  presets print the exact env vars to paste (`ANTHROPIC_BASE_URL=…`).
- **Validation.** Property test: every adapter's stream reassembles into the same canonical response as
  its non-streaming twin. Pair tests extended to streaming × tools across all 16 pairs. Release gate: a
  live run where Claude Code completes a real edit task through the proxy on Ollama.
- **Launch.** README demo GIF; "Claude Code + local Llama in 30 seconds" on HN, r/LocalLLaMA,
  r/ClaudeAI; Ollama community-integrations listing.
- **Not in v1.1:** several providers per instance (v1.2), UI (v1.3), embeddings (v1.4).

---

## Phase 2: The gateway you keep running (v1.2–v1.5)

### v1.2 One endpoint, many providers (M)
- **All formats served at once.** OpenAI, Anthropic, Gemini and Ollama paths are all live on one
  port; the request path decides the source format. `SOURCE_API` is retired.
- **Model-name routing.** `gpt-*` → OpenAI, `claude-*` → Anthropic, `gemini-*` → Gemini, otherwise
  Ollama; overridable with ordered glob rules (`ROUTES="claude-*=anthropic,qwen*=ollama,*=openai"`);
  explicit `provider/model` syntax.
- **Aliases.** `fast`, `smart`, `local` → real models, so client configs survive model swaps.
- **Fallback chains.** On 429/5xx/timeout, try the next target — only before the first streamed byte.
- **Merged model list.** `/v1/models` and equivalents list every routed model and alias.
- **Optional `babelgate.yaml`** for routes, aliases and fallbacks. Env vars still cover the
  single-target case.
- **OpenAI-compatible targets as config.** Groq, Together, DeepSeek, OpenRouter, LM Studio, vLLM,
  llama.cpp: `type: openai-compatible, base_url`, no new adapter. ~15 providers for free.

### v1.3 See what's happening (M)
- **Usage store.** SQLite: tokens, latency, model, route and fallback hops per request.
- **Cost.** Bundled, updatable price table; cost per request, model and day. Local models show $0 and
  "what this would have cost".
- **Built-in UI at `/ui`.** One static bundle, no extra service: live request log with a **translation
  inspector** (the request in source, canonical and target form side by side), usage/cost charts,
  routing-table viewer, and a playground that sends one prompt to N models side by side.
- **`/metrics`** (Prometheus) and OpenTelemetry traces.
- **Privacy by default.** Prompt bodies are not stored unless `LOG_BODIES=true`; redaction hooks.

### v1.4 API breadth (M)
- **Embeddings.** OpenAI ↔ Gemini ↔ Ollama; `501` in the source's dialect for Anthropic.
- **Structured output.** `response_format`/JSON schema ↔ Gemini `responseSchema` ↔ Ollama `format`;
  tool-call emulation for Anthropic.
- **OpenAI Responses API as a fifth adapter.** Newer OpenAI SDKs and agents use it, and it
  re-proves "a new provider costs one adapter file".
- **Media.** PDFs/documents; image URLs fetched and inlined for base64-only providers.
- **Reasoning.** `reasoning_effort` ↔ Anthropic `thinking.budget` ↔ Gemini `thinkingConfig`; reasoning
  content mapped across.

### v1.5 Resilience and local-first polish (M)
- **Health and balancing.** Provider health checks, circuit breaker, load balancing across multiple
  keys or Ollama hosts.
- **Response cache.** Exact-match, opt-in — useful for CI and test suites running SDK code against a
  cheap or local backend.
- **Limits.** Rate limiting per client key; CORS and helmet.
- **Distribution.** Single binary (Node SEA or Bun compile) with `brew`/`winget`, or a tray app — chosen
  in the v1.5 spec.
- **Presets and recipes.** Cursor, Continue, Aider, Open WebUI, LangChain, LlamaIndex, Vercel AI SDK —
  each a tested recipe page.

> **🟢 POWERHOUSE: after v1.5.** Any client in any of 5 formats reaches any of ~20 providers through
> one endpoint, with streaming, tools, structured output, embeddings, fallbacks, a cost dashboard and a
> translation inspector. It installs in one command and every pair is contract-tested. Targets: 2k GitHub
> stars; listed in Ollama, Open WebUI and Claude Code community docs; 10+ outside contributors; **the
> first teams asking for shared keys and budgets** — the signal for Phase 3.

---

## Phase 3: Teams and the paid tier (v2.0–v2.4)

**[Team]** marks features in `@babelgate/team`, a commercial package in a private repo that uses only
the public plugin API. Everything else stays Apache-2.0.

### v2.0 Plugin API and multiple keys (M) · open
- Stable hooks — `onRequest`, `onRoute`, `onResponse`, `onStreamChunk`, `onError` — on typed canonical
  objects. Logging, cost and cache are rebuilt as plugins to prove the hooks are sufficient.
- Example plugins: PII redaction, prompt-injection guard (external classifier call-out), header routing.
- Multiple labelled `PROXY_API_KEY`s with per-key usage. Individuals and homelabs never hit a paywall.

### v2.1 Team governance (L) · **[Team]** · 💰 ONLY AFTER 3 TEAMS COMMIT
- Virtual keys per person/project/app with model allow-lists and expiry; upstream keys never exposed.
- Budgets and quotas (daily/monthly, $ or tokens, per key/team/project); alert at 80%, stop at 100%.
- Admin UI: keys, teams, budgets, spend reports, CSV export.
- Audit log: who used which model, when, at what cost; optional body capture with retention policies.
- Postgres alongside SQLite for multi-instance deployments.
- Until the gate is met, the v2.0 hooks and a waitlist page are the team offer.

### v2.2 Enterprise access (M) · **[Team]**
- SSO (OIDC: Google, Okta, Entra) and roles (admin/member/viewer).
- Signed policy files: model allow-lists per group, data residency (EU-only providers), block
  training-enabled endpoints.
- Compliance pack: security questionnaire, DPA template, Helm chart and self-hosting guide.

### v2.3 Smart routing (M) · open + **[Team]**
- Open: cost- and latency-aware routing ("cheapest model meeting X"), A/B splits, shadow traffic.
- [Team]: routing rules per team; evals comparing models on your own traffic before switching.

### v2.4 Prompt and agent operations (M) · **[Team]**
- Versioned prompt templates served by the proxy; replay recorded sessions against a new model;
  regression diffs.

**Pricing sketch** (confirmed in the v2.1 spec): Free — everything open, unlimited. Team — ~$20–30 per
active user per month, or ~$200/month flat per instance under 25 users. Enterprise — SSO, policy and
support, custom (~$10k+/year). Paid support contracts available from v1.5.

---

## Phase 4: Hosted control plane (v3.0) · ☁️ only if Phase 3 shows demand

### v3.0 Hosted control plane (L)
The proxy keeps running in the customer's infrastructure; a hosted dashboard receives metadata only
(usage, cost, keys, policies). Prompts never leave the customer, and we never resell tokens.

**Non-goal:** an OpenRouter-style token reseller. Billing for tokens, abuse handling and upstream
contracts are a full-time operations business, not a part-time one.

---

## Repository visibility

| Repo | Visibility | When |
|---|---|---|
| `babelgate` (core, Apache-2.0) | Public, stays public | Already public. CLA bot in place before the first outside PR is merged |
| `babelgate-team` (commercial) | Private, permanently | Created at the start of v2.1; depends only on the public plugin API |
| Hosted control plane | Private | Only if Phase 4 happens |
| Specs, plans, decisions for open features | Public, in `docs/` | Always. Pricing details and customer notes live in the private repo |

Public is not the same as announced: the repo is public now; the announcement waits for v1.1.

---

## Running alongside the versions

| When | Track |
|---|---|
| v1.0.1 | Public-repo hygiene: Apache-2.0, CLA, CI, issue templates |
| v1.1 | Launch: HN, r/LocalLLaMA, r/ClaudeAI, Ollama integrations list, demo video |
| From v1.1 | One recipe page per client tool; triage issues within 48h; a "good first issue" queue |
| v1.3 | Second Show HN with the translation inspector; a write-up of the canonical-format design |
| v1.5 | GitHub Sponsors; paid support contracts; team waitlist page |
| Before every version spec | 30-minute check of LiteLLM, Portkey, Bifrost, claude-code-router and Cloudflare AI Gateway release notes: copy what's table stakes, don't race on breadth |
| Before v2.1 | **3 committed teams, or don't build the paid tier** |

Overall horizon (from 2026-10-26): v1.1 launch in roughly 2.5–3.5 months, v1.5 (powerhouse) in roughly
8–11 months, v2.1 no earlier than about 12 months and only behind its gate. **Re-plan after every
release:** real users' issues outrank this list.
