/**
 * The passive circuit breaker (v1.6 spec §3.5). Per provider, count
 * consecutive fallback-eligible failures — attempt-targets decides
 * eligibility (`isFallbackEligible`) and calls `recordFailure`; this
 * is only the state machine. After `failures` (default 3) the
 * provider is *open* for a cool-down (default 30 s) that doubles per
 * re-open up to `max_cooldown_ms` (default 5 min); one success closes
 * it and forgets the streak. `circuit_breaker: false` on a provider
 * disables its breaker entirely.
 *
 * State lives in memory on the loaded config (`GatewayConfig.
 * breakers`) — no active probes: they would spend tokens.
 */

/** One provider's breaker tuning (spec §3.5 `circuit_breaker:`). */
export interface BreakerConfig {
  /** Consecutive eligible failures that open the circuit. */
  failures: number;
  /** Cool-down of the first open, in ms; doubles per re-open. */
  cooldownMs: number;
  /** Ceiling for the doubling cool-down, in ms. */
  maxCooldownMs: number;
}

/** The spec §3.5 defaults: 3 failures, 30 s doubling to 5 min. */
export const BREAKER_DEFAULTS: BreakerConfig = {
  failures: 3,
  cooldownMs: 30_000,
  maxCooldownMs: 300_000,
};

/** The `/ui/api/routing` and snapshot() view of one provider. */
export interface BreakerSnapshot {
  provider: string;
  state: "closed" | "open";
  /** Epoch ms the open ends; present only while open. */
  openUntil?: number;
  consecutiveFailures: number;
}

export interface Breakers {
  /** True while the provider's open cool-down has not expired. */
  isOpen(provider: string): boolean;
  /**
   * One fallback-eligible failure (attempt-targets decides). At the
   * threshold the circuit opens; an open or expired-open failure
   * re-opens with the next doubled cool-down.
   */
  recordFailure(provider: string): void;
  /** One success: closes the circuit and resets streak and cool-down. */
  recordSuccess(provider: string): void;
  /** Point-in-time state of every provider seen so far. */
  snapshot(): BreakerSnapshot[];
}

interface BreakerState {
  consecutiveFailures: number;
  /** Epoch ms the current open ends; absent while closed. */
  openUntil?: number;
  /** The cool-down the next open will use (doubles per re-open). */
  cooldownMs: number;
}

/**
 * `cfg` keys on provider name: a `BreakerConfig` overrides the
 * defaults, `false` disables the breaker for that provider, and a
 * provider with no entry gets BREAKER_DEFAULTS. `now` is injectable
 * for tests.
 */
export function createBreakers(
  cfg: Record<string, BreakerConfig | false>,
  now: () => number = Date.now,
): Breakers {
  const states = new Map<string, BreakerState>();

  const configFor = (provider: string): BreakerConfig | false =>
    cfg[provider] ?? BREAKER_DEFAULTS;

  const stateFor = (provider: string, conf: BreakerConfig): BreakerState => {
    let s = states.get(provider);
    if (s === undefined) {
      s = { consecutiveFailures: 0, cooldownMs: conf.cooldownMs };
      states.set(provider, s);
    }
    return s;
  };

  return {
    isOpen(provider) {
      if (cfg[provider] === false) return false;
      const s = states.get(provider);
      // An expired open is half-open: the next attempt decides, so
      // the breaker reports closed and lets traffic through.
      return s?.openUntil !== undefined && now() < s.openUntil;
    },

    recordFailure(provider) {
      const conf = configFor(provider);
      if (conf === false) return;
      const s = stateFor(provider, conf);
      s.consecutiveFailures += 1;
      if (s.consecutiveFailures >= conf.failures) {
        // First open uses the base cool-down; every re-open (expired
        // or still open — the all-open plan keeps trying the first
        // target) doubles it to the cap.
        s.openUntil = now() + s.cooldownMs;
        s.cooldownMs = Math.min(s.cooldownMs * 2, conf.maxCooldownMs);
      }
    },

    recordSuccess(provider) {
      const conf = configFor(provider);
      states.set(provider, {
        consecutiveFailures: 0,
        cooldownMs: (conf === false ? BREAKER_DEFAULTS : conf).cooldownMs,
      });
    },

    snapshot() {
      const t = now();
      return [...states.entries()].map(([provider, s]) => {
        const open = s.openUntil !== undefined && t < s.openUntil;
        return {
          provider,
          state: open ? ("open" as const) : ("closed" as const),
          ...(open ? { openUntil: s.openUntil } : {}),
          consecutiveFailures: s.consecutiveFailures,
        };
      });
    },
  };
}
