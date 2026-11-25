import { Router } from "express";
import { getConfig } from "../config/env-config";
import { PROVIDER_PRESETS } from "../config/provider-presets";
import { lookupPrice, type Price } from "../cost/price-table";
import { planRoute, type RouteTarget } from "../routing/plan-route";
import { uiError } from "./access";

/**
 * `GET /ui/api/routing` (spec §3.9): the routing table as JSON —
 * providers (name, type, base URL, flags, caps; keys and key env names
 * never), aliases, ordered rules with their fallbacks, the default
 * provider, and price + source per configured model (every alias
 * target, every rule target and fallback, deduped).
 *
 * `GET /ui/api/routing/plan?model=` is a planRoute dry run — the
 * answer to "where would this model go?" with no upstream call. A dry
 * run has no body, so `estimatedInputTokens` is 0: a rule with a
 * `when.min_input_tokens` condition never matches here, which the
 * routing screen reads as "not at this size".
 */
export function routingRouter(): Router {
  const router = Router();

  router.get("/routing", async (_req, res, next) => {
    try {
      const config = getConfig();
      const providers = config.registry.names().map((name) => {
        const entry = config.registry.get(name);
        return {
          name: entry.name,
          type: entry.type,
          baseUrl: entry.baseUrl,
          ...(entry.maxOutputTokens !== undefined
            ? { maxOutputTokens: entry.maxOutputTokens }
            : {}),
          cacheHints: entry.cacheHints ?? false,
          livePrices: entry.livePrices ?? false,
          repairToolCalls: entry.repairToolCalls ?? false,
          local: entry.local ?? false,
        };
      });

      const targets = new Map<string, RouteTarget>();
      const add = (t: RouteTarget): void => {
        targets.set(`${t.provider}/${t.model}`, t);
      };
      for (const target of Object.values(config.routing.aliases)) {
        add(target);
      }
      for (const rule of config.routing.rules) {
        add(rule.to);
        for (const target of rule.fallback) add(target);
      }

      const prices: {
        target: string;
        price?: Price;
        source?: string;
        freeTier?: { preset: string; docs: string; verified: string };
      }[] = [];
      for (const [label, target] of targets) {
        const entry = config.registry.get(target.provider);
        // §3.3 cost honesty: a route whose provider's preset has
        // `tier: "free"` carries the free-tier label instead of a
        // price — the label comes from the preset, so no lookup runs.
        const presetName = entry.preset;
        if (presetName !== undefined) {
          const preset = PROVIDER_PRESETS[presetName];
          if (preset.tier === "free") {
            prices.push({
              target: label,
              freeTier: {
                preset: presetName,
                docs: preset.docs,
                verified: preset.verified,
              },
            });
            continue;
          }
        }
        const hit = await lookupPrice(entry, target.model, config);
        prices.push({
          target: label,
          ...(hit !== undefined
            ? { price: hit.price, source: hit.source }
            : {}),
        });
      }

      res.json({
        providers,
        aliases: config.routing.aliases,
        rules: config.routing.rules,
        defaultProvider: config.routing.defaultProvider,
        prices,
        // v1.6 spec §3.5: live breaker state per provider.
        breakers: config.breakers?.snapshot() ?? [],
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/routing/plan", (req, res) => {
    const model = req.query.model;
    if (typeof model !== "string" || model === "") {
      return uiError(
        res,
        400,
        "VALIDATION_ERROR",
        "model is required",
      );
    }
    const config = getConfig();
    res.json(
      planRoute({
        requestedModel: model,
        estimatedInputTokens: 0,
        routing: config.routing,
        providerNames: new Set(config.registry.names()),
      }),
    );
  });

  return router;
}
