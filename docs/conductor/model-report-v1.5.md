# v1.5 model breakdown

**Purpose:** keep the owner's Claude usage under the weekly and 5-hour limits. Says which model conducts each
v1.5 task and why, what it should save, and (after the release) what it actually used.
Plan: `docs/superpowers/plans/2026-11-16-babelgate-v1.5-plan.md` (Task Index, "Conductor" column).
Spec: `docs/superpowers/specs/2026-11-16-babelgate-v1.5-design.md` §3.0, §5.1.

## Where the tokens go today (baseline, v1.3–v1.4)
- **Devin is free.** All 183 Devin sessions on this repo ran `swe-2-high` (free on the owner's plan).
  Implementation stays with Devin; giving Opus Devin's permissions would move free work onto paid Opus.
- **Opus conducts, and re-reading is the cost.** 57 sessions, 5,926 turns: 645M cache-read, 22.0M cache-write,
  3.84M output tokens ≈ $380 API-equivalent, ≈ $10 per task. Output (the actual thinking) is ≈ $77 of it.
- **Every turn starts at ≈ 49k tokens** (tools, skills, connectors) and the per-session average is ≈ 96k.
- **Most turns are mechanical:** 743 grep calls, 254 diff reads, 226 file reads, 232 CI/Devin waits.

## Rules for choosing the conductor model
| Model | Use for | Never for |
|---|---|---|
| **Opus 5.5** | Interface changes, wire formats, reasoning/signature rules, security-sensitive code (SSRF guard), routing-path changes, tasks ending at an owner gate where evidence must be judged | — |
| **Sonnet 5.5** | Docs, recipes, scripts, UI, config vocabularies, test plumbing, research write-ups, release chores; tasks that follow a pattern an Opus task set | Canonical changes; the first task of a new wire mechanism |
| **Haiku 5.5** | The `log-reader` helper only: summarizing long CI and Devin logs into ≤ 15 lines | Conducting; judging; writing fix instructions |

Judgment rules and escalations are identical whichever model conducts; `judge.sh` runs the mechanical checks
for both.

## Per-task breakdown
Estimates are per task, API-equivalent, against the ≈ $10 baseline: Task 0 should cut an Opus-conducted task to
≈ $5–6; a Sonnet-conducted task costs about half of that again (≈ $2.5–3).

| # | Task | Conductor | Reason | Est. |
|---|---|---|---|---|
| 0a | Judge script, waits, usage report | Opus | Encodes every judgment rule (runs on the old flow) | ≈ $10 |
| 0b | Lean context, headless runs, log reader | Opus | Permissions and context settings (old flow) | ≈ $10 |
| 1 | Recordings | Sonnet | Evidence capture, no product code | ≈ $3 |
| 2 | Canonical media change | Opus | Interface change | ≈ $6 |
| 3 | Reasoning request config, `reasoning: false` | Opus | Changes defaults for every user | ≈ $6 |
| 4 | Reasoning for Anthropic/Gemini clients | Opus | Signatures, origin rules, wire formats | ≈ $6 |
| 5 | Reasoning for Chat/Ollama clients | Sonnet | Text-only; follows Task 4 | ≈ $3 |
| 6 | Media + fetch guard | Opus | SSRF guard, wire formats | ≈ $6 |
| 7 | Tool-result images | Sonnet | Extends Task 6's mechanism | ≈ $3 |
| 8 | Anthropic/Chat pass-through | Opus | Routing path, trace/abort semantics | ≈ $6 |
| 9 | Gaps and presets | Sonnet | Config vocabulary; docs-cited values | ≈ $3 |
| 10 | Embeddings | Sonnet | Self-contained endpoint | ≈ $3 |
| 11 | Compatibility matrix | Sonnet | Test plumbing and rendering | ≈ $3 |
| 12 | Client replay | Sonnet | Scripts + workflow patch | ≈ $3 |
| 13 | Supply chain (patch) | Sonnet | Workflow patch; owner judges at the gate | ≈ $3 |
| 14 | Antigravity spike | Sonnet | Research write-up | ≈ $2 |
| 15 | Inspector UI | Sonnet | UI over existing data | ≈ $3 |
| 16 | Docs and positioning | Sonnet | Copy | ≈ $2 |
| 17 | Live suite, gates A–C | Opus | Judges release evidence | ≈ $6 |
| 18 | Release `1.5.0` | Sonnet | Release chore | ≈ $2 |

**Estimate for the version:** ≈ $100 API-equivalent for 20 tasks, against ≈ $200 if v1.5 ran like v1.4.
Opus share ≈ $56; the rest is Sonnet. These are planning numbers, not measurements.

## Check points
- **After Tasks 1–3:** the conductor posts `usage-report.sh --version v1.5` against the baseline on the Task 3
  PR. Under 40% saving → owner decision: move more tasks to Sonnet, or adopt the Sonnet-run loop (option B).
- **At release (Task 18):** this file gains a "Measured" column per task and the version total; the next
  version's Conductor column is set from it.

## Measured
_Filled in at Task 18._
