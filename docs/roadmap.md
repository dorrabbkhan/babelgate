# babelgate roadmap

**Status:** v1.4 released — Codex on any model: the OpenAI Responses API as a fifth client and
provider format, Codex CLI on Gemini, Claude and Chat-only backends with custom tools, reasoning
carried between turns and structured output across all five formats; byte-preserving pass-through
to Responses-native upstreams.
**Next:** v1.5 ("Correct everywhere"). Last revised 2026-11-16. Reasoning behind this roadmap: the
2026-10-26 roadmap design spec and the 2026-11-04 and 2026-11-16 revision specs in `docs/superpowers/specs/`;
market evidence in `docs/research/2026-11-16-market-analysis.md`.

**Positioning:** **the translator you can check.** A small, typed gateway that translates any client format to
any provider, with every format pair contract-tested **and published**, each new Claude Code and Codex release
replayed against it, and a translation inspector that shows exactly what it changed. Scope line: every agent
and SDK on every model. Proof points, in launch-copy order:
- **Published compatibility matrix**, generated from the tests, with the client versions last replayed.
- **The translation inspector**: source, canonical and target side by side, every dropped field named.
- **Small and auditable**: provenance-signed npm releases, signed images, an SBOM, few runtime dependencies.
- **A shim for native endpoints**: where a provider already speaks the client's format (Ollama, LM Studio,
  vLLM, DeepSeek, GLM, Kimi, Qwen and OpenRouter serve the Anthropic API; several serve Responses), babelgate
  passes through and fixes the gaps that endpoint leaves.

"Any model" for Claude Code or Codex, routing, fallbacks, a cost UI and provider count are table stakes in
2026 (claude-code-router, LiteLLM, Bifrost, Cloudflare, Vercel, OpenRouter all offer them), not the reason to
pick babelgate. Gemini CLI is frozen as an entry point (Google moved individuals to Antigravity CLI): its recipe
keeps working, but it is out of the headline.

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
| 🟢 **POWERHOUSE** | **v1.6** | One endpoint, ~20 providers, 5 formats, Claude Code / Codex on any model, every pair tested and published, client releases replayed, signed releases, one-command install |
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

## Phase 2: The gateway you keep running (v1.2–v1.6)

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

### v1.3 See what's happening (L)
- **Usage store.** SQLite: tokens, latency, model, route and fallback hops per request, and the client
  (User-Agent: Claude Code, Codex, Gemini CLI, an SDK) so spend can be seen per agent.
- **Cost.** Bundled, updatable price table; cost per request, model and day. Local models show $0 and
  "what this would have cost".
- **Built-in UI at `/ui`.** One static bundle, no extra service: live request log with a **translation
  inspector** (the request in source, canonical and target form side by side), usage/cost charts,
  routing-table viewer, and a playground that sends one prompt to N models side by side.
- **`/metrics`** (Prometheus) and OpenTelemetry traces.
- **Tool-call failure diagnostics.** The inspector flags where a model broke a tool call: arguments
  that aren't valid JSON, markdown fences inside arguments, unknown tool names, missing required fields.
- **Output-token cap per target.** `max_output_tokens` per target in `babelgate.yaml` clamps
  `max_tokens`, so Claude Code's large default no longer needs `CLAUDE_CODE_MAX_OUTPUT_TOKENS` set by hand.
- **Prompt caching mapped, not just ignored.** `cache_control` maps to each provider's own caching where
  one exists; prefixes are kept byte-stable so automatic prefix caches (OpenAI, DeepSeek, Ollama) hit.
- **Gemini CLI entry point.** Recipe (`GOOGLE_GEMINI_BASE_URL`) and a live gate where Gemini CLI
  completes the edit task on a non-Gemini model.
- **Privacy by default.** Prompt bodies are not stored unless `LOG_BODIES=true`; redaction hooks.

### v1.4 Codex on any model (L) · new entry point
- **OpenAI Responses API as a fifth adapter**, source and target. Codex CLI speaks only Responses since
  February 2026, so Chat-only backends (Ollama, vLLM, llama.cpp, Gemini, Anthropic) can't serve it
  without a translator. Streaming events, tools and the stateless request shape first; stored
  conversation state (`previous_response_id`) only if Codex needs it. Re-proves "a new provider costs one
  adapter file".
- **Structured output.** Responses `text.format` / Chat `response_format` JSON schema ↔ Gemini
  `responseSchema` ↔ Ollama `format`; tool-call emulation for Anthropic.
- **Codex recipe and live gate.** Codex completes the edit task through the proxy on a Chat-only backend.
- **Launch post** for the Codex entry point.

### v1.5 Correct everywhere (L)
- **Task 0, conductor efficiency (build process, first).** Judge script for the mechanical review rules,
  waits that cost no turns, a lean starting context, a fresh session per task and a conductor model per task
  (`docs/conductor/model-report-v1.5.md`). Target: ≥ 40% less Claude usage per task than v1.4.
- **Reasoning for every source.** Claude Code, Chat, Gemini and Ollama clients send and receive reasoning;
  foreign signatures travel in the `bg1.` envelope; `reasoning: false` keeps 1.4 behaviour per provider.
- **Media.** URL images, documents/PDFs, images in tool results; URLs fetched and inlined behind a private-network
  guard where the target needs bytes; unsupported targets refuse in the client's dialect.
- **Native-endpoint shim.** Same-format pass-through for Anthropic and Chat with provider presets (Ollama,
  LM Studio, DeepSeek, GLM, Kimi Anthropic endpoints) and declared gaps, each with one fix.
- **Proof.** Generated compatibility matrix (CI fails when stale); weekly replay of the latest Claude Code and
  Codex; npm provenance, signed images, SBOM.
- **Embeddings, minimal.** OpenAI-format inbound; OpenAI-compatible, Gemini and Ollama targets.
- **Gemini CLI frozen; Antigravity CLI spike** (one day, report only).

### v1.6 One command, free to start (M)
- **Distribution first.** Single binary (Node SEA or Bun compile) with `brew`/`winget`, or a tray app — chosen
  in the v1.6 spec.
- **Free and cheap provider presets.** Curated list (OpenRouter free models, NVIDIA NIM, Groq, DeepSeek) — cost
  is what drives attention in this market.
- **Presets and recipes.** Cursor, Continue, Aider, Open WebUI, LangChain, LlamaIndex, Vercel AI SDK, and
  Ollama-only apps on cloud models — each a tested recipe page.
- **Minimal health.** Provider health checks and a circuit breaker, kept small.
- **Response cache.** Exact-match, opt-in, small — for CI and test suites.
- **Moved to v2.0 unless users ask earlier:** key load balancing, rate limiting per client key.
- **Antigravity CLI adopted as an entry point** (v1.5 Task 14 spike, 2026-11-18; recipe, `thinkingBudget` fix and record script landed in PR #140; the terms question stays with the owner).

> **🟢 POWERHOUSE: after v1.6.** Any client in any of 5 formats reaches any of ~20 providers through
> one endpoint — Claude Code and Codex included — with streaming, tools, reasoning, media, structured output,
> embeddings, fallbacks, a cost dashboard and a translation inspector. It installs in one command; every pair is
> contract-tested and the results are published; each new Claude Code and Codex release is replayed; releases
> are signed. Targets: 2k GitHub
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
- **Wedge (2026-11-16):** governance for Claude Code alone is covered by Anthropic's own gateway, so the
  paid tier leads with what spans clients: per-session spend and loop caps and an audit trail with inspector
  replay across Claude Code, Codex and SDK traffic in one place.
- Virtual keys per person/project/app with model allow-lists and expiry; upstream keys never exposed.
- Budgets and quotas (daily/monthly, $ or tokens, per key/team/project/client); alert at 80%, stop at 100%.
- Coding-agent guardrails: per-session spend cap and a loop cap (stop an unattended agent after N
  turns without a user message).
- Admin UI: keys, teams, budgets, spend reports, CSV export.
- Audit log: who used which model, when, at what cost; optional body capture with retention policies.
- Postgres alongside SQLite for multi-instance deployments.
- Until the gate is met, the v2.0 hooks and a waitlist page are the team offer.

### v2.2 Enterprise access (M) · **[Team]**
- SSO (OIDC: Google, Okta, Entra) and roles (admin/member/viewer).
- Signed policy files: model allow-lists per group, data residency (EU-only providers), block
  training-enabled endpoints, and an **air-gapped mode** that refuses every non-local route, with audit
  evidence that no request left the network.
- Compliance pack: security questionnaire, DPA template, Helm chart and self-hosting guide.

### v2.3 Smart routing (M) · open + **[Team]**
- Open: cost- and latency-aware routing ("cheapest model meeting X"), A/B splits, shadow traffic.
- Open: routing on what the request contains — context size, thinking on, a client's background or
  small-model calls (claude-code-router has this for Claude Code alone; we do it for every client).
  Never on a guess of the next tool call, which is the model's output.
- [Team]: routing rules per team; evals comparing models on your own traffic before switching.

### v2.4 Prompt and agent operations (M) · **[Team]**
- Versioned prompt templates served by the proxy; replay recorded sessions against a new model;
  regression diffs.

**Pricing sketch** (confirmed in the v2.1 spec): Free — everything open, unlimited. Team — ~$20–30 per
active user per month, or ~$200/month flat per instance under 25 users. Enterprise — SSO, policy and
support, custom (~$10k+/year). Paid support contracts available from v1.6.

---

## Phase 4: Hosted control plane (v3.0) · ☁️ only if Phase 3 shows demand

### v3.0 Hosted control plane (L)
The proxy keeps running in the customer's infrastructure; a hosted dashboard receives metadata only
(usage, cost, keys, policies). Prompts never leave the customer, and we never resell tokens.

**Non-goal:** an OpenRouter-style token reseller. Billing for tokens, abuse handling and upstream
contracts are a full-time operations business, not a part-time one. The same goes for a hosted relay that
customer requests pass through.

**Considered and rejected (2026-11-04 review):** hosted relay tier, ARR-target planning, semantic caching
for agents, mocked tool results, prompt-cache "emulation" by hashing, in-place secret redaction for
coding agents. Reasons in the 2026-11-04 revision spec.

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
| Launch copy | Lead with cheap cloud models (OpenRouter, DeepSeek, Qwen, Gemini) before local CPU. Answer "how is this different from LiteLLM?" up front: any format in, every pair contract-tested, one command. Name the native Anthropic endpoints (Ollama, DeepSeek, GLM) and say what babelgate adds |
| v1.3 | Second Show HN with the translation inspector and the Gemini CLI entry point; a write-up of the canonical-format design |
| v1.4 | Codex entry-point launch: HN, r/OpenAI, Codex community docs |
| v1.6 | GitHub Sponsors; paid support contracts; team waitlist page |
| Monthly and before every version spec | Scripted competitor check (repo metadata, releases, changelog links) of LiteLLM, Bifrost, claude-code-router, OmniRoute, free-claude-code, agentgateway, Agent Router, Kong, Cloudflare and Vercel AI Gateway, OpenRouter, Anthropic's Claude Code gateway, Antigravity CLI, and the native Anthropic/Responses endpoints (Ollama, LM Studio, vLLM, DeepSeek, GLM, Kimi): copy what's table stakes, don't race on breadth, and move any pair a provider now serves natively from "bridge" to "shim" |
| Before v2.1 | **3 committed teams, or don't build the paid tier** |

Overall horizon (from 2026-10-26, revised 2026-11-04): v1.1 launch in roughly 2.5–3.5 months, v1.6
(powerhouse) in roughly 9–12.5 months — one M version later than v1.5 was, for the Codex entry point —
v2.1 no earlier than about 13 months and only behind its gate. **Re-plan after every
release:** real users' issues outrank this list.
