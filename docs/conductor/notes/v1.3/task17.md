# v1.3 Task 17 — conductor notes

Live check from PR #58 (Task 1, decision 1a): the gemini request encoder puts `thoughtSignature:
"skip_thought_signature_validator"` on EVERY outgoing `functionCall` part, while Gemini itself signs
only the first parallel call. Add a live case: Gemini CLI (or a Gemini-format client) → a Gemini 3.x
target with a turn that has parallel tool calls in the history. Expected: 200. If the upstream
rejects it, STOP: Owner decision needed (placeholder on the first part only, or wait for 1b, real
signatures in canonical). Record the result in the Task 17 decisions entry.
