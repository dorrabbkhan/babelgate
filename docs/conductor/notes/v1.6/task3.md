# v1.6 Task 3 — owner decision: `between_tools` without an effort maps to `"high"`

**Decided by the owner on 2026-11-21** (in the conductor session, after reading PR #160's status comment).
This replaces the plan's "else `"low"`" in conductor's call (b) and the Task 3 Interfaces line.

- `thinking: {type: "between_tools"}` with no `output_config.effort`, or with an effort string that is
  neither on the canonical ladder nor `"max"`, decodes to `{ effort: "high" }`. Reason: Anthropic's API
  defaults `output_config.effort` to `high` on Claude Sonnet 5.5 (the only model that accepts
  `between_tools`), per https://platform.claude.com/docs/en/build-with-claude/effort. Everything else in
  the mapping stays as the plan says, including the `thinking_mode_mapped` note.
- Keep the `"between_tools max lowers to xhigh"` test unchanged (it keeps the decoder consistent with
  `adaptive`, even though Anthropic rejects `max` with `between_tools`).
- The plan's test name `"between_tools without effort maps to low"` becomes
  `"between_tools without effort maps to high"` and asserts `{ effort: "high" }` exactly. This is an
  owner-approved change to a test added in this same PR, not a loosening.
- Record this in the Task 3 `docs/decisions.md` entry as "Owner decision 2026-11-21: no-effort default is
  `high` (Anthropic's documented default), replacing the plan's `low`". Do not write an "Owner sign-off" line.
