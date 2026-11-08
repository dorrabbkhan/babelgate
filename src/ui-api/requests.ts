import { Router } from "express";
import { getBodyRing } from "../observe/sinks/body-ring";
import { getUsageStore } from "../observe/sinks/usage-store";
import { ValidationError } from "../utils/errors";
import { uiError } from "./access";

/**
 * `GET /ui/api/requests` and `/requests/:id` (spec §3.9): rows from the
 * usage store, newest first, cursor-paged; the detail carries the row
 * plus bodies — ring first, then the `bodies` table (LOG_BODIES) — or
 * `bodies: null, reason: "not_retained"`. A disabled store answers
 * empty, never an error: the Requests screen still loads.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** One optional string query parameter. */
function strParam(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function requestsRouter(): Router {
  const router = Router();

  router.get("/requests", (req, res) => {
    const limitRaw = strParam(req.query.limit);
    let limit = DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return uiError(
          res,
          400,
          "VALIDATION_ERROR",
          "limit must be a positive integer",
        );
      }
      if (parsed > MAX_LIMIT) {
        return uiError(
          res,
          400,
          "VALIDATION_ERROR",
          "limit must be an integer from 1 to 500",
        );
      }
      limit = parsed;
    }

    const store = getUsageStore();
    if (store === undefined) {
      res.json({ rows: [] });
      return;
    }
    try {
      const { rows, nextCursor } = store.listRequests({
        ...(strParam(req.query.cursor) !== undefined
          ? { cursor: strParam(req.query.cursor) }
          : {}),
        limit,
        ...(strParam(req.query.client) !== undefined
          ? { client: strParam(req.query.client) }
          : {}),
        ...(strParam(req.query.model) !== undefined
          ? { model: strParam(req.query.model) }
          : {}),
        ...(strParam(req.query.provider) !== undefined
          ? { provider: strParam(req.query.provider) }
          : {}),
        ...(strParam(req.query.status) !== undefined
          ? { status: strParam(req.query.status) }
          : {}),
      });
      res.json({
        rows,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return uiError(
          res,
          400,
          "VALIDATION_ERROR",
          err.message,
        );
      }
      throw err;
    }
  });

  router.get("/requests/:id", (req, res) => {
    const found = getUsageStore()?.getRequest(req.params.id);
    if (found === undefined) {
      return uiError(res, 404, "NOT_FOUND", "request not found");
    }
    const { bodies: stored, ...row } = found;
    const bodies =
      getBodyRing()?.get(req.params.id) ?? stored ?? null;
    res.json({
      row,
      bodies,
      ...(bodies === null ? { reason: "not_retained" as const } : {}),
    });
  });

  return router;
}
