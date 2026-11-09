import {
  adapters,
  PROVIDER_ROUTES,
} from "../transformers";
import type { GatewayConfig } from "../config/env-config";
import type { ProviderEntry } from "../routing/registry";
import { authHeaders } from "../routing/registry";
import type { RoutePlan, RouteTarget } from "../routing/plan-route";
import { planRoute } from "../routing/plan-route";
import type { Hop } from "../routing/route-log";
import { newTrace } from "../observe/trace";
import {
  currentTrace,
  runWithTrace,
  snapshot,
} from "../observe/context";
import { finishTrace, traceStarted } from "../observe/emit";
import { getBodyRing } from "../observe/sinks/body-ring";
import { diagnoseToolCalls } from "../observe/tool-diagnostics";
import { createRepairTransform } from "../observe/tool-repair-stream";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  StreamDecoder,
  StreamEncoder,
} from "../types/canonical.types";
import { UpstreamError } from "../utils/errors";
import {
  estimateInputTokens,
  estimateOutputTokens,
} from "../utils/token-estimate";
import type { UpstreamStreamResponse } from "./http-client";
import { postStream } from "./http-client";
import {
  runStreamPipeline,
  streamCanonicalEvents,
} from "./stream-pipeline";
import { reassembleStream } from "../utils/stream-reassemble";
import {
  attemptTargets,
  canonicalForTarget,
  errorTraceFields,
  maxTokensClampOf,
  toClientFacing,
  type AttemptResult,
} from "./attempt-targets";
import type { ChatInput } from "./chat.service";
import type { ProxyResult } from "./proxy.service";

/** The pieces of a won stream attempt: response stream, abort handle, decoder. */
interface UpstreamAttempt {
  upstream: UpstreamStreamResponse;
  upstreamAc: AbortController;
  decoder: StreamDecoder;
}

/**
 * The attempt callback both streaming services share (spec §3.2):
 * encode the canonical copy for this target, snapshot it (§3.5),
 * postStream to its stream endpoint. postStream resolves on response
 * headers, so this is what the §3.4 fallback decision hangs off: once
 * 2xx headers arrive the target is committed and mid-stream failures
 * end in an in-stream error, never a fallback. A Gemini target uses
 * the route's streamRequestPath (:streamGenerateContent?alt=sse);
 * the others stream on the chat path. Client disconnect aborts the
 * upstream request; upstreamAc lets the pipeline's end (terminal
 * event, failure) tear it down too — a bare body cancel doesn't reach
 * the request on every transport.
 */
function attemptStreamTarget(
  canonical: CanonicalRequest,
  config: GatewayConfig,
  requestId: string,
  signal: AbortSignal | undefined,
) {
  return async (
    entry: ProviderEntry,
    target: RouteTarget,
  ): Promise<UpstreamAttempt> => {
    const decoder = adapters[entry.type].createStreamDecoder(
      target.model,
    );
    const targetBody = adapters[entry.type].fromCanonicalRequest(
      canonicalForTarget(canonical, entry, target),
    );
    // §3.5: one target snapshot per hop (fallbacks included).
    snapshot("target", targetBody);
    const targetRoute = PROVIDER_ROUTES[entry.type].find(
      (r) => r.kind === "chat",
    )!;
    const url = `${entry.baseUrl}${
      targetRoute.streamRequestPath?.(target.model) ??
      targetRoute.requestPath(target.model)
    }`;

    const upstreamAc = new AbortController();
    const upstream = await postStream({
      url,
      headers: authHeaders(entry),
      body: targetBody,
      timeoutMs: entry.timeoutMs ?? config.upstreamTimeoutMs,
      retries: config.upstreamRetries,
      requestId,
      signal:
        signal !== undefined
          ? AbortSignal.any([signal, upstreamAc.signal])
          : upstreamAc.signal,
    }).catch((err) => {
      throw err instanceof UpstreamError
        ? toClientFacing(err, entry.type)
        : err;
    });

    return { upstream, upstreamAc, decoder };
  };
}

/**
 * Wrap the target decoder so every canonical event it produces lands
 * in `observed` (usage, finish reason, reassembly and tool-call
 * diagnostics all read it; chunk contents are never logged, §3.2).
 * §3.7: with repair_tool_calls on, argument deltas are held per call
 * and released merged (repaired when possible) before each end. The
 * transform sits AFTER the recording wrapper so `observed` — and the
 * diagnostics computed from it — see the original arguments.
 */
function observedDecoder(
  decoder: StreamDecoder,
  repair: boolean,
): { pipelineDecoder: StreamDecoder; observed: CanonicalStreamEvent[] } {
  const observed: CanonicalStreamEvent[] = [];
  const recordingDecoder: StreamDecoder = {
    feed(chunk) {
      const events = decoder.feed(chunk);
      observed.push(...events);
      return events;
    },
    end() {
      const events = decoder.end();
      observed.push(...events);
      return events;
    },
  };

  const repairTransform = repair ? createRepairTransform() : undefined;
  const pipelineDecoder: StreamDecoder =
    repairTransform === undefined
      ? recordingDecoder
      : {
          feed: (chunk) =>
            recordingDecoder.feed(chunk).flatMap(repairTransform),
          end: () => recordingDecoder.end().flatMap(repairTransform),
        };
  return { pipelineDecoder, observed };
}

/**
 * Whatever ended a stream — terminal event, in-stream error, client
 * disconnect — the upstream request is done with, and the trace is
 * emitted exactly once (spec §3.1): a client that went away
 * mid-stream is "aborted", an in-stream error is "error", everything
 * else "ok". httpStatus is the 200 the route flushed before the
 * stream started; when the route never iterated (a throw before the
 * for-await) the client got no stream — 499 if it went away, else
 * `clientStatus`, the status it actually received.
 */
async function finishStreamTrace(opts: {
  reason: string;
  requestedModel: string;
  canonical: CanonicalRequest;
  result: AttemptResult<UpstreamAttempt>;
  observed: CanonicalStreamEvent[];
  signal: AbortSignal;
  iterated: boolean;
  clientStatus?: number;
}): Promise<void> {
  const {
    reason,
    requestedModel,
    canonical,
    result,
    observed,
    signal,
    iterated,
    clientStatus,
  } = opts;
  result.value.upstreamAc.abort();
  // §3.5 + §3.7: reassemble the ORIGINAL events — the inspector
  // ring's canonical response (snapshot is a no-op with the ring
  // off) and the tool-call diagnostics the trace always gets. A
  // stream that ended mid-flight or on an error event doesn't
  // reassemble; its held calls were already released with a
  // diagnostic by the repair transform, and the wire tap still
  // shows what the upstream sent.
  try {
    const canonicalResp: CanonicalResponse =
      reassembleStream(observed);
    canonicalResp.model = requestedModel;
    snapshot("response.canonical", canonicalResp);
    const trace = currentTrace();
    if (trace !== undefined) {
      // Dedupe against diagnostics the repair transform already
      // recorded for held calls released at a terminal event.
      const seen = new Set(
        trace.diagnostics.map(
          (d) => `${d.toolCallId} ${d.code} ${d.detail ?? ""}`,
        ),
      );
      for (const d of diagnoseToolCalls(
        canonicalResp.message.toolCalls ?? [],
        canonical.tools,
      )) {
        if (!seen.has(`${d.toolCallId} ${d.code} ${d.detail ?? ""}`)) {
          trace.diagnostics.push(d);
        }
      }
    }
  } catch {
    // partial or errored streams have no canonical response
  }
  const last = observed.at(-1);
  const usageEvent = observed.find((e) => e.type === "usage");
  const status = signal.aborted
    ? ("aborted" as const)
    : !iterated
      ? ("error" as const)
      : last?.type === "error"
        ? ("error" as const)
        : ("ok" as const);
  const usage =
    usageEvent?.type === "usage" ? usageEvent.usage : undefined;
  // §3.6: a successful stream with no usage event is costed on the
  // local chars/4 estimate instead of real counts.
  const estimated = status === "ok" && usage === undefined;
  await finishTrace({
    reason,
    requestedModel,
    hops: result.hops,
    winner: result.target.provider,
    stream: true,
    status,
    httpStatus: iterated
      ? 200
      : signal.aborted
        ? 499
        : (clientStatus ?? 500),
    errorType:
      !signal.aborted && last?.type === "error"
        ? last.error.kind
        : undefined,
    inputTokens:
      usage?.inputTokens ??
      (estimated ? estimateInputTokens(canonical) : undefined),
    outputTokens:
      usage?.outputTokens ??
      (estimated ? estimateOutputTokens(observed) : undefined),
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    ...(estimated ? { costEstimated: true } : {}),
    finishReason:
      last?.type === "message_end" ? last.finishReason : undefined,
    maxTokensClamp: maxTokensClampOf(canonical, result.entry),
  });
}

/** §3.1: ttfb is the moment the first event goes to the client. */
function stampTtfb(): void {
  const trace = currentTrace();
  if (trace !== undefined && trace.ttfbMs === undefined) {
    trace.ttfbMs = Date.now() - trace.startedAt;
  }
}

/**
 * Streaming chat over a RoutePlan (spec §3.2): per target — encode the
 * canonical copy, postStream to its stream endpoint, pipe through
 * runStreamPipeline. The route log line and the x-babelgate-* reply
 * headers come from spec §3.4.
 */
export async function proxyChatStream(
  input: ChatInput,
): Promise<ProxyResult> {
  const {
    source,
    sourceBody,
    canonical,
    requestedModel,
    plan,
    config,
    requestId,
    opts,
  } = input;

  const hops: Hop[] = [];
  let encoder: StreamEncoder;
  let result;
  try {
    // Inside the try so a throwing encoder still finishes the trace
    // (hops is [] here — the request never reached an upstream).
    encoder = adapters[source].createStreamEncoder({
      sourceRequest: sourceBody,
      query: opts?.query ?? {},
      requestedModel,
    });
    result = await attemptTargets(
      plan,
      config.registry,
      attemptStreamTarget(
        canonical,
        config,
        requestId,
        opts?.signal,
      ),
      { requestId, signal: opts?.signal, hops },
    );
  } catch (err) {
    await finishTrace({
      reason: plan.reason,
      requestedModel,
      hops,
      stream: true,
      ...errorTraceFields(err, opts?.signal?.aborted === true),
    });
    throw err;
  }

  const { upstream } = result.value;
  const { pipelineDecoder, observed } = observedDecoder(
    result.value.decoder,
    result.entry.repairToolCalls === true,
  );

  const signal = opts?.signal ?? new AbortController().signal;

  // True once the route starts consuming chunks — which it only does
  // after flushing headers, so iterated implies the client got the 200
  // status line.
  let iterated = false;

  const finish = async (clientStatus?: number): Promise<void> => {
    await finishStreamTrace({
      reason: plan.reason,
      requestedModel,
      canonical,
      result,
      observed,
      signal,
      iterated,
      clientStatus,
    });
  };

  const chunks = (async function* (): AsyncGenerator<string> {
    try {
      iterated = true;
      for await (const chunk of runStreamPipeline({
        upstream: upstream.body,
        decoder: pipelineDecoder,
        encoder,
        idleMs: result.entry.streamIdleMs ?? config.upstreamStreamIdleMs,
        signal,
      })) {
        stampTtfb();
        yield chunk;
      }
    } finally {
      await finish();
    }
  })();

  return {
    stream: { contentType: encoder.contentType, chunks, finish },
    headers: {
      "x-babelgate-provider": result.target.provider,
      "x-babelgate-model": result.target.model,
      "x-babelgate-attempts": String(result.hops.length),
    },
  };
}

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
