/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { BarChart } from "./BarChart";

/**
 * §3.9 charts — hand-written SVG stacked bars. The tallest stack
 * fills the plot height exactly; an all-zero series renders a flat
 * (invisible) stack, never NaN geometry.
 */

function heightsByBar(container: HTMLElement): Map<string, number> {
  const perBar = new Map<string, number>();
  for (const rect of container.querySelectorAll("rect[data-bar]")) {
    const bar = rect.getAttribute("data-bar") ?? "";
    const h = Number(rect.getAttribute("height"));
    perBar.set(bar, (perBar.get(bar) ?? 0) + h);
  }
  return perBar;
}

describe("BarChart", () => {
  it("bars scale to max", () => {
    const container = document.createElement("div");
    render(
      <BarChart
        labels={["a", "b", "c"]}
        series={[
          { name: "cost", values: [2, 8, 4] },
          { name: "saved", values: [2, 0, 4] },
        ]}
        height={120}
      />,
      container,
    );

    const perBar = heightsByBar(container);
    // stack totals 4 / 8 / 8 — the 8s reach the full plot height
    expect(perBar.get("1")).toBe(120);
    expect(perBar.get("2")).toBe(120);
    expect(perBar.get("0")).toBe(60);
  });

  it("zero-height series renders", () => {
    const container = document.createElement("div");
    render(
      <BarChart
        labels={["a", "b"]}
        series={[{ name: "cost", values: [0, 0] }]}
        height={120}
      />,
      container,
    );

    const rects = [...container.querySelectorAll("rect[data-bar]")];
    expect(rects.length).toBe(2);
    for (const rect of rects) {
      expect(rect.getAttribute("height")).toBe("0");
    }
    expect(container.innerHTML).not.toContain("NaN");
  });
});
