import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from "prom-client";
import { getConfig } from "../../config/env-config";
import type { Provider } from "../../transformers";
import { registerSink, type TraceSink } from "../emit";
import type { RequestTrace } from "../trace";

/**
 * The metrics sink (spec §3.8): one Prometheus registry holding the
 * babelgate_* families plus the Node process defaults. The route in
 * app.ts serves registry.metrics() as the text exposition. Labels
 * carry only routing/usage facts — provider, routed model, client
 * kind, status and codes — never prompt text, completions, tool
 * arguments or keys, so a scraper learns nothing a trace does not
 * already log.
 */

/** §3.8: at most 100 distinct values per label, then "other". */
const LABEL_CAP = 100;
const labelValues = new Map<string, Set<string>>();

/**
 * Keep one label's cardinality bounded: values already seen pass
 * through unchanged; once 100 distinct values exist, anything new is
 * reported as "other". The budget is process-wide — a registry reset
 * resets it too (resetMetricsSink).
 */
export function capLabel(name: string, value: string): string {
  let seen = labelValues.get(name);
  if (seen === undefined) {
    seen = new Set();
    labelValues.set(name, seen);
  }
  if (seen.has(value)) return value;
  if (seen.size >= LABEL_CAP) return "other";
  seen.add(value);
  return value;
}

export interface MetricsSink extends TraceSink {
  registry: Registry;
  /** §3.8 aux counter — count_tokens and model-list requests. */
  incAux(source: Provider, kind: "count_tokens" | "models"): void;
  /** §3.8 sink-error counter — called via emit.reportSinkError. */
  incSinkError(sink: string): void;
}

/** The winning hop, or the last attempted one when nothing won. */
function routedHop(trace: RequestTrace) {
  return (
    [...trace.hops].reverse().find((h) => h.outcome === "ok") ??
    trace.hops[trace.hops.length - 1]
  );
}

export function createMetricsSink(): MetricsSink {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requests = new Counter({
    name: "babelgate_requests_total",
    help: "Chat requests by source, routed provider/model, client and status",
    labelNames: ["source", "provider", "model", "client", "status"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "babelgate_request_duration_seconds",
    help: "End-to-end chat request duration",
    labelNames: ["source", "provider", "status"],
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });
  const ttfb = new Histogram({
    name: "babelgate_ttfb_seconds",
    help: "Time to first byte of the routed upstream response",
    labelNames: ["source", "provider", "status"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const tokens = new Counter({
    name: "babelgate_tokens_total",
    help: "Tokens by kind",
    labelNames: ["provider", "model", "client", "kind"],
    registers: [registry],
  });
  const cost = new Counter({
    name: "babelgate_cost_usd_total",
    help: "Request cost in USD",
    labelNames: ["provider", "model", "client"],
    registers: [registry],
  });
  const fallbacks = new Counter({
    name: "babelgate_fallbacks_total",
    help: "Fallback edges — one per hop attempted after a failure",
    labelNames: ["from_provider", "outcome"],
    registers: [registry],
  });
  const toolFailures = new Counter({
    name: "babelgate_tool_call_failures_total",
    help: "Diagnosed tool-call problems by code",
    labelNames: ["provider", "model", "code"],
    registers: [registry],
  });
  const toolRepairs = new Counter({
    name: "babelgate_tool_call_repairs_total",
    help: "Tool-call repair steps applied",
    labelNames: ["provider", "model", "code"],
    registers: [registry],
  });
  const unpriced = new Counter({
    name: "babelgate_unpriced_requests_total",
    help: "Routed requests with no price (costUsd null)",
    labelNames: ["model"],
    registers: [registry],
  });
  const sinkErrors = new Counter({
    name: "babelgate_sink_errors_total",
    help: "Trace-sink failures — dropped traces, batches and prunes",
    labelNames: ["sink"],
    registers: [registry],
  });
  const aux = new Counter({
    name: "babelgate_aux_requests_total",
    help: "Non-chat requests — count_tokens and model lists",
    labelNames: ["source", "kind"],
    registers: [registry],
  });

  return {
    name: "metrics",
    registry,

    accept(trace: RequestTrace): void {
      const winner = [...trace.hops]
        .reverse()
        .find((h) => h.outcome === "ok");
      const hop = winner ?? routedHop(trace);
      const source = capLabel("source", trace.sourceApi);
      const provider = capLabel("provider", hop?.provider ?? "");
      const model = capLabel("model", hop?.model ?? "");
      const client = capLabel("client", trace.client);
      const status = capLabel("status", trace.status);

      requests.inc({ source, provider, model, client, status });
      duration.observe({ source, provider, status }, trace.totalMs / 1000);
      if (trace.ttfbMs !== undefined) {
        ttfb.observe({ source, provider, status }, trace.ttfbMs / 1000);
      }

      // Tokens, cost and the unpriced counter belong to the routed
      // (winning) hop — a request that won nothing has no routed
      // model to price.
      if (winner !== undefined) {
        const kinds: [string, number | undefined][] = [
          ["input", trace.inputTokens],
          ["output", trace.outputTokens],
          ["cache_read", trace.cacheReadTokens],
          ["cache_write", trace.cacheWriteTokens],
        ];
        for (const [kind, value] of kinds) {
          if (value !== undefined && value > 0) {
            tokens.inc({ provider, model, client, kind }, value);
          }
        }
        if (trace.costUsd !== null) {
          cost.inc({ provider, model, client }, trace.costUsd);
        } else {
          unpriced.inc({ model });
        }
      }

      // Each hop attempted after a failure is one fallback edge,
      // labelled with the outcome of the hop fallen back to.
      for (let i = 1; i < trace.hops.length; i++) {
        fallbacks.inc({
          from_provider: capLabel(
            "from_provider",
            trace.hops[i - 1]!.provider,
          ),
          outcome: capLabel("outcome", trace.hops[i]!.outcome),
        });
      }

      for (const d of trace.diagnostics) {
        toolFailures.inc({ provider, model, code: capLabel("code", d.code) });
      }
      for (const r of trace.repairs) {
        for (const step of r.steps) {
          toolRepairs.inc({ provider, model, code: capLabel("code", step) });
        }
      }
    },

    incAux(sourceApi: Provider, kind: "count_tokens" | "models"): void {
      aux.inc({ source: capLabel("source", sourceApi), kind });
    },

    incSinkError(sink: string): void {
      sinkErrors.inc({ sink: capLabel("sink", sink) });
    },
  };
}

let singleton: MetricsSink | undefined;

/**
 * The process-wide metrics sink (spec §3.8), created on first call —
 * app.ts scrapes its registry, proxy.service counts aux requests and
 * emit.ts counts sink errors through it. `observe.metrics` off →
 * undefined everywhere and no prom-client objects exist. Registered
 * as a trace sink on every call so a resetSinks() never detaches it.
 */
export function getMetricsSink(): MetricsSink | undefined {
  if (!getConfig().observe.metrics) return undefined;
  singleton ??= createMetricsSink();
  registerSink(singleton);
  return singleton;
}

/** Test helper: forget the singleton and the label-cap state. */
export function resetMetricsSink(): void {
  singleton = undefined;
  labelValues.clear();
}
