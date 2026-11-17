# v1.5 Task 4: owner decisions (2026-11-17, owner in chat)

**D5 extension (owner-approved):**
- In `tests/contracts/stream-reasoning-drop.test.ts`, the `it.each(PROVIDERS)` case
  "%s: reasoning block mid-stream leaves the wire bytes unchanged" may drop `anthropic` and `gemini` from its
  provider list (`openai` and `ollama` stay until Task 5). In the same PR, replace them with new tests that assert
  the exact events/bytes each of those two encoders now emits (thinking block / `thinking_delta` / one
  `signature_delta` carrying the `bg1.` envelope before `content_block_stop`; Gemini `{text, thought: true}`
  part with the envelope in `thoughtSignature`), including the envelope's unpacked contents.
- Any other existing test in `anthropic.adapter.test.ts`, `gemini.adapter.test.ts` or `tests/contracts/*` that
  pins reasoning being DROPPED for Anthropic/Gemini clients (encode or decode) may change only to assert the new
  behaviour at least as exactly as it asserted the old (same note codes and paths where a drop still happens, e.g.
  a raw non-`bg1.` signature under conductor's call (c)). Never delete such a test; never weaken an assertion.
- The `text_signature` case in `stream-reasoning-drop.test.ts` stays as is.
- Record each changed test by name and full path in the Task 4 decisions.md entry, citing this note.
- No fixture or contract snapshot changes: still STOP.

**From the first attempt (cancelled after a rejected tool call):** keep every file you read or write inside the
repository (no `/tmp`, no paths under `~`), never run `docker`, and avoid any command that would need
confirmation. Worktrees only under `.claude/worktrees/<name>`.

This notes file (`docs/conductor/notes/v1.5/task4.md`) is untracked in the shared checkout on purpose: do not
`git add` or commit it; the conductor commits it separately.

**Owner decision, 2026-11-17 (chat, after the PR #120 escalation): option 1.** The `text_signature` case in
`tests/contracts/stream-reasoning-drop.test.ts` ("%s: client encoders ignore text_signature") runs for
`openai`/`gemini`/`ollama` only; Anthropic is covered by the exact test "anthropic: text_signature closes the text
block and rides a trailing envelope" (fix round 1, `f0aabc7`). This replaces "stays as is" above.
