/** @jsxImportSource preact */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "preact";
import { act } from "preact/test-utils";
import { Playground } from "./Playground";
import { streamPlayground, type PlaygroundHandlers } from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, streamPlayground: vi.fn() };
});

const streamMock = vi.mocked(streamPlayground);

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("Playground screen", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    streamMock.mockReturnValue({ close: vi.fn() });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("columns render deltas per model", async () => {
    let handlers: PlaygroundHandlers | undefined;
    streamMock.mockImplementation((_body, h) => {
      handlers = h;
      return { close: vi.fn() };
    });

    await act(async () => {
      render(<Playground />, container);
    });

    const modelInputs = container.querySelectorAll<HTMLInputElement>(
      "input[data-model]",
    );
    expect(modelInputs.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      modelInputs[0]!.value = "m1";
      modelInputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
      modelInputs[1]!.value = "m2";
      modelInputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
      const prompt = container.querySelector<HTMLTextAreaElement>(
        "textarea[data-prompt]",
      )!;
      prompt.value = "hello";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });
    await act(async () => {
      container
        .querySelector("button[data-run]")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
    });

    expect(streamMock).toHaveBeenCalledOnce();
    expect(streamMock.mock.calls[0]![0].models).toEqual(["m1", "m2"]);
    expect(streamMock.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "hello" },
    ]);

    const cols = container.querySelectorAll("[data-col]");
    expect(cols).toHaveLength(2);

    await act(async () => {
      handlers!.onDelta?.({ model: "m1", text: "hel" });
      handlers!.onDelta?.({ model: "m2", text: "wor" });
      handlers!.onDelta?.({ model: "m1", text: "lo" });
      await tick();
    });

    const colText = (i: number): string =>
      container.querySelectorAll("[data-col]")[i]!.textContent ?? "";
    expect(colText(0)).toContain("m1");
    expect(colText(0)).toContain("hello");
    expect(colText(0)).not.toContain("wor");
    expect(colText(1)).toContain("m2");
    expect(colText(1)).toContain("wor");
    expect(colText(1)).not.toContain("hello");

    await act(async () => {
      handlers!.onDone?.({
        model: "m1",
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        costUsd: 0,
        ms: 42,
      });
      await tick();
    });
    expect(colText(0)).toContain("5/7");
    expect(colText(0)).toContain("42");
  });
});
