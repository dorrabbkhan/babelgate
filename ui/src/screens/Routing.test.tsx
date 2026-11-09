/** @jsxImportSource preact */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "preact";
import { act } from "preact/test-utils";
import { Routing } from "./Routing";
import { getRouting, planRoute } from "../api";
import type { RoutingInfo } from "../api";

vi.mock("../api", () => ({
  getRouting: vi.fn(),
  planRoute: vi.fn(),
}));

const routingMock = vi.mocked(getRouting);
const planMock = vi.mocked(planRoute);

/** let pending fetch .then chains run before act flushes effects */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const INFO: RoutingInfo = {
  providers: [
    {
      name: "local",
      type: "ollama",
      baseUrl: "http://localhost:11434",
      cacheHints: false,
      livePrices: false,
      repairToolCalls: false,
      local: true,
    },
    {
      name: "or",
      type: "openai",
      baseUrl: "https://openrouter.ai/api",
      maxOutputTokens: 8000,
      cacheHints: true,
      livePrices: true,
      repairToolCalls: false,
      local: false,
    },
  ],
  aliases: { fast: { provider: "local", model: "qwen3-coder:30b" } },
  rules: [
    {
      match: "claude-*",
      to: { provider: "or", model: "anthropic/claude-sonnet-4.5" },
      fallback: [{ provider: "local", model: "qwen3-coder:30b" }],
    },
  ],
  defaultProvider: "or",
  prices: [
    {
      target: "or/anthropic/claude-sonnet-4.5",
      price: { input: 3, output: 15, cacheRead: 0.3 },
      source: "bundled",
    },
    {
      target: "local/qwen3-coder:30b",
      price: { input: 0, output: 0 },
      source: "local",
    },
    { target: "or/unknown-model" },
  ],
};

describe("Routing screen", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    routingMock.mockResolvedValue(INFO);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("renders providers, aliases, rules and prices", async () => {
    await act(async () => {
      render(<Routing />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    // providers: name, type, base url, cap and flags
    expect(text).toContain("local");
    expect(text).toContain("ollama");
    expect(text).toContain("http://localhost:11434");
    expect(text).toContain("8000");
    expect(text).toContain("cache_hints");
    expect(text).toContain("live_prices");
    // aliases and rules
    expect(text).toContain("fast");
    expect(text).toContain("local/qwen3-coder:30b");
    expect(text).toContain("claude-*");
    expect(text).toContain("or/anthropic/claude-sonnet-4.5");
    // default provider and prices
    expect(text).toContain("default");
    expect(text).toContain("$3/$15");
    expect(text).toContain("bundled");
    expect(text).toContain("or/unknown-model");
  });

  it("prices rows carry a typed Price and PriceSource", () => {
    // compile-time contract (tsc -p ui): `price` is `Price`, not
    // `unknown` — the field accesses below only typecheck when it is
    const row: RoutingInfo["prices"][number] = {
      target: "or/anthropic/claude-sonnet-4.5",
      price: { input: 3, output: 15, cacheRead: 0.3 },
      source: "bundled",
    };
    expect(row.price?.input).toBe(3);
    expect(row.price?.cacheWrite).toBeUndefined();
    expect(row.source).toBe("bundled");
    const bad: RoutingInfo["prices"][number] = {
      target: "x",
      // @ts-expect-error — a malformed price must not typecheck
      price: { bogus: 1 },
    };
    expect(bad.target).toBe("x");
  });

  it("plan box shows targets and reason", async () => {
    planMock.mockResolvedValue({
      targets: [
        { provider: "or", model: "anthropic/claude-sonnet-4.5" },
        { provider: "local", model: "qwen3-coder:30b" },
      ],
      reason: "rule:0",
    });
    await act(async () => {
      render(<Routing />, container);
    });
    await act(async () => {
      await tick();
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[data-plan-model]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      input!.value = "claude-foo";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = container.querySelector("button[data-plan-go]");
    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
    });

    expect(planMock).toHaveBeenCalledWith("claude-foo");
    const text = container.textContent ?? "";
    expect(text).toContain("or/anthropic/claude-sonnet-4.5");
    expect(text).toContain("local/qwen3-coder:30b");
    expect(text).toContain("rule:0");
  });
});
