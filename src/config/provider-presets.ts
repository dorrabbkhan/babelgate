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
   * LM Studio's Anthropic endpoint. Gaps measured by the follow-up
   * probe (`scripts/gates/probe-anthropic-shim.sh`, LM Studio headless
   * server, 2026-11-18, `ibm/granite-4-micro` and `qwen/qwen3-vl-8b`):
   * `POST /v1/messages/count_tokens` → HTTP 200 with a body error
   * ("Unexpected endpoint or method"), and a base64 `document` block →
   * 400 invalid_request_error ("Expected 'text' | 'image' |
   * 'tool_result'") on both models, so `count_tokens` and `documents`
   * stay declared. `tool_choice:{type:"any"}` → 200 but plain text on
   * both models — LM Studio appears to ignore it, so `tool_choice` is
   * declared (probable, not proven: see decisions.md). `cache_control`
   * (system block and top-level) was accepted — whether LM Studio
   * actually caches is unproven — and a `source.type:"url"` image was
   * fetched and answered by the vision model, so neither is declared;
   * streamed usage rides the message_* events.
   */
  "lmstudio-anthropic": {
    type: "anthropic",
    base_url: "http://localhost:1234",
    gaps: ["count_tokens", "documents", "tool_choice"],
    docs: "https://lmstudio.ai/docs/developer/anthropic-compat",
    verified: "2026-11-18",
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
   * z.ai's Anthropic Messages endpoint — the general endpoint for
   * standard (non-Coding-Plan) keys per the key-management page
   * (https://docs.z.ai/devpack/notice/api-key-management.md; pricing:
   * https://docs.z.ai/guides/overview/pricing.md). Gaps measured by
   * the probe (`scripts/gates/probe-anthropic-shim.sh` and
   * `scripts/gates/semantic-check-shim.sh`, standard free-tier key,
   * 2026-11-18, `GLM-4.5-Flash`/`GLM-4.7-Flash` text-only;
   * `GLM-4.6V-Flash` vision was saturated): `count_tokens` → 200
   * `{"input_tokens":0}` on all three models — answered without a
   * model call, so a client would trust a wrong number; a base64
   * `document` block → 200 but the endpoint turns the PDF into a
   * signed URL the model cannot open, so `documents` stays declared
   * and is refused in the client's dialect; `tool_choice:{type:"any"}`
   * → 200 with `stop_reason:end_turn` and no `tool_use` — declared,
   * probable. `cache_control` was accepted (whether z.ai actually
   * caches is unproven) and streamed usage rides the message_*
   * events, so neither is declared. `url_images` stays declared:
   * accepted (200) but unproven — a text-only model guessed the image
   * and the vision model never answered.
   */
  "glm-anthropic": {
    type: "anthropic",
    base_url: "https://api.z.ai/api/anthropic",
    api_key_env: "ZAI_API_KEY",
    gaps: ["count_tokens", "documents", "tool_choice", "url_images"],
    docs: "https://docs.z.ai/devpack/tool/others",
    verified: "2026-11-18",
  },
  /**
   * Moonshot Kimi's Anthropic endpoint. Its Messages schema: image
   * `source.type:"url"` accepts only `ms://<file_id>` file references
   * (not http(s) URLs → url_images); `cache_control` markers inside
   * `messages` are ignored while the request-level top-level
   * `cache_control` field is honoured — the prompt_cache fix strips
   * the in-`messages`/`system`/`tools` markers and keeps the
   * top-level one (→ prompt_cache); no `document` block type and no
   * count_tokens endpoint appear in the schema (→ documents,
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
