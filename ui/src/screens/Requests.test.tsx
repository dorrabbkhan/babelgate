/** @jsxImportSource preact */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "preact";
import { act } from "preact/test-utils";
import { Requests } from "./Requests";
import { listRequests, streamLive } from "../api";
import type { LiveHandlers, RequestRow } from "../api";

vi.mock("../api", () => ({
  listRequests: vi.fn(),
  streamLive: vi.fn(),
}));

const listMock = vi.mocked(listRequests);
const liveMock = vi.mocked(streamLive);

/** let pending fetch .then chains run before act flushes effects */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function makeRow(overrides: Partial<RequestRow>): RequestRow {
  return {
    id: "r1",
    startedAt: 1_730_000_000_000,
    client: "claude-code",
    userAgent: null,
    sourceApi: "anthropic",
    requestedModel: "claude-sonnet-4.5",
    routeReason: "default",
    provider: "openai",
    model: "gpt-4o",
    stream: false,
    status: "ok",
    httpStatus: 200,
    errorType: null,
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
    costUsd: 0.004,
    wouldCostUsd: null,
    costEstimated: false,
    priceSource: "bundled",
    ttfbMs: 120,
    totalMs: 640,
    finishReason: "stop",
    hops: [{ provider: "openai", model: "gpt-4o", outcome: "ok", ms: 640 }],
    notes: [],
    diagnostics: [
      { toolCallId: "call_1", name: "get_weather", code: "invalid_json" },
    ],
    repairs: [],
    ...overrides,
  };
}

describe("Requests screen", () => {
  let container: HTMLDivElement;
  let live: LiveHandlers;

  beforeEach(() => {
    vi.clearAllMocks();
    liveMock.mockImplementation((handlers: LiveHandlers) => {
      live = handlers;
      return { close: vi.fn() };
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("renders rows and live inserts", async () => {
    listMock.mockResolvedValue({ rows: [makeRow({})] });
    await act(async () => {
      render(<Requests />, container);
    });
    await act(async () => {
      await tick();
    });

    expect(container.textContent).toContain("claude-code");
    expect(container.textContent).toContain("claude-sonnet-4.5");
    expect(container.textContent).toContain("gpt-4o");
    // diagnostics badge + hop count columns
    expect(container.querySelector(".badge")).not.toBeNull();
    expect(container.textContent).toContain("1");

    // a finished event inserts a row without a refetch
    const row2 = makeRow({
      id: "r2",
      client: "openai-sdk",
      model: "gpt-4o-mini",
      diagnostics: [],
    });
    await act(async () => {
      live.onFinished?.(row2);
    });
    expect(container.textContent).toContain("gpt-4o-mini");
    expect(listMock).toHaveBeenCalledTimes(1);

    // a started event shows an in-flight row
    await act(async () => {
      live.onStarted?.({
        id: "r3",
        client: "gemini-cli",
        sourceApi: "gemini",
        requestedModel: "gemini-2.5-pro",
        startedAt: 1_730_000_001_000,
      });
    });
    expect(container.textContent).toContain("gemini-2.5-pro");
    expect(container.textContent).toContain("running");
    // finishing it replaces the pending row
    await act(async () => {
      live.onFinished?.(
        makeRow({ id: "r3", requestedModel: "gemini-2.5-pro", diagnostics: [] }),
      );
    });
    expect(container.textContent).not.toContain("running");
  });

  it("filters", async () => {
    listMock.mockResolvedValue({ rows: [] });
    await act(async () => {
      render(<Requests />, container);
    });
    listMock.mockClear();

    const clientInput = container.querySelector<HTMLInputElement>(
      'input[data-filter="client"]',
    );
    expect(clientInput).not.toBeNull();
    await act(async () => {
      clientInput!.value = "claude-code";
      clientInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(listMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ client: "claude-code" }),
      undefined,
    );

    const statusSelect = container.querySelector<HTMLSelectElement>(
      'select[data-filter="status"]',
    );
    expect(statusSelect).not.toBeNull();
    await act(async () => {
      statusSelect!.value = "error";
      statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(listMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ client: "claude-code", status: "error" }),
      undefined,
    );
  });

  it("live rows that don't match the filters are not inserted", async () => {
    listMock.mockResolvedValue({ rows: [] });
    await act(async () => {
      render(<Requests />, container);
    });
    await act(async () => {
      await tick();
    });

    const statusSelect = container.querySelector<HTMLSelectElement>(
      'select[data-filter="status"]',
    );
    await act(async () => {
      statusSelect!.value = "error";
      statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // a finished row with the wrong status is not inserted
    await act(async () => {
      live.onFinished?.(
        makeRow({ id: "ok1", client: "filtered-out", status: "ok" }),
      );
    });
    expect(container.textContent).not.toContain("filtered-out");

    // a pending started row is hidden while a status filter is set
    await act(async () => {
      live.onStarted?.({
        id: "p1",
        client: "pending-hidden",
        sourceApi: "openai",
        requestedModel: "gpt-4o",
        startedAt: 1_730_000_002_000,
      });
    });
    expect(container.textContent).not.toContain("pending-hidden");

    // a finished row matching the status filter is inserted
    await act(async () => {
      live.onFinished?.(
        makeRow({ id: "err1", client: "kept", status: "error" }),
      );
    });
    expect(container.textContent).toContain("kept");
  });
});
