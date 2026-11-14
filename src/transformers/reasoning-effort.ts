/**
 * Provider-neutral reasoning-effort helpers (v1.4 spec §3.3). The
 * canonical ladder is Codex's; each adapter maps it onto its own
 * target's levels or budget. No provider names in this file — the
 * per-provider supported sets and field names live in the adapters.
 */

/** Canonical `config.reasoning.effort` values, weakest → strongest. */
export const EFFORT_LADDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type Effort = (typeof EFFORT_LADDER)[number];

/**
 * The nearest supported level AT OR BELOW the requested effort on the
 * canonical ladder; `"none"` when nothing lower qualifies (callers map
 * that to their target's off state). `supported` must be a subset of
 * the ladder.
 */
export function nearestSupported(
  effort: Effort,
  supported: readonly Effort[],
): Effort {
  const requested = EFFORT_LADDER.indexOf(effort);
  for (let i = requested; i >= 0; i--) {
    const level = EFFORT_LADDER[i];
    if (level === "none" || supported.includes(level)) return level;
  }
  return "none";
}

/**
 * Starting token budgets for targets that take a numeric thinking
 * budget rather than a level (spec §3.3): Anthropic extended thinking
 * `budget_tokens` and Gemini 2.x `thinkingBudget`. `none` → 0.
 */
export function budgetFor(effort: Effort): number {
  switch (effort) {
    case "none":
      return 0;
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 24576;
    case "xhigh":
      return 32000;
  }
}
