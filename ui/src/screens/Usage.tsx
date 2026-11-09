/** @jsxImportSource preact */
import { useCallback, useEffect, useState } from "preact/hooks";
import { getUsage, UiApiError, type UsageGroup } from "../api";
import { AuthPrompt } from "../components/AuthPrompt";
import { BarChart, Legend, type ChartSeries } from "../components/BarChart";
import { LineChart } from "../components/LineChart";

/**
 * §3.9 screen 3 — Usage: cost and tokens per day over a 7/30-day
 * range, totals, and a split by model or client. The daily cost bar
 * stacks `costUsd` (what was paid) on `wouldCostUsd` (what the local
 * rows would have cost at the reference price, spec §3.6) — the only
 * cost split /ui/api/usage exposes, so each day's stack reads as paid
 * + saved. "saved ≈ $X" is the sum of wouldCostUsd. Unpriced rows are
 * counted, never folded into a $0 total.
 */

const DAY_MS = 86_400_000;

function dayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function emptyDay(key: string): UsageGroup {
  return {
    key,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    wouldCostUsd: 0,
    unpriced: 0,
    errors: 0,
    fallbacks: 0,
    cacheHitRatio: null,
  };
}

/** Fill the range's missing days (UTC, the store's day basis) so the charts read as a timeline. */
function fillDays(groups: UsageGroup[], from: number, to: number): UsageGroup[] {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const days: UsageGroup[] = [];
  const start = Date.parse(`${dayKey(from)}T00:00:00.000Z`);
  const end = Date.parse(`${dayKey(to)}T00:00:00.000Z`);
  for (let t = start; t <= end; t += DAY_MS) {
    const key = dayKey(t);
    days.push(byKey.get(key) ?? emptyDay(key));
  }
  return days;
}

function fmtMoney(v: number): string {
  return `$${v.toFixed(4)}`;
}

function fmtPct(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

interface Totals {
  requests: number;
  costUsd: number;
  wouldCostUsd: number;
  cacheRead: number;
  input: number;
  unpriced: number;
}

function sum(groups: UsageGroup[]): Totals {
  return groups.reduce<Totals>(
    (a, g) => ({
      requests: a.requests + g.requests,
      costUsd: a.costUsd + g.costUsd,
      wouldCostUsd: a.wouldCostUsd + g.wouldCostUsd,
      cacheRead: a.cacheRead + g.cacheReadTokens,
      input: a.input + g.inputTokens,
      unpriced: a.unpriced + g.unpriced,
    }),
    {
      requests: 0,
      costUsd: 0,
      wouldCostUsd: 0,
      cacheRead: 0,
      input: 0,
      unpriced: 0,
    },
  );
}

function GroupTable({ groups }: { groups: UsageGroup[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>group</th>
          <th>requests</th>
          <th>tokens in/out</th>
          <th>cache %</th>
          <th>cost</th>
          <th>saved</th>
          <th>unpriced</th>
          <th>errors</th>
          <th>fallbacks</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <tr key={g.key}>
            <td>{g.key}</td>
            <td>{g.requests}</td>
            <td>
              {g.inputTokens.toLocaleString()}/
              {g.outputTokens.toLocaleString()}
            </td>
            <td>{fmtPct(g.cacheHitRatio)}</td>
            <td>{fmtMoney(g.costUsd)}</td>
            <td>{fmtMoney(g.wouldCostUsd)}</td>
            <td>{g.unpriced}</td>
            <td>{g.errors}</td>
            <td>{g.fallbacks}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Usage() {
  const [days, setDays] = useState(7);
  const [groupBy, setGroupBy] = useState<"model" | "client">("model");
  const [dayGroups, setDayGroups] = useState<UsageGroup[] | null>(null);
  const [dimGroups, setDimGroups] = useState<UsageGroup[]>([]);
  const [error, setError] = useState<UiApiError | null>(null);

  const load = useCallback(() => {
    const to = Date.now();
    const from = to - days * DAY_MS;
    return Promise.all([
      getUsage({ from, to, group: "day" }),
      getUsage({ from, to, group: groupBy }),
    ])
      .then(([d, g]) => {
        setDayGroups(d.groups);
        setDimGroups(g.groups);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof UiApiError
            ? err
            : new UiApiError(0, "ERROR", String(err)),
        );
      });
  }, [days, groupBy]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null && (error.status === 401 || error.status === 403)) {
    return <AuthPrompt error={error} onRetry={() => void load()} />;
  }

  const empty = dayGroups !== null && dayGroups.length === 0;
  const totals = sum(dayGroups ?? []);
  const cacheHit =
    totals.input > 0 ? totals.cacheRead / totals.input : null;

  const filled =
    dayGroups === null || dayGroups.length === 0
      ? []
      : fillDays(dayGroups, Date.now() - days * DAY_MS, Date.now());
  const labels = filled.map((g) => g.key.slice(5));
  const costSeries: ChartSeries[] = [
    { name: "cost", values: filled.map((g) => g.costUsd) },
    { name: "saved", values: filled.map((g) => g.wouldCostUsd) },
  ];
  const tokenSeries: ChartSeries[] = [
    { name: "input", values: filled.map((g) => g.inputTokens) },
    { name: "output", values: filled.map((g) => g.outputTokens) },
  ];

  return (
    <div>
      <div class="filters">
        <select
          data-range
          value={String(days)}
          onChange={(e) =>
            setDays(Number((e.target as HTMLSelectElement).value))
          }
        >
          <option value="7">7 days</option>
          <option value="30">30 days</option>
        </select>
        <select
          data-group
          value={groupBy}
          onChange={(e) =>
            setGroupBy(
              (e.target as HTMLSelectElement).value as
                | "model"
                | "client",
            )
          }
        >
          <option value="model">by model</option>
          <option value="client">by client</option>
        </select>
      </div>
      {error !== null && <p class="error">{error.message}</p>}
      {dayGroups === null ? (
        <p class="muted">loading…</p>
      ) : empty ? (
        <p class="muted">no usage in this range</p>
      ) : (
        <>
          <div class="panel usage-totals">
            <span>
              <strong>{totals.requests} requests</strong>
            </span>
            <span>
              cost <strong>{fmtMoney(totals.costUsd)}</strong>
            </span>
            <span>
              saved ≈ <strong>{fmtMoney(totals.wouldCostUsd)}</strong>
            </span>
            <span>
              cache hits <strong>{fmtPct(cacheHit)}</strong>
            </span>
            <span>
              <strong>{totals.unpriced}</strong> requests without a
              price
            </span>
          </div>
          <div class="panel">
            <h3>cost per day</h3>
            <BarChart labels={labels} series={costSeries} />
            <Legend series={costSeries} />
          </div>
          <div class="panel">
            <h3>tokens per day</h3>
            <LineChart labels={labels} series={tokenSeries} />
            <Legend series={tokenSeries} />
          </div>
          <GroupTable groups={dimGroups} />
        </>
      )}
    </div>
  );
}
