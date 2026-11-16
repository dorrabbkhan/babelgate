# babelgate market and competitor analysis (2026-11-16)

Method: GitHub API (stars, license, last push, latest release, issue searches) pulled on 2026-11-16; vendor docs and changelogs fetched directly where possible; news and aggregator claims are marked as such. Anything I could not confirm from a primary source is marked **unverified**. Star counts are a snapshot and several are suspiciously large for young repos (see OmniRoute, free-claude-code); treat them as attention signals, not quality signals.

---

## 0. Headline

1. The "translate Claude Code / Codex to any model" job is no longer a gap. It is served by at least five free, actively maintained projects with 10x to 1000x babelgate's attention (babelgate has 0 stars today), and by every large hosted gateway (Cloudflare, Vercel, OpenRouter, Kong) with a documented Claude Code and/or Codex recipe.
2. The independent commercial gateway market consolidated in 2026: Portkey bought by Palo Alto Networks (closed ~May 29), Helicone bought by Mintlify (Mar 3, maintenance mode), OpenRouter being bought by Stripe (announced Aug 19, reported $7B+), TensorZero repo archived (Jun 12), Langfuse bought by ClickHouse (Jan; observability). Envoy AI Gateway left CNCF/Envoy and became "Agent Router" under the Agentic AI Foundation (Sep 2026); agentgateway also went to AAIF.
3. Anthropic now ships its own self-hosted gateway inside the `claude` binary (SSO by IdP group, OTLP telemetry, model allow-lists) and states it does not support routing Claude Code to non-Claude models through any gateway. That is a strategic and (for team features) a direct threat; for the individual "any model" use case it is a support-posture risk, not a technical block.
4. Gemini CLI is being sunset for individual users (Antigravity CLI launched May 19, Gemini CLI stopped serving Google AI Pro/Ultra and free Code Assist individuals on Jun 18). It remains for enterprise licences and paid API keys. babelgate's Gemini CLI entry point is now a shrinking audience.
5. Native-format erosion is real and large: Ollama, LM Studio, vLLM, DeepSeek, GLM, Kimi, MiniMax, Qwen (Alibaba) all serve the Anthropic Messages API; Ollama, LM Studio, vLLM, OpenRouter, Vercel serve the Responses API. Only Chat-only or Gemini-only backends still need translation.

---

## 1. Competitor profiles

### 1.1 LiteLLM (BerriAI) - the incumbent
- What: Python SDK + proxy "AI gateway" to 100+ providers. Repo `BerriAI/litellm`: ~63.4k stars, license shown as NOASSERTION by GitHub (MIT core plus a `enterprise/` directory under a commercial licence; README links "LiteLLM Commercial License"), last push 2026-11-16, latest release v1.109.1 (2026-11-12); ~5.2k open issues/PRs.
- Formats accepted: `/chat/completions`, `/responses`, `/messages` (Anthropic), plus `/embeddings`, images, audio, batches, rerank, A2A (README). Gemini-format inbound for Gemini CLI is documented (`GOOGLE_GEMINI_BASE_URL`, needs `model_group_alias` to map a Gemini model name to another provider). **Ollama-format inbound (`/api/chat`): not found** (search found only the outbound `ollama_chat` provider).
- Agent CLIs: first-class. Docs and blog for Claude Code (cost cutting, "server-side auto mode through LiteLLM" Sep 21, SSO login for "Claude Code gateway" fixed Nov 12 in PR #51473), Codex (open PRs Nov 3 to serve "the requesting Codex release's own model catalog" and an e2e test matrix of Codex scenarios), Gemini CLI tutorial, plus "Lite-Harness SDK" (Jun 2) for Claude Code / Codex / Pi.
- Quality signals (negative): open issues such as #47531 "/v1/messages to a non-Anthropic model silently drops Claude Code's mid-conversation tool_addition blocks" (Oct 20), #46920 guardrails rewrite Anthropic `advisor` tool into empty custom tool (Oct 16), #50955 Claude Code discovery IDs rejected by JWT team auth (Nov 10). A Feb 16 incident report on invalid beta headers with Claude Code. So the translation path is actively maintained and also actively breaking on new Claude Code features.
- Observability / governance: spend tracking, budgets, virtual keys, teams, SSO, guardrails, Prometheus/OTel, Langfuse etc. Enterprise tier (SSO, audit) is commercial.
- Funding / business: open core + enterprise licence. Funding figures conflict across aggregators ($1.6M seed Aug 2026 per Preqin; $9M seed Nov 2023 per another; "$7M ARR" headline) - **unverified**.
- Security (important): LiteLLM published 2026 incidents: Mar 18 guardrail logging exposed secret headers; Mar 24 "suspected supply chain incident" (PyPI, litigation reported in Texas - secondary source, **unverified**); Apr 29 CVE-2026-42208; Jun 1 auth bypass via Host header; **Oct 21 "LiteLLM release v1.107.0 Compromised"**, post-mortem Oct 23, remediation Oct 30. This is the single biggest wedge against LiteLLM for security-conscious users.

### 1.2 Bifrost (Maxim AI)
- Go gateway, Apache-2.0. `maximhq/bifrost`: ~9.6k stars, pushed 2026-11-16, enterprise release `ent-v2.5.2-base` on 2026-11-15, ~1.6k open issues/PRs, very high commit cadence.
- Inbound formats (docs.getbifrost.ai integrations page): OpenAI (`/openai/v1/chat/completions`), Anthropic (`/anthropic/v1/messages`), Google GenAI (`/genai/v1beta/models/{model}:generateContent`), Bedrock, Cohere, LiteLLM, LangChain. Responses passthrough exists (issue #9140 "OpenAI Responses passthrough logs Codex requests..."; PR #9950 Codex WebSocket mode). **Ollama as an inbound format: not documented.**
- Agent CLIs: Claude Code, Codex, Gemini CLI all documented in Maxim blog posts; many fresh issues (#9633 `/v1/messages` 500 after Claude Code adds MCP tools, Nov 5; #8458 streaming `web_search_20250305` via OpenRouter breaks Claude Code, Oct 13; #9197 Bedrock invoke drops safeguard_results).
- Features: 23+ providers, failover, load balancing, semantic cache, MCP gateway (client + server), virtual keys with budgets (OSS per Maxim page), built-in web UI. Enterprise-only: adaptive load balancing, clustering, guardrails, SSO/RBAC, audit logs, vault, in-VPC (vendor pages; split between OSS/enterprise is inconsistent across sources). Enterprise price not public; 14-day trial.
- Claims "11 microseconds overhead at 5,000 RPS" - vendor marketing, unverified.

### 1.3 Portkey
- `Portkey-AI/gateway`: ~13.4k stars, MIT, **last commit 2026-05-25, last release v1.15.2 on 2026-01-12**. README says "Gateway 2.0 (pre-release): core enterprise gateway merging into open source". Series A $15M (Feb 2026, Elevation + Lightspeed); open-sourced production gateway Mar 24; **acquired by Palo Alto Networks (announced Apr 30, closed ~May 29 per multiple secondary sources)** to become the AI gateway for Prisma AIRS. OSS repo has been quiet since the deal; its future is uncommitted (secondary-source commentary).
- Pricing (aggregators, **verify on portkey.ai/pricing**): Developer free (10k logs), Production $49/mo, Enterprise custom.
- Formats/agents: OpenAI-compatible unified API, 1,600+ models; Claude Code/Codex support not established in my research (**unverified**). Strong on guardrails, MCP gateway, governance.
- Read: no longer an independent competitor for a part-time OSS project; becomes a security-vendor product. Opens a vacuum for "independent open gateway".

### 1.4 Helicone
- Acquired by Mintlify (post dated 2026-03-03); main platform in maintenance mode (security, new models, bug fixes; no roadmap). `Helicone/helicone` 6.3k stars, still pushed Nov 12; Rust `Helicone/ai-gateway` 646 stars, GPL-3.0, last push 2025-11-21 (effectively dormant). Not a competitor now. Langfuse (observability) was acquired by ClickHouse in January (secondary source).

### 1.5 OpenRouter
- Hosted token router, ~400+ models. Series B $113M (May 26, 2026, CapitalG-led per aggregators, **verify**), then **Stripe agreed to acquire it (Stripe newsroom dated Aug 19; price undisclosed by Stripe, reported $7B-$8B by Bloomberg/FT via press)**. Closing status inconsistent across sources.
- Endpoints: OpenAI Chat, **`/messages` (Anthropic Messages)**, **`/responses` (stateless; rejects `store:true` and `previous_response_id`)**; May 27 changelog added presets on the messages route. Claude Code works against the Messages route (third-party reference warns non-Anthropic-provider models "may misbehave"). Fee: 5.5% on credit purchases (aggregators; **verify**).
- Read: for anyone willing to pay a reseller, OpenRouter already is "Claude Code / Codex on any model" with zero install. Roadmap non-goal of a reseller is correct.

### 1.6 Cloudflare AI Gateway
- Hosted; core features free on all plans; logs limits depend on plan (100k free; 10M per gateway on Workers Paid per official limits page; new accounts from Sep 24 2026 move to Workers Logs pricing). 2026: unified billing (5% fee on credit purchases, provider price pass-through), dollar-based spend limits (Jun), single credit balance incl. Workers AI (Aug), one invoice line per model (Sep), Zero Data Retention routing, dynamic routing, `/ai/v1/chat/completions` and an Anthropic-SDK-compatible `/ai/v1/messages`.
- Documented coding-agent recipes: Claude Code, Claude Desktop, Copilot CLI, Codex, Pi, and a Gemini CLI integration page. Responses endpoint for Codex: not confirmed in my results (**unverified**).
- No self-hosting. Governance is Cloudflare Access-based.

### 1.7 Vercel AI Gateway
- Hosted. Anthropic Messages endpoint (`/v1/messages`) with a Claude Code guide (base URL change, model list in picker), OpenAI Chat and OpenAI Responses listed as separate API options; Codex doc is third-party (**unverified from Vercel's own docs**). Pricing: pass-through list price with credits; details not verified.

### 1.8 Kong AI Gateway
- `Kong/kong` 44.4k stars, Apache-2.0, 3.9.4 released Oct 12 (core); AI Gateway 3.13 (Dec 18 2025) added MCP ACLs, Claude Code support, guardrails; a "2.x Policies model" is replacing 3.x plugins (**unverified detail**). Kong's own doc: Claude Code can sit behind it over Anthropic/OpenAI/Azure/Gemini/Vertex/Bedrock/Alibaba; Codex is **OpenAI-only**; **streaming not supported for non-Claude models on Azure OpenAI, Gemini, Bedrock** (Kong docs). Enterprise API-management company; the buyer is a platform team, not an individual.

### 1.9 Envoy AI Gateway -> "Agent Router"
- Left CNCF/Envoy structure and joined the Agentic AI Foundation, renamed Agent Router (AAIF post Sep 9; effective ~Sep 10). 1.0 on Jun 23, v1.2.1 on Nov 6. Repo `theagentrouter/agent-router` ~2.4k stars, Apache-2.0, pushed 2026-11-16. Kubernetes-native (Envoy Gateway CRDs, Helm); not a desktop/dev-laptop competitor. Per one source, Claude Code/Codex recipes exist (**unverified**).
- agentgateway (Solo.io -> AAIF in June): `agentgateway/agentgateway` 6.2k stars, Apache-2.0, v1.7.0 on Oct 27. Rust; docs include a Claude Code integration and Anthropic Messages handling (passes through when provider speaks Messages, converts to Responses/Completions otherwise).

### 1.10 TensorZero
- Apache-2.0, 11.7k stars, **repo archived by owner 2026-06-12**; CEO announced wind-down after a $7.3M seed (Aug 2025). Code remains public but unmaintained. Evidence that VC-backed open-source gateways can vanish; a lesson for babelgate's "paid tier after 3 teams commit" stance (cautious is right).

### 1.11 claude-code-router (musistudio) - the closest direct rival
- 38.2k stars, MIT, v3.1.5 released 2026-11-16, pushed same day (started Feb 2025). It is no longer "just Claude Code": README now says "one local control plane for every AI agent". Agents: Claude Code (CLI and app), Claude Design, Codex (CLI and app), Grok CLI, Kimi CLI, Kilo Code, OpenCode, Pi, ZCode, WorkBuddy. **Gemini CLI is not listed.** Protocols: OpenAI Chat / Responses, Anthropic Messages, Gemini Generate Content / Interactions (direction ambiguous in README). Features: header/body conditional routing, retries, ordered fallbacks, credential pools, key rotation, per-key limits and expiry, request log with cost estimates, Electron desktop app + browser UI, MCP/ToolHub, web search and vision "fusion", messaging relay.
- Quality signals: 66 open issues matching tool/streaming/thinking, e.g. #1725 "OpenAI Responses streaming misroutes reasoning deltas after tool_use/text" (Aug 26), #1378 DeepSeek V4 Pro thinking + tool calls 400, #1397 streaming transformer corrupts tool-call argument deltas for reasoning models, #1629 thinking blocks lost after first turn (model-name mismatch). These are precisely the multi-turn reasoning/tool problems babelgate says it solves by contract tests.
- Gaps vs babelgate: no per-pair contract-test claim, no translation inspector (it has logs), no Gemini CLI, no Ollama-format inbound (unverified).

### 1.12 Other "agent on any model" tools (the long tail is now enormous)
| Project | Stars | License | Last push | Note |
|---|---|---|---|---|
| OmniRoute (`cheaper-inference/OmniRoute`, formerly diegosouzapw) | 88.0k | MIT | 2026-11-16 | created Feb 2026; "394 providers, 150+ free tiers", Claude Code/Codex/Cursor/Cline/Copilot; format translation OpenAI/Claude/Gemini/Responses (README via third-party mirror); latest v3.8.53 Nov 6. Star count unusually high; **treat as marketing-driven**, quality unverified |
| free-claude-code (`Alishahryar1`) | 70.8k | AGPL-3.0 (README badge; GitHub says NOASSERTION) | 2026-11-16 | 12 harnesses (Claude Code, Codex, Pi, OpenCode, Cline...), 61 providers, four APIs inbound incl. Anthropic Messages, Chat, Responses; free-token angle, phone/Discord/Telegram; RTK/Headroom compression |
| cc-switch (`farion1231`) | 154.9k | MIT | 2026-11-16 | desktop all-in-one config switcher for Claude Code / Codex / OpenCode etc.; a config manager more than a translator |
| claudish (MadAppGang) | 1.0k | n/a | 2026-11-16 | Claude Code with any model |
| 1rgs/claude-code-proxy, fuergaosi233/claude-code-proxy | 3.8k, 2.8k | n/a, MIT | Jun / Mar 2026 | classic Anthropic-to-OpenAI proxies, stagnating |
| y-router | 0.4k | MIT | archived | archived Jan 2026 |
| codex-relay (MetaFARS) | 0.2k | MIT | 2026-11-10 | Rust Responses-to-Chat bridge for Codex |
| rosetta-llm (Lokesh-Chimakurthi) | 13 | n/a | 2026-11-16 | "Multi-format LLM proxy: OpenAI Chat, Responses, Anthropic" - same idea, tiny |
| headroom (headroomlabs-ai) | 79.8k | n/a | 2026-11-16 | context compression adjacent to gateways; LiteLLM integrates it |

Takeaway: demand for "Claude Code / Codex on any model" is very large (hundreds of thousands of stars across the category) and driven by free/cheap tokens and cost reduction, not by enterprise governance. Those projects are mostly one-person efforts with a thin quality story (issue backlogs show the same thinking/tool/streaming bugs).

### 1.13 Native-API providers (see section 3)
Ollama (187k stars, v0.40.16 Nov 9), LM Studio, vLLM, DeepSeek, Moonshot, Zhipu/Z.ai, MiniMax, Alibaba: serve Anthropic Messages natively.

---

## 2. Market answers

**Size and trend.** Estimates are poor and conflict by ~3x: The Business Research Company puts the "LLM gateway platform" market at $3.34B (2025) to $4.23B (2026); a separate report from the same publisher says $2.18B to $2.76B; SNS Insider says $1.33B (2026) rising to $11.32B (2035); an IT Brief article attributes to Gartner AI-gateway spending of ~$251M (2026) to ~$429M (2027) and Gartner is cited (secondhand, **unverified**) saying 70% of orgs building multi-LLM apps will use gateway capabilities by 2028. The real signals are deal flow, not TAM: Stripe/OpenRouter ($7B+ reported), Palo Alto/Portkey, Mintlify/Helicone, ClickHouse/Langfuse, F5/CalypsoAI, TrueFoundry/Seldon. Analysts frame the "agent gateway" or "agent control plane" as the growth segment.

**"Coding agent on any model" trend.** Strong and cost-driven: the biggest repos by stars are free-token routers and config switchers. LiteLLM publishes a stream of Claude Code cost posts (Jun 30, Jul 4, Jul 27). At the same time, vendor positions are hardening: Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" (code.claude.com docs) and ships its own gateway; Google is retiring Gemini CLI for individuals; Codex dropped Chat Completions in Feb 2026 (secondary sources; no OpenAI primary found).

**Who is consolidating.** Security vendors buy gateways (Palo Alto, F5), payments buys routers (Stripe, after Metronome in Jan), docs/dev-tools buy observability (Mintlify, ClickHouse), foundations absorb infra gateways (AAIF: Agent Router, agentgateway). Independent venture-backed OSS gateways have a poor survival record this year (TensorZero archived, Helicone in maintenance, Portkey OSS stalled, LiteLLM hit by compromised releases).

**Table stakes in 2026 (do not market these as differentiators):**
- Multi-provider routing, fallbacks/retries, per-key budgets and virtual keys.
- OpenAI Chat + Anthropic Messages + Responses inbound; Claude Code and Codex recipes (everyone has them).
- Usage and cost dashboard, Prometheus/OTel export.
- MCP gateway features (Bifrost, Portkey, Kong, LiteLLM all ship it).
- Semantic or response caching, guardrails hooks.
- A web UI. (Bifrost, CCR, LiteLLM, OmniRoute all have one.)

---

## 3. Native-format erosion (specific, dated)

| Provider/runtime | Anthropic Messages | OpenAI Responses | Evidence |
|---|---|---|---|
| Ollama | Yes, since v0.14.0 (Jan 2026); streaming, tools, base64 vision, thinking (budget not enforced). Not: `tool_choice`, `count_tokens`, prompt caching, URL images, PDF documents, stream `error` events | Yes, since v0.13.3 (Dec 2025), stateless only (no `previous_response_id`); cloud lacks custom-tool replay | docs.ollama.com anthropic-compatibility; Ollama issue #13595; Agno docs |
| LM Studio | Yes, since 0.4.1 (Jan 30 2026), `/v1/messages`, official Claude Code guide | Yes, since 0.3.29 (Oct 2025); joined "Open Responses" spec effort with OpenAI (Jan 15 2026) | LM Studio changelog/blog; open bug about Qwen thinking templates after 0.4.19 |
| vLLM | Yes, `/v1/messages` PR #22627 merged 2025-10-22 | Yes (`/v1/responses`, gpt-oss with Harmony, built-in tools via flags) | vLLM PR; vLLM Responses blog (via mirror) |
| DeepSeek | Yes (`api.deepseek.com/anthropic`) | not checked | third-party guides (URLs vary - **verify per provider docs**) |
| Z.ai / GLM | Yes (`api.z.ai/api/anthropic`) | not checked | same |
| Moonshot / Kimi | Yes (`api.moonshot.ai/anthropic`; `.cn` variant differs) | not checked | same |
| MiniMax | Yes (`api.minimax.io/anthropic`) | not checked | same |
| Alibaba Qwen (DashScope) | Yes (`.../apps/anthropic`) | not checked | same |
| OpenRouter | Yes (`/messages`) | Yes, stateless | OpenRouter docs and changelog May 27 |
| Vercel AI Gateway | Yes (`/v1/messages`) | Yes (listed) | Vercel docs |
| Cloudflare | Yes (`/ai/v1/messages`) | unconfirmed | Cloudflare changelog |
| Gemini API | No Anthropic or Responses endpoint found; OpenAI-compatible endpoint exists (`/v1beta/openai/`, beta) | No | developersdigest comparison (secondary) - **verify against Google docs** |
| Anthropic API | native; OpenAI-compat layer exists for testing | no | secondary sources |

A twelve-of-twenty finding from one reference says 12 of 20 surveyed providers document an Anthropic-compatible endpoint. Implication: the pairs "Claude Code to Ollama/DeepSeek/GLM/Kimi/Qwen/MiniMax/LM Studio/vLLM" and "Codex to Ollama/LM Studio/vLLM/OpenRouter" need no translation. What remains translation-only: Claude Code or Codex to **Gemini**, to **OpenAI Chat-only hosts** (Groq, Together, Fireworks, Mistral, Cerebras, many others), and to **Anthropic** for Codex; Gemini CLI to anything non-Gemini; Ollama-native clients to anything. Native endpoints are also imperfect (Ollama lacks `tool_choice`, `count_tokens`, caching, error events; LM Studio template bugs), which is where a gateway still adds value as a *shim*, but that is a weaker pitch than "translator".

---

## 4. Feature matrix

Legend: Y = yes/documented, P = partial or caveated, N = no / not found, ? = unverified. "CLI" = explicit documented support for Claude Code (CC), Codex (CX), Gemini CLI (GC).

| | babelgate (v1.4) | LiteLLM | Bifrost | claude-code-router | OmniRoute | OpenRouter | Cloudflare AI GW | Vercel AI GW | Kong AI GW |
|---|---|---|---|---|---|---|---|---|---|
| Model | OSS Apache-2.0, self-host, solo dev | OSS MIT core + commercial ent., self-host (+ cloud) | OSS Apache-2.0 + enterprise, self-host | OSS MIT, local/desktop | OSS MIT, local/self-host | Hosted reseller, 5.5% fee, Stripe-bound | Hosted, free core, 5% on credits | Hosted, credits | OSS core + commercial platform |
| GitHub stars / last release | 0 / v1.4.0 | 63.4k / v1.109.1 (Nov 12) | 9.6k / ent v2.5.2 (Nov 15) | 38.2k / v3.1.5 (Nov 16) | 88.0k / v3.8.53 (Nov 6) | n/a | n/a | n/a | 44.4k (Kong) / 3.9.4 (Oct 12) |
| Inbound OpenAI Chat | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Inbound Anthropic Messages | Y | Y | Y | Y | Y | Y | Y | Y | P (Claude Code via ai-proxy) |
| Inbound OpenAI Responses | Y | Y | Y (passthrough, Codex WS) | Y | Y? | Y (stateless) | ? | Y | Y (Codex route, OpenAI-only) |
| Inbound Gemini | Y | Y (Gemini CLI doc) | Y (`/genai`) | P? (Gemini protocols listed) | Y? | N | ? | ? | ? |
| Inbound Ollama `/api/*` | **Y** | N (not found) | N (not documented) | ? | ? | N | N | N | N |
| Claude Code documented | Y | Y (deep) | Y | Y | Y | P | Y | Y | Y |
| Codex documented | Y | Y (deep) | Y | Y | Y | ? | Y | ? (third-party) | P (OpenAI only) |
| Gemini CLI documented | Y | Y (tutorial) | Y | N | ? | ? | Y | ? | ? |
| Codex/CC to non-native models, streaming + tools | Y (contract-tested every pair) | Y (open bugs) | Y (open bugs) | Y (open bugs) | Y? | Y but "may misbehave" | P | P | P (no streaming for several non-Claude providers) |
| Reasoning carried between turns | Y (Responses/Anthropic ~v1.4; non-Responses sources in v1.5) | P | ? | P (known bugs) | ? | P | ? | ? | ? |
| Routing, aliases, fallbacks | Y | Y | Y | Y | Y | Y | Y (dynamic routing) | Y | Y |
| Load balancing / health / circuit breaker | planned v1.6 | Y | Y (adaptive = enterprise) | P (key rotation) | Y | n/a | Y | Y | Y |
| Cache | planned v1.6 | Y | Y (semantic) | N | ? | prompt cache passthrough | Y | ? | Y |
| Cost dashboard / usage store | Y (SQLite, /ui) | Y | Y | Y (logs + est. cost) | Y | Y (hosted) | Y | Y | Y (enterprise) |
| Translation inspector (src/canonical/target view) | **Y** | N | N | N (request logs) | N? | N | N | N | N |
| Prometheus / OTel | Y | Y | Y | N? | ? | n/a | Y/Logpush | Y | Y |
| Virtual keys, budgets, SSO, audit | planned v2.x paid | Y (SSO/audit commercial) | Y keys+budgets OSS; SSO/RBAC/audit enterprise | P (client keys, limits) | ? | Y | Y (Access) | Y | Y (enterprise) |
| MCP gateway | N | Y | Y | Y (ToolHub) | ? | ? | ? | ? | Y |
| Single-binary / desktop app | planned v1.6 | N (Python/Docker) | Y (Go binary, npx) | Y (Electron) | Y | n/a | n/a | n/a | N |
| Security record 2026 | clean (no public users) | **two compromised releases/incidents (Mar 24, Oct 21)** | no major found | n/f | n/f | n/a | n/a | n/a | n/a |

Headline: babelgate is feature-complete on the *format* axis (five inbound formats, three CLIs, every-pair contract tests, inspector) and trails every competitor on *distribution* (stars, community, desktop app, free-tier lists), *breadth* (providers, MCP, semantic cache, guardrails) and *governance* (not yet shipped). The only cells where babelgate is alone, to the limit of what I could verify: **Ollama as an inbound client format**, **the translation inspector**, and **"contract-tested every source x target pair" as a published claim**.

---

## 5. Candidate USPs: real vs commoditized

### Commoditized (do not lead with these)
- "Claude Code / Codex on any model": CCR (38k), OmniRoute (88k), free-claude-code (71k), LiteLLM, Bifrost, Kong, Cloudflare, Vercel, OpenRouter all do it.
- "Any client format to any provider": LiteLLM, Bifrost, CCR, OmniRoute, agentgateway cover Chat, Anthropic, Responses and often Gemini.
- Routing, fallbacks, aliases, cost dashboard, Prometheus/OTel, a web UI.
- "Open core with team governance later": Bifrost, LiteLLM, Portkey, Kong already sell exactly this with years of head start. Virtual keys and budgets are already in Bifrost OSS.
- Gemini CLI as an entry point: audience shrinking; Gemini CLI still works only with API keys and enterprise licences, and Antigravity CLI is multi-model natively (single secondary source, unverified).
- Governance for Claude Code specifically: Anthropic's Claude apps gateway (SSO by IdP group, model allow-lists, OTLP) is built into the binary.

### Plausibly real (nobody well funded owns these)
1. **Verifiable translation correctness**: every-pair contract tests + fixtures recorded from real SDKs, published as a compatibility matrix with CI badges and a public conformance report. Competitors' issue trackers show exactly the failing areas (reasoning/thinking round-trips, tool-argument deltas, interleaved blocks, new Claude Code beta features dropped: LiteLLM #47531, CCR #1725/#1397/#1629, Bifrost #9633/#8458). No competitor publishes pair-level conformance. Strongest USP if it is *visible* and *kept ahead of new client releases*.
2. **Translation inspector** (source / canonical / target side by side, with tool-call failure diagnostics). Nobody has it (logs only). Developer-debugging value is real; it also doubles as the proof for USP 1. Medium defensibility; easy to copy but nobody is.
3. **Supply-chain-trustworthy gateway**: a small, typed TypeScript codebase, pinned/reproducible releases, provenance (npm provenance, SLSA, signed images, SBOM), minimal dependency count - positioned against LiteLLM's two compromised releases (Mar 24, Oct 21) and Portkey/Helicone/TensorZero's ownership upheavals. Credible and time-sensitive; costs little. Not claimed by anyone.
4. **Ollama-format inbound + local-first**: Ollama-native apps (editors' "Ollama" option, Open WebUI Ollama mode) using cloud models. Niche but unserved by LiteLLM/Bifrost (not found); LM Studio/Ollama users are numerous. Small TAM; low competitive risk.
5. **Independent, neutral, non-acquirable-by-a-vendor** gateway for the dev laptop and small team, with an Apache core and a plugin API (v2.0) - the vacuum left by Portkey OSS going dormant. This is a positioning, not a feature; only credible if maintenance cadence stays visibly high.
6. **Client-side compatibility shim for imperfect native endpoints**: reasoning/tool-choice/`count_tokens`/caching/error-event gaps in Ollama's Anthropic endpoint (and LM Studio template bugs). Practical pitch: "your provider speaks Anthropic; babelgate makes Claude Code actually work on it". Nobody markets this.

### Not real (be blunt)
- Raw performance: Bifrost claims 11 microsecond overhead in Go; a Node proxy cannot win that, and nobody picks a gateway on it for dev-laptop use.
- Number of providers: OmniRoute claims 394, free-claude-code 61, Bifrost 23+, LiteLLM 100+. v1.6's "~20 providers" will look small; it is only fine because OpenAI-compatible is config.
- A paid governance tier as a *differentiator*. It is a *requirement* for revenue, and Anthropic, LiteLLM, Bifrost, Kong, Cloudflare already supply it. The three-LOI gate is right.
- A hosted tier / reseller (OpenRouter/Stripe). Roadmap already rejects this; keep.

---

## 6. Gaps and threats

1. **Distribution gap**: 0 stars vs tens of thousands. Even a perfect product is unseen. The launch plan (HN, r/LocalLLaMA, r/ClaudeAI) is necessary but the category's attention is on "free tokens" and one-click desktop apps. No marketing hook for either.
2. **Anthropic's posture**: Claude apps gateway built into the CLI; "does not support routing Claude Code to non-Claude models". A future Claude Code release that enforces `allowedProviders`, pins models or restricts third-party endpoints would hurt. Today's `allowedProviders` is admin-opt-in, not a block (Claude Code v2.1.285+). Track Claude Code changelog on every release.
3. **Native Anthropic endpoints** shrink the Claude Code headline for local/Chinese providers (section 3). The unique translation territory is Gemini, Chat-only hosts, and Codex-on-Anthropic.
4. **Gemini CLI deprecation** reduces the value of a roadmap item (v1.3) already shipped; sunk but make sure no more investment.
5. **Moving-target maintenance**: LiteLLM, Bifrost and CCR each have 10+ open issues from the last six weeks about new Claude Code or Codex behaviours (tool_addition blocks, advisor tool, MCP tool addition, Codex model catalog, Codex WebSocket mode, image generation, web search). A solo part-time agent-driven dev must keep pace with Claude Code and Codex releases; this is the core operating risk for the "correctness" USP.
6. **Governance market is crowded and closing**: Anthropic (SSO, OTLP), LiteLLM, Bifrost, Kong, Cloudflare, Portkey+Palo Alto. A late, small paid tier needs a sharper wedge than "keys and budgets".
7. **Security expectations are rising** (LiteLLM incidents): any outside contributor path, CLA bot, dependency hygiene and release signing will be scrutinised.
8. **Consolidators with distribution**: Stripe/OpenRouter will bundle billing; Cloudflare gives 5% unified billing; both lower the price of "just pay a hosted router".

---

## 7. Recommendations (roadmap)

1. **Make correctness the public headline and publish the evidence.** Add a public "compatibility matrix" page and CI badge (source x target x streaming/tools/reasoning) generated from the contract suite; add a recurring "new client release" job that replays latest Claude Code / Codex captures against the proxy. Evidence: competitor issue lists (LiteLLM #47531, #46920; CCR #1725, #1397, #1629; Bifrost #9633, #8458). Reorder: do this *before* embeddings/media in v1.5.
2. **Re-scope v1.5: reasoning mapping first; shrink embeddings/media.** Reasoning carry-over across non-Responses sources is the exact bug class competitors have open (CCR #1629 "thinking blocks lost", DeepSeek thinking + tool call 400s, Ollama's `budget_tokens` not enforced). Embeddings are plain commodity (LiteLLM, Bifrost, everyone) - keep minimal or defer; media (image URL inlining, PDF) matters mainly because Ollama's Anthropic endpoint rejects URL images and PDF document blocks.
3. **Add a "native-endpoint shim" mode and say it in the headline.** When the target already speaks the client's format (Ollama/LM Studio/vLLM/DeepSeek/GLM/Kimi/Qwen/MiniMax Anthropic endpoints), run byte-preserving pass-through plus fixes for known gaps: `count_tokens` estimate, `tool_choice` emulation, `cache_control` handling, stream `error` events, base64 inlining of URL images, `max_tokens` clamps. Evidence: Ollama's docs list these as unsupported; LM Studio bug on Qwen templates; section 3. This directly converts native-format erosion into a feature. (Responses pass-through already exists for v1.4.)
4. **Lead launch copy with supply-chain trust and the inspector, not "any model".** Ship npm provenance, signed container images and SBOM, a dependency-count badge, pinned release policy; write the "what we did after the LiteLLM compromises" comparison without naming-and-shaming. Evidence: LiteLLM Mar 24 and Oct 21 incidents; Portkey/Helicone/TensorZero upheaval. Cost: small (days). Also make the inspector shareable (export a redacted trace as a bug-report bundle), turning it into the standard way to file "my tool call broke" reports across clients.
5. **Drop or freeze Gemini CLI as a first-class entry point; keep Gemini as provider and inbound format.** Gemini CLI individuals lost service Jun 18; Antigravity CLI is the successor and its endpoint/base-URL story is undocumented in the sources I could verify. Action: do not add live-gate effort; investigate Antigravity CLI's configuration once (a 1-day spike), then decide. Keep `/v1beta` Gemini inbound because Gemini SDK/apps still use it and Bifrost/LiteLLM offer it.
6. **Re-sequence v1.6: ship the single binary / one-click install before health/balancing/response cache.** CCR (Electron app) and OmniRoute/free-claude-code (one-liner installers, phone access, free-tier lists) win on install friction; LiteLLM and Bifrost already have health/balancing/caching. Keep health/circuit breaker minimal, make "response cache" opt-in and tiny (CI use case). Add a **curated free/cheap-provider preset list** (OpenRouter free models, NVIDIA NIM, Groq, DeepSeek) because cost-saving is the observable demand driver in star counts.
7. **Don't build team governance on a plugin API alone; prep a differentiated wedge before v2.1 and keep the 3-LOI gate.** Anthropic's gateway already covers SSO + OTLP for Claude Code; Bifrost OSS has virtual keys and budgets; Cloudflare has dollar spend limits. The wedge that is still open: *cross-client* policy (the same budget/loop cap across Claude Code, Codex, SDKs), *loop caps and per-session spend caps* for unattended agents, and *evidence/audit with inspector replay*. Validate with design partners, with LiteLLM and Bifrost enterprise users who are unhappy with the security incidents/complexity. Evidence: LiteLLM issues show governance and Claude Code interplay is fragile (JWT team auth vs Claude Code picker IDs #50955, #51008).
8. **Join the standards where they exist.** Track "Open Responses" (openresponses.org, announced with OpenAI/LM Studio, Jan 2026) and AAIF projects (Agent Router, agentgateway). If babelgate's canonical format maps cleanly onto Open Responses, say so, and consider contributing conformance fixtures upstream. This builds credibility cheaply and reduces the "yet another format" objection. Evidence: LM Studio/OpenAI Open Responses post; AAIF consolidation (Sep 2026).

Also: raise the pre-version competitor check from "30 minutes" to a scripted monthly job (GitHub API: stars/last release/issue counts for ~12 repos), because the landscape moved materially in each of the last 8 months.

---

## 8. Open questions and unverified items
- OpenRouter: whether the Stripe deal has closed; terms; $113M Series B figure; 5.5% fee (aggregators only).
- Portkey: exact close date (May 29 vs "early June"), OSS future, Claude Code/Codex support.
- LiteLLM: funding, ARR, litigation claim; exact scope of v1.107.0 compromise (read titles only, not post bodies).
- OmniRoute/free-claude-code star counts and real quality; inbound-format claims for OmniRoute come from a third-party mirror.
- Cloudflare Responses endpoint for Codex; Vercel Codex doc; Kong 2.x policy line; Envoy/Agent Router Claude Code/Codex recipes.
- Codex's removal of Chat Completions (Feb 2026): secondary sources only; no OpenAI primary found.
- Whether CCR's Gemini protocols are inbound or provider-side.
- Gemini API lacks Anthropic/Responses endpoints: from a secondary comparison; confirm with Google docs.
- Antigravity CLI custom-endpoint support.
- Provider Anthropic-compat URLs for DeepSeek/Kimi/GLM/MiniMax/Qwen: third-party lists; confirm in each provider's own docs.
- Market-size numbers (TBRC, SNS, Gartner via secondhand).

---

## Sources (accessed 2026-11-16 unless noted)

GitHub API (repo metadata, releases, issue searches), pulled 2026-11-16:
- https://github.com/BerriAI/litellm (and issues #47531, #46920, #50955, #51008, #51473, #49946)
- https://github.com/maximhq/bifrost (issues #9633, #8458, #9197, #9140, #9950)
- https://github.com/Portkey-AI/gateway
- https://github.com/musistudio/claude-code-router (README; issues #1725, #1397, #1378, #1629)
- https://github.com/tensorzero/tensorzero (archived 2026-06-12)
- https://github.com/theagentrouter/agent-router (formerly envoyproxy/ai-gateway)
- https://github.com/agentgateway/agentgateway
- https://github.com/Kong/kong
- https://github.com/Helicone/helicone and https://github.com/Helicone/ai-gateway
- https://github.com/ollama/ollama
- https://github.com/cheaper-inference/OmniRoute
- https://github.com/Alishahryar1/free-claude-code
- https://github.com/farion1231/cc-switch
- https://github.com/MetaFARS/codex-relay, https://github.com/MadAppGang/claudish, https://github.com/Lokesh-Chimakurthi/rosetta-llm
- https://github.com/google-gemini/gemini-cli, https://github.com/openai/codex

Primary vendor documents:
- LiteLLM blog archive (incident titles and dates): https://docs.litellm.ai/blog/archive
- LiteLLM release notes: https://docs.litellm.ai/release_notes/ (v1.109.0 dated Nov 11, v1.108.0 Nov 4)
- LiteLLM Gemini CLI tutorial: https://docs.litellm.ai/docs/tutorials/litellm_gemini_cli
- Claude Code gateways: https://code.claude.com/docs/en/gateways.md , https://code.claude.com/docs/en/llm-gateway
- Ollama Anthropic compatibility: https://docs.ollama.com/api/anthropic-compatibility
- LM Studio Anthropic compat: https://lmstudio.ai/docs/developer/anthropic-compat ; Open Responses post (2026-01-15): https://lmstudio.ai/blog/openresponses
- Bifrost integrations: https://docs.getbifrost.ai/integrations/what-is-an-integration
- Vercel AI Gateway Anthropic compat: https://vercel.com/docs/ai-gateway/anthropic-compat ; Claude Code: https://vercel.com/docs/ai-gateway/coding-agents/claude-code
- Cloudflare changelog 2026-08-07 / 2026-09-01 and pricing: https://developers.cloudflare.com/changelog/post/2026-09-01-billing-and-model-names/ , https://developers.cloudflare.com/ai-gateway/reference/pricing , https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/
- OpenRouter changelog (2026-05-27) and messages API docs: https://openrouter.ai/docs/changelog/2026/5/27
- Kong AI CLIs and Codex pages: https://developer.konghq.com/ai-gateway/ai-clis/ , https://developer.konghq.com/how-to/use-codex-with-ai-gateway/
- Stripe newsroom (2026-08-19): https://stripe.com/en-us/newsroom/news/stripe-agrees-to-acquire-openrouter
- Helicone joins Mintlify (2026-03-03): https://helicone.ai/blog/joining-mintlify , https://www.mintlify.com/blog/mintlify-acquires-helicone
- Google Developers Blog, Gemini CLI to Antigravity CLI (2026-05-19): https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- AAIF: Agent Router joins AAIF (2026-09-09): https://aaif.io/blog/agent-router-joins-aaif
- vLLM `/v1/messages` PR (merged 2025-10-22): https://github.com/vllm-project/vllm/pull/22627
- agentgateway Messages docs: https://agentgateway.dev/docs/standalone/main/documentation/llm/api-types/messages/

Secondary / aggregator / news (lower confidence):
- Portkey acquisition and Series A: https://doolpa.com/news/palo-alto-acquires-portkey-prisma-airs-april-30-2026 , https://tetrate.io/learn/ai/portkey-palo-alto-acquisition , https://hyperframeresearch.com/2026/06/02/palo-alto-networks-portkey-buy-exposes-real-world-ai-gateway-friction/
- Portkey pricing: https://pricingsaas.com/companies/portkey
- OpenRouter Series B and deal coverage: https://braindetox.kr/en/posts/openrouter_series_b_multi_model_routing_2026.html , https://app.dealroom.co/news/note/stripe-agrees-to-acquire-openrouter , https://www.forrester.com/blogs/stripe-is-acquiring-openrouter-to-control-the-ai-consumption-layer/
- OpenRouter fee: https://dupple.com/learn/openrouter-pricing
- TensorZero wind-down: https://the-context.pages.dev/en/news/2026-06-14-tensorzero-archived/ , https://byteiota.com/tensorzero-shuts-down-what-oss-llmops-cant-survive/
- Consolidation overview: https://tooldirectory.ai/blog/bought-or-buried-2026-ai-consolidation , https://www.forbes.com/sites/janakirammsv/2026/07/05/agent-gateways-are-becoming-the-control-plane-for-enterprise-ai/
- Market size: https://www.marketresearch.com/Business-Research-Company-v4006/Large-Language-Model-Gateways-Global-44388774 , https://www.snsinsider.com/reports/enterprise-ai-gateway-market-10657 , https://itbrief.co.uk/story/gartner-sees-securing-ai-market-hit-usd-4-8bn-in-2027
- Codex Chat-wire removal and routers: https://dev.to/creeta/codex-cli-dropped-chat-wire-opencodex-picks-up-the-routing-2emb , https://opper.ai/blog/codex-router
- Claude Code any-model landscape: https://opper.ai/blog/claude-code-router , https://futureagi.com/blog/best-ai-gateways-claude-code-any-llm-provider-2026/
- Provider Anthropic-compatible endpoints (URLs): https://app.stationx.net/articles/claude-code-other-models , https://www.developersdigest.tech/reference/api-compatibility
- Gemini CLI sunset coverage: https://www.theregister.com/ai-ml/2026/05/20/bye-bye-gemini-cli-google-nudges-devs-toward-antigravity/5243605 , https://fossforce.com/2026/05/gemini-clis-short-life-and-googles-antigravity-bait-and-switch/
- Bifrost pricing/feature split: https://www.getmaxim.ai/bifrost/pricing.md , https://www.truefoundry.com/blog/bifrost-enterprise
- Cloudflare fee summary: https://www.truefoundry.com/blog/cloudflare-ai-gateway-pricing-a-complete-breakdown
