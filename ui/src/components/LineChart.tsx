/** @jsxImportSource preact */
import { seriesVar, type ChartSeries } from "./BarChart";

/**
 * Hand-written SVG line chart (spec §3.9 — no chart library). Same
 * geometry contract as BarChart: `height` is the plot height, the max
 * value reaches the top, zero sits on the baseline, an all-zero
 * series draws a flat line. `--series-N` variables colour the lines
 * for light and dark.
 */

interface ChartProps {
  labels: string[];
  series: ChartSeries[];
  height?: number;
}

const WIDTH = 640;
const LABEL_H = 16;

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

  return (
    <svg
      class="chart line-chart"
      viewBox={`0 0 ${WIDTH} ${height + LABEL_H}`}
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
      {labels.map((label, i) => (
        <text
          key={label}
          class="axis"
          x={x(i)}
          y={height + LABEL_H - 4}
          text-anchor={
            labels.length > 1 && i === 0
              ? "start"
              : labels.length > 1 && i === labels.length - 1
                ? "end"
                : "middle"
          }
        >
          {label}
        </text>
      ))}
    </svg>
  );
}
