# babelgate market check and vision check (2026-11-20)

A short follow-up to `2026-11-16-market-analysis.md`, done before the v1.6 spec. Method: GitHub API (stars,
last push, latest release) for the tracked repos, release notes of Claude Code, Codex, LiteLLM and Agent
Router since 2026-11-16, issue searches, and babelgate's own open issues and replay artifacts. Done by hand:
the scripted competitor check the 2026-11-16 revision asked for does not exist yet (v1.6 adds it).

## 1. What moved since 2026-11-16

| Repo | Stars (11-16 → 11-20) | Latest release |
|---|---|---|
| dorrabbkhan/babelgate | 0 → 0 | v1.5.1 (11-20) |
| BerriAI/litellm | 63.4k → 63.6k | v1.110.2 (11-20; five releases that day) |
| maximhq/bifrost | 9.6k → 9.8k | helm-chart-v2.1.49 (11-19) |
| musistudio/claude-code-router | 38.2k → 38.3k | v3.1.5 (11-16) |
| cheaper-inference/OmniRoute | 88.0k → 89.2k | v3.8.54 (11-17) |
| Alishahryar1/free-claude-code | 70.8k → 72.2k | v6.19.41 (11-20) |
| farion1231/cc-switch | 154.9k → 156.0k | v4.0.37 (11-20) |
| agentgateway/agentgateway | 6.2k → 6.3k | v1.7.0 (10-27) |
| theagentrouter/agent-router | 2.4k → 2.4k | v1.3.0 (11-18) |
| Portkey-AI/gateway | 13.4k → 13.4k | v1.15.2 (01-12); no commits since 11-01 |
| Kong/kong | 44.4k → 44.4k | 3.9.5 (11-19) |

No new entrant, acquisition or shutdown. The landscape in the 11-16 analysis stands. Details worth acting on:

1. **Anthropic thinking modes.** Sonnet 5.5 accepts `thinking: {"type": "between_tools"}` and `adaptive`
   thinking. Agent Router 1.3 (11-18) added both and forwards `reasoning_effort` as `output_config.effort`.
   babelgate maps `enabled`, `disabled` and `adaptive` (with `output_config.effort`); `between_tools` falls
   to the `thinking_dropped` note (`anthropic.adapter.ts` `toCanonicalReasoning`), so reasoning is visibly,
   not silently, lost. A Claude Code release that starts sending it would lose reasoning on every bridged
   target.
2. **Claude Code 2.1.329 (11-19)** removed its automatic retry at a gateway model's `max_tokens` limit and
   tells gateway users to set `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. babelgate's per-target `max_output_tokens`
   (v1.3) already clamps this server-side; the Claude Code recipe should say so.
3. **Claude Code 2.1.328** fixed MCP tools whose input schema starts with `anyOf`/`oneOf`/`allOf` going
   missing on third-party providers. Such schemas now reach gateways; schema translation to Gemini needs a
   test for them.
4. **LiteLLM #52744** sizes Claude Code for proxy models and matches `ollama launch` env, and #52053 reports
   a permanent 400 loop on thinking-binding errors with Claude Fable 5.2: the same thinking/replay bug class
   as before, still open at the incumbent.
5. **claude-code-router #1983** — usage rows never record which client sent them; babelgate does this
   (User-Agent per request, v1.3).
6. **Codex 0.171** adds a default model provider selection in the app server and keeps investing in
   WebSocket startup; see §2.

## 2. babelgate's own state

- **Weekly client replay: green again, but churning** (issue #148, still open). Failures on 11-18, 11-19 and
  an 11-20 dispatch had two causes, both fixed by 11-20: (a) Claude Code 2.1.327 and 2.1.328 each added a
  property inside the built-in `ReportFindings` tool's JSON Schema, which the shape diff counts as an added
  path; each needed an owner-approved fixture PR (#142, #149); (b) the Codex recorder saw no requests on
  codex 0.170 because `localhost` resolved to `::1` (fixed in `0192cad`). The 11-20 13:26 dispatch run is
  green on Claude Code 2.1.329 and codex 0.171. Both edit-task gates passed throughout: the product never
  broke. The lesson is the cost: a client release that edits a tool schema should not need an owner PR.
- **Issue #99** (Gemini text-part `thoughtSignature`) is still open, but the work shipped in v1.4 (PRs #100, #101: canonical `text_signature` event); only closing it remains.
- **Not launched.** 0 stars, 0 forks, 0 watchers. The launch posts in `docs/launch/` are drafts. The owner
  is holding the launch for v1.6 on purpose (decided 2026-11-20).

## 3. Vision check

| Question | Answer |
|---|---|
| Is "the translator you can check" still the right headline? | Yes. Nobody added published pair-level conformance, an inspector or a client-release replay in four days, and competitors' open issues are still thinking/tool/replay bugs. |
| Does the evidence hold up today? | Yes, but it is brittle: it went red three times in three days for harness reasons (tool-schema text, an IPv6 recorder bind), never for a product bug. Launching on it requires it to tolerate harmless client changes. |
| Is the product the bottleneck? | No. Distribution is: 0 stars against 10k–150k for the category. v1.6 is the launch version, so install friction, a free first run and launch material are the product work that matters most. |
| Do POWERHOUSE targets still make sense? | They are attention targets (2k stars, community-doc listings, 10+ outside contributors). They are only reachable after a launch, so they move to "v1.6 + launch" and are measured 60 days after the posts go out. |
| Anything to drop? | Nothing new. Key load balancing and per-client rate limits stay in v2.0. Gemini CLI stays frozen. |
| Anything to add to v1.6? | (a) make the replay ignore tool-schema text so harmless client releases stop needing owner fixture PRs, and close #148; (b) move the Codex recorder pin to current; (c) map `between_tools` thinking; (d) close #99 (done in v1.4); (e) the scripted competitor check that was decided on 11-16 and never built; (f) launch readiness: first run on a free provider in under a minute, README rewritten around it, launch posts and demo refreshed. |
| Phase 3? | Unchanged. Agent Router's quota policies and Bifrost OSS budgets keep "keys and budgets" commoditised; the cross-client wedge and the 3-team gate stand. |

## Sources (accessed 2026-11-20)
- GitHub API repo metadata and latest releases for the repos in §1.
- https://github.com/anthropics/claude-code/releases (v2.1.328, v2.1.329)
- https://github.com/openai/codex/releases (rust-v0.171.0)
- https://github.com/theagentrouter/agent-router/releases/tag/v1.3.0
- https://github.com/BerriAI/litellm/issues/52744, /52053
- https://github.com/musistudio/claude-code-router/issues/1983
- https://github.com/dorrabbkhan/babelgate/issues/148 and replay run 44549011473 artifact
  (`codex-record.log`, `summary.md`)
