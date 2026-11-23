import { z } from "zod";

/**
 * Provider presets and the gap vocabulary (v1.5 spec §3.3, widened by
 * v1.6 spec §3.3).
 *
 * A provider entry may declare `gaps:` from a fixed vocabulary — each
 * gap names one thing the upstream's same-format endpoint
 * (Anthropic- or OpenAI-compatible) does not do, and each has
 * exactly one fix (§3.3's table), applied by the source format's
 * `patchGaps`/`applyGapFixes` before the pass-through forward (or to
 * the reply), or by the target adapter's encode on the canonical
 * path (`json_schema`, v1.6 Task 8b). The vocabulary is per gap,
 * never per provider pair.
 *
 * `PROVIDER_PRESETS` names endpoints that fill `type`, `base_url`,
 * `api_key_env` and `gaps`. `tier` splits them: "shim" presets are
 * the five v1.5 Anthropic-endpoint shims — only those imply
 * `passthrough: true` in yaml-config (v1.6 spec §3.3). "free" and
 * "cheap" presets are ordinary providers reachable through the
 * canonical path; they never imply pass-through. Explicit provider
 * keys override preset values. Every preset's values are verified
 * against the provider's own documentation (`docs`, `verified`) per
 * the wire-format evidence rule, and the whole table is checked
 * against `providerPresetSchema` at load.
 */

export const GAPS = [
  "tool_choice",
  "count_tokens",
  "prompt_cache",
  "url_images",
  "documents",
  "stream_usage",
  "json_schema",
] as const;

export type Gap = (typeof GAPS)[number];

export const PRESET_TIERS = ["free", "cheap", "shim"] as const;

export type PresetTier = (typeof PRESET_TIERS)[number];

export const PRESET_NAMES = [
  "ollama-anthropic",
  "lmstudio-anthropic",
  "deepseek-anthropic",
  "glm-anthropic",
  "kimi-anthropic",
  "openrouter-free",
  "gemini-free",
  "groq",
  "nvidia-nim",
  "cerebras",
  "deepseek",
] as const;

export type PresetName = (typeof PRESET_NAMES)[number];

export interface ProviderPreset {
  type: "anthropic" | "openai" | "gemini";
  /** "shim" presets imply passthrough; "free"/"cheap" never do (§3.3). */
  tier: PresetTier;
  base_url: string;
  api_key_env?: string;
  /** Where a user gets a key — printed when the key env is missing. */
  signup_url?: string;
  gaps: Gap[];
  /** Model per client preset proven on the edit task (Task 8 fills). */
  suggested?: {
    "claude-code"?: string;
    codex?: string;
    "openai-apps"?: string;
  };
  /** Provider cap below the client's default (§3.3, E11). */
  max_output_tokens?: number;
  /** Provider documentation the values were verified against. */
  docs: string;
  /** Date of that verification (YYYY-MM-DD). */
  verified: string;
}

/**
 * Runtime shape of one preset — the wire-format evidence rule makes
 * `docs` and `verified` required, and `verified` must be a date.
 * `PROVIDER_PRESETS` is parsed with this at module load, so a preset
 * that drops its evidence fails at startup, not at request time.
 */
export const providerPresetSchema: z.ZodType<ProviderPreset> =
  z.strictObject({
    type: z.enum(["anthropic", "openai", "gemini"]),
    tier: z.enum(PRESET_TIERS),
    base_url: z.string().min(1),
    api_key_env: z.string().min(1).optional(),
    signup_url: z.string().min(1).optional(),
    gaps: z.array(z.enum(GAPS)),
    suggested: z
      .strictObject({
        "claude-code": z.string().min(1).optional(),
        codex: z.string().min(1).optional(),
        "openai-apps": z.string().min(1).optional(),
      })
      .optional(),
    max_output_tokens: z.number().int().positive().optional(),
    docs: z.string().min(1),
    verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });

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
    tier: "shim",
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
   * stay declared. `tool_choice` is proven
   * (`scripts/gates/tool-check-shim.sh`, qwen3-vl-8b, 2026-11-18): the
   * control called the tool while `any` and a named `get_time` got
   * plain text — forced/named are ignored — but `{type:"none"}`
   * suppressed the call, so `none` IS honoured and the fix keeps it
   * in the body. `cache_control`
   * (system block and top-level) was accepted — whether LM Studio
   * actually caches is unproven — and a `source.type:"url"` image was
   * fetched and answered by the vision model, so neither is declared;
   * streamed usage rides the message_* events.
   */
  "lmstudio-anthropic": {
    type: "anthropic",
    tier: "shim",
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
    tier: "shim",
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
   * and is refused in the client's dialect; `tool_choice` is proven
   * ignored (`scripts/gates/tool-check-shim.sh`, GLM-4.5-Flash,
   * 2026-11-18): the control called the tool while `any` and a named
   * `get_time` got `stop_reason:end_turn` text, and `{type:"none"}`
   * still got the `tool_use` — `none` is ignored too. `cache_control`
   * was accepted (whether z.ai actually
   * caches is unproven) and streamed usage rides the message_*
   * events, so neither is declared. `url_images` stays declared:
   * accepted (200) but unproven — a text-only model guessed the image
   * and the vision model never answered.
   */
  "glm-anthropic": {
    type: "anthropic",
    tier: "shim",
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
    tier: "shim",
    base_url: "https://api.moonshot.ai/anthropic",
    api_key_env: "MOONSHOT_API_KEY",
    gaps: ["count_tokens", "prompt_cache", "url_images", "documents"],
    docs: "https://platform.kimi.ai/docs/api/messages",
    verified: "2026-11-17",
  },
  /**
   * OpenRouter's OpenAI-compatible endpoint — its free tier is the
   * `:free` model variants (per https://openrouter.ai/docs/faq:
   * 50 requests/day, or 1000/day with >=10 purchased credits).
   * Verified 2026-11-22 against https://openrouter.ai/docs/quickstart
   * (`POST https://openrouter.ai/api/v1/chat/completions`,
   * `Authorization: Bearer $OPENROUTER_API_KEY`): babelgate appends
   * /v1/chat/completions itself, so base_url drops the /v1 — the
   * same convention docs/recipes/openai-compatible-providers.md
   * live-tests in the release gate and tests/live/live.helpers.ts
   * documents.
   */
  "openrouter-free": {
    type: "openai",
    tier: "free",
    base_url: "https://openrouter.ai/api",
    api_key_env: "OPENROUTER_API_KEY",
    signup_url: "https://openrouter.ai/keys",
    gaps: [],
    // Proven on the edit task through `--provider openrouter-free`,
    // 2026-11-23 (conductor live run, v1.6 Task 8 Step 4).
    suggested: {
      "claude-code": "nvidia/nemotron-3-ultra-550b-a55b:free",
      codex: "nvidia/nemotron-3-ultra-550b-a55b:free",
    },
    docs: "https://openrouter.ai/docs/quickstart",
    verified: "2026-11-22",
  },
  /**
   * Gemini API free tier through the native adapter. Verified
   * 2026-11-22 against https://ai.google.dev/gemini-api/docs/
   * quickstart (REST: `https://generativelanguage.googleapis.com/
   * v1beta/...` with `x-goog-api-key: $GEMINI_API_KEY`) and the Free
   * usage tier on https://ai.google.dev/gemini-api/docs/rate-limits.
   */
  "gemini-free": {
    type: "gemini",
    tier: "free",
    base_url: "https://generativelanguage.googleapis.com",
    api_key_env: "GEMINI_API_KEY",
    signup_url: "https://aistudio.google.com/apikey",
    gaps: [],
    // Proven on the edit task through `--provider gemini-free`,
    // 2026-11-22 (conductor live run, v1.6 Task 8 Step 4).
    suggested: {
      "claude-code": "gemini-3.8-flash",
      codex: "gemini-3.8-flash",
    },
    docs: "https://ai.google.dev/gemini-api/docs/rate-limits",
    verified: "2026-11-22",
  },
  /**
   * GroqCloud's OpenAI-compatible endpoint, free tier per its rate
   * limits page. Verified 2026-11-22 against
   * https://console.groq.com/docs/openai (OpenAI SDK base_url
   * `https://api.groq.com/openai/v1`, `GROQ_API_KEY`) — babelgate
   * appends /v1/chat/completions, so base_url drops the /v1 — and
   * https://console.groq.com/docs/rate-limits for the free tier.
   */
  groq: {
    type: "openai",
    tier: "free",
    base_url: "https://api.groq.com/openai",
    api_key_env: "GROQ_API_KEY",
    signup_url: "https://console.groq.com/keys",
    gaps: [],
    docs: "https://console.groq.com/docs/openai",
    verified: "2026-11-22",
  },
  /**
   * NVIDIA NIM hosted API catalog. Verified 2026-11-22 against
   * https://docs.api.nvidia.com/nim/reference/llm-apis (URL
   * `https://integrate.api.nvidia.com`, `POST /v1/chat/completions`,
   * `Authorization: Bearer $NVIDIA_API_KEY`); build.nvidia.com's FAQ
   * documents the free prototyping tier (no credit card, ~40 RPM).
   */
  "nvidia-nim": {
    type: "openai",
    tier: "free",
    base_url: "https://integrate.api.nvidia.com",
    api_key_env: "NVIDIA_API_KEY",
    signup_url: "https://build.nvidia.com",
    gaps: [],
    // Proven on the edit task through `--provider nvidia-nim`,
    // 2026-11-23 (conductor live run, v1.6 Task 8 Step 4).
    suggested: {
      "claude-code": "nvidia/nemotron-3-ultra-550b-a55b",
      codex: "nvidia/nemotron-3-ultra-550b-a55b",
    },
    docs: "https://docs.api.nvidia.com/nim/reference/llm-apis",
    verified: "2026-11-22",
  },
  /**
   * Cerebras Inference free tier. Verified 2026-11-22 against
   * https://inference-docs.cerebras.ai/quickstart (`POST
   * https://api.cerebras.ai/v1/chat/completions`,
   * `CEREBRAS_API_KEY`, "Free accounts have lower per-minute
   * limits") — babelgate appends /v1/chat/completions, so base_url
   * drops the /v1.
   */
  cerebras: {
    type: "openai",
    tier: "free",
    base_url: "https://api.cerebras.ai",
    api_key_env: "CEREBRAS_API_KEY",
    signup_url: "https://cloud.cerebras.ai",
    gaps: [],
    // Proven on the edit task through `--provider cerebras`,
    // 2026-11-23 (conductor live run, v1.6 Task 8 Step 4).
    suggested: {
      "claude-code": "gpt-oss-120b",
      codex: "gpt-oss-120b",
    },
    // Cerebras free tier max output 32k per
    // https://inference-docs.cerebras.ai/models/openai-oss; the model
    // passed only with this cap.
    max_output_tokens: 32768,
    docs: "https://inference-docs.cerebras.ai/quickstart",
    verified: "2026-11-22",
  },
  /**
   * DeepSeek's OpenAI-compatible endpoint (paid, low cost — the
   * "cheap" tier; pricing at
   * https://api-docs.deepseek.com/quick_start/pricing). Verified
   * 2026-11-22 against
   * https://api-docs.deepseek.com/quick_start/quick_start (`base_url
   * (OpenAI) = https://api.deepseek.com`, `DEEPSEEK_API_KEY`); the
   * /v1 path is the documented OpenAI-compat alias, and
   * docs/recipes/openai-compatible-providers.md already ships this
   * base_url. Gap verified 2026-11-23 against
   * https://api-docs.deepseek.com/guides/json_mode: JSON Output
   * documents only `response_format {type:"json_object"}` and
   * requires the word "json" in the prompt; `json_schema` answers
   * 400 "This response_format type is unavailable now" (Task 8
   * live run), so `json_schema` is declared and the encoder sends
   * `json_object` plus a system line carrying the schema.
   */
  deepseek: {
    type: "openai",
    tier: "cheap",
    base_url: "https://api.deepseek.com",
    api_key_env: "DEEPSEEK_API_KEY",
    signup_url: "https://platform.deepseek.com/api_keys",
    gaps: ["json_schema"],
    // Proven on the edit task through `--provider deepseek`,
    // 2026-11-23 (conductor live run, v1.6 Task 8a Step 5).
    suggested: {
      "claude-code": "deepseek-flash",
      codex: "deepseek-flash",
    },
    docs: "https://api-docs.deepseek.com/quick_start/quick_start",
    verified: "2026-11-23",
  },
};

// A preset without its wire-format evidence fails here, at module
// load — never silently at request time.
for (const preset of Object.values(PROVIDER_PRESETS)) {
  providerPresetSchema.parse(preset);
}
