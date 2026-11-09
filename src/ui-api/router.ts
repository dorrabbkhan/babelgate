import { Router } from "express";
import { getConfig } from "../config/env-config";
import { uiAccess } from "./access";
import { liveRouter } from "./live";
import { playgroundRouter } from "./playground";
import { requestsRouter } from "./requests";
import { routingRouter } from "./routing";
import { usageRouter } from "./usage";

/**
 * The `/ui/api` router (spec §3.9): access control first — the env is
 * read per request so a config reload (tests, resetConfig) takes
 * effect without rebuilding the router — then the JSON routes. The
 */
export function uiApiRouter(): Router {
  const router = Router();
  router.use((req, res, next) => uiAccess(getConfig())(req, res, next));
  router.use(requestsRouter());
  router.use(liveRouter());
  router.use(usageRouter());
  router.use(routingRouter());
  router.use(playgroundRouter());
  return router;
}
