# babelgate roadmap revision — 2026-11-16

**Status:** approved by the owner in conversation, 2026-11-16 ("lgtm, let's do all this"); this written
spec awaits owner review. Amends the 2026-10-26 roadmap design spec and the 2026-11-04 revision;
everything not changed here still stands (open core, the 3-team gate, no token reselling, validation
discipline). Input: the competitor and market analysis of 2026-11-16
(`docs/research/2026-11-16-market-analysis.md`, sources and "unverified" marks inside), done before the
v1.5 spec as the roadmap's "before every version spec" check requires.

## 1. Why revise

1. **"Claude Code / Codex on any model" is no longer a gap.** claude-code-router (38k stars, now Codex,
   Kimi CLI, OpenCode and others too), LiteLLM, Bifrost, Kong, Cloudflare, Vercel and OpenRouter all
   document Claude Code and/or Codex setups; two 2026 projects (OmniRoute, free-claude-code) show
   70k–88k stars (attention signals; quality unverified). babelgate's current headline is shared by all of
   them.
2. **Native formats keep spreading.** The Anthropic Messages API is served natively by Ollama (≥ 0.14),
   LM Studio, vLLM, DeepSeek, GLM, Kimi, MiniMax, Qwen, OpenRouter, Vercel and Cloudflare; Responses by
   Ollama (stateless), LM Studio, vLLM, OpenRouter and Vercel. Real translation is still needed for
   **Gemini**, **Chat-only hosts** (Groq, Together, Fireworks, Mistral, Cerebras…) and **Codex on Claude**.
   The native endpoints are incomplete: Ollama's Anthropic endpoint has no `tool_choice`, `count_tokens`,
   prompt caching, URL images or PDFs.
3. **Competitors break on exactly what we test.** Open issues on LiteLLM, Bifrost and claude-code-router
   report lost thinking blocks, corrupted streamed tool arguments and dropped Claude Code features. No
   competitor publishes pair-level correctness evidence.
4. **The market consolidated.** Portkey → Palo Alto Networks, Helicone → Mintlify (maintenance mode),
   OpenRouter → Stripe (announced), TensorZero archived, Envoy AI Gateway → Agentic AI Foundation.
   LiteLLM shipped two compromised or incident releases in 2026 (titles read, post-mortems not).
   Independent, small, auditable and neutral is now a property worth stating.
5. **Vendors are closing ranks.** Anthropic ships its own gateway inside Claude Code (SSO by IdP group,
   OTLP, model allow-lists) and its docs say routing Claude Code to non-Claude models is not supported.
   Google retired Gemini CLI for individual users in favour of Antigravity CLI (2026-05-19; service ended
   for individuals 2026-06-18; enterprise licences and paid API keys keep working).

## 2. Decisions

### 2.1 Positioning: provably correct, and shows you why
**Headline: "The translator you can check."** babelgate is the gateway whose every format pair is
contract-tested and published, that replays each new Claude Code and Codex release against itself, and
whose translation inspector shows exactly what it changed. "Every agent and SDK on every model" stays as
the scope line, not the headline.

Proof points, in launch-copy order:
1. **Published compatibility matrix** — every source × target × feature cell, generated from the tests,
   with the client versions last replayed.
2. **The translation inspector** — source, canonical and target side by side, with every dropped field
   named.
3. **Small and auditable** — provenance-signed npm releases, signed container images, an SBOM, few
   runtime dependencies. Stated plainly, without naming other projects' incidents.
4. **A shim for native endpoints** — where a provider already speaks the client's format, babelgate
   passes through and fixes the gaps that provider's endpoint leaves.

Not claimed as differentiators any more: "any model", routing, fallbacks, a cost UI, provider count,
raw performance, governance features as such.

### 2.2 Version changes
- **v1.5 is renamed "Correct everywhere" (L).** Contents (detail in the v1.5 design spec):
  0. **Conductor efficiency first** (Task 0, before any product task): build-process work to keep the
     owner's Claude usage under the weekly and 5-hour limits.
  1. **Reasoning** for every source format (from the old v1.5; v1.4 did Responses only).
  2. **Media**: URL images, documents/PDFs, images in tool results (from the old v1.5).
  3. **Native-endpoint shim**: same-format pass-through for the Anthropic format plus declared per-provider
     gaps with one defined fix each (new).
  4. **Published compatibility matrix and client-release replay** (new).
  5. **Supply-chain trust**: npm provenance, signed images, SBOM (new; OWNER GATE: publishing config).
  6. **Embeddings, minimal**: OpenAI-format inbound only (shrunk from three formats).
  7. **Gemini CLI frozen; Antigravity CLI spike** (new).
- **v1.6 reordered: "One command, free to start" (M).** The single binary / one-click install and a
  curated free-and-cheap provider preset list (OpenRouter free models, NVIDIA NIM, Groq, DeepSeek) come
  first; client recipes (Cursor, Continue, Aider, Open WebUI, LangChain, LlamaIndex, Vercel AI SDK,
  Ollama-only apps) stay; health checks and a circuit breaker stay **minimal**; the exact-match response
  cache stays opt-in and small (the CI use case); key load balancing and rate limiting move to v2.0
  unless users ask earlier.
- **Gemini CLI.** Frozen as an entry point from v1.5: the recipe stays and keeps working, it gets no new
  live-gate effort and leaves the headline. The Gemini inbound format and Gemini as a provider are
  unaffected (Gemini SDKs and apps still use them). Antigravity CLI is assessed in a one-day spike in
  v1.5; adopting it as an entry point is an owner decision with the spike's findings.
- **POWERHOUSE (after v1.6)** is restated: any client in 5 formats reaches any provider through one
  endpoint, every pair contract-tested **and published**, client releases replayed, signed releases,
  one-command install. Targets unchanged.
- **Phase 3 wedge.** Governance for Claude Code alone is now covered by Anthropic's own gateway. The
  paid tier's wedge is **cross-client**: per-session spend and loop caps and an audit trail with
  inspector replay, across Claude Code, Codex and SDK traffic in one place. The 3-team gate is unchanged
  and stays the only trigger for building it.
- **Running alongside.** The pre-spec competitor check becomes a script (repo metadata, releases,
  changelog links for the tracked list) run monthly and before every version spec, so the check is
  cheap and comparable over time. The tracked list gains claude-code-router's multi-agent scope,
  OmniRoute, free-claude-code, agentgateway, Agent Router (ex-Envoy AI Gateway), Anthropic's Claude Code
  gateway and Antigravity CLI.

### 2.3 Build-process change (not product)
The conductor runs as before (Opus conducts, Devin implements on free SWE-2), with less for Opus to do:
mechanical checks scripted, waits that cost no turns, a lean starting context, a fresh session per task,
and a recommended conductor model per plan task (Sonnet where the task is mechanical). Detail and the
measured baseline are in the v1.5 design spec, Task 0. The owner chose this ("A: Opus stays the conductor,
with less to do") over a Sonnet-run loop or a script-driven loop.

### 2.4 Competitive landscape update
| Tool | Where babelgate differs |
|---|---|
| claude-code-router | Many agents, routing, desktop app; no pair-level correctness evidence, no translation inspector, no Ollama inbound, no Gemini CLI |
| LiteLLM | Broadest provider list, Claude Code/Codex/Gemini CLI documented; Python, config-heavy; open translation bugs; two 2026 release incidents |
| Bifrost | Fast (Go), Claude Code/Codex/Gemini CLI documented; open `/v1/messages` and streaming bugs |
| OmniRoute, free-claude-code | Free-tier aggregation and many harnesses; attention-driven, quality unverified |
| Anthropic's Claude Code gateway | Claude-only by design; governance for Claude Code alone |
| Cloudflare / Vercel AI Gateway, OpenRouter | Hosted; a pass-through hop, not a self-hosted translator |
| Kong / Agent Router / agentgateway | Platform-team infrastructure; Kong documents no streaming for several non-Claude providers |

## 3. Considered and not adopted
- **Racing on provider count** (OmniRoute claims 394). OpenAI-compatible providers stay config, not
  adapters; the matrix, not the count, is the claim.
- **Dropping Gemini inbound with Gemini CLI.** Gemini SDK and app traffic still uses it, and LiteLLM and
  Bifrost offer it; only the CLI entry point is frozen.
- **Naming competitors' security incidents in launch copy.** We state our own supply-chain practice;
  readers can compare.
- **A script-driven or Sonnet-driven conductor loop.** Larger savings, but the owner chose to keep Opus
  as conductor and remove its mechanical work first (§2.3); revisit if Task 0's measured saving is short.

## 4. Sources
`docs/research/2026-11-16-market-analysis.md` (§ Sources): GitHub API snapshots (2026-11-16), Claude Code
gateway docs (code.claude.com/docs/en/gateways), Ollama Anthropic compatibility docs, LM Studio Anthropic
and Open Responses docs, Google Developers Blog on Gemini CLI → Antigravity CLI (2026-05-19), Stripe
newsroom (2026-08-19), Helicone/Mintlify posts (2026-03-03), AAIF (2026-09-09), LiteLLM blog archive,
Kong AI Gateway docs, vendor coding-agent pages. Deal sizes and market-size figures are press or analyst
claims and are not relied on.
