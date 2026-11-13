# v1.4 Task 5 — owner decisions

**Namespace tools (owner decision A, PR #87, 2026-11-13):** Codex sends `{type: "namespace", name,
description, tools: [function tools]}` (`multi_agent_v1` with `spawn_agent`, `send_input`, `wait_agent`,
`resume_agent`, `close_agent`; spec §1.2 E13). On non-Responses targets, flatten each nested tool into a
function tool. Raise calls back to the namespaced form on the way out, so Codex sees the call it expects.
Choose the flattened naming yourself (it must survive every provider's tool-name rules, e.g. Gemini/Anthropic
character sets and length) and record the choice and the reason in docs/decisions.md. Like custom tools, this
lives in the services (`custom-tools.ts`), not in the four existing adapters. Pin it with a round-trip test per
target. Responses → Responses keeps namespaces native.

`web_search` (E14) follows spec §2.2/§3.6: `builtin_tool_dropped` on the bridge.

Note: with the fallback shape, Codex sends **no** `apply_patch` custom tool. Custom tools still matter for the
gates (Task 14 enables `apply_patch` via `model_catalog_json`) and for pass-through, so implement §3.6 as
specified.
