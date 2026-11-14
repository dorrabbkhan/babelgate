import { describe, it, expect } from "vitest";
import {
  EFFORT_LADDER,
  budgetFor,
  nearestSupported,
} from "./reasoning-effort";

describe("reasoning effort helpers (v1.4 spec §3.3)", () => {
  it("exposes the canonical effort ladder", () => {
    expect(EFFORT_LADDER).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("xhigh on a high-max target becomes high", () => {
    expect(nearestSupported("xhigh", ["low", "medium", "high"])).toBe(
      "high",
    );
  });

  it("minimal on a low-min target becomes none", () => {
    expect(nearestSupported("minimal", ["low", "medium", "high"])).toBe(
      "none",
    );
  });

  it("keeps a supported level unchanged", () => {
    expect(
      nearestSupported("medium", ["minimal", "low", "medium", "high"]),
    ).toBe("medium");
  });

  it("none resolves to none even on thinking-capable targets", () => {
    expect(nearestSupported("none", ["low", "medium", "high"])).toBe(
      "none",
    );
  });

  it("budgetFor maps the starting-budget table", () => {
    expect(budgetFor("none")).toBe(0);
    expect(budgetFor("minimal")).toBe(1024);
    expect(budgetFor("low")).toBe(2048);
    expect(budgetFor("medium")).toBe(8192);
    expect(budgetFor("high")).toBe(24576);
    expect(budgetFor("xhigh")).toBe(32000);
  });
});
