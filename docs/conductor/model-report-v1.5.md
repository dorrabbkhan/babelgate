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
Source: `scripts/conductor/usage-report.sh --version v1.5`, run 2026-11-20 (Task 18). Conductor
sessions only; Devin sessions are not in the report and are free anyway. `$` is API-equivalent.

| # | Conductor | Est. | Sessions | Turns | $ | ctx1~ | ctxμ~ |
|---|---|---|---|---|---|---|---|
| 0a | Opus | ≈ $10 | 1 | 85 | 4.147 | 45.8k | 125.8k |
| 0b | Opus | ≈ $10 | 1 | 38 | 1.880 | 45.8k | 94.2k |
| 1 | Sonnet | ≈ $3 | 1 | 65 | 1.503 | 45.8k | 104.2k |
| 2 | Opus | ≈ $6 | 1 | 39 | 1.829 | 44.1k | 73.9k |
| 3 | Opus | ≈ $6 | 1 | 63 | 2.358 | 44.3k | 85.5k |
| 4 | Opus | ≈ $6 | 1 | 65 | 2.606 | 44.3k | 89.8k |
| 5 | Sonnet | ≈ $3 | 1 | 33 | 0.608 | 44.2k | 70.0k |
| 6 | Opus | ≈ $6 | — | — | — | — | — |
| 7 | Sonnet | ≈ $3 | 1 | 6 | 0.120 | 25.9k | 29.8k |
| 8 | Opus | ≈ $6 | 1 | 36 | 0.454 | 25.9k | 46.6k |
| 9 | Sonnet | ≈ $3 | 1 | 158 | 5.407 | 25.9k | 117.5k |
| 10 | Sonnet | ≈ $3 | — | — | — | — | — |
| 11 | Sonnet | ≈ $3 | 1 | 67 | 1.117 | 25.9k | 69.3k |
| 12 | Sonnet | ≈ $3 | 1 | 129 | 2.974 | 26.1k | 87.8k |
| 13 | Sonnet | ≈ $3 | 1 | 52 | 0.864 | 26.1k | 60.8k |
| 14 | Sonnet | ≈ $2 | 1 | 123 | 3.027 | 26.2k | 108.7k |
| 15 | Sonnet | ≈ $3 | 1 | 37 | 0.731 | 26.2k | 49.7k |
| 16 | Sonnet | ≈ $2 | — | — | — | — | — |
| 17 | Opus | ≈ $6 | 1 | 266 | 13.410 | 26.6k | 116.9k |
| 18 | Sonnet | ≈ $2 | 1 | 12 | 0.229 | 26.5k | 35.7k |

**Version total:** **$43.265** across 17 sessions / 17 tasks ($26.215 on Opus, $17.050 on
Sonnet/Haiku); median **$1.829 per task** against the ≈ $10 v1.4 baseline — ≈ 82% below, well past
the ≥ 40% target. First-turn context median **26.5k** (target ≤ 30k, was 48.9k); per-session mean
context median 85.5k (was ≈ 96k).

- **Tasks 6, 10 and 16 have no attributed session** in
  `~/.claude/projects/-home-dorrabb-babelgate`: the report attributes a session by its first
  `/conduct v1.5 <N>` or `v1.5-task<N>` mention and found none — they were run under another project
  slug or unlogged, so their conductor cost is absent from the total.
- **16 sessions since 2026-11-16 are `unattributed`** ($17.049): spot checks, fix rounds and reruns
  without a task mention in the first user turn.
- **Task 17 is the outlier** ($13.410, 266 turns): live-suite debugging plus three owner-visible
  gate runs. The next-highest task is $5.407.
- **Takeaway for v1.6:** the model column held — no Sonnet task needed an Opus rescue on cost
  grounds; the savings came from Task 0's lean context (≈ 45% smaller first turns) and one fresh
  session per task, not from cheaper models alone. Fix rounds and live-evidence tasks (9, 12, 14,
  17) are where the turns go; gate tasks should budget like Opus work whatever the column says.
