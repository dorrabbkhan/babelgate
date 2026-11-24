# v1.6 Task 13c — owner decisions

**2026-11-24, owner (in the conductor session), after Task 13b's live run:** do this task.

1. The `openrouter-free` and `deepseek` presets turn `reasoning_passback` on. This is the "task says so"
   exception to "Defaults unchanged for existing configs", scoped to these two presets only. Both presets are
   new in v1.6 and unreleased. Plain provider entries keep passback off, and an explicit
   `reasoning_passback: false` still wins.
2. No other preset, default or adapter changes. `reasoning_details` passback is out of scope.
3. Task 15's launch copy does not compare babelgate with other gateways on reasoning passback until this task
   is merged and its live step passed.
