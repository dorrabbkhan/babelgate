/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import type { DiffEntry } from "../diff";

/**
 * Collapsible JSON for the Inspector (spec §3.9). `highlights` marks
 * paths the adjacent-stage diff added or changed; `removed` paths are
 * listed under the tree (a removed field has no node to paint).
 */

interface JsonTreeProps {
  value: unknown;
  /** path → kind for nodes this stage introduced or altered */
  highlights?: Map<string, DiffEntry["kind"]>;
  /** paths removed relative to the previous stage */
  removed?: string[];
}

interface NodeProps {
  name: string | null;
  path: string;
  value: unknown;
  highlights: Map<string, DiffEntry["kind"]> | undefined;
  /** auto-expand levels above this depth */
  depth: number;
}

const AUTO_EXPAND_DEPTH = 1;

function primitiveClass(value: unknown): string {
  if (typeof value === "string") return "str";
  if (typeof value === "number" || typeof value === "bigint") return "num";
  return "lit";
}

function primitiveText(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return String(value);
}

function JsonNode({ name, path, value, highlights, depth }: NodeProps) {
  const isContainer =
    typeof value === "object" && value !== null;
  const [open, setOpen] = useState(depth <= AUTO_EXPAND_DEPTH);
  const hl = highlights?.get(path);
  const cls = hl !== undefined ? ` row hl-${hl}` : " row";

  const label =
    name === null ? null : (
      <>
        <span class="key">{name}</span>
        {": "}
      </>
    );

  if (!isContainer) {
    return (
      <div class={cls}>
        {label}
        <span class={primitiveClass(value)}>{primitiveText(value)}</span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const childPath = (key: string): string =>
    isArray ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;

  return (
    <div>
      <div class={cls} onClick={() => setOpen(!open)}>
        <span class="twisty">{open ? "▾" : "▸"} </span>
        {label}
        <span class="muted">
          {isArray ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </div>
      {open &&
        entries.map(([key, child]) => (
          <div class="row" key={key}>
            <JsonNode
              name={isArray ? `[${key}]` : key}
              path={childPath(key)}
              value={child}
              highlights={highlights}
              depth={depth + 1}
            />
          </div>
        ))}
    </div>
  );
}

export function JsonTree({ value, highlights, removed }: JsonTreeProps) {
  return (
    <div class="json-tree">
      <JsonNode
        name={null}
        path=""
        value={value}
        highlights={highlights}
        depth={0}
      />
      {removed !== undefined && removed.length > 0 && (
        <div class="removed-list">
          removed in this stage: {removed.join(", ")}
        </div>
      )}
    </div>
  );
}
