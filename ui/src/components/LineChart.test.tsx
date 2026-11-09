/** @jsxImportSource preact */
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { LineChart } from "./LineChart";

function pointsOf(
  container: HTMLElement,
  series: string,
): [number, number][] {
  const line = container.querySelector(
    `polyline[data-series="${series}"]`,
  );
  expect(line).not.toBeNull();
  return (line?.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number) as [number, number]);
}

describe("LineChart", () => {
  it("line scales to max", () => {
    const container = document.createElement("div");
    render(
      <LineChart
        labels={["a", "b", "c"]}
        series={[{ name: "input", values: [0, 10, 5] }]}
        height={120}
      />,
      container,
    );

    const ys = pointsOf(container, "input").map(([, y]) => y);
    expect(Math.min(...ys)).toBe(0); // the 10 reaches the top
    expect(Math.max(...ys)).toBe(120); // the 0 sits on the baseline
    expect(ys).toContain(60); // the 5 is halfway
  });

  it("zero-height series renders", () => {
    const container = document.createElement("div");
    render(
      <LineChart
        labels={["a", "b"]}
        series={[{ name: "input", values: [0, 0] }]}
        height={120}
      />,
      container,
    );

    const ys = pointsOf(container, "input").map(([, y]) => y);
    expect(ys).toEqual([120, 120]); // flat on the baseline
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("axis labels do not scale with the chart", () => {
    const container = document.createElement("div");
    render(
      <LineChart
        labels={["a", "b", "c"]}
        series={[{ name: "input", values: [1, 2, 3] }]}
      />,
      container,
    );

    // labels must render at a fixed on-screen size; an SVG <text>
    // inside the viewBox-stretched svg would scale with the page width
    const svg = container.querySelector("svg.chart");
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll("text.axis").length).toBe(0);
    const spans = [
      ...container.querySelectorAll(".axis-labels span"),
    ];
    expect(spans.map((s) => s.textContent)).toEqual(["a", "b", "c"]);
    for (const span of spans) {
      expect(span.closest("svg")).toBeNull();
    }
    // edge anchoring survives the move: first label start-aligned at
    // the left edge, last end-aligned at the right edge
    expect((spans[0] as HTMLElement).style.left).toBe("0%");
    expect((spans[2] as HTMLElement).style.left).toBe("100%");
  });
});
