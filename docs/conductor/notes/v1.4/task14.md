# v1.4 Task 14 — owner decisions

**Gates A/B Codex config (owner decision A, PR #87, 2026-11-13):** with a Gemini/Claude model name Codex uses
fallback metadata: no `apply_patch`, no default reasoning effort (spec §1.2 E12). For the gates to exercise
custom tools and reasoning:
- set `model_reasoning_effort` (gate A: `medium`) in the gate's `config.toml`;
- ship a `model_catalog_json` in `examples/` with an entry for the gate model that has
  `apply_patch_tool_type: "freeform"` and **`use_responses_lite: false`** (or the field name codex-cli
  0.169.0 actually uses; check `codex-rs/models-manager` at tag `rust-v0.169.0`).

**Unproven:** no recording so far contains an `apply_patch` tool. The one catalog model recorded
(`gpt-6-luna`) used responses-lite with a custom `functions.exec` tool instead (E15). Before the gate run,
record once with the catalog (`scripts/gates/record-codex.sh` is the conductor's to run) and confirm a
top-level `tools` list with a `custom` `apply_patch` and no `x-openai-internal-codex-responses-lite` header.
If the catalog can't give that shape, STOP with an owner decision (options: gate without apply_patch;
support responses-lite on the bridge; something else).

Gate B may use OpenRouter's Anthropic endpoint (E18: `/api/v1/messages` returns signed thinking blocks for
`anthropic/claude-haiku-4.5`).

Run codex-cli **0.169.0** (pinned: the recordings and E12–E19 are for that version). The owner may install
it globally (`npm i -g @openai/codex@0.169.0`); otherwise `npx -y @openai/codex@0.169.0`.
