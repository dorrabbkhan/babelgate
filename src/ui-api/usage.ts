import { Router } from "express";
import { getUsageStore } from "../observe/sinks/usage-store";
import type { UsageGroup } from "../observe/sinks/usage-queries";
import { uiError } from "./access";

/**
 * `GET /ui/api/usage` (spec §3.9): tokens, cost, would-have-cost,
 * cache-hit ratio, error and fallback counts per group —
 * `?from&to` are epoch-ms bounds (default: all time) and
 * `?group=day|model|provider|client` (default: day). `inputTokens`
 * include cached tokens (§3.6 bills input − cacheRead − cacheWrite at
 * the input price), so the cache-hit ratio is cacheRead / input; it is
 * null when a group saw no input. A disabled store answers empty.
 */

const GROUPS = new Set(["day", "model", "provider", "client"]);

function numParam(
  value: unknown,
  fallback: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function usageRouter(): Router {
  const router = Router();

  router.get("/usage", (req, res) => {
    const group =
      typeof req.query.group === "string" ? req.query.group : "day";
    if (!GROUPS.has(group)) {
      return uiError(
        res,
        400,
        "VALIDATION_ERROR",
        "group must be one of day, model, provider, client",
      );
    }
    const from = numParam(req.query.from, 0);
    const to = numParam(req.query.to, Date.now());
    if (from === undefined || to === undefined) {
      return uiError(
        res,
        400,
        "VALIDATION_ERROR",
        "from and to must be epoch milliseconds",
      );
    }

    const store = getUsageStore();
    const groups: (UsageGroup & { cacheHitRatio: number | null })[] = (
      store?.usage({
        from,
        to,
        group: group as "day" | "model" | "provider" | "client",
      }) ?? []
    ).map((g) => ({
      ...g,
      cacheHitRatio:
        g.inputTokens > 0 ? g.cacheReadTokens / g.inputTokens : null,
    }));
    res.json({ groups });
  });

  return router;
}
