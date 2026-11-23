import { adapters } from "../transformers";
import type { Hop } from "../routing/route-log";
import { finishTrace } from "../observe/emit";
import type { StreamEncoder } from "../types/canonical.types";
import { runStreamPipeline } from "./stream-pipeline";
import {
  attemptTargets,
  errorTraceFields,
  maxTokensClampOf,
  type AttemptCtx,
  type AttemptResult,
} from "./attempt-targets";
import {
  attemptStreamTarget,
  finishStreamTrace,
  observedDecoder,
  snapshotStreamResponse,
  stampTtfb,
  streamEventTransforms,
  type UpstreamAttempt,
} from "./stream-attempt";
import {
  assertBridgeableBody,
  isPassthrough,
  passthroughRelay,
  passthroughStreamAttempt,
  type PassthroughStreamAttempt,
} from "./passthrough";
import {
  finishPassthroughTrace,
  markFailedPassthroughHop,
} from "./passthrough-trace";
import {
  relayResponseHeaders,
  type PassthroughObservation,
} from "./passthrough-relay";
import type { ChatInput } from "./chat.service";
import { probeRequestCache } from "./chat-cache.service";
import type { ProxyResult } from "./proxy.service";
import {
  entryEvents,
  isCacheableEvents,
  type CachedEntry,
} from "./response-cache";
import type { RouteTarget } from "../routing/plan-route";
import type { CanonicalStreamEvent } from "../types/canonical.types";
import { logger } from "../utils/logger";

export { streamCanonical } from "./canonical-stream.service";
export type { StreamCanonicalContext } from "./canonical-stream.service";

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
  const attemptCtx: AttemptCtx = {
    requestId,
    signal: opts?.signal,
    hops,
  };
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
    // §3.5: an enabled cache answers before any upstream call — the
    // stored event sequence (or a unary reply replayed as one) is
    // pushed through this client's own transforms and encoder.
    const cached = probeRequestCache(input);
    if (cached !== undefined) {
      try {
        return streamCacheHit(input, cached, encoder);
      } catch (err) {
        logger.debug(
          { requestId, err },
          "Cache hit could not be replayed — fetching fresh",
        );
      }
    }
    const bridgedAttempt = attemptStreamTarget(
      canonical,
      config,
      requestId,
      opts?.signal,
      { source, sourceBody },
    );
    result = await attemptTargets(
      plan,
      config.registry,
      (entry, target) => {
        // §3.4/§3.3: a same-format pass-through entry relays the
        // request verbatim — it is never encoded.
        if (isPassthrough(source, entry)) {
          return passthroughStreamAttempt(entry, target, {
            sourceBody,
            canonical,
            config,
            requestId,
            signal: opts?.signal,
          });
        }
        // §2.2: responses-lite bodies are pass-through-only — on the
        // bridge each marker is a 400 naming the item.
        if (source === "responses") {
          assertBridgeableBody(sourceBody);
        }
        // §3.4: the canonical couldn't be validated — it could only
        // have been relayed, never encoded.
        if (input.deferredValidation !== undefined) {
          throw input.deferredValidation;
        }
        return bridgedAttempt(entry, target);
      },
      attemptCtx,
      config.breakers,
    );
  } catch (err) {
    // v1.5 follow-up: same marking as chat.service — a failed
    // pass-through attempt is not a translated request. A client
    // abort records no hop; the in-flight entry answers instead.
    markFailedPassthroughHop(
      source,
      hops,
      config.registry,
      opts?.signal?.aborted === true ? attemptCtx.inFlight : undefined,
    );
    await finishTrace({
      reason: plan.reason,
      requestedModel,
      hops,
      stream: true,
      ...errorTraceFields(err, opts?.signal?.aborted === true),
    });
    throw err;
  }

  const signal = opts?.signal ?? new AbortController().signal;

  // §3.4/§3.3: a won pass-through hop relays the upstream SSE byte
  // for byte — the dialect's model restored in its model-bearing
  // frames only — never through the canonical pipeline.
  if (isPassthrough(source, result.entry)) {
    const pt = result as AttemptResult<PassthroughStreamAttempt>;
    const observation: PassthroughObservation = {};
    let ptIterated = false;
    const ptFinish = async (clientStatus?: number): Promise<void> =>
      finishPassthroughTrace({
        reason: plan.reason,
        requestedModel,
        canonical,
        result: pt,
        observation,
        signal,
        iterated: ptIterated,
        clientStatus,
      });
    const ptChunks = (async function* (): AsyncGenerator<string> {
      try {
        ptIterated = true;
        // §3.3: the entry's own dialect relay — responses relays the
        // lifecycle events, anthropic restores `message.model` in
        // message_start, chat restores every chunk's `model` and the
        // `data: [DONE]` terminator rides through verbatim.
        for await (const chunk of passthroughRelay(pt.entry)({
          upstream: pt.value.upstream.body,
          upstreamHeaders: pt.value.upstream.headers,
          requestedModel,
          idleMs: pt.entry.streamIdleMs ?? config.upstreamStreamIdleMs,
          signal,
          observation,
        })) {
          stampTtfb();
          yield chunk;
        }
      } finally {
        await ptFinish();
      }
    })();
    return {
      stream: {
        contentType:
          pt.value.upstream.contentType ?? "text/event-stream",
        chunks: ptChunks,
        finish: ptFinish,
      },
      headers: {
        ...relayResponseHeaders(pt.value.upstream.headers),
        "x-babelgate-provider": pt.target.provider,
        "x-babelgate-model": pt.target.model,
        "x-babelgate-attempts": String(pt.attempts),
      },
    };
  }

  const bridged = result as AttemptResult<UpstreamAttempt>;
  const { upstream } = bridged.value;
  const { pipelineDecoder, observed } = observedDecoder(
    bridged.value.decoder,
    bridged.entry.repairToolCalls === true,
    canonical,
  );

  // §3.5: the winning target's key — the stream is stored under it
  // once the reply completes (a complete stream only, decided at
  // finish); undefined when the request is never cached.
  const winKey = config.cache?.key(bridged.target, canonical);

  // True once the route starts consuming chunks — which it only does
  // after flushing headers, so iterated implies the client got the 200
  // status line.
  let iterated = false;

  const finish = async (clientStatus?: number): Promise<void> => {
    await finishStreamTrace({
      reason: plan.reason,
      requestedModel,
      canonical,
      result: bridged,
      observed,
      signal,
      iterated,
      clientStatus,
    });
    // §3.5: store only a complete, error-free stream — the pre-
    // transform events, so a later hit re-shapes them for its client.
    if (winKey !== undefined && isCacheableEvents(observed)) {
      config.cache!.set(winKey, { events: observed });
    }
  };

  const chunks = (async function* (): AsyncGenerator<string> {
    try {
      iterated = true;
      for await (const chunk of runStreamPipeline({
        upstream: upstream.body,
        decoder: pipelineDecoder,
        encoder,
        idleMs: bridged.entry.streamIdleMs ?? config.upstreamStreamIdleMs,
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
      "x-babelgate-provider": bridged.target.provider,
      "x-babelgate-model": bridged.target.model,
      "x-babelgate-attempts": String(bridged.attempts),
    },
  };
}

/**
 * §3.5: serve a stream cache hit — the stored pre-transform event
 * sequence (a stored unary reply is replayed as the stream that would
 * have produced it) is pushed through this entry's own transform
 * chain and the client's stream encoder, so the replay is what a
 * live decode would have produced, whatever the source format. The
 * trace marks `cacheHit`, the row prices $0, and
 * `x-babelgate-attempts: 0` says no upstream was called.
 */
function streamCacheHit(
  input: ChatInput,
  hit: { target: RouteTarget; entry: CachedEntry },
  encoder: StreamEncoder,
): ProxyResult {
  const { canonical, requestedModel, plan, config, opts } = input;
  const entry = config.registry.get(hit.target.provider);
  const stored = entryEvents(hit.entry);
  const expand = streamEventTransforms(
    canonical,
    entry.repairToolCalls === true,
  );
  const signal = opts?.signal ?? new AbortController().signal;
  const hops: Hop[] = [
    {
      provider: hit.target.provider,
      model: hit.target.model,
      outcome: "ok",
      ms: 0,
    },
  ];
  const last = stored.at(-1);
  const usageEvent = stored.find((e) => e.type === "usage");
  const usage =
    usageEvent?.type === "usage" ? usageEvent.usage : undefined;

  // finishStreamTrace's rules for a stream that never went upstream:
  // iterated means the route consumed chunks (the client got the 200);
  // otherwise clientStatus is the status the client actually saw.
  let iterated = false;
  const finish = async (clientStatus?: number): Promise<void> => {
    // Same ring snapshot + diagnostics a live stream's finish takes.
    snapshotStreamResponse(requestedModel, canonical, stored);
    await finishTrace({
      reason: plan.reason,
      requestedModel,
      hops,
      winner: hit.target.provider,
      stream: true,
      status: signal.aborted ? "aborted" : !iterated ? "error" : "ok",
      httpStatus: iterated
        ? 200
        : signal.aborted
          ? 499
          : (clientStatus ?? 500),
      cacheHit: true,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheWriteTokens: usage?.cacheWriteTokens,
      reasoningTokens: usage?.reasoningTokens,
      finishReason:
        last?.type === "message_end" ? last.finishReason : undefined,
      maxTokensClamp: maxTokensClampOf(canonical, entry),
    });
  };

  const chunks = (async function* (): AsyncGenerator<string> {
    try {
      iterated = true;
      for (const event of stored) {
        for (const out of expand([event])) {
          const encoded = encoder.encode(out);
          if (encoded !== "") {
            stampTtfb();
            yield encoded;
          }
        }
      }
      if (!signal.aborted) {
        const tail = encoder.end();
        if (tail !== "") yield tail;
      }
    } finally {
      await finish();
    }
  })();

  return {
    stream: { contentType: encoder.contentType, chunks, finish },
    headers: {
      "x-babelgate-provider": hit.target.provider,
      "x-babelgate-model": hit.target.model,
      "x-babelgate-attempts": "0",
      "x-babelgate-cache": "hit",
    },
  };
}
