import type { GatewayConfig } from "../config/env-config";

/**
 * The startup routing table (spec §3.5): one line per provider, one per
 * alias, one per route in order, then the default. Key env var names
 * may be shown; key values never are.
 */
export function formatRoutingTable(config: GatewayConfig): string[] {
  const lines: string[] = [];

  for (const name of config.registry.names()) {
    const entry = config.registry.get(name);
    const key =
      entry.apiKeyEnv !== undefined ? `env ${entry.apiKeyEnv}` : "none";
    lines.push(
      `provider ${name} (type ${entry.type}, ${entry.baseUrl}, key ${key})`,
    );
  }

  for (const [name, target] of Object.entries(config.routing.aliases)) {
    lines.push(`alias ${name} -> ${target.provider}/${target.model}`);
  }

  for (const [index, rule] of config.routing.rules.entries()) {
    const when =
      rule.when?.minInputTokens !== undefined
        ? ` when min_input_tokens>=${rule.when.minInputTokens}`
        : "";
    const fallback =
      rule.fallback.length > 0
        ? ` fallback ${rule.fallback
            .map((target) => `${target.provider}/${target.model}`)
            .join(", ")}`
        : "";
    lines.push(
      `route ${index} ${rule.match}${when} -> ${rule.to.provider}/${rule.to.model}${fallback}`,
    );
  }

  lines.push(`default -> ${config.routing.defaultProvider}`);
  return lines;
}
