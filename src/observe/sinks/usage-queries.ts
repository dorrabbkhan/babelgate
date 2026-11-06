import type { DatabaseSync } from "node:sqlite";
import type { Hop } from "../../routing/route-log";
import { ValidationError } from "../../utils/errors";
import type { BodySnapshots, RequestTrace } from "../trace";

/**
 * The usage store's read path (spec §3.4): the `requests` row as
 * queries return it (camelCased, JSON columns parsed), newest-first
 * cursor paging, and the usage aggregation the UI and /metrics
 * consume. Writes live in usage-store.ts — a query never mutates.
 */

/** The `requests` row as queries return it: camelCased, JSON columns parsed. */
export interface RequestRow {
  id: string;
  startedAt: number;
  client: string;
  userAgent: string | null;
  sourceApi: string;
  requestedModel: string;
  routeReason: string;
  provider: string | null;
  model: string | null;
  stream: boolean;
  status: string;
  httpStatus: number;
  errorType: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  wouldCostUsd: number | null;
  costEstimated: boolean;
  priceSource: string | null;
  ttfbMs: number | null;
  totalMs: number;
  finishReason: string | null;
  hops: Hop[];
  notes: RequestTrace["notes"];
  diagnostics: RequestTrace["diagnostics"];
  repairs: RequestTrace["repairs"];
}

export interface UsageGroup {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  wouldCostUsd: number;
  /** rows whose cost is unknown — never conflated with $0 (D8) */
  unpriced: number;
  errors: number;
  /** rows that took more than one hop */
  fallbacks: number;
}

export interface UsageQueries {
  listRequests(q: {
    cursor?: string;
    limit: number;
    client?: string;
    model?: string;
    provider?: string;
    status?: string;
  }): { rows: RequestRow[]; nextCursor?: string };
  getRequest(
    id: string,
  ): (RequestRow & { bodies?: BodySnapshots }) | undefined;
  usage(q: {
    from: number;
    to: number;
    group: "day" | "model" | "provider" | "client";
  }): UsageGroup[];
}

type RawRow = Record<string, number | string | null>;

function toRequestRow(raw: RawRow): RequestRow {
  return {
    id: raw.id as string,
    startedAt: raw.started_at as number,
    client: raw.client as string,
    userAgent: raw.user_agent as string | null,
    sourceApi: raw.source_api as string,
    requestedModel: raw.requested_model as string,
    routeReason: raw.route_reason as string,
    provider: raw.provider as string | null,
    model: raw.model as string | null,
    stream: raw.stream === 1,
    status: raw.status as string,
    httpStatus: raw.http_status as number,
    errorType: raw.error_type as string | null,
    inputTokens: raw.input_tokens as number | null,
    outputTokens: raw.output_tokens as number | null,
    cacheReadTokens: raw.cache_read_tokens as number | null,
    cacheWriteTokens: raw.cache_write_tokens as number | null,
    costUsd: raw.cost_usd as number | null,
    wouldCostUsd: raw.would_cost_usd as number | null,
    costEstimated: raw.cost_estimated === 1,
    priceSource: raw.price_source as string | null,
    ttfbMs: raw.ttfb_ms as number | null,
    totalMs: raw.total_ms as number,
    finishReason: raw.finish_reason as string | null,
    hops: JSON.parse(raw.hops as string) as Hop[],
    notes: JSON.parse(raw.notes as string) as RequestTrace["notes"],
    diagnostics: JSON.parse(
      raw.diagnostics as string,
    ) as RequestTrace["diagnostics"],
    repairs: JSON.parse(raw.repairs as string) as RequestTrace["repairs"],
  };
}

function cursorOf(row: RequestRow): string {
  return Buffer.from(JSON.stringify([row.startedAt, row.id])).toString(
    "base64url",
  );
}

function parseCursor(cursor: string): [number, string] {
  try {
    const [startedAt, id] = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as [number, string];
    if (typeof startedAt !== "number" || typeof id !== "string") {
      throw new Error("bad shape");
    }
    return [startedAt, id];
  } catch {
    throw new ValidationError("invalid cursor");
  }
}

const GROUP_EXPR = {
  day: "date(started_at / 1000, 'unixepoch')",
  model: "COALESCE(model, 'none')",
  provider: "COALESCE(provider, 'none')",
  client: "client",
} as const;

/** Build the read-only half of the store against an open, migrated db. */
export function createUsageQueries(db: DatabaseSync): UsageQueries {
  return {
    listRequests(q) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (q.client !== undefined) {
        where.push("client = ?");
        params.push(q.client);
      }
      if (q.model !== undefined) {
        where.push("model = ?");
        params.push(q.model);
      }
      if (q.provider !== undefined) {
        where.push("provider = ?");
        params.push(q.provider);
      }
      if (q.status !== undefined) {
        where.push("status = ?");
        params.push(q.status);
      }
      if (q.cursor !== undefined) {
        const [startedAt, id] = parseCursor(q.cursor);
        where.push("(started_at < ? OR (started_at = ? AND id < ?))");
        params.push(startedAt, startedAt, id);
      }
      const rows = (
        db
          .prepare(
            `SELECT * FROM requests${
              where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
            } ORDER BY started_at DESC, id DESC LIMIT ?`,
          )
          .all(...params, q.limit + 1) as RawRow[]
      ).map(toRequestRow);
      const page = rows.slice(0, q.limit);
      return {
        rows: page,
        ...(rows.length > q.limit && page.length > 0
          ? { nextCursor: cursorOf(page[page.length - 1]) }
          : {}),
      };
    },

    getRequest(id) {
      const raw = db
        .prepare("SELECT * FROM requests WHERE id = ?")
        .get(id) as RawRow | undefined;
      if (raw === undefined) return undefined;
      const body = db
        .prepare("SELECT snapshots FROM bodies WHERE id = ?")
        .get(id) as { snapshots: string } | undefined;
      return {
        ...toRequestRow(raw),
        ...(body !== undefined
          ? {
              bodies: JSON.parse(body.snapshots) as BodySnapshots,
            }
          : {}),
      };
    },

    usage(q) {
      const expr = GROUP_EXPR[q.group];
      const rows = db
        .prepare(
          `SELECT ${expr} AS key,
             COUNT(*) AS requests,
             SUM(COALESCE(input_tokens, 0)) AS input_tokens,
             SUM(COALESCE(output_tokens, 0)) AS output_tokens,
             SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
             SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
             SUM(COALESCE(cost_usd, 0)) AS cost_usd,
             SUM(COALESCE(would_cost_usd, 0)) AS would_cost_usd,
             SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN json_array_length(hops) > 1 THEN 1 ELSE 0 END) AS fallbacks
           FROM requests
           WHERE started_at >= ? AND started_at < ?
           GROUP BY key
           ORDER BY ${q.group === "day" ? "key" : "requests DESC, key"}`,
        )
        .all(q.from, q.to) as RawRow[];
      return rows.map((r) => ({
        key: String(r.key),
        requests: r.requests as number,
        inputTokens: r.input_tokens as number,
        outputTokens: r.output_tokens as number,
        cacheReadTokens: r.cache_read_tokens as number,
        cacheWriteTokens: r.cache_write_tokens as number,
        costUsd: r.cost_usd as number,
        wouldCostUsd: r.would_cost_usd as number,
        unpriced: r.unpriced as number,
        errors: r.errors as number,
        fallbacks: r.fallbacks as number,
      }));
    },
  };
}
