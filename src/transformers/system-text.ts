import type { CanonicalContentPart } from "../types/canonical.types";

/**
 * Flatten a canonical `systemPrompt` to a plain string (spec §3.2): every
 * encoder but Anthropic's sends the system text as one string; parts exist
 * only to carry cache hints. A system array's text blocks join with "\n\n"
 * — the same separator the Anthropic decoder has always used for them.
 */
export function systemText(
  system: string | CanonicalContentPart[] | undefined,
): string | undefined {
  if (system === undefined || typeof system === "string") {
    return system;
  }
  return system.map((p) => p.text ?? "").join("\n\n");
}
