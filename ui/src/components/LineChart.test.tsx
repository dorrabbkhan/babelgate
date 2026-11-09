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
});
