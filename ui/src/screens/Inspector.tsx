/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getRequest,
  UiApiError,
  type Bodies,
  type BodySnapshot,
  type RequestDetail,
  type RequestRow,
} from "../api";
import { AuthPrompt } from "../components/AuthPrompt";
import { JsonTree } from "../components/JsonTree";
import { structuralDiff, type DiffEntry } from "../diff";

/**
 * §3.9 screen 2 — the translation inspector: source | canonical |
 * target (a tab per hop) | response, each a collapsible JsonTree, with
 * the fields added/changed between adjacent stages highlighted via
 * structuralDiff and removed paths listed. Notes, diagnostics and
 * repairs sit at the top. No retained bodies → metadata plus the spec
 * message.
 */

const NOT_RETAINED =
  "bodies not retained — the inspector keeps the last N requests in " +
  "memory; set LOG_BODIES=true to keep them on disk";

interface StageProps {
  title: string;
  snapshot: BodySnapshot | undefined;
  /** diff of the previous stage → this one */
  diff: DiffEntry[];
}

function Stage({ title, snapshot, diff }: StageProps) {
  const highlights = useMemo(() => {
    const m = new Map<string, DiffEntry["kind"]>();
    for (const d of diff) {
      if (d.kind !== "removed") m.set(d.path, d.kind);
    }
    return m;
  }, [diff]);
  const removed = useMemo(
    () => diff.filter((d) => d.kind === "removed").map((d) => d.path),
    [diff],
  );

  return (
    <div class="stage">
      <h3>
        {title}
        {snapshot?.truncated === true && (
          <span class="badge">truncated</span>
        )}
      </h3>
      {snapshot === undefined ? (
        <p class="muted">not captured</p>
      ) : (
        <JsonTree
          value={snapshot.value}
          highlights={highlights}
          removed={removed}
        />
      )}
    </div>
  );
}

function Meta({ row }: { row: RequestRow }) {
  const routed =
    row.provider !== null && row.model !== null
      ? `${row.provider}/${row.model}`
      : "—";
  return (
    <div class="inspector-meta">
      <div>
        <strong>{row.requestedModel}</strong> → {routed} · {row.status} ·
        http {row.httpStatus} · {row.totalMs} ms ·{" "}
        {new Date(row.startedAt).toLocaleString()}
      </div>
      <div class="muted">
        {row.client} via {row.sourceApi} · tokens{" "}
        {row.inputTokens ?? 0}/{row.outputTokens ?? 0}
        {row.costUsd !== null && ` · $${row.costUsd.toFixed(4)}`}
        {row.finishReason !== null && ` · ${row.finishReason}`}
        {row.errorType !== null && ` · ${row.errorType}`}
      </div>
    </div>
  );
}

function Notes({ row }: { row: RequestRow }) {
  if (
    row.notes.length === 0 &&
    row.diagnostics.length === 0 &&
    row.repairs.length === 0
  ) {
    return null;
  }
  return (
    <div class="inspector-notes">
      {row.notes.length > 0 && (
        <div>
          <strong>notes</strong>
          <ul>
            {row.notes.map((n, i) => (
              <li key={i}>
                {n.stage} · {n.adapter} · {n.code}
                {n.path !== undefined && ` · ${n.path}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {row.diagnostics.length > 0 && (
        <div>
          <strong>diagnostics</strong>
          <ul>
            {row.diagnostics.map((d, i) => (
              <li key={i}>
                {d.name} ({d.toolCallId}) · {d.code}
                {d.detail !== undefined && ` · ${d.detail}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {row.repairs.length > 0 && (
        <div>
          <strong>repairs</strong>
          <ul>
            {row.repairs.map((r, i) => (
              <li key={i}>
                {r.toolCallId} · {r.steps.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function diffBetween(
  a: BodySnapshot | undefined,
  b: BodySnapshot | undefined,
): DiffEntry[] {
  if (a === undefined || b === undefined) return [];
  return structuralDiff(a.value, b.value);
}

function Stages({ detail }: { detail: RequestDetail & { bodies: Bodies } }) {
  const { row, bodies } = detail;
  const [hopIdx, setHopIdx] = useState(0);
  const targetSnap = bodies.target[hopIdx];
  const responseSnap =
    bodies.response?.wire ?? bodies.response?.canonical;

  const hopCount = Math.max(bodies.target.length, row.hops.length);
  const hopLabel = (i: number): string => {
    const hop = row.hops[i];
    if (hop === undefined) return `hop ${i + 1}`;
    const mark = hop.outcome === "ok" ? "" : ` (${hop.outcome})`;
    return `${hop.provider}/${hop.model}${mark}`;
  };

  return (
    <div class="stages">
      <Stage
        title="source"
        snapshot={bodies.source}
        diff={[]}
      />
      <Stage
        title="canonical"
        snapshot={bodies.canonical}
        diff={diffBetween(bodies.source, bodies.canonical)}
      />
      <div class="stage">
        <h3>target</h3>
        {hopCount > 1 && (
          <div class="tabs">
            {Array.from({ length: hopCount }, (_, i) => (
              <button
                key={i}
                class={i === hopIdx ? "active" : ""}
                onClick={() => setHopIdx(i)}
              >
                {hopLabel(i)}
              </button>
            ))}
          </div>
        )}
        {targetSnap === undefined ? (
          <p class="muted">not captured</p>
        ) : (
          <JsonTree
            value={targetSnap.value}
            highlights={new Map(
              diffBetween(bodies.canonical, targetSnap)
                .filter((d) => d.kind !== "removed")
                .map((d) => [d.path, d.kind]),
            )}
            removed={diffBetween(bodies.canonical, targetSnap)
              .filter((d) => d.kind === "removed")
              .map((d) => d.path)}
          />
        )}
      </div>
      <Stage
        title="response"
        snapshot={responseSnap}
        diff={diffBetween(targetSnap, responseSnap)}
      />
    </div>
  );
}

export function Inspector({ id }: { id: string }) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<UiApiError | null>(null);

  const load = (): void => {
    getRequest(id)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof UiApiError
            ? err
            : new UiApiError(0, "ERROR", String(err)),
        );
      });
  };

  useEffect(load, [id]);

  if (error !== null) {
    if (error.status === 401 || error.status === 403) {
      return <AuthPrompt error={error} onRetry={load} />;
    }
    return <p class="error">{error.message}</p>;
  }
  if (detail === null) return <p class="muted">loading…</p>;

  return (
    <div>
      <p>
        <a href="#/requests">← requests</a>
      </p>
      <Meta row={detail.row} />
      <Notes row={detail.row} />
      {detail.bodies === null ? (
        <p class="inspector-meta">{NOT_RETAINED}</p>
      ) : (
        <Stages
          detail={detail as RequestDetail & { bodies: Bodies }}
        />
      )}
    </div>
  );
}
