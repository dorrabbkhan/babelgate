# Conductor usage baseline — v1.3 + v1.4 (2026-11-16)

Spec §3.0.5 baseline for evidence E9–E11. Aggregates only — no prompt text,
no tool inputs/outputs, no keys.

## How this was produced

- Command: `usage-report.sh --since 2026-11-04 --version v1.3,v1.4` (a second
  pass with `--json` for the machine-readable form), run by the conductor on
  2026-11-16 against `~/.claude/projects/-home-dorrabb-babelgate`; output
  captured as `tmp/usage-baseline.json` / `tmp/usage-baseline.txt`
  (gitignored, aggregates only). Every number below comes from that output;
  medians are stated at the precision the script prints.
- This doc restricts to tasks matching `^v1\.[34]-task[0-9]` — **30 sessions**
  — which drops `unattributed`, the `v0.3-task12` typo session and the
  current `v1.5-task0a` session. The two sessions the earlier pass left as
  `taskN` placeholders now attribute to real tasks under the digit-only
  regex: `78a9df1a` → `v1.3-task14` and `97f48092` (a run-plan session) →
  `v1.4-task10`.
- Turns count once per assistant `message.id` (the log writes one line per
  content block repeating the same usage) and include `subagents/*.jsonl`
  sidechains priced by their own model. `$` is API-equivalent at the script's
  price table (opus 4/20/0.20/8, sonnet 2/10/0.10/4, haiku 0.10/0.50/0.01/0.20
  per 1M in/out/cache-rd/cache-wr).

## Per task (all models)

ctx1~ / ctxμ~ are the per-session medians of first-turn context (input +
cache) and mean turn context. Tool mix is the top 5 buckets.

| task | sess | turns | cache-rd | cache-wr | output | $ | ctx1~ | ctxμ~ | tool mix |
|---|---|---|---|---|---|---|---|---|---|
| v1.3-task1 | 1 | 84 | 10.20M | 120.2k | 48.9k | 3.979 | 67.0k | 122.8k | bash:36 devin:18 diff-read:18 ci-wait:2 AskUserQuestion:1 |
| v1.3-task10 | 1 | 30 | 2.70M | 121.7k | 12.1k | 1.756 | 68.9k | 94.1k | bash:16 devin:5 diff-read:4 ci-wait:1 |
| v1.3-task11 | 1 | 37 | 3.64M | 78.8k | 16.3k | 1.685 | 68.9k | 100.4k | bash:20 devin:6 diff-read:5 grep:2 Write:2 |
| v1.3-task13 | 1 | 39 | 3.01M | 74.5k | 17.6k | 1.549 | 48.8k | 79.0k | bash:25 devin:5 diff-read:4 ci-wait:2 grep:1 |
| v1.3-task14 | 1 | 44 | 3.25M | 76.3k | 21.2k | 1.686 | 48.1k | 75.6k | bash:12 diff-read:12 grep:3 file-read:3 Skill:2 |
| v1.3-task15 | 1 | 40 | 3.05M | 76.7k | 19.7k | 1.618 | 49.0k | 78.3k | bash:18 diff-read:12 devin:5 |
| v1.3-task16 | 1 | 48 | 4.10M | 86.1k | 18.2k | 1.873 | 49.0k | 87.2k | bash:20 grep:10 diff-read:8 devin:5 ci-wait:1 |
| v1.3-task17 | 2 | 167 | 21.02M | 432.2k | 108.3k | 9.311 | 47.0k | 117.6k | bash:75 diff-read:26 devin:14 grep:13 Write:6 |
| v1.3-task18 | 1 | 147 | 16.64M | 380.3k | 122.1k | 8.814 | 45.8k | 115.8k | bash:73 WebSearch:21 grep:16 WebFetch:10 diff-read:8 |
| v1.3-task2 | 1 | 21 | 1.64M | 46.4k | 6.9k | 0.838 | 64.9k | 80.2k | bash:9 devin:5 ScheduleWakeup:3 diff-read:1 ci-wait:1 |
| v1.3-task3 | 3 | 505 | 64.98M | 2.26M | 253.3k | 36.118 | 68.3k | 119.8k | bash:224 diff-read:102 devin:90 ci-wait:12 grep:12 |
| v1.3-task4 | 1 | 38 | 3.21M | 173.7k | 19.0k | 2.048 | 68.4k | 88.9k | bash:19 devin:6 diff-read:3 WebFetch:3 Agent:1 |
| v1.3-task5 | 1 | 67 | 8.21M | 314.5k | 35.2k | 4.863 | 68.8k | 127.2k | diff-read:23 bash:17 devin:13 grep:4 AskUserQuestion:1 |
| v1.3-task6 | 1 | 28 | 2.51M | 141.7k | 14.6k | 1.928 | 66.7k | 94.7k | bash:11 diff-read:6 devin:5 grep:2 |
| v1.3-task7 | 1 | 55 | 5.77M | 184.6k | 23.3k | 3.096 | 68.8k | 108.2k | bash:27 diff-read:13 devin:6 ToolSearch:1 grep:1 |
| v1.4-task1 | 1 | 118 | 14.43M | 607.8k | 82.9k | 5.958 | 45.8k | 127.4k | bash:47 WebFetch:31 diff-read:18 mcp__t3-code__t3_background_wait:12 devin:7 |
| v1.4-task10 | 1 | 167 | 21.74M | 702.7k | 84.0k | 11.653 | 45.2k | 134.4k | bash:55 diff-read:30 mcp__t3-code__t3_background_wait:18 devin:9 grep:9 |
| v1.4-task11 | 1 | 53 | 4.82M | 251.5k | 18.3k | 3.342 | 46.4k | 95.7k | bash:19 grep:10 devin:9 diff-read:4 mcp__t3-code__t3_background_wait:3 |
| v1.4-task12 | 1 | 68 | 6.75M | 196.6k | 33.3k | 3.591 | 45.8k | 102.2k | bash:26 devin:13 file-read:10 diff-read:9 mcp__t3-code__t3_background_wait:5 |
| v1.4-task13 | 1 | 57 | 4.80M | 83.8k | 20.8k | 2.047 | 45.8k | 85.6k | bash:28 devin:10 grep:7 diff-read:4 mcp__t3-code__t3_background_wait:3 |
| v1.4-task14 | 1 | 114 | 14.82M | 216.8k | 73.4k | 5.846 | 46.4k | 131.9k | bash:58 diff-read:17 grep:8 devin:7 mcp__t3-code__t3_background_wait:7 |
| v1.4-task15 | 1 | 32 | 2.24M | 112.0k | 9.4k | 1.531 | 45.0k | 73.5k | bash:10 devin:4 mcp__t3-code__t3_background_wait:3 diff-read:3 ToolSearch:2 |
| v1.4-task2 | 1 | 43 | 3.82M | 91.1k | 19.1k | 1.876 | 45.8k | 91.0k | bash:14 diff-read:9 ci-wait:6 devin:4 mcp__t3-code__t3_background_wait:4 |
| v1.4-task3 | 1 | 49 | 4.55M | 95.0k | 20.1k | 2.072 | 45.8k | 94.9k | bash:22 diff-read:8 mcp__t3-code__t3_background_wait:6 devin:5 ci-wait:3 |
| v1.4-task4 | 1 | 54 | 5.05M | 180.2k | 26.3k | 2.978 | 45.8k | 96.8k | bash:22 diff-read:13 devin:6 mcp__t3-code__t3_background_wait:6 ToolSearch:2 |
| v1.4-task7 | 1 | 67 | 6.27M | 178.0k | 30.8k | 3.294 | 45.5k | 96.2k | bash:26 grep:8 diff-read:7 devin:6 mcp__t3-code__t3_background_wait:4 |
| v1.4-task7a | 1 | 59 | 5.92M | 248.1k | 31.1k | 3.791 | 45.8k | 104.5k | bash:16 diff-read:15 devin:8 mcp__t3-code__t3_background_wait:6 mcp__t3-code__link_pull_request:3 |

## Summary

sess = sessions; $/task~ = median per-task total `$`; ctx1~/ctxμ~ = per-session
medians of first-turn and mean context.

| version | sess | tasks | turns | cache-rd | cache-wr | output | $ | $opus | $/task~ | ctx1~ | ctxμ~ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v1.3 | 18 | 15 | 1,350 | 153.91M | 4.56M | 736.8k | 81.161 | 81.138 | 1.928 | 66.9k | 94.4k |
| v1.4 | 12 | 12 | 881 | 95.21M | 2.96M | 449.6k | 47.979 | 47.870 | 3.318 | 45.8k | 96.5k |
| total | 30 | 27 | 2,231 | 249.11M | 7.53M | 1.19M | 129.140 | 129.008 | 2.978 | 48.4k | 96.0k |

## vs. spec E9–E11

- **E9** states ≈ $380 over 57 sessions and 5,926 Opus turns. Those numbers
  were counted *before* the `message.id` dedup — Claude Code writes one log
  line per content block (about 2× per message) — and over a wider session set
  (everything in the projects dir, including `unattributed`, the `taskN`
  placeholders, `v0.3-task12` and `v1.5-task0a`). The deduped, v1.3+v1.4-only
  numbers here are **30 sessions, 2,231 turns, $129.140** ($129.008 opus-only;
  E9 was all-models-in-name but the logs are almost entirely Opus).
- **E10**'s first-turn-context median on this set is **48.4k** — it differs
  slightly from the spec's 48.9k, which counted a different session set.
  Per-session mean-context median **96.0k**.
- **E11**'s mix holds in kind if not in count (E11 was the wider set): over
  these 30 sessions the top buckets are bash 945, diff-read 382, devin 278,
  grep 114, t3-code background waits 79, ci-wait 59 — mechanical checks,
  diff reads and waits are most of the tool calls.
