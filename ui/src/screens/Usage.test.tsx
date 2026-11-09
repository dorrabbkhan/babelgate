/** @jsxImportSource preact */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "preact";
import { act } from "preact/test-utils";
import { Usage } from "./Usage";
import { getUsage } from "../api";
import type { UsageGroup } from "../api";

vi.mock("../api", () => ({
  getUsage: vi.fn(),
}));

const usageMock = vi.mocked(getUsage);

/** let pending fetch .then chains run before act flushes effects */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function group(overrides: Partial<UsageGroup>): UsageGroup {
  return {
    key: "2026-11-08",
    requests: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    wouldCostUsd: 0,
    unpriced: 0,
    errors: 0,
    fallbacks: 0,
    cacheHitRatio: null,
    ...overrides,
  };
}

function mockUsage(groups: Record<string, UsageGroup[]>): void {
  usageMock.mockImplementation(
    async ({ group: g }) => ({ groups: groups[g ?? "day"] ?? [] }),
  );
}

describe("Usage screen", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("renders the totals and the group table", async () => {
    mockUsage({
      day: [
        group({
          key: "2026-11-08",
          requests: 2,
          inputTokens: 2000,
          cacheReadTokens: 500,
          costUsd: 0.02,
        }),
        group({
          key: "2026-11-09",
          inputTokens: 1000,
          cacheReadTokens: 250,
          costUsd: 0.03,
        }),
      ],
      model: [
        group({ key: "gpt-4o", requests: 3, costUsd: 0.05 }),
        group({ key: "qwen3-coder:30b", requests: 0 }),
      ],
    });
    await act(async () => {
      render(<Usage />, container);
    });
    await act(async () => {
      await tick();
    });

    expect(usageMock).toHaveBeenCalledWith(
      expect.objectContaining({ group: "day" }),
    );
    expect(usageMock).toHaveBeenCalledWith(
      expect.objectContaining({ group: "model" }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("3 requests");
    expect(text).toContain("$0.0500"); // 0.02 + 0.03
    expect(text).toContain("cache hits 25%"); // 500 / 2000
    expect(text).toContain("gpt-4o");
    expect(text).toContain("qwen3-coder:30b");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("empty store shows an empty state, not NaN", async () => {
    mockUsage({ day: [], model: [] });
    await act(async () => {
      render(<Usage />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("no usage in this range");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("$");
  });

  it("unpriced requests are never summed as $0", async () => {
    mockUsage({
      day: [
        group({ requests: 3, costUsd: 0, unpriced: 2 }),
      ],
      model: [group({ key: "mystery", costUsd: 0, unpriced: 2 })],
    });
    await act(async () => {
      render(<Usage />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    // the unpriced count is surfaced, not folded into a $0 total
    expect(text).toContain("2 requests without a price");
  });

  it("saved only from local rows", async () => {
    mockUsage({
      day: [
        group({ costUsd: 3, wouldCostUsd: 0 }), // cloud spend
        group({ costUsd: 0, wouldCostUsd: 1.5 }), // local row
        group({ costUsd: 0, wouldCostUsd: 0.25 }), // local row
      ],
      client: [],
    });
    await act(async () => {
      render(<Usage />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("saved ≈ $1.7500");
    expect(text).toContain("$3.0000"); // cloud spend separate
  });

  it("group selector refetches with the dimension", async () => {
    mockUsage({ day: [group({})], model: [group({ key: "m1" })], client: [] });
    await act(async () => {
      render(<Usage />, container);
    });
    await act(async () => {
      await tick();
    });
    usageMock.mockClear();

    const select = container.querySelector<HTMLSelectElement>(
      'select[data-group]',
    );
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = "client";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
    });
    expect(usageMock).toHaveBeenCalledWith(
      expect.objectContaining({ group: "client" }),
    );
  });
});
