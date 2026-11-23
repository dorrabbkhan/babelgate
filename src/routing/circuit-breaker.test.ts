import { describe, it, expect } from "vitest";
import { createBreakers, type BreakerConfig } from "./circuit-breaker";

/**
 * The passive circuit breaker (v1.6 spec §3.5): consecutive
 * fallback-eligible failures per provider open the circuit for a
 * cool-down that doubles per re-open to a cap; a success closes and
 * resets it. `recordFailure` is only ever called for eligible errors
 * (attempt-targets decides eligibility) — the counter itself is just
 * a state machine. `now` is injected so the tests never sleep.
 */
describe("createBreakers (spec §3.5)", () => {
  const cfg = (over: Partial<BreakerConfig> = {}): BreakerConfig => ({
    failures: 3,
    cooldownMs: 1_000,
    maxCooldownMs: 4_000,
    ...over,
  });

  it("opens after 3 eligible failures", () => {
    let t = 0;
    const breakers = createBreakers({ p: cfg() }, () => t);

    breakers.recordFailure("p");
    breakers.recordFailure("p");
    expect(breakers.isOpen("p")).toBe(false);
    breakers.recordFailure("p");
    expect(breakers.isOpen("p")).toBe(true);
    expect(breakers.snapshot()).toEqual([
      {
        provider: "p",
        state: "open",
        openUntil: 1_000,
        consecutiveFailures: 3,
      },
    ]);

    // The open expires with the cool-down — the next attempt decides.
    t = 1_000;
    expect(breakers.isOpen("p")).toBe(false);
  });

  it("cooldown doubles to cap", () => {
    let t = 0;
    const breakers = createBreakers(
      { p: cfg({ failures: 1 }) },
      () => t,
    );

    breakers.recordFailure("p"); // opens with the base 1s
    expect(breakers.snapshot()[0]!.openUntil).toBe(1_000);

    t = 1_001; // expired — this failure re-opens at 2s
    breakers.recordFailure("p");
    expect(breakers.snapshot()[0]!.openUntil).toBe(3_001);

    t = 3_002; // re-opens at 4s — the cap
    breakers.recordFailure("p");
    expect(breakers.snapshot()[0]!.openUntil).toBe(7_002);

    t = 7_003; // still the cap, never 8s
    breakers.recordFailure("p");
    expect(breakers.snapshot()[0]!.openUntil).toBe(11_003);
  });

  it("success closes", () => {
    let t = 0;
    const breakers = createBreakers({ p: cfg() }, () => t);

    breakers.recordFailure("p");
    breakers.recordFailure("p");
    breakers.recordFailure("p");
    expect(breakers.isOpen("p")).toBe(true);

    breakers.recordSuccess("p");
    expect(breakers.isOpen("p")).toBe(false);
    expect(breakers.snapshot()[0]).toMatchObject({
      provider: "p",
      state: "closed",
      consecutiveFailures: 0,
    });

    // The reset is real: the next open needs the full 3 failures and
    // starts the cool-down back at the base, not the doubled value.
    breakers.recordFailure("p");
    breakers.recordFailure("p");
    expect(breakers.isOpen("p")).toBe(false);
    breakers.recordFailure("p");
    expect(breakers.snapshot()[0]!.openUntil).toBe(1_000);
  });

  it("circuit_breaker:false never opens", () => {
    const breakers = createBreakers({ p: false });
    for (let i = 0; i < 10; i++) breakers.recordFailure("p");
    expect(breakers.isOpen("p")).toBe(false);
    expect(breakers.snapshot()).toEqual([]);
  });

  it("a provider without an entry gets the defaults", () => {
    let t = 0;
    const breakers = createBreakers({}, () => t);

    breakers.recordFailure("q");
    breakers.recordFailure("q");
    expect(breakers.isOpen("q")).toBe(false);
    breakers.recordFailure("q");
    // Default config: 3 failures, 30 s cool-down (spec §3.5).
    expect(breakers.isOpen("q")).toBe(true);
    expect(breakers.snapshot()[0]!.openUntil).toBe(30_000);
  });

  it("an expired open reports closed in the snapshot", () => {
    let t = 0;
    const breakers = createBreakers({ p: cfg({ failures: 1 }) }, () => t);
    breakers.recordFailure("p");
    t = 2_000;
    expect(breakers.isOpen("p")).toBe(false);
    expect(breakers.snapshot()[0]).toEqual({
      provider: "p",
      state: "closed",
      consecutiveFailures: 1,
    });
  });
});
