/**
 * Responses pass-through (v1.4 spec §3.4): when the source dialect is
 * Responses and the routed provider entry is `type: responses`, the
 * request is relayed to the upstream as-is — no canonical
 * transformation — with only `model` rewritten and `max_output_tokens`
 * clamped (the same clamp record the bridged path produces). The
 * reply is relayed byte for byte; `response.model` inside the five
 * lifecycle events is restored to the client's model by a JSON
 * round-trip of that event's `data:` frame alone. Everything else —
 * framing, whitespace, delta payloads — reaches the client exactly as
 * the upstream sent it. The SSE relay itself lives in
 * passthrough-relay.ts (rule 7); this file owns the routing
 * decision, the request body and the trace finish.
 *
 * Wire-format sources (every event/field this file touches):
 *  - The Response object and its `model`/`usage` fields:
 *    https://platform.openai.com/docs/api-reference/responses/object
 *  - The lifecycle event set the relay restores `model` in:
 *    https://platform.openai.com/docs/api-reference/responses-streaming
 *  - `codex-rs/codex-api/src/sse/responses.rs` at 0.169.0 (E19).
 */
import type { GatewayConfig } from "../config/env-config";
import type { ProviderEntry } from "../routing/registry";
import { authHeaders } from "../routing/registry";
import type { RouteTarget } from "../routing/plan-route";
import { PROVIDER_ROUTES, type Provider } from "../transformers";
import { toCanonicalResponse } from "../transformers/adapters/responses.response";
import {
  currentTrace,
  runWithAttempt,
  snapshot,
} from "../observe/context";
import { finishTrace } from "../observe/emit";
import { diagnoseToolCalls } from "../observe/tool-diagnostics";
import type { CanonicalRequest } from "../types/canonical.types";
import { UnsupportedParameterError, UpstreamError } from "../utils/errors";
import {
  postJson,
  postStream,
  type UpstreamResponse,
  type UpstreamStreamResponse,
} from "./http-client";
import {
  relayResponseHeaders,
  type PassthroughObservation,
} from "./passthrough-relay";
import {
  maxTokensClampOf,
  toClientFacing,
  type AttemptResult,
} from "./attempt-targets";
import type { ProxyResult } from "./proxy.service";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/** §3.4: pass-through iff a Responses source routes to a responses entry. */
export function isPassthrough(
  source: Provider,
  entry: ProviderEntry,
): boolean {
  return source === "responses" && entry.type === "responses";
}

/**
 * §2.2: responses-lite markers are pass-through-only (owner decision,
 * Task 3). proxy.service's pre-routing check stays stateful-only so a
 * pass-through target can relay these; a bridged attempt — including
 * a non-responses fallback — rejects them with the same 400 the old
 * unconditional check produced, naming the item.
 */
export function assertBridgeableBody(body: unknown): void {
  if (body === null || typeof body !== "object") return;
  const request = body as Record<string, unknown>;
  const liteParam = (param: string): never => {
    throw new UnsupportedParameterError(
      param,
      `${param} is not supported: responses-lite requests are pass-through only in v1.4`,
    );
  };

  if (
    request.reasoning !== null &&
    typeof request.reasoning === "object" &&
    (request.reasoning as Record<string, unknown>).context !== undefined
  ) {
    liteParam("reasoning.context");
  }

  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (item === null || typeof item !== "object") continue;
      const entry = item as {
        type?: unknown;
        phase?: unknown;
        namespace?: unknown;
      };
      if (entry.type === "additional_tools") liteParam("additional_tools");
      if (entry.type === "message" && entry.phase !== undefined) {
        liteParam("phase");
      }
      if (
        (entry.type === "custom_tool_call" ||
          entry.type === "custom_tool_call_output") &&
        entry.namespace !== undefined
      ) {
        liteParam("custom_tool_call");
      }
    }
  }
}

/**
 * The forwarded request body (§3.4): the client's bytes with `model`
 * rewritten to the routed upstream model and `max_output_tokens`
 * carrying the same clamp canonicalForTarget applies. A shallow copy
 * keeps every other field — built-in tools, reasoning/encrypted
 * fields, provider extras — untouched.
 */
export function passthroughTargetBody(
  sourceBody: unknown,
  target: RouteTarget,
  canonical: CanonicalRequest,
  entry: ProviderEntry,
): Obj {
  const src =
    sourceBody !== null && typeof sourceBody === "object"
      ? (sourceBody as Obj)
      : {};
  const body: Obj = { ...src, model: target.model };
  const clamp = maxTokensClampOf(canonical, entry);
  if (clamp !== undefined) body.max_output_tokens = clamp.to;
  return body;
}

function responsesChatUrl(entry: ProviderEntry): string {
  const route = PROVIDER_ROUTES.responses.find((r) => r.kind === "chat")!;
  return `${entry.baseUrl}${route.requestPath()}`;
}

/** Unary pass-through attempt — used inside chat.service's attempt loop. */
export async function passthroughUnaryAttempt(
  entry: ProviderEntry,
  target: RouteTarget,
  ctx: {
    sourceBody: unknown;
    canonical: CanonicalRequest;
    config: GatewayConfig;
    requestId: string;
  },
): Promise<UpstreamResponse> {
  // v1.4 §3.2: same ambient attempt scope the bridged path opens.
  return runWithAttempt(
    { providerName: target.provider, upstreamModel: target.model },
    async () => {
      const body = passthroughTargetBody(
        ctx.sourceBody,
        target,
        ctx.canonical,
        entry,
      );
      // §3.5: one target snapshot per hop (fallbacks included).
      snapshot("target", body);
      const upstream = await postJson({
        url: responsesChatUrl(entry),
        headers: authHeaders(entry),
        body,
        timeoutMs: entry.timeoutMs ?? ctx.config.upstreamTimeoutMs,
        retries: ctx.config.upstreamRetries,
        requestId: ctx.requestId,
      }).catch((err) => {
        throw err instanceof UpstreamError
          ? toClientFacing(err, "responses")
          : err;
      });
      if (upstream.status < 200 || upstream.status >= 300) {
        const err = new UpstreamError(
          `Upstream responses returned ${upstream.status}`,
          upstream.status,
          upstream.body,
        );
        err.retryAfterSeconds = upstream.retryAfterSeconds;
        throw toClientFacing(err, "responses");
      }
      return upstream;
    },
  );
}

/** The pieces of a won pass-through stream attempt. */
export interface PassthroughStreamAttempt {
  upstream: UpstreamStreamResponse;
  upstreamAc: AbortController;
}

/** Stream pass-through attempt — same fallback contract as the bridge. */
export async function passthroughStreamAttempt(
  entry: ProviderEntry,
  target: RouteTarget,
  ctx: {
    sourceBody: unknown;
    canonical: CanonicalRequest;
    config: GatewayConfig;
    requestId: string;
    signal?: AbortSignal;
  },
): Promise<PassthroughStreamAttempt> {
  return runWithAttempt(
    { providerName: target.provider, upstreamModel: target.model },
    async () => {
      const body = passthroughTargetBody(
        ctx.sourceBody,
        target,
        ctx.canonical,
        entry,
      );
      // §3.5: one target snapshot per hop (fallbacks included).
      snapshot("target", body);
      const upstreamAc = new AbortController();
      const upstream = await postStream({
        url: responsesChatUrl(entry),
        headers: authHeaders(entry),
        body,
        timeoutMs: entry.timeoutMs ?? ctx.config.upstreamTimeoutMs,
        retries: ctx.config.upstreamRetries,
        requestId: ctx.requestId,
        signal:
          ctx.signal !== undefined
            ? AbortSignal.any([ctx.signal, upstreamAc.signal])
            : upstreamAc.signal,
      }).catch((err) => {
        throw err instanceof UpstreamError
          ? toClientFacing(err, "responses")
          : err;
      });
      return { upstream, upstreamAc };
    },
  );
}

// ============ Trace finishes ============

/**
 * One pass-through Response object → the canonical read the trace
 * needs (usage, finishReason, tool calls). This is the responses
 * adapter's own response codec — the field map never drifts from the
 * bridged path — run purely as observation: its `field_dropped`
 * notes describe a translation that never happened and are cleared
 * with the rest by markPassthrough. Item/usage/status shapes:
 * https://platform.openai.com/docs/api-reference/responses/object
 */
function observeResponse(response: unknown): {
  calls: ReturnType<typeof toCanonicalResponse>["message"]["toolCalls"];
  usage: ReturnType<typeof toCanonicalResponse>["usage"];
  finishReason: ReturnType<typeof toCanonicalResponse>["finishReason"];
} {
  const decoded = toCanonicalResponse(
    response as Parameters<typeof toCanonicalResponse>[0],
    "unused",
  );
  return {
    calls: decoded.message.toolCalls,
    usage: decoded.usage,
    finishReason: decoded.finishReason,
  };
}

/**
 * A pass-through trace is marked `passthrough: true` and carries no
 * canonical artefacts: the routing decode's notes describe
 * transforms that never ran, and the `canonical` body stage (taken
 * before routing, for the bridged hop that never came) is removed —
 * the inspector shows source, target and response.wire only.
 */
function markPassthrough(): void {
  const trace = currentTrace();
  if (trace === undefined) return;
  trace.notes.length = 0;
  if (trace.bodies !== undefined) delete trace.bodies.canonical;
  trace.passthrough = true;
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
  const observed = observeResponse(upstreamBody);
  const trace = currentTrace();
  // §3.7: diagnostics run on the relayed function calls — repair is
  // never applied on pass-through (it would alter the bytes).
  trace?.diagnostics.push(
    ...diagnoseToolCalls(observed.calls ?? [], canonical.tools),
  );
  markPassthrough();
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
      "x-babelgate-attempts": String(result.hops.length),
    },
  };
}

/**
 * Whatever ended a pass-through stream, the upstream request is done
 * with and the trace emits exactly once — aborted when the client
 * went away, error when the stream failed, ok otherwise. Usage comes
 * only from `response.completed`'s `response.usage` (§3.4) — absent
 * unless that event already reached the client.
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
      ? observeResponse(terminal.response)
      : undefined;
  const usage =
    terminal?.type === "response.completed" ? observed?.usage : undefined;
  const trace = currentTrace();
  trace?.diagnostics.push(
    ...diagnoseToolCalls(observed?.calls ?? [], canonical.tools),
  );
  markPassthrough();
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
      !signal.aborted && failed
        ? (observation.errorKind ?? "upstream")
        : undefined,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    finishReason:
      terminal?.type === "response.completed" ||
      terminal?.type === "response.incomplete"
        ? observed?.finishReason
        : undefined,
    maxTokensClamp: maxTokensClampOf(canonical, result.entry),
  });
}
