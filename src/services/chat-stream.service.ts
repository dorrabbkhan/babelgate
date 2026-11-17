import { adapters } from "../transformers";
import type { Hop } from "../routing/route-log";
import { finishTrace } from "../observe/emit";
import type { StreamEncoder } from "../types/canonical.types";
import { runStreamPipeline } from "./stream-pipeline";
import {
  attemptTargets,
  errorTraceFields,
  type AttemptResult,
} from "./attempt-targets";
import {
  attemptStreamTarget,
  finishStreamTrace,
  observedDecoder,
  stampTtfb,
  type UpstreamAttempt,
} from "./stream-attempt";
import {
  assertBridgeableBody,
  finishPassthroughTrace,
  isPassthrough,
  passthroughStreamAttempt,
  type PassthroughStreamAttempt,
} from "./passthrough";
import {
  relayResponseHeaders,
  relayResponsesStream,
  type PassthroughObservation,
} from "./passthrough-relay";
import type { ChatInput } from "./chat.service";
import type { ProxyResult } from "./proxy.service";

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
        // §3.4: a `type: responses` entry on a responses source is
        // pass-through — the request is relayed, never encoded.
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

  const signal = opts?.signal ?? new AbortController().signal;

  // §3.4: a won pass-through hop relays the upstream SSE byte for
  // byte — `response.model` restored inside the five lifecycle
  // events only — never through the canonical pipeline.
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
        for await (const chunk of relayResponsesStream({
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
        "x-babelgate-attempts": String(pt.hops.length),
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
      "x-babelgate-attempts": String(bridged.hops.length),
    },
  };
}
