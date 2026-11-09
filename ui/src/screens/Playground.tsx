/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { UiApiError } from "../api";
import {
  streamPlayground,
  type PlaygroundDone,
} from "../playground-api";

/**
 * §3.9 screen 5 — the playground: 2–4 models streaming side by side
 * from one prompt, tokens/cost/latency under each column. Runs go
 * through POST /ui/api/playground → streamPlayground; every model is
 * its own traced chat request (`client=playground`), so the Requests
 * and Inspector screens see exactly what a real client would produce.
 */

interface Column {
  model: string;
  text: string;
  error?: string;
  usage?: PlaygroundDone["usage"];
  costUsd?: number | null;
  ms?: number;
  done?: boolean;
}

function PgColumn({ col, running }: { col: Column; running: boolean }) {
  return (
    <div class="pg-col" data-col>
      <h3>
        {col.model}
        {!col.done && running ? " …" : ""}
      </h3>
      {col.error !== undefined ? (
        <p class="error">{col.error}</p>
      ) : (
        <pre class="pg-text">{col.text}</pre>
      )}
      <div class="pg-stats muted">
        {col.usage !== undefined &&
          col.usage !== null &&
          `${col.usage.inputTokens}/${col.usage.outputTokens} tok`}
        {col.costUsd !== undefined &&
          col.costUsd !== null &&
          ` · $${col.costUsd.toFixed(4)}`}
        {col.ms !== undefined && ` · ${col.ms} ms`}
      </div>
    </div>
  );
}

export function Playground() {
  const [models, setModels] = useState(["", "", "", ""]);
  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [temperature, setTemperature] = useState("");
  const [columns, setColumns] = useState<Column[]>([]);
  const [running, setRunning] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const streamRef = useRef<{ close(): void } | null>(null);

  // An unmounted screen aborts its run; a new run closes the old one.
  useEffect(() => () => streamRef.current?.close(), []);

  const picked = models
    .map((m) => m.trim())
    .filter((m) => m !== "");
  const canRun =
    !running && picked.length >= 2 && prompt.trim() !== "";

  const setModel = (i: number, value: string): void => {
    setModels((prev) => prev.map((m, j) => (j === i ? value : m)));
  };

  const run = (): void => {
    if (!canRun) return;
    streamRef.current?.close();
    setFatal(null);
    setColumns(picked.map((model) => ({ model, text: "" })));
    setRunning(true);

    const params: { maxTokens?: number; temperature?: number } = {};
    const mt = Number(maxTokens);
    if (maxTokens.trim() !== "" && Number.isFinite(mt)) {
      params.maxTokens = mt;
    }
    const tp = Number(temperature);
    if (temperature.trim() !== "" && Number.isFinite(tp)) {
      params.temperature = tp;
    }

    // Columns are keyed by position: a frame lands on its model's
    // index in `picked`, never on whichever column happens to share a
    // model name (the server rejects duplicates, but the render must
    // not depend on that).
    const patch = (
      model: string,
      update: Partial<Column> | ((c: Column) => Partial<Column>),
    ): void => {
      const index = picked.indexOf(model);
      if (index === -1) return;
      setColumns((cols) =>
        cols.map((c, i) =>
          i === index
            ? {
                ...c,
                ...(typeof update === "function" ? update(c) : update),
              }
            : c,
        ),
      );
    };

    streamRef.current = streamPlayground(
      {
        messages: [{ role: "user", content: prompt }],
        ...(system.trim() !== "" ? { system } : {}),
        models: picked,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      },
      {
        onDelta: ({ model, text }) =>
          patch(model, (c) => ({ text: c.text + text })),
        onDone: ({ model, usage, costUsd, ms }) =>
          patch(model, { usage, costUsd, ms, done: true }),
        onModelError: ({ model, message }) =>
          patch(model, { error: message, done: true }),
        onEnd: (err) => {
          setRunning(false);
          if (err !== undefined) {
            setFatal(
              err instanceof UiApiError ? err.message : String(err),
            );
          }
        },
      },
    );
  };

  return (
    <div>
      <div class="pg-form panel">
        <textarea
          data-system
          placeholder="system prompt (optional)"
          rows={2}
          value={system}
          onInput={(e) =>
            setSystem((e.target as HTMLTextAreaElement).value)
          }
        />
        <textarea
          data-prompt
          placeholder="message"
          rows={4}
          value={prompt}
          onInput={(e) =>
            setPrompt((e.target as HTMLTextAreaElement).value)
          }
        />
        <div class="pg-models">
          {models.map((m, i) => (
            <input
              key={i}
              data-model
              placeholder={`model ${i + 1}`}
              value={m}
              onInput={(e) =>
                setModel(i, (e.target as HTMLInputElement).value)
              }
            />
          ))}
        </div>
        <div class="pg-params">
          <input
            data-max-tokens
            placeholder="max tokens (default 512)"
            value={maxTokens}
            onInput={(e) =>
              setMaxTokens((e.target as HTMLInputElement).value)
            }
          />
          <input
            data-temperature
            placeholder="temperature"
            value={temperature}
            onInput={(e) =>
              setTemperature((e.target as HTMLInputElement).value)
            }
          />
          <button data-run disabled={!canRun} onClick={run}>
            {running ? "running…" : "run"}
          </button>
        </div>
      </div>
      {fatal !== null && <p class="error">{fatal}</p>}
      <div class="pg-columns">
        {columns.map((col, i) => (
          <PgColumn key={i} col={col} running={running} />
        ))}
      </div>
    </div>
  );
}
