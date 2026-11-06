/**
 * Retention (spec §3.4): rows whose `started_at` is older than
 * `USAGE_RETENTION_DAYS` are deleted; their `bodies` rows go with them
 * via the foreign-key cascade. One pass runs at start, then hourly by
 * default — the timer is unref'd so it never keeps the process alive.
 */
export function startRetention(
  store: { pruneBefore(cutoffMs: number): void },
  days: number,
  everyMs = 3_600_000,
): () => void {
  const prune = () => {
    store.pruneBefore(Date.now() - days * 86_400_000);
  };
  prune();
  const timer = setInterval(prune, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
