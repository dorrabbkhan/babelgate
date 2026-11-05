import type {
  CanonicalCacheHint,
  CanonicalContentPart,
  CanonicalUsage,
} from "../../types/canonical.types";
import type {
  CacheControlEphemeral,
  MessageCreateParams,
  TextBlockParam,
} from "../../types/anthropic.types";

/**
 * Anthropic cache-hint and cached-usage conversion (spec §3.2). Kept out
 * of anthropic.adapter.ts / anthropic.messages.ts to keep those files
 * under ~400 lines; imports only src/types, same as they do.
 */

/** cache_control → canonical hint; an absent ttl decodes to {} (the wire default is 5m). */
export function toCacheHint(
  cc: CacheControlEphemeral | null | undefined,
): CanonicalCacheHint | undefined {
  if (!cc) return undefined;
  return cc.ttl !== undefined ? { ttl: cc.ttl } : {};
}

/** canonical hint → wire cache_control. */
export function toCacheControl(
  hint: CanonicalCacheHint | undefined,
): CacheControlEphemeral | undefined {
  if (!hint) return undefined;
  return { type: "ephemeral", ...(hint.ttl !== undefined && { ttl: hint.ttl }) };
}

/** The subset of a wire Usage canonical reads (SDK fields are `number | null`). */
export interface AnthropicWireUsage {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
}

/**
 * Wire usage → canonical: `inputTokens` is ALL input, cached included —
 * Anthropic's `input_tokens` excludes it, so the cache fields are summed in.
 * Cache fields are emitted only when non-zero.
 */
export function anthropicUsageToCanonical(
  usage: AnthropicWireUsage,
): CanonicalUsage {
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + read + write;
  const output = usage.output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(read > 0 && { cacheReadTokens: read }),
    ...(write > 0 && { cacheWriteTokens: write }),
  };
}

/**
 * Canonical → wire usage: `input_tokens` excludes cached tokens (clamped at
 * 0), and the cache fields are emitted only when non-zero — no-hint usage
 * produces exactly the bytes it did before §3.2.
 */
export function canonicalUsageToAnthropic(
  usage: CanonicalUsage,
): AnthropicWireUsage {
  return {
    input_tokens: Math.max(
      0,
      usage.inputTokens -
        (usage.cacheReadTokens ?? 0) -
        (usage.cacheWriteTokens ?? 0),
    ),
    ...(usage.cacheWriteTokens !== undefined &&
      usage.cacheWriteTokens > 0 && {
        cache_creation_input_tokens: usage.cacheWriteTokens,
      }),
    ...(usage.cacheReadTokens !== undefined &&
      usage.cacheReadTokens > 0 && {
        cache_read_input_tokens: usage.cacheReadTokens,
      }),
    output_tokens: usage.outputTokens,
  };
}

/** system blocks → string today; hinted parts when any block carries cache_control (§3.2). */
export function toCanonicalSystem(
  system: Exclude<MessageCreateParams["system"], string | undefined>,
): string | CanonicalContentPart[] {
  const textBlocks = system.filter(
    (b): b is TextBlockParam => b.type === "text",
  );
  if (!textBlocks.some((b) => b.cache_control)) {
    return textBlocks.map((b) => b.text).join("\n\n");
  }
  return textBlocks.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b.cache_control && { cache: toCacheHint(b.cache_control) }),
  }));
}

/** Canonical system prompt → `system`: parts emit a TextBlockParam array carrying cache_control (§3.2). */
export function toAnthropicSystem(
  system: string | CanonicalContentPart[] | undefined,
): MessageCreateParams["system"] {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map((part) => ({
    type: "text" as const,
    text: part.text ?? "",
    ...(part.cache && { cache_control: toCacheControl(part.cache) }),
  }));
}

/**
 * cache_control on text/image parts, custom tools and system blocks is
 * carried as a canonical cache hint (§3.2) — this scan only fires where a
 * hint still can't be carried: other block kinds (tool_use, tool_result
 * and their nested content, thinking, …) and server-side tools.
 */
export function hasUncarriedCacheControl(
  request: MessageCreateParams,
): boolean {
  const scan = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(scan);
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if ("cache_control" in obj) return true;
      return Object.values(obj).some(scan);
    }
    return false;
  };
  for (const m of request.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === "text" || block.type === "image") continue;
      if (scan(block)) return true;
    }
  }
  for (const tool of request.tools ?? []) {
    if (!("name" in tool) && scan(tool)) return true;
  }
  if (Array.isArray(request.system)) {
    for (const b of request.system) {
      if (b.type !== "text" && scan(b)) return true;
    }
  }
  return false;
}
