import {
  adapters,
  PROVIDER_ROUTES,
} from "../transformers";
import type { GatewayConfig } from "../config/env-config";
import type { ProviderEntry } from "../routing/registry";
import { authHeaders } from "../routing/registry";
import type { RouteTarget } from "../routing/plan-route";
import {
  currentTrace,
  runWithAttempt,
  snapshot,
  type AttemptContext,
} from "../observe/context";
import { finishTrace } from "../observe/emit";
import { diagnoseToolCalls } from "../observe/tool-diagnostics";
import { createRepairTransform } from "../observe/tool-repair-stream";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  StreamDecoder,
} from "../types/canonical.types";
import { UpstreamError } from "../utils/errors";
import {
  estimateInputTokens,
  estimateOutputTokens,
} from "../utils/token-estimate";
import type { UpstreamStreamResponse } from "./http-client";
import { postStream } from "./http-client";
import { reassembleStream } from "../utils/stream-reassemble";
import {
  canonicalForTarget,
  maxTokensClampOf,
  toClientFacing,
  type AttemptResult,
} from "./attempt-targets";

/** The pieces of a won stream attempt: response stream, abort handle, decoder. */
export interface UpstreamAttempt {
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
export function attemptStreamTarget(
  canonical: CanonicalRequest,
  config: GatewayConfig,
  requestId: string,
  signal: AbortSignal | undefined,
) {
  return async (
    entry: ProviderEntry,
    target: RouteTarget,
  ): Promise<UpstreamAttempt> => {
    // v1.4 §3.2: the attempt's provider name and upstream model are
    // ambient for its encode and upstream call — every hop gets its
    // own scope. The decoder's feed/end run later, in the pipeline's
    // async scope, so they re-enter this attempt's context on every
    // call rather than relying on ambient propagation.
    const attempt: AttemptContext = {
      providerName: target.provider,
      upstreamModel: target.model,
    };
    return runWithAttempt(attempt, async () => {
      const raw = adapters[entry.type].createStreamDecoder(target.model);
      const decoder: StreamDecoder = {
        feed: (chunk) => runWithAttempt(attempt, () => raw.feed(chunk)),
        end: () => runWithAttempt(attempt, () => raw.end()),
      };
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
    });
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
export function observedDecoder(
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
export async function finishStreamTrace(opts: {
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
export function stampTtfb(): void {
  const trace = currentTrace();
  if (trace !== undefined && trace.ttfbMs === undefined) {
    trace.ttfbMs = Date.now() - trace.startedAt;
  }
}
