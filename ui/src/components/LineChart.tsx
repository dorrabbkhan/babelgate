/** @jsxImportSource preact */
import { seriesVar, type ChartSeries } from "./BarChart";

/**
 * Hand-written SVG line chart (spec §3.9 — no chart library). Same
 * geometry contract as BarChart: `height` is the plot height, the max
 * value reaches the top, zero sits on the baseline, an all-zero
 * series draws a flat line. `--series-N` variables colour the lines
 * for light and dark. Labels are HTML below the svg (fixed size — SVG
 * text would scale with the viewBox stretch); the edge anchoring is
 * kept so the first/last label sits flush with the plot edges.
 */

interface ChartProps {
  labels: string[];
  series: ChartSeries[];
  height?: number;
}

const WIDTH = 640;

export function LineChart({ labels, series, height = 140 }: ChartProps) {
  const slot =
    labels.length > 1 ? WIDTH / (labels.length - 1) : WIDTH;
  const x = (i: number): number =>
    labels.length > 1 ? i * slot : WIDTH / 2;
  const max = Math.max(
    0,
    ...series.flatMap((s) => s.values.slice(0, labels.length)),
  );
  const scale = max > 0 ? height / max : 0;
  const y = (v: number): number => height - v * scale;

  // .axis-labels centres a span on its `left` — the edge labels undo
  // that so the first is start-aligned and the last end-aligned
  const labelStyle = (
    i: number,
  ): { left: string; transform?: string } => {
    if (labels.length > 1 && i === 0)
      return { left: "0%", transform: "none" };
    if (labels.length > 1 && i === labels.length - 1)
      return { left: "100%", transform: "translateX(-100%)" };
    return { left: `${(x(i) / WIDTH) * 100}%` };
  };

  return (
    <div class="chart-wrap">
      <svg
        class="chart line-chart"
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
      >
        {series.map((s, si) => (
          <polyline
            key={s.name}
            data-series={s.name}
            points={labels
              .map((_, i) => `${x(i)},${y(s.values[i] ?? 0)}`)
              .join(" ")}
            fill="none"
            stroke-width={2}
            style={{ stroke: seriesVar(si) }}
          />
        ))}
      </svg>
      <div class="axis-labels">
        {labels.map((label, i) => (
          <span key={label} style={labelStyle(i)}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
