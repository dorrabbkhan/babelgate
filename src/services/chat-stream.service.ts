import {
  adapters,
  PROVIDER_ROUTES,
} from "../transformers";
import { authHeaders } from "../routing/registry";
import { logRoute, type Hop } from "../routing/route-log";
import type {
  CanonicalStreamEvent,
  StreamDecoder,
} from "../types/canonical.types";
import { UpstreamError } from "../utils/errors";
import { postStream } from "./http-client";
import { runStreamPipeline } from "./stream-pipeline";
import {
  attemptTargets,
  canonicalForTarget,
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

  const encoder = adapters[source].createStreamEncoder({
    sourceRequest: sourceBody,
    query: opts?.query ?? {},
    requestedModel,
  });

  const hops: Hop[] = [];
  let result;
  try {
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
    logRoute({
      requestId,
      sourceApi: source,
      requestedModel,
      reason: plan.reason,
      hops,
      stream: true,
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

  const chunks = (async function* (): AsyncGenerator<string> {
    try {
      yield* runStreamPipeline({
        upstream: upstream.body,
        decoder: recordingDecoder,
        encoder,
        idleMs: result.entry.streamIdleMs ?? config.upstreamStreamIdleMs,
        signal,
      });
    } finally {
      // Whatever ended the pipe — terminal event, in-stream error,
      // client disconnect — the upstream request is done with, and the
      // route log line goes out exactly once (spec §3.4).
      upstreamAc.abort();
      const last = observed.at(-1);
      const usageEvent = observed.find((e) => e.type === "usage");
      logRoute({
        requestId,
        sourceApi: source,
        requestedModel,
        reason: plan.reason,
        hops: result.hops,
        winner: result.target.provider,
        stream: true,
        inputTokens:
          usageEvent?.type === "usage"
            ? usageEvent.usage.inputTokens
            : undefined,
        outputTokens:
          usageEvent?.type === "usage"
            ? usageEvent.usage.outputTokens
            : undefined,
        finishReason:
          last?.type === "message_end" ? last.finishReason : undefined,
      });
    }
  })();

  return {
    stream: { contentType: encoder.contentType, chunks },
    headers: {
      "x-babelgate-provider": result.target.provider,
      "x-babelgate-model": result.target.model,
      "x-babelgate-attempts": String(result.hops.length),
    },
  };
}
