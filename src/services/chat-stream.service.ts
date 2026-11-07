import {
  adapters,
  PROVIDER_ROUTES,
} from "../transformers";
import { authHeaders } from "../routing/registry";
import type { Hop } from "../routing/route-log";
import { currentTrace, snapshot } from "../observe/context";
import { finishTrace } from "../observe/emit";
import type {
  CanonicalStreamEvent,
  StreamDecoder,
  StreamEncoder,
} from "../types/canonical.types";
import { UpstreamError } from "../utils/errors";
import {
  estimateInputTokens,
  estimateOutputTokens,
} from "../utils/token-estimate";
import { postStream } from "./http-client";
import { runStreamPipeline } from "./stream-pipeline";
import { reassembleStream } from "../utils/stream-reassemble";
import {
  attemptTargets,
  canonicalForTarget,
  errorTraceFields,
  maxTokensClampOf,
  toClientFacing,
} from "./attempt-targets";
import type { ChatInput } from "./chat.service";
import type { ProxyResult } from "./proxy.service";

/**
 * Streaming chat over a RoutePlan (spec §3.2): per target — encode the
 * canonical copy, postStream to its stream endpoint, pipe through
 * runStreamPipeline. The postStream call resolves on response headers,
 * so the attempt is what the §3.4 fallback decision hangs off: once 2xx
 * headers arrive the target is committed and mid-stream failures end in
 * an in-stream error, never a fallback. A Gemini target uses the
 * route's streamRequestPath (:streamGenerateContent?alt=sse); the
 * others stream on the chat path.
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
      async (entry, target) => {
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

        // Client disconnect aborts the upstream request; upstreamAc lets
        // the pipeline's end (terminal event, failure) tear it down too —
        // a bare body cancel doesn't reach the request on every transport.
        const upstreamAc = new AbortController();
        const upstream = await postStream({
          url,
          headers: authHeaders(entry),
          body: targetBody,
          timeoutMs: entry.timeoutMs ?? config.upstreamTimeoutMs,
          retries: config.upstreamRetries,
          requestId,
          signal: opts?.signal
            ? AbortSignal.any([opts.signal, upstreamAc.signal])
            : upstreamAc.signal,
        }).catch((err) => {
          throw err instanceof UpstreamError
            ? toClientFacing(err, entry.type)
            : err;
        });

        return { upstream, upstreamAc, decoder };
      },
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

  const { upstream, upstreamAc, decoder } = result.value;

  // Watch the event stream for the route log line — the pipeline
  // yields only encoded bytes, so the decoder is wrapped. Chunk contents
  // are never logged (§3.2); only usage and the finish reason are.
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

  const signal = opts?.signal ?? new AbortController().signal;

  // True once the route starts consuming chunks — which it only does
  // after flushing headers, so iterated implies the client got the 200
  // status line.
  let iterated = false;

  /**
   * Whatever ended the pipe — terminal event, in-stream error, client
   * disconnect — the upstream request is done with, and the trace is
   * emitted exactly once (spec §3.1): a client that went away
   * mid-stream is "aborted", an in-stream error is "error", everything
   * else "ok". httpStatus is the 200 the route flushed before the
   * stream started; when the route never iterated (a throw before the
   * for-await) the client got no stream — 499 if it went away, else
   * `clientStatus`, the status it actually received.
   */
  const finish = async (clientStatus?: number): Promise<void> => {
    upstreamAc.abort();
    // §3.5: the reassembled response goes to the inspector ring — a
    // stream that ended mid-flight or on an error event doesn't
    // reassemble; the wire tap still shows what the upstream sent.
    // With the ring off (no trace bodies) reassembly is skipped too —
    // it only feeds the snapshot.
    if (currentTrace()?.bodies !== undefined) {
      try {
        const canonicalResp = reassembleStream(observed);
        canonicalResp.model = requestedModel;
        snapshot("response.canonical", canonicalResp);
      } catch {
        // partial or errored streams have no canonical response
      }
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
      reason: plan.reason,
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
  };

  const chunks = (async function* (): AsyncGenerator<string> {
    try {
      iterated = true;
      let ttfbSet = false;
      for await (const chunk of runStreamPipeline({
        upstream: upstream.body,
        decoder: recordingDecoder,
        encoder,
        idleMs: result.entry.streamIdleMs ?? config.upstreamStreamIdleMs,
        signal,
      })) {
        // §3.1: ttfb is the moment the first chunk goes to the client.
        if (!ttfbSet) {
          ttfbSet = true;
          const trace = currentTrace();
          if (trace !== undefined) {
            trace.ttfbMs = Date.now() - trace.startedAt;
          }
        }
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
