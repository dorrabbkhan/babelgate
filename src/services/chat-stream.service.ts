import { adapters } from "../transformers";
import type { Hop } from "../routing/route-log";
import { finishTrace } from "../observe/emit";
import type { StreamEncoder } from "../types/canonical.types";
import { runStreamPipeline } from "./stream-pipeline";
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
