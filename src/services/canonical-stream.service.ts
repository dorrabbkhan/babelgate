import type { GatewayConfig } from "../config/env-config";
import type { Hop } from "../routing/route-log";
import { planRoute } from "../routing/plan-route";
import { newTrace } from "../observe/trace";
import {
  runWithTrace,
  snapshot,
} from "../observe/context";
import { finishTrace, traceStarted } from "../observe/emit";
import { getBodyRing } from "../observe/sinks/body-ring";
import type {
  CanonicalRequest,
  CanonicalStreamEvent,
} from "../types/canonical.types";
import { estimateInputTokens } from "../utils/token-estimate";
import { streamCanonicalEvents } from "./stream-pipeline";
import {
  attemptTargets,
  errorTraceFields,
} from "./attempt-targets";
import {
  attemptStreamTarget,
  finishStreamTrace,
  observedDecoder,
  stampTtfb,
} from "./stream-attempt";

export interface StreamCanonicalContext {
  requestId: string;
  /** Client disconnect — aborts the upstream request */
  signal?: AbortSignal;
  /** The trace's client identity (spec §3.4). */
  client: "playground";
}

/**
 * planRoute → attempts → decode → canonical events (spec §3.9
 * playground): `proxyChatStream` without a source dialect. Runs inside
 * the per-model trace scope `streamCanonical` opens — snapshot,
 * recordNote, traceStarted and finishTrace all see it ambiently. A
 * pre-stream failure (all targets lost) finishes the trace and throws;
 * a mid-stream failure surfaces as the pipeline's `error` event.
 */
async function* canonicalAttemptStream(
  canonical: CanonicalRequest,
  requestedModel: string,
  config: GatewayConfig,
  ctx: StreamCanonicalContext,
): AsyncGenerator<CanonicalStreamEvent> {
  snapshot("canonical", canonical);
  traceStarted(requestedModel);
  const plan = planRoute({
    requestedModel,
    estimatedInputTokens: estimateInputTokens(canonical),
    routing: config.routing,
    providerNames: new Set(config.registry.names()),
  });
  const hops: Hop[] = [];
  let result;
  try {
    result = await attemptTargets(
      plan,
      config.registry,
      attemptStreamTarget(canonical, config, ctx.requestId, ctx.signal),
      { requestId: ctx.requestId, signal: ctx.signal, hops },
    );
  } catch (err) {
    await finishTrace({
      reason: plan.reason,
      requestedModel,
      hops,
      stream: true,
      ...errorTraceFields(err, ctx.signal?.aborted === true),
    });
    throw err;
  }

  const { upstream } = result.value;
  const { pipelineDecoder, observed } = observedDecoder(
    result.value.decoder,
    result.entry.repairToolCalls === true,
  );
  const signal = ctx.signal ?? new AbortController().signal;
  let iterated = false;

  try {
    for await (const event of streamCanonicalEvents({
      upstream: upstream.body,
      decoder: pipelineDecoder,
      idleMs: result.entry.streamIdleMs ?? config.upstreamStreamIdleMs,
      signal,
    })) {
      stampTtfb();
      iterated = true;
      yield event;
    }
  } finally {
    await finishStreamTrace({
      reason: plan.reason,
      requestedModel,
      canonical,
      result,
      observed,
      signal,
      iterated,
    });
  }
}

/**
 * The /ui playground's chat entry (spec §3.9): a canonical request in,
 * canonical stream events out, each call its own trace with
 * `client: "playground"`. The scope lives around the whole iteration:
 * an async generator's body sees the context of whichever frame calls
 * `next()`, so every pull — and the early-close `return()` — re-enters
 * `runWithTrace` rather than relying on the caller's context.
 * `sourceApi` is "playground": the request arrives already-canonical.
 */
export function streamCanonical(
  canonical: CanonicalRequest,
  requestedModel: string,
  config: GatewayConfig,
  ctx: StreamCanonicalContext,
): AsyncIterable<CanonicalStreamEvent> {
  const trace = newTrace({
    requestId: ctx.requestId,
    startedAt: Date.now(),
    client: ctx.client,
    sourceApi: "playground",
  });
  // §3.5: same ring rule as proxy.service — bodies only while the
  // inspector ring exists.
  if (getBodyRing() !== undefined) trace.bodies = { target: [] };

  const inner = runWithTrace(trace, () =>
    canonicalAttemptStream(canonical, requestedModel, config, ctx),
  );

  return (async function* (): AsyncGenerator<CanonicalStreamEvent> {
    try {
      for (;;) {
        const step = await runWithTrace(trace, () => inner.next());
        if (step.done === true) return;
        yield step.value;
      }
    } finally {
      // The consumer stopped early (client abort, done) — run the
      // inner generator's finally inside the scope so the trace is
      // still emitted exactly once.
      await runWithTrace(trace, () => inner.return(undefined));
    }
  })();
}
