import { logger } from "../utils/logger";
import { reportSinkError } from "./emit";

/**
 * Retention (spec §3.4): rows whose `started_at` is older than
 * `USAGE_RETENTION_DAYS` are deleted; their `bodies` rows go with them
 * via the foreign-key cascade. One pass runs at start, then hourly by
 * default — the timer is unref'd so it never keeps the process alive.
 * A failing prune (a locked db, say) warns once a minute and retries
 * on the next tick — it never throws: the start call runs inside
 * startServer and a tick runs inside the interval, where a throw
 * would kill the process.
 */

/** Retention failures warn at most once a minute — same as flush. */
const WARN_THROTTLE_MS = 60_000;

export function startRetention(
  store: { pruneBefore(cutoffMs: number): void },
  days: number,
  everyMs = 3_600_000,
): () => void {
  let lastWarn = -Infinity;
  const prune = () => {
    try {
      store.pruneBefore(Date.now() - days * 86_400_000);
    } catch (err) {
      // §3.8: a failed prune counts as a usage-store sink failure.
      reportSinkError("usage-store");
      const t = Date.now();
      if (t - lastWarn >= WARN_THROTTLE_MS) {
        lastWarn = t;
        logger.warn(
          { err },
          "Usage store retention failed — will retry next run",
        );
      }
    }
  };
  prune();
  const timer = setInterval(prune, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
