import { describe, expect, it } from "vitest";
import { isSea } from "./sea";

describe("sea", () => {
  it("isSea false under node", () => {
    expect(isSea()).toBe(false);
  });
});
