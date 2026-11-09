/** @jsxImportSource preact */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "preact";
import { act } from "preact/test-utils";
import { Inspector } from "./Inspector";
import { getRequest } from "../api";
import type { RequestDetail, RequestRow } from "../api";

/** let pending fetch .then chains run before act flushes effects */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

vi.mock("../api", () => ({
  getRequest: vi.fn(),
}));

const getMock = vi.mocked(getRequest);

function makeRow(overrides: Partial<RequestRow>): RequestRow {
  return {
    id: "r1",
    startedAt: 1_730_000_000_000,
    client: "claude-code",
    userAgent: null,
    sourceApi: "openai",
    requestedModel: "gpt-4o",
    routeReason: "default",
    provider: "openai",
    model: "gpt-4o",
    stream: false,
    status: "ok",
    httpStatus: 200,
    errorType: null,
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 0.004,
    wouldCostUsd: null,
    costEstimated: false,
    priceSource: "bundled",
    ttfbMs: 120,
    totalMs: 640,
    finishReason: "stop",
    hops: [
      { provider: "openai", model: "gpt-4o", outcome: "ok", ms: 640 },
      { provider: "openai", model: "gpt-4o-mini", outcome: "ok", ms: 300 },
    ],
    notes: [
      {
        stage: "decode",
        adapter: "openai",
        code: "unsupported_param",
        path: "messages[0].content[1]",
      },
    ],
    diagnostics: [
      { toolCallId: "call_9", name: "get_weather", code: "fenced_json" },
    ],
    repairs: [{ toolCallId: "call_9", steps: ["strip_fence"] }],
    ...overrides,
  };
}

function makeDetail(): RequestDetail {
  return {
    row: makeRow({}),
    bodies: {
      source: {
        value: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      },
      canonical: {
        value: {
          model: "gpt-4o",
          messages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
          ],
        },
      },
      target: [
        { value: { model: "gpt-4o", input: "hop-one-sentinel" } },
        { value: { model: "gpt-4o-mini", input: "hop-two-sentinel" } },
      ],
      response: {
        wire: { value: { choices: [{ message: { content: "reply" } }] } },
      },
    },
  };
}

describe("Inspector screen", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("four stages and a tab per hop", async () => {
    getMock.mockResolvedValue(makeDetail());
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const stages = container.querySelectorAll(".stage");
    expect(stages).toHaveLength(4);
    const headings = [...stages].map(
      (s) => s.querySelector("h3")?.textContent ?? "",
    );
    expect(headings[0]).toContain("source");
    expect(headings[1]).toContain("canonical");
    expect(headings[2]).toContain("target");
    expect(headings[3]).toContain("response");

    // a tab per hop, first selected: hop 1 body shown, hop 2 hidden
    const tabs = container.querySelectorAll(".stage .tabs button");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain("gpt-4o");
    expect(container.textContent).toContain("hop-one-sentinel");
    expect(container.textContent).not.toContain("hop-two-sentinel");

    await act(async () => {
      tabs[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("hop-two-sentinel");
    expect(container.textContent).not.toContain("hop-one-sentinel");
  });

  it("not retained message", async () => {
    getMock.mockResolvedValue({
      row: makeRow({ notes: [], diagnostics: [], repairs: [] }),
      bodies: null,
      reason: "not_retained",
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    // spec §3.9, verbatim
    expect(container.textContent).toContain(
      "bodies not retained — the inspector keeps the last N requests in memory; " +
        "set LOG_BODIES=true to keep them on disk",
    );
    // metadata still renders
    expect(container.textContent).toContain("gpt-4o");
    expect(container.querySelectorAll(".stage")).toHaveLength(0);
  });

  it("notes and diagnostics at top", async () => {
    getMock.mockResolvedValue(makeDetail());
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const notes = container.querySelector(".inspector-notes");
    expect(notes).not.toBeNull();
    expect(notes!.textContent).toContain("unsupported_param");
    expect(notes!.textContent).toContain("fenced_json");
    expect(notes!.textContent).toContain("strip_fence");

    // they precede the stage columns in document order
    const stages = container.querySelector(".stages");
    expect(stages).not.toBeNull();
    expect(
      notes!.compareDocumentPosition(stages!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
