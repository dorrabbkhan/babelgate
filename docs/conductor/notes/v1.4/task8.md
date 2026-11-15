# v1.4 Task 8 — owner decisions

**Approved by the owner on 2026-11-15 (PR #102, escalation option 1). Use exactly this scope and don't STOP on it:**

1. **D9 contract expectation change.** In `tests/contracts/stream-decoders.test.ts`, the v1.3 test
   `"ollama decoder ignores thinking"` (it predates reasoning parts and contradicts spec §3.3,
   "Ollama `thinking` → reasoning part") is renamed `"ollama decoder maps thinking to reasoning events"`.
   Its expected list becomes exactly:
   `{type: "message_start", id: "call_0", model: "qwen3:0.6b"}`,
   `{type: "reasoning_start", index: 0, origin: {provider: "", model: "qwen3:0.6b"}}`,
   `{type: "reasoning_delta", index: 0, text: "let me think"}`,
   `{type: "text_delta", text: "Hi"}`,
   `{type: "usage", usage: {inputTokens: 10, outputTokens: 1, totalTokens: 11}}`,
   `{type: "message_end", finishReason: "stop"}`.
   It stays an exact `toEqual`. The inline NDJSON input stays unchanged, and the comment is updated to say
   what the test now pins. If the decoder's real order differs, for example reasoning events before `message_start`,
   STOP and report the actual order instead of editing the expectation to match.
2. Nothing else. No fixture, snapshot or other existing assertion changes; any other one is still a STOP.
   Record D9 in `docs/decisions.md` in the Task 8 entry, naming PR #102.
3. Ollama and OpenAI **client** encoders still never emit reasoning (Global Constraints). A test in each of
   those adapters pins this.
