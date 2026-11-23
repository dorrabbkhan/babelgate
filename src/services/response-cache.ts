import { createHash } from "node:crypto";
import type { RouteTarget } from "../routing/plan-route";
import type {
  CanonicalContentPart,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from "../types/canonical.types";
import { reassembleStream } from "../utils/stream-reassemble";

/**
 * The opt-in exact-match response cache (v1.6 spec §3.5), for CI and
 * test-suite use: `cache: {enabled: true, ttl_ms, max_entries}` or
 * `CACHE=on`, off by default. The key is a sha256 over a stable JSON
 * of the canonical request plus the routed target — every canonical
 * field except the stream flag and client metadata — so a streaming
 * and a non-streaming request share an entry, and a hit is re-encoded
 * in the asking client's own dialect.
 *
 * Never cached: `config.temperature > 0` unless
 * `cache.ignore_temperature` (a temperature request is not
 * deterministic enough to replay), any error, a response or stream
 * whose finish reason is `length` with tool calls (the calls were cut
 * short mid-arguments), and pass-through requests (the chat services
 * filter them out of the probe list — a relay was never translated).
 *
 * Entries live in memory on the loaded config (`GatewayConfig.cache`),
 * LRU by `max_entries`, TTL by `ttl_ms` — and never reach logs,
 * `/metrics` or `/ui/api/*`. A hit records `cacheHit` on the trace;
 * the usage row marks `cache_hit = 1` and costs $0.
 */

/** `cache:` tuning (spec §3.5) — every key defaults when absent. */
export interface CacheConfig {
  /** Entry lifetime in ms (spec default 300_000). */
  ttlMs: number;
  /** LRU cap (spec default 500). */
  maxEntries: number;
  /** `cache.ignore_temperature`: cache `temperature > 0` requests too. */
  ignoreTemperature: boolean;
}

/** The spec §3.5 defaults: 5-minute TTL, 500 entries, temperature honoured. */
export const CACHE_DEFAULTS: CacheConfig = {
  ttlMs: 300_000,
  maxEntries: 500,
  ignoreTemperature: false,
};

/**
 * One stored reply (spec §3.5): the decoded canonical response, or the
 * canonical event sequence a stream produced — both BEFORE client
 * shaping (no raised custom calls, no argument repair, model still the
 * upstream's). A hit applies the asking source's and entry's shaping
 * exactly as a fresh decode would, so the replay is what that client
 * would have received live.
 */
export type CachedEntry =
  | { response: CanonicalResponse }
  | { events: CanonicalStreamEvent[] };

export interface ResponseCache {
  /**
   * The request's key under `target`, or undefined when the request is
   * never cached (`config.temperature > 0` without ignore_temperature).
   */
  key(target: RouteTarget, req: CanonicalRequest): string | undefined;
  get(key: string): CachedEntry | undefined;
  set(key: string, entry: CachedEntry): void;
}

/** JSON.stringify with sorted keys at every level — order-stable hashing. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * The cache key (spec §3.5): sha256 of a stable JSON of the canonical
 * request plus the routed target — every canonical field except the
 * stream flag and client metadata. `model` is the routed model
 * (target.model), never the string the client asked for. Two requests
 * that differ only in `tool_choice`, `tools`, `response_format` or
 * reasoning config produce different keys (Review Focus 3).
 */
export function cacheKey(
  target: RouteTarget,
  req: CanonicalRequest,
): string {
  return createHash("sha256")
    .update(
      stableJson({
        provider: target.provider,
        model: target.model,
        messages: req.messages,
        system: req.systemPrompt,
        tools: req.tools,
        toolChoice: req.toolChoice,
        responseFormat: req.responseFormat,
        parallelToolCalls: req.parallelToolCalls,
        config: req.config,
      }),
    )
    .digest("hex");
}

/**
 * `cfg.maxEntries` is the LRU bound, `cfg.ttlMs` the lifetime; `now` is
 * injectable for tests. get() refreshes recency; set() evicts the
 * oldest entries first and stores a deep copy — the services' stored
 * canonical objects share structure with live responses.
 */
export function createResponseCache(
  cfg: CacheConfig,
  now: () => number = Date.now,
): ResponseCache {
  const store = new Map<string, { entry: CachedEntry; expiresAt: number }>();

  return {
    key(target, req) {
      const temperature = req.config?.temperature;
      if (
        temperature !== undefined &&
        temperature > 0 &&
        !cfg.ignoreTemperature
      ) {
        return undefined;
      }
      return cacheKey(target, req);
    },

    get(key) {
      const slot = store.get(key);
      if (slot === undefined) return undefined;
      if (now() >= slot.expiresAt) {
        store.delete(key);
        return undefined;
      }
      // LRU touch — reinsert at the tail.
      store.delete(key);
      store.set(key, slot);
      return slot.entry;
    },

    set(key, entry) {
      store.delete(key);
      while (store.size >= cfg.maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
      store.set(key, {
        entry: structuredClone(entry),
        expiresAt: now() + cfg.ttlMs,
      });
    },
  };
}

/**
 * The first cached entry for `canonical` on any of `targets`, in plan
 * order (spec §3.5: a hit only for an identical canonical request to
 * the same target). Callers pass only the targets a cache may serve —
 * pass-through entries and unbridgeable requests are filtered upstream.
 */
export function probeCache(
  cache: ResponseCache,
  canonical: CanonicalRequest,
  targets: RouteTarget[],
): { target: RouteTarget; entry: CachedEntry } | undefined {
  for (const t of targets) {
    const key = cache.key(t, canonical);
    if (key === undefined) continue;
    const hit = cache.get(key);
    if (hit !== undefined) return { target: t, entry: hit };
  }
  return undefined;
}

/**
 * §3.5 never-cache, response shape: only a tool call cut short by the
 * token cap (`finishReason: "length"` with calls present) is unsafe to
 * replay — a plain `length` finish is complete text and may cache.
 */
export function isCacheableResponse(resp: CanonicalResponse): boolean {
  return !(
    resp.finishReason === "length" &&
    (resp.message.toolCalls?.length ?? 0) > 0
  );
}

/**
 * §3.5 never-cache, stream shape: only a COMPLETE stream may be stored
 * — the last event is `message_end` (no `error` anywhere, no abort
 * truncation) and it didn't cut a tool call short on the token cap.
 */
export function isCacheableEvents(events: CanonicalStreamEvent[]): boolean {
  const last = events.at(-1);
  if (last?.type !== "message_end") return false;
  if (events.some((e) => e.type === "error")) return false;
  if (
    last.finishReason === "length" &&
    events.some((e) => e.type === "tool_call_start")
  ) {
    return false;
  }
  return true;
}

/**
 * The stored entry as a canonical response: a `{response}` entry
 * deep-copied (the caller re-shapes it for its own client), an
 * `{events}` entry folded back with reassembleStream — a stored
 * sequence is always complete (isCacheableEvents ran at set), so the
 * fold never meets an error or mid-stream truncation.
 */
export function entryResponse(entry: CachedEntry): CanonicalResponse {
  return "response" in entry
    ? structuredClone(entry.response)
    : reassembleStream(entry.events);
}

/**
 * The stored entry as a canonical event sequence: an `{events}` entry
 * verbatim (still pre-client-shaping — the caller applies its own
 * transforms), a `{response}` entry replayed as the stream that would
 * have produced it — message_start, one block per content part and
 * tool call, usage, message_end. Content-part and tool-call indices
 * follow the spec §3.1 event rules.
 */
export function entryEvents(entry: CachedEntry): CanonicalStreamEvent[] {
  if ("events" in entry) return entry.events;
  const resp = entry.response;
  const events: CanonicalStreamEvent[] = [
    { type: "message_start", id: resp.id, model: resp.model },
  ];
  const parts: CanonicalContentPart[] =
    typeof resp.message.content === "string"
      ? [{ type: "text", text: resp.message.content }]
      : resp.message.content;
  let reasoningIndex = 0;
  for (const part of parts) {
    if (part.type === "text") {
      events.push({ type: "text_delta", text: part.text ?? "" });
      if (part.signature !== undefined) {
        events.push({ type: "text_signature", signature: part.signature });
      }
    } else if (part.type === "reasoning" && part.reasoning !== undefined) {
      const index = reasoningIndex++;
      events.push({
        type: "reasoning_start",
        index,
        origin: part.reasoning.origin,
        ...(part.reasoning.redacted === true ? { redacted: true } : {}),
      });
      if (part.reasoning.text !== undefined) {
        events.push({
          type: "reasoning_delta",
          index,
          text: part.reasoning.text,
        });
      }
      if (part.signature !== undefined) {
        events.push({
          type: "reasoning_signature",
          index,
          signature: part.signature,
        });
      }
    }
  }
  for (const [index, call] of (resp.message.toolCalls ?? []).entries()) {
    events.push({
      type: "tool_call_start",
      index,
      id: call.id,
      name: call.function.name,
      ...(call.function.namespace !== undefined
        ? { namespace: call.function.namespace }
        : {}),
      ...(call.custom === true ? { custom: true } : {}),
      ...(call.signature !== undefined ? { signature: call.signature } : {}),
    });
    events.push({
      type: "tool_call_delta",
      index,
      argumentsDelta: call.function.arguments,
    });
    events.push({ type: "tool_call_end", index });
  }
  if (resp.usage !== undefined) {
    events.push({ type: "usage", usage: resp.usage });
  }
  events.push({ type: "message_end", finishReason: resp.finishReason });
  return events;
}
