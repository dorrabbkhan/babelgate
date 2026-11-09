/** @jsxImportSource preact */

/**
 * Hand-written SVG stacked bar chart (spec §3.9 — no chart library).
 * Colours come from the `--series-N` CSS variables so the same markup
 * renders under the light and dark palettes in index.html. `height`
 * is the plot height in viewBox units — the tallest stack always
 * reaches exactly `height`; an all-zero input draws a flat stack,
 * never NaN geometry. The x-label strip sits below the plot.
 */

export interface ChartSeries {
  name: string;
  values: number[];
}

interface ChartProps {
  labels: string[];
  series: ChartSeries[];
  /** plot height (what the data scales to), viewBox units */
  height?: number;
}

const WIDTH = 640;
const LABEL_H = 16;
const SERIES_COLORS = 6;

export function seriesVar(index: number): string {
  return `var(--series-${(index % SERIES_COLORS) + 1})`;
}

export function Legend({ series }: { series: ChartSeries[] }) {
  return (
    <div class="legend">
      {series.map((s, i) => (
        <span key={s.name}>
          <i class="sw" style={{ background: seriesVar(i) }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

export function BarChart({ labels, series, height = 140 }: ChartProps) {
  const slot = labels.length > 0 ? WIDTH / labels.length : WIDTH;
  const barWidth = Math.min(slot * 0.7, 48);
  const maxTotal = Math.max(
    0,
    ...labels.map((_, i) =>
      series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
    ),
  );
  const scale = maxTotal > 0 ? height / maxTotal : 0;

  return (
    <svg
      class="chart bar-chart"
      viewBox={`0 0 ${WIDTH} ${height + LABEL_H}`}
      role="img"
    >
      {labels.map((label, i) => {
        let y = height;
        return (
          <g key={label}>
            {series.map((s, si) => {
              const h = (s.values[i] ?? 0) * scale;
              y -= h;
              return (
                <rect
                  key={s.name}
                  data-bar={i}
                  data-series={s.name}
                  x={slot * i + (slot - barWidth) / 2}
                  y={y}
                  width={barWidth}
                  height={h}
                  style={{ fill: seriesVar(si) }}
                />
              );
            })}
            <text
              class="axis"
              x={slot * i + slot / 2}
              y={height + LABEL_H - 4}
              text-anchor="middle"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
