/**
 * Pass-through trace finishes (v1.4 spec §3.4, v1.5 spec §3.3):
 * how a won pass-through hop — unary or streamed — turns the
 * relay's observation into the request's single trace. Split from
 * passthrough.ts (rule 7): that file owns the routing decision,
 * request body and count_tokens forwarding; this one owns
 * observation → trace. Usage comes from the dialect's own channel —
 * the terminal lifecycle event's `response.usage` on responses, the
 * observer decoder's canonical `usage` event on anthropic/chat — so
 * no second wire-format field map exists anywhere.
 */
import type {
  ProviderEntry,
  ProviderRegistry,
} from "../routing/registry";
import type { Hop } from "../routing/route-log";
import { adapters, type Provider } from "../transformers";
import { currentTrace, recordNote, snapshot } from "../observe/context";
import { finishTrace } from "../observe/emit";
import {
  estimateInputTokens,
  estimateOutputTokens,
} from "../utils/token-estimate";
import { diagnoseToolCalls } from "../observe/tool-diagnostics";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalToolCall,
} from "../types/canonical.types";
import type { UpstreamResponse } from "./http-client";
import {
  relayResponseHeaders,
  type PassthroughObservation,
} from "./passthrough-relay";
import {
  maxTokensClampOf,
  type AttemptResult,
} from "./attempt-targets";
import {
  isPassthrough,
  type PassthroughStreamAttempt,
} from "./passthrough";
import type { ProxyResult } from "./proxy.service";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

// ============ Trace finishes ============

interface ObservedReply {
  calls?: CanonicalToolCall[];
  usage?: CanonicalResponse["usage"];
  finishReason?: CanonicalResponse["finishReason"];
}

/**
 * One pass-through reply body → the canonical read the trace needs
 * (usage, finishReason, tool calls). This is the ENTRY adapter's own
 * response codec — the field map never drifts from the bridged path
 * — run purely as observation: its `field_dropped` notes describe a
 * translation that never happened and are cleared with the rest by
 * markPassthrough. A body the codec can't read (a proxy relayed
 * something nonstandard) yields nothing rather than failing the
 * reply the client already has.
 */
function observeBody(body: unknown, entry: ProviderEntry): ObservedReply {
  try {
    const decoded = adapters[entry.type].toCanonicalResponse(
      body,
      "unused",
    );
    return {
      calls: decoded.message.toolCalls,
      usage: decoded.usage,
      finishReason: decoded.finishReason,
    };
  } catch {
    return {};
  }
}

/**
 * `observation.events` — the canonical events the anthropic/chat
 * dialect's observer decoder produced from the relayed bytes → the
 * same read. Best-effort: events are scanned, never re-validated,
 * so a partial stream contributes whatever arrived (a `usage` or
 * `message_end` event only exists when the corresponding wire
 * terminator already reached the client — both decoders hold them
 * until message_stop / [DONE]).
 */
function observeStreamEvents(
  events: CanonicalStreamEvent[] | undefined,
): ObservedReply {
  if (events === undefined) return {};
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let usage: ObservedReply["usage"];
  let finishReason: ObservedReply["finishReason"];
  for (const event of events) {
    switch (event.type) {
      case "tool_call_start":
        calls.set(event.index, {
          id: event.id,
          name: event.name,
          args: "",
        });
        break;
      case "tool_call_delta": {
        const call = calls.get(event.index);
        if (call !== undefined) call.args += event.argumentsDelta;
        break;
      }
      case "usage":
        usage = event.usage;
        break;
      case "message_end":
        finishReason = event.finishReason;
        break;
    }
  }
  return {
    calls: [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    usage,
    finishReason,
  };
}

/**
 * A pass-through trace is marked `passthrough: true` and carries no
 * canonical artefacts: the routing decode's notes describe
 * transforms that never ran, and the `canonical` body stage (taken
 * before routing, for the bridged hop that never came) is removed —
 * the inspector shows source, target and response.wire only.
 */
export function markPassthrough(entry: ProviderEntry): void {
  const trace = currentTrace();
  if (trace === undefined) return;
  // The routing decode's notes describe transforms that never ran —
  // sweep them. Gap-fix notes recorded during the attempt carry the
  // "encode" stage and stay (v1.5 spec §3.3, Task 9).
  trace.notes = trace.notes.filter((n) => n.stage !== "decode");
  if (trace.bodies !== undefined) delete trace.bodies.canonical;
  trace.passthrough = true;
  // §3.3 (Task 15): the preset name rides the row so the inspector's
  // pass-through marker can name the shim endpoint that relayed.
  if (entry.preset !== undefined) trace.preset = entry.preset;
}

/**
 * The failure-path half of markPassthrough (v1.5 follow-up): when the
 * attempt loop's LAST recorded hop was a pass-through relay for this
 * source, the finished error/aborted trace is marked like a won one —
 * passthrough: true, the entry's preset, decode notes swept, no
 * canonical body stage — so a 500ing or timed-out shim call never
 * shows as a translated request. The last hop in the route record
 * decides: a fallback that died on a canonical entry keeps its
 * translated row.
 *
 * `abortedInFlight` covers the one case an empty record lies: a
 * client abort rethrows the attempt loop before the hop is recorded,
 * so the route record stays empty even though the request DID reach
 * an upstream. The services pass the attempt ctx's `inFlight` entry —
 * only when the abort signal actually fired (a pre-upstream failure
 * on a pass-through entry still means nothing reached it). With the
 * record empty and no abort, the original rule stands: nothing
 * reached an upstream.
 */
export function markFailedPassthroughHop(
  source: Provider,
  hops: Hop[],
  registry: ProviderRegistry,
  abortedInFlight?: ProviderEntry,
): void {
  // A skipped_open hop means nothing reached that target — the last
  // real hop is the last non-skipped one.
  const last = [...hops]
    .reverse()
    .find((h) => h.outcome !== "skipped_open");
  if (last === undefined) {
    if (
      abortedInFlight !== undefined &&
      isPassthrough(source, abortedInFlight)
    ) {
      markPassthrough(abortedInFlight);
    }
    return;
  }
  if (!registry.has(last.provider)) return;
  const entry = registry.get(last.provider);
  if (isPassthrough(source, entry)) markPassthrough(entry);
}

/** Unary pass-through finish: diagnostics + trace + the relayed body. */
export async function finishPassthroughUnary(opts: {
  reason: string;
  requestedModel: string;
  canonical: CanonicalRequest;
  result: AttemptResult<UpstreamResponse>;
}): Promise<ProxyResult> {
  const { result, requestedModel, canonical } = opts;
  // §3.5: the upstream JSON body lands in the ring.
  snapshot("response.wire", result.value.body);
  const upstreamBody = result.value.body;
  // §3.4: the non-stream reply is a JSON round-trip with `model`
  // restored — every other field is relayed unchanged.
  const body =
    upstreamBody !== null && typeof upstreamBody === "object"
      ? { ...(upstreamBody as Obj), model: requestedModel }
      : upstreamBody;
  const observed = observeBody(upstreamBody, result.entry);
  const trace = currentTrace();
  // §3.7: diagnostics run on the relayed function calls — repair is
  // never applied on pass-through (it would alter the bytes).
  trace?.diagnostics.push(
    ...diagnoseToolCalls(observed.calls ?? [], canonical.tools),
  );
  markPassthrough(result.entry);
  const usage = observed.usage;
  await finishTrace({
    reason: opts.reason,
    requestedModel,
    hops: result.hops,
    winner: result.target.provider,
    stream: false,
    status: "ok",
    httpStatus: 200,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    reasoningTokens: usage?.reasoningTokens,
    finishReason: observed.finishReason,
    maxTokensClamp: maxTokensClampOf(canonical, result.entry),
    ttfbMs:
      trace === undefined ? undefined : Date.now() - trace.startedAt,
  });
  return {
    body,
    headers: {
      ...relayResponseHeaders(result.value.headers),
      "x-babelgate-provider": result.target.provider,
      "x-babelgate-model": result.target.model,
      "x-babelgate-attempts": String(result.attempts),
    },
  };
}

/**
 * Whatever ended a pass-through stream, the upstream request is done
 * with and the trace emits exactly once — aborted when the client
 * went away, error when the stream failed, ok otherwise. Usage comes
 * from the dialect's own observation channel — `response.completed`'s
 * `response.usage` on responses (§3.4), the observer decoder's usage
 * event on anthropic/chat — absent unless the wire terminator that
 * carries it already reached the client.
 */
export async function finishPassthroughTrace(opts: {
  reason: string;
  requestedModel: string;
  canonical: CanonicalRequest;
  result: AttemptResult<PassthroughStreamAttempt>;
  observation: PassthroughObservation;
  signal: AbortSignal;
  iterated: boolean;
  clientStatus?: number;
}): Promise<void> {
  const {
    reason,
    requestedModel,
    canonical,
    result,
    observation,
    signal,
    iterated,
    clientStatus,
  } = opts;
  result.value.upstreamAc.abort();
  const terminal = observation.terminal;
  const observed =
    terminal?.response !== undefined
      ? observeBody(terminal.response, result.entry)
      : observeStreamEvents(observation.events);
  // On responses only a `completed` reply counts; on anthropic/chat
  // the observer's usage event exists only when the wire terminator
  // carrying it (message_stop / [DONE]) already reached the client —
  // `terminal` is set on exactly those.
  const usage =
    result.entry.type === "responses"
      ? terminal?.type === "response.completed"
        ? observed.usage
        : undefined
      : terminal !== undefined
        ? observed.usage
        : undefined;
  const trace = currentTrace();
  trace?.diagnostics.push(
    ...diagnoseToolCalls(observed.calls ?? [], canonical.tools),
  );
  markPassthrough(result.entry);
  const failed =
    terminal?.type === "response.failed" ||
    observation.errorKind !== undefined;
  const status = signal.aborted
    ? ("aborted" as const)
    : !iterated
      ? ("error" as const)
      : failed
        ? ("error" as const)
        : ("ok" as const);
  // §3.3 (Task 9): a stream_usage gap whose upstream still sent no
  // usage chunk gets the chars/4 estimate — flagged estimated on the
  // trace, never presented as counted.
  const usageEstimated =
    result.entry.gaps?.includes("stream_usage") === true &&
    status === "ok" &&
    usage === undefined;
  if (usageEstimated) {
    recordNote(
      { stage: "encode", adapter: result.entry.type, code: "usage_estimated" },
      `stream_usage gap on "${result.target.provider}": usage estimated`,
    );
  }
  await finishTrace({
    reason,
    requestedModel,
    hops: result.hops,
    winner: result.target.provider,
    stream: true,
    status,
    ...(usageEstimated ? { costEstimated: true } : {}),
    httpStatus: iterated
      ? 200
      : signal.aborted
        ? 499
        : (clientStatus ?? 500),
    errorType:
      !signal.aborted && failed
        ? (observation.errorKind ?? "upstream")
        : undefined,
    inputTokens:
      usage?.inputTokens ??
      (usageEstimated ? estimateInputTokens(canonical) : undefined),
    outputTokens:
      usage?.outputTokens ??
      (usageEstimated
        ? estimateOutputTokens(observation.events ?? [])
        : undefined),
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    reasoningTokens: usage?.reasoningTokens,
    finishReason:
      result.entry.type === "responses"
        ? terminal?.type === "response.completed" ||
          terminal?.type === "response.incomplete"
          ? observed.finishReason
          : undefined
        : terminal !== undefined
          ? observed.finishReason
          : undefined,
    maxTokensClamp: maxTokensClampOf(canonical, result.entry),
  });
}
