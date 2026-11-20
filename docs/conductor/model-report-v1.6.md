# v1.6 model breakdown

**Purpose:** say which model conducts each v1.6 task and why, what it should cost, and (after the release)
what it actually used. Plan: `docs/superpowers/plans/2026-11-20-babelgate-v1.6-plan.md` (Task Index,
"Conductor" column). Spec: `docs/superpowers/specs/2026-11-20-babelgate-v1.6-design.md` §5.

## Starting point (measured on v1.5, `model-report-v1.5.md`)
- Median **$1.83 per task**, $43.27 for 17 attributed tasks; first-turn context median 26.5k.
- The model column held: no Sonnet task needed an Opus rescue. Savings came from lean context and one fresh
  session per task.
- Cost concentrates in fix rounds and live-evidence tasks (v1.5 Tasks 9, 12, 14, 17; Task 17 alone $13.41).

## Rules (unchanged from v1.5)
Opus for interface or wire-format changes, new build or routing paths, and tasks whose evidence becomes an
owner decision or a public claim. Sonnet for docs, recipes, scripts, UI, config vocabulary and release chores.
Haiku only as the `log-reader` helper. Gate tasks budget like Opus work whatever the column says.

## Per-task breakdown
Estimates are API-equivalent, from v1.5's measured figures: ≈ $2.5 for an Opus task, ≈ $1.2 for a Sonnet
task, more where live evidence or hand verification is expected.

| # | Task | Conductor | Reason | Est. |
|---|---|---|---|---|
| 1 | Shape-diff schema subtrees | Sonnet | Script with seeded tests | ≈ $1 |
| 2 | Codex pin, recipe check, close issues | Sonnet | Evidence capture | ≈ $1.5 |
| 3 | `between_tools` | Opus | Wire format, docs evidence | ≈ $2.5 |
| 4 | SEA build + process harness | Opus | New build path; tested == shipped | ≈ $4 |
| 5 | Binaries in CI (patch) | Sonnet | Workflow patch; owner gate | ≈ $2 |
| 6 | Installers, brew, winget | Sonnet | Scripts and templates | ≈ $1.5 |
| 7 | Preset tiers, free presets | Sonnet | Doc-cited config values | ≈ $1.5 |
| 8 | First run + suggested models | Opus | User-facing defaults; live runs per model | ≈ $5 |
| 9 | Circuit breaker | Sonnet | Small state machine | ≈ $1.2 |
| 10 | Response cache | Opus | Keying correctness, stream replay, migration | ≈ $2.5 |
| 11 | App recipes | Sonnet | Hand-verified copy | ≈ $2 |
| 12 | SDK recipes + examples | Sonnet | Copy plus tests | ≈ $1.5 |
| 13 | Competitor-check script | Sonnet | Script | ≈ $1 |
| 13b | Competitor conformance run | Opus | Evidence that may become public claims | ≈ $5 |
| 14 | UI labels | Sonnet | UI over existing data | ≈ $1.2 |
| 15 | Launch readiness | Sonnet | Copy; owner review | ≈ $2 |
| 16 | Landing page | Sonnet | Static page from approved mockup | ≈ $2 |
| 17 | Live cases; gates E, F | Opus | Release evidence (v1.5's outlier) | ≈ $10 |
| 18 | Release 1.6.0 | Sonnet | Chore; owner gate | ≈ $0.5 |

**Expected total:** ≈ $47 for 19 tasks, median ≈ $1.5–2. Watch Tasks 4, 8, 13b and 17.

## Measured
Filled at release (Task 18) from `scripts/conductor/usage-report.sh --version v1.6`.
