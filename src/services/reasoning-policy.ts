import { recordNote } from "../observe/context";
import type { ProviderEntry } from "../routing/registry";
import type { Provider } from "../transformers";
import type { CanonicalRequest } from "../types/canonical.types";

/**
 * What a per-attempt reasoning policy needs to know about the client
 * request: which dialect it was decoded from and the original body
 * (the note paths below are wire field names, so the body is read
 * structurally, never logged).
 */
export interface ReasoningPolicySource {
  source: Provider;
  sourceBody: unknown;
}

/**
 * `reasoning: false` on a provider entry restores v1.4 for that
 * provider (v1.5 spec §3.1): the reasoning request config the source
 * decoder just mapped is removed before encode, with exactly the
 * note(s) v1.4 recorded for that source's field — only Anthropic's
 * `thinking` carried one (`thinking_dropped`); the Chat, Gemini and
 * Ollama fields were ignored silently, so none is recorded here.
 * Called per attempt, before encode: a fallback entry without the
 * flag still sees the mapped config. A Responses source is
 * untouched — its `reasoning` mapped in v1.4 too.
 */
export function applyReasoningPolicy(
  req: CanonicalRequest,
  entry: ProviderEntry,
  source: Provider,
  sourceBody: unknown,
): CanonicalRequest {
  if (entry.reasoning !== false || source === "responses") return req;
  if (req.config?.reasoning === undefined) return req;
  if (
    source === "anthropic" &&
    (sourceBody as { thinking?: unknown })?.thinking !== undefined
  ) {
    recordNote(
      {
        stage: "decode",
        adapter: "anthropic",
        code: "thinking_dropped",
        path: "thinking",
      },
      'Dropping request field "thinking" (provider reasoning: false)',
    );
  }
  const { reasoning: _stripped, ...config } = req.config;
  return { ...req, config };
}
