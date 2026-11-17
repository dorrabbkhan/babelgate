/**
 * Provider presets and the gap vocabulary (v1.5 spec §3.3).
 *
 * A provider entry may declare `gaps:` from a fixed vocabulary — each
 * gap names one thing the upstream's Anthropic-compatible endpoint
 * does not do, and each has exactly one fix (§3.3's table), applied
 * by the source format's `patchGaps`/`applyGapFixes` before the
 * pass-through forward (or to the reply). The vocabulary is per gap,
 * never per provider pair.
 *
 * `PROVIDER_PRESETS` names shim endpoints that fill `type`,
 * `base_url`, `gaps` and — via the `preset` key's presence —
 * `passthrough: true` (D6). Explicit provider keys override preset
 * values. Every preset's gap list is verified against the provider's
 * own documentation (`docs`, `verified`) per the wire-format
 * evidence rule; Ollama's list comes from Task 1's measured probe
 * (E16), not just its docs page.
 */

export const GAPS = [
  "tool_choice",
  "count_tokens",
  "prompt_cache",
  "url_images",
  "documents",
  "stream_usage",
] as const;

export type Gap = (typeof GAPS)[number];

export const PRESET_NAMES = [
  "ollama-anthropic",
  "lmstudio-anthropic",
  "deepseek-anthropic",
  "glm-anthropic",
  "kimi-anthropic",
] as const;

export type PresetName = (typeof PRESET_NAMES)[number];

export interface ProviderPreset {
  type: "anthropic";
  base_url: string;
  api_key_env?: string;
  gaps: Gap[];
  /** Provider documentation the gap list was verified against. */
  docs: string;
  /** Date of that verification (YYYY-MM-DD). */
  verified: string;
}

export const PROVIDER_PRESETS: Record<PresetName, ProviderPreset> = {
  /**
   * Ollama's Anthropic endpoint. Gaps measured by Task 1's probe
   * (E16, `scripts/gates/probe-ollama-anthropic.sh`, Ollama 0.40.11,
   * 2026-11-16): `POST /v1/messages/count_tokens` → 404; image
   * `source.type:"url"` → 400; a base64 document block returned 200
   * on a text model, which is "accepted, not supported" — the PDF may
   * be silently dropped, so `documents` is declared and refused in
   * the client's dialect rather than silently lost. `tool_choice:
   * {type:"any"}`, ephemeral `cache_control` and streamed `usage`
   * were all measured working, so those gaps are not declared.
   */
  "ollama-anthropic": {
    type: "anthropic",
    base_url: "http://localhost:11434",
    gaps: ["count_tokens", "url_images", "documents"],
    docs: "https://docs.ollama.com/api/anthropic-compatibility",
    verified: "2026-11-16",
  },
  /**
   * LM Studio's Anthropic endpoint. Its docs list exactly one
   * endpoint, `POST /v1/messages`, with text, streaming and
   * `tool_choice` examples — no count_tokens, no `cache_control`, no
   * URL-image or document blocks are documented, so all four are
   * declared (a declared gap's fix is honest: local estimate, strip
   * with note, fetch+inline, refuse). `tool_choice` appears in the
   * docs' own example and streamed usage rides the documented
   * message_* events, so neither is declared.
   */
  "lmstudio-anthropic": {
    type: "anthropic",
    base_url: "http://localhost:1234",
    gaps: ["count_tokens", "prompt_cache", "url_images", "documents"],
    docs: "https://lmstudio.ai/docs/developer/anthropic-compat",
    verified: "2026-11-17",
  },
  /**
   * DeepSeek's Anthropic endpoint. Its published compatibility table:
   * `cache_control` is "Ignored" on every block kind (→ prompt_cache);
   * no count_tokens endpoint exists (→ count_tokens). `tool_choice`
   * (all four values), image `source.type:"url"` and `document`
   * blocks (`file`/`text` sources) are documented as supported, and
   * usage rides the stream's `message_delta`, so the other gaps are
   * not declared.
   */
  "deepseek-anthropic": {
    type: "anthropic",
    base_url: "https://api.deepseek.com/anthropic",
    api_key_env: "DEEPSEEK_API_KEY",
    gaps: ["count_tokens", "prompt_cache"],
    docs: "https://api-docs.deepseek.com/guides/anthropic_api",
    verified: "2026-11-17",
  },
  /**
   * z.ai's GLM Coding Plan Anthropic endpoint. The docs describe the
   * coding endpoint for Claude Code-style clients — tools (and so
   * `tool_choice`) work — but publish no field-level compatibility
   * table and no count_tokens endpoint, so the four unproven gaps are
   * declared. Usage rides the stream's message_* events.
   */
  "glm-anthropic": {
    type: "anthropic",
    base_url: "https://api.z.ai/api/anthropic",
    api_key_env: "ZAI_API_KEY",
    gaps: ["count_tokens", "prompt_cache", "url_images", "documents"],
    docs: "https://docs.z.ai/devpack/tool/others",
    verified: "2026-11-17",
  },
  /**
   * Moonshot Kimi's Anthropic endpoint. Its Messages schema: image
   * `source.type:"url"` accepts only `ms://<file_id>` file references
   * (not http(s) URLs → url_images); `cache_control` markers inside
   * `messages` are ignored (→ prompt_cache); no `document` block type
   * and no count_tokens endpoint appear in the schema (→ documents,
   * count_tokens). `tool_choice` and streaming are documented.
   */
  "kimi-anthropic": {
    type: "anthropic",
    base_url: "https://api.moonshot.ai/anthropic",
    api_key_env: "MOONSHOT_API_KEY",
    gaps: ["count_tokens", "prompt_cache", "url_images", "documents"],
    docs: "https://platform.kimi.ai/docs/api/messages",
    verified: "2026-11-17",
  },
};
