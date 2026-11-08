import { afterEach, describe, expect, it, vi } from "vitest";

async function freshAuth() {
  vi.resetModules();
  return import("./auth");
}

describe("auth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    try {
      sessionStorage.clear();
    } catch {
      // storage may be mocked to throw — nothing to clean
    }
  });

  it("round-trips the key through sessionStorage", async () => {
    const { getKey, setKey } = await freshAuth();
    expect(getKey()).toBeNull();
    setKey("k-1");
    expect(sessionStorage.getItem("babelgate-key")).toBe("k-1");
    expect(getKey()).toBe("k-1");
    setKey(null);
    expect(getKey()).toBeNull();
  });

  it("storage throwing still works for the session", async () => {
    const denied = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(denied);

    const { getKey, setKey } = await freshAuth();
    setKey("k-session");
    expect(getKey()).toBe("k-session");
    setKey("k-2");
    expect(getKey()).toBe("k-2");
    setKey(null);
    expect(getKey()).toBeNull();
  });
});
