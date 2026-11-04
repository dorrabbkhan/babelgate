# babelgate roadmap revision — 2026-11-04

**Status:** approved by the owner in conversation, 2026-11-04. Amends the 2026-10-26 roadmap design spec;
everything not changed here still stands (open core, the 3-team gate, no token reselling, validation
discipline). Input: an outside strategy review (a Gemini conversation on competitors and monetization),
checked claim by claim against sources and against our own release evidence.

## 1. Why revise

1. **Providers now speak Anthropic natively.** Ollama ≥ 0.14 serves the Anthropic Messages API, with streaming
   and tools (no `count_tokens`, no `tool_choice`). DeepSeek (`api.deepseek.com/anthropic`) and Z.AI's GLM
   (`api.z.ai/api/anthropic`) do too, and OpenRouter has an Anthropic endpoint guaranteed only for
   Anthropic's own models. "Claude Code on Ollama" no longer needs a proxy, so it can't be the headline.
2. **Codex CLI speaks only the Responses API.** `wire_api = "chat"` was deprecated in December 2025 and
   removed in February 2026. Chat-only backends (Ollama, vLLM, llama.cpp, Gemini, Anthropic) can't serve
   Codex without a translator. That makes the Responses adapter a launch-sized entry point, not breadth work.
3. **Gemini CLI accepts a custom endpoint.** `GOOGLE_GEMINI_BASE_URL` is applied since April 2026
   (gemini-cli PR #25357). Gemini-format clients have almost no native alternative outside Google, and
   babelgate already serves the Gemini format.
4. **Our own evidence favours cheap cloud models over local CPU.** v1.2 Gate 3 passed with Claude Code on
   `qwen/qwen3-coder` via OpenRouter in 19 s; the GPU Ollama gates are deferred to v1.3. Users manually
   set `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000` to stay under OpenRouter key budgets.

## 2. The test for where babelgate earns its place

**The client is locked to one API format and the model doesn't speak it.** Where a provider already
speaks the client's format, babelgate is a convenience (routing, fallbacks, cost, one URL); where it
doesn't, babelgate is the bridge.

| Source format | Clients | Native support elsewhere | babelgate's value |
|---|---|---|---|
| OpenAI Chat | OpenAI SDK, LangChain, Open WebUI, Cursor | Almost everyone | Gateway features; LiteLLM's ground |
| Anthropic | Claude Code, Anthropic SDK | Ollama, DeepSeek, GLM, OpenRouter (Anthropic models) | Bridge to OpenAI, Gemini, vLLM, llama.cpp, most OpenRouter models |
| Gemini | Gemini CLI, google-genai SDK | Google only | Bridge to every other model |
| Ollama | Ollama-only apps, editor "Ollama" options | Ollama only | Bridge to cloud models |
| OpenAI Responses | Codex CLI, newer OpenAI SDKs and agents | OpenAI and few others | Bridge to every Chat-only backend |

## 3. Decisions

### 3.1 Positioning: many entry points, not one
**"Every agent and SDK on every model."** Three flawless experiences, replacing the 2026-10-26 list:
1. **Agent CLIs on any model** — Claude Code, Codex CLI and Gemini CLI, each against models that don't
   speak its format, with streaming and tools.
2. **Any SDK or app, any backend** — OpenAI, Anthropic, Gemini and Ollama clients, unchanged.
3. **One endpoint, many providers** — routing, aliases, fallbacks (shipped in v1.2).

Claude Code stays the first and best-tested example, not the identity. No single client vendor's
roadmap can strand the project. Recipes and launch posts are per entry point. Where a native path
exists, recipes say so and state what babelgate adds instead of hiding it.

### 3.2 Version changes
- **v1.3 (See what's happening)** gains: a per-target output-token cap; tool-call failure diagnostics in
  the inspector; `cache_control` mapped to each provider's own caching where one exists; the client
  identity (User-Agent) recorded per request; a Gemini CLI recipe and live gate.
- **New v1.4: Codex on any model.** The Responses API adapter (moved from the old v1.4) plus structured
  output (Responses `text.format` and Chat `response_format` share the JSON-schema work), a Codex recipe
  and a live gate where Codex completes the edit task on a Chat-only backend.
- **v1.5 API breadth**: embeddings, media, reasoning (the rest of the old v1.4).
- **v1.6 Resilience and local-first polish**: the old v1.5, with Ollama-only app recipes.
- **POWERHOUSE moves from v1.5 to v1.6.** Cost: about one more M version (~1–1.5 months).
- **v2.1** gains per-session spend and loop caps for coding agents and budgets per client identity.
- **v2.2** names an air-gapped mode explicitly (a policy that refuses every non-local route, with audit
  evidence) inside the existing signed policy files.
- **v2.3** routes on what the request contains (context size, thinking on, a client's background or
  small-model calls), and never on a prediction of the next tool call.

### 3.3 Competitive landscape additions
| Tool | Where babelgate differs |
|---|---|
| Ollama / DeepSeek / GLM Anthropic endpoints | One provider each, Anthropic format only; no routing, fallbacks or cost view |
| OpenRouter Anthropic endpoint | Hosted; non-Anthropic models not guaranteed |
| claude-code-router (~26k stars) | Claude Code only; routes by request type. babelgate serves five client formats |
| Codex routers, LiteLLM as Codex/Gemini CLI proxy | Python/config-heavy or single-client; babelgate is contract-tested across every pair |
| anthropic-proxy (npm), anthropic-proxy-rs | Single format pair, OpenAI-compatible targets only |

The answer to "how is this different from LiteLLM?" is any format in, every pair contract-tested,
one command. "It's Node, no YAML" is not a differentiator: the shims are npm packages too.

## 4. Rejected from the review, and why
- **ARR projections and per-tier revenue tables.** No evidence behind the numbers; the 3-team gate decides.
- **A hosted relay ($19/mo).** Customer code would pass through our servers, contradicting the privacy
  stance and the no-reselling non-goal.
- **Routing on "the tool being called".** The next tool call is the model's output; the proxy can't see
  it before choosing the model. Request-feature routing (§3.2, v2.3) is the feasible version.
- **Prompt-cache emulation by hashing.** Savings come from the provider's KV cache, not from the proxy.
  The feasible version is the `cache_control` mapping plus stable prefixes (v1.3).
- **Mocking tool results such as `git status`.** Tools run in the client, not through the proxy.
- **Semantic caching for agents.** Agent turns don't repeat; exact-match caching (v1.6) stays for CI.
- **In-place secret redaction for coding agents.** The agent edits the redacted text and writes it back.
  Redaction stays an opt-in v2.0 plugin; air-gapped routing is the regulated-industry answer.

## 5. Sources
- Ollama Anthropic compatibility: https://docs.ollama.com/api/anthropic-compatibility, https://registry.ollama.ai/blog/claude
- OpenRouter and Claude Code: https://openrouter.ai/docs/guides/guides/coding-agents
- Codex wire API: https://codex.danielvaughan.com/2026/04/23/codex-cli-custom-model-providers-configuration-guide/, https://github.com/janhq/jan/issues/7413
- Gemini CLI base URL: https://github.com/google-gemini/gemini-cli/pull/25357
- DeepSeek / GLM Anthropic endpoints: https://github.com/alorse/cc-compatible-models
- claude-code-router: https://www.morphllm.com/claude-code-router
