import type { ProviderPreset } from "./config/provider-presets";

const CLIENT_PRESETS = ["claude-code", "codex", "openai-apps"] as const;

/**
 * `babelgate presets` (v1.6 spec §3.3): one row per provider preset —
 * name, tier, key env var, suggested client models, then the docs URL
 * with its verification date. Key env *names* only, never values.
 */
export function formatPresetList(
  presets: Readonly<Record<string, ProviderPreset>>,
): string[] {
  return Object.entries(presets).map(([name, preset]) => {
    const key =
      preset.api_key_env !== undefined
        ? `key env ${preset.api_key_env}`
        : "keyless";
    const suggested = CLIENT_PRESETS.map(
      (client) => preset.suggested?.[client],
    ).filter((model): model is string => model !== undefined);
    const models =
      suggested.length === 0 ? "-" : suggested.join(", ");
    return (
      `${name} (tier ${preset.tier}, ${key}, suggested ${models})` +
      ` — ${preset.docs} (verified ${preset.verified})`
    );
  });
}
