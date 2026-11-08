/** @jsxImportSource preact */
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  listRequests,
  streamLive,
  UiApiError,
  type LiveStarted,
  type ListParams,
  type RequestRow,
} from "../api";
import { AuthPrompt } from "../components/AuthPrompt";

/**
 * §3.9 screen 1 — the live requests table: rows from
 * `GET /ui/api/requests` plus `started`/`finished` inserts from the
 * /live feed (reconnecting with backoff inside streamLive). Server-
 * side filters (client, model, provider, status) re-run the list.
 */

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

function fmtTokens(row: RequestRow): string {
  const inn = row.inputTokens ?? 0;
  const out = row.outputTokens ?? 0;
  return `${inn}/${out}`;
}

function fmtCache(row: RequestRow): string {
  const inn = row.inputTokens ?? 0;
  const read = row.cacheReadTokens ?? 0;
  return inn > 0 ? `${Math.round((read / inn) * 100)}%` : "—";
}

function fmtCost(row: RequestRow): string {
  if (row.costUsd === null) return "?";
  return `$${row.costUsd.toFixed(4)}`;
}

function target(row: RequestRow): string {
  const routed =
    row.provider !== null && row.model !== null
      ? `${row.provider}/${row.model}`
      : "—";
  return `${row.requestedModel} → ${routed}`;
}

interface Filters {
  client: string;
  model: string;
  provider: string;
  status: string;
}

function Row({ row }: { row: RequestRow }) {
  return (
    <tr
      onClick={() => {
        location.hash = `#/requests/${encodeURIComponent(row.id)}`;
      }}
    >
      <td>{fmtTime(row.startedAt)}</td>
      <td>{row.client}</td>
      <td>{target(row)}</td>
      <td class={`status-${row.status}`}>{row.status}</td>
      <td>{fmtTokens(row)}</td>
      <td>{fmtCache(row)}</td>
      <td>{fmtCost(row)}</td>
      <td>{row.totalMs}</td>
      <td>
        {row.diagnostics.length > 0 && (
          <span class="badge">{row.diagnostics.length}</span>
        )}
      </td>
      <td>{row.hops.length}</td>
    </tr>
  );
}

function PendingRow({ started }: { started: LiveStarted }) {
  return (
    <tr class="muted">
      <td>{fmtTime(started.startedAt)}</td>
      <td>{started.client}</td>
      <td>{started.requestedModel} → …</td>
      <td class="status-running">running</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td />
      <td>—</td>
    </tr>
  );
}

export function Requests() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [pending, setPending] = useState<LiveStarted[]>([]);
  const [filters, setFilters] = useState<Filters>({
    client: "",
    model: "",
    provider: "",
    status: "",
  });
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [error, setError] = useState<UiApiError | null>(null);

  const params = useCallback((): ListParams => {
    const p: ListParams = {};
    if (filters.client !== "") p.client = filters.client;
    if (filters.model !== "") p.model = filters.model;
    if (filters.provider !== "") p.provider = filters.provider;
    if (filters.status !== "") p.status = filters.status;
    return p;
  }, [filters]);

  const load = useCallback(
    (cursor?: string) => {
      return listRequests(params(), cursor)
        .then((page) => {
          setRows((prev) =>
            cursor === undefined ? page.rows : [...prev, ...page.rows],
          );
          setNextCursor(page.nextCursor);
          setError(null);
        })
        .catch((err: unknown) => {
          setError(
            err instanceof UiApiError
              ? err
              : new UiApiError(0, "ERROR", String(err)),
          );
        });
    },
    [params],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const feed = streamLive({
      onStarted: (s) =>
        setPending((prev) => [s, ...prev.filter((p) => p.id !== s.id)]),
      onFinished: (row) => {
        setPending((prev) => prev.filter((p) => p.id !== row.id));
        setRows((prev) => [row, ...prev.filter((r) => r.id !== row.id)]);
      },
      onError: (err) => {
        if (err instanceof UiApiError) setError(err);
      },
    });
    return () => feed.close();
  }, []);

  if (error !== null && (error.status === 401 || error.status === 403)) {
    return <AuthPrompt error={error} onRetry={() => void load()} />;
  }

  const setFilter = (key: keyof Filters, value: string): void =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  return (
    <div>
      <div class="filters">
        <input
          data-filter="client"
          placeholder="client"
          value={filters.client}
          onInput={(e) =>
            setFilter("client", (e.target as HTMLInputElement).value)
          }
        />
        <input
          data-filter="model"
          placeholder="model"
          value={filters.model}
          onInput={(e) =>
            setFilter("model", (e.target as HTMLInputElement).value)
          }
        />
        <input
          data-filter="provider"
          placeholder="provider"
          value={filters.provider}
          onInput={(e) =>
            setFilter("provider", (e.target as HTMLInputElement).value)
          }
        />
        <select
          data-filter="status"
          value={filters.status}
          onChange={(e) =>
            setFilter("status", (e.target as HTMLSelectElement).value)
          }
        >
          <option value="">any status</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="aborted">aborted</option>
        </select>
      </div>
      {error !== null && <p class="error">{error.message}</p>}
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>client</th>
            <th>requested → routed</th>
            <th>status</th>
            <th>tokens in/out</th>
            <th>cache %</th>
            <th>cost</th>
            <th>ms</th>
            <th>diag</th>
            <th>hops</th>
          </tr>
        </thead>
        <tbody>
          {pending.map((s) => (
            <PendingRow key={s.id} started={s} />
          ))}
          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </tbody>
      </table>
      {rows.length === 0 && pending.length === 0 && (
        <p class="muted">no requests yet</p>
      )}
      {nextCursor !== undefined && (
        <button onClick={() => void load(nextCursor)}>load more</button>
      )}
    </div>
  );
}
