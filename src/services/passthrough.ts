/**
 * Same-format pass-through (v1.4 spec §3.4, v1.5 spec §3.3 D6): when
 * the source dialect matches the routed provider entry's type and the
 * entry passes through — `type: responses` unconditionally, an
 * `anthropic`/`openai` entry with `passthrough: true` — the request
 * is relayed to the upstream as-is: no canonical transformation,
 * only `model` rewritten and the dialect's max-tokens field clamped
 * (the same clamp record the bridged path produces). The reply is
 * relayed byte for byte; `model` inside the dialect's model-bearing
 * frames is restored to the client's model by a JSON round-trip of
 * that event's `data:` frame alone. Everything else — framing,
 * whitespace, delta payloads — reaches the client exactly as the
 * upstream sent it. The SSE relay engine lives in
 * passthrough-relay.ts, the per-dialect wire knowledge in
 * passthrough-dialects.ts and the observation→trace finishes in
 * passthrough-trace.ts (rule 7); this file owns the routing
 * decision, the request body and the count_tokens forward.
 *
 * Wire-format sources (every event/field this file touches):
 *  - The Response object and its `model`/`usage` fields:
 *    https://platform.openai.com/docs/api-reference/responses/object
 *  - The lifecycle event set the relay restores `model` in:
 *    https://platform.openai.com/docs/api-reference/responses-streaming
 *  - `codex-rs/codex-api/src/sse/responses.rs` at 0.169.0 (E19).
 *  - Anthropic Messages + count_tokens:
 *    https://docs.anthropic.com/en/api/messages
 *  - Chat Completions + `stream_options.include_usage`:
 *    https://platform.openai.com/docs/api-reference/chat/create
 */
import type { GatewayConfig } from "../config/env-config";
import type { ProviderEntry } from "../routing/registry";
import { authHeaders } from "../routing/registry";
import type { RoutePlan, RouteTarget } from "../routing/plan-route";
import { PROVIDER_ROUTES, type Provider } from "../transformers";
import { runWithAttempt, recordNote, snapshot } from "../observe/context";
import type { CanonicalRequest } from "../types/canonical.types";
import { UnsupportedParameterError, UpstreamError } from "../utils/errors";
import { logger } from "../utils/logger";
import {
  postJson,
  postStream,
  type UpstreamResponse,
  type UpstreamStreamResponse,
} from "./http-client";
import {
  relayAnthropicStream,
  relayChatStream,
  relayResponsesStream,
} from "./passthrough-dialects";
import {
  relayResponseHeaders,
  type RelayStreamOpts,
} from "./passthrough-relay";
import {
  attemptTargets,
  maxTokensClampOf,
  toClientFacing,
} from "./attempt-targets";
import { applyGapFixes } from "./gap-fixes";
import { MEDIA_DEFAULTS } from "./media-inline";
import type { ProxyResult } from "./proxy.service";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/**
 * §3.3 (D6): pass-through iff the source and the entry share a format
 * AND the entry passes through — a `type: responses` entry always
 * (the v1.4 rule); an `anthropic`/`openai` entry only with
 * `passthrough: true`. The flag never crosses formats, and no flag
 * keeps same-format anthropic/openai traffic on the canonical path.
 */
export function isPassthrough(
  source: Provider,
  entry: ProviderEntry,
): boolean {
  return (
    source === entry.type &&
    (entry.type === "responses" || entry.passthrough === true)
  );
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
 * The forwarded request body (§3.3/§3.4): the client's bytes with
 * `model` rewritten to the routed upstream model and the dialect's
 * own max-tokens field carrying the same clamp canonicalForTarget
 * applies — `max_output_tokens` on responses, `max_tokens` on
 * anthropic, and on chat whichever of `max_completion_tokens` /
 * `max_tokens` the client sent (`max_tokens` when neither did).
 * A shallow copy keeps every other field — built-in tools,
 * reasoning/encrypted fields, `stream_options`, provider extras —
 * untouched.
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
  if (clamp !== undefined) {
    if (entry.type === "responses") {
      body.max_output_tokens = clamp.to;
    } else if (
      entry.type === "openai" &&
      src.max_completion_tokens === undefined
    ) {
      // A chat client that asked for neither field still gets the cap
      // on the field its dialect spells the bridged encoder's way.
      body.max_tokens = clamp.to;
    } else if (entry.type === "openai") {
      body.max_completion_tokens = clamp.to;
    } else {
      body.max_tokens = clamp.to;
    }
  }
  return body;
}

/**
 * §3.3 (Task 9): the entry's declared gaps fix the body after the
 * model rewrite and before the target snapshot — the snapshot and
 * the upstream see the same bytes. Notes the adapter's patchGaps
 * returned are recorded with stage "encode" so markPassthrough's
 * decode-note sweep keeps them (passthrough-trace.ts).
 */
async function gapFixedBody(
  entry: ProviderEntry,
  body: Obj,
  media: GatewayConfig["media"],
): Promise<Obj> {
  if (entry.gaps === undefined || entry.gaps.length === 0) return body;
  const { body: fixed, notes } = await applyGapFixes(
    entry.type,
    body,
    entry.gaps,
    media ?? MEDIA_DEFAULTS,
  );
  for (const n of notes) recordNote(n);
  return fixed as Obj;
}

/**
 * The upstream chat endpoint for this entry — the provider route's
 * own `requestPath` (Gemini's embeds the model; the others ignore
 * it), so a pass-through hop posts to exactly the URL the bridged
 * path would.
 */
function chatUrl(entry: ProviderEntry, model: string): string {
  const route = PROVIDER_ROUTES[entry.type].find(
    (r) => r.kind === "chat",
  )!;
  return `${entry.baseUrl}${route.requestPath(model)}`;
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
      const body = await gapFixedBody(
        entry,
        passthroughTargetBody(
          ctx.sourceBody,
          target,
          ctx.canonical,
          entry,
        ),
        ctx.config.media,
      );
      // §3.5: one target snapshot per hop (fallbacks included).
      snapshot("target", body);
      const upstream = await postJson({
        url: chatUrl(entry, target.model),
        headers: authHeaders(entry),
        body,
        timeoutMs: entry.timeoutMs ?? ctx.config.upstreamTimeoutMs,
        retries: ctx.config.upstreamRetries,
        requestId: ctx.requestId,
      }).catch((err) => {
        throw err instanceof UpstreamError
          ? toClientFacing(err, entry.type)
          : err;
      });
      if (upstream.status < 200 || upstream.status >= 300) {
        const err = new UpstreamError(
          `Upstream ${entry.type} returned ${upstream.status}`,
          upstream.status,
          upstream.body,
        );
        err.retryAfterSeconds = upstream.retryAfterSeconds;
        throw toClientFacing(err, entry.type);
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
      const body = await gapFixedBody(
        entry,
        passthroughTargetBody(
          ctx.sourceBody,
          target,
          ctx.canonical,
          entry,
        ),
        ctx.config.media,
      );
      // §3.5: one target snapshot per hop (fallbacks included).
      snapshot("target", body);
      const upstreamAc = new AbortController();
      const upstream = await postStream({
        url: chatUrl(entry, target.model),
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
          ? toClientFacing(err, entry.type)
          : err;
      });
      return { upstream, upstreamAc };
    },
  );
}

/**
 * The dialect's stream relay for a won pass-through entry —
 * chat-stream.service feeds it the upstream body. `isPassthrough`
 * guarantees the entry's type is one of the three.
 */
export function passthroughRelay(
  entry: ProviderEntry,
): (opts: RelayStreamOpts) => AsyncGenerator<string> {
  if (entry.type === "anthropic") return relayAnthropicStream;
  if (entry.type === "openai") return relayChatStream;
  return relayResponsesStream;
}

// ============ count_tokens ============

/**
 * §3.3 (Task 8): the source's count_tokens request is forwarded
 * verbatim — `model` rewritten, nothing else — to the first
 * pass-through target in the plan, when that target's provider has a
 * count_tokens endpoint (Anthropic's POST /v1/messages/count_tokens):
 * the upstream's real count, not the local chars/4 estimate. The
 * first target that CANNOT relay it (a bridged entry, or a provider
 * type with no count_tokens route) answers locally instead — a
 * different dialect's count shape would be a provider-pair special
 * case. Forwarded hops obey the same fallback contract as chat
 * attempts; an entry's `gaps` declaration suppresses the forward and
 * forces the local answer (Task 9 — `count_tokens`).
 */
export async function passthroughCountTokens(opts: {
  source: Provider;
  /** The client's count_tokens body (after the route's unwrap). */
  sourceBody: unknown;
  plan: RoutePlan;
  config: GatewayConfig;
  requestId: string;
  estimate: number;
  countTokensBody: (estimate: number) => unknown;
  signal?: AbortSignal;
}): Promise<ProxyResult> {
  const { source, sourceBody, plan, config, requestId } = opts;
  const result = await attemptTargets(
    plan,
    config.registry,
    (entry, target) =>
      runWithAttempt(
        { providerName: target.provider, upstreamModel: target.model },
        async () => {
          const ctRoute = PROVIDER_ROUTES[entry.type].find(
            (r) => r.kind === "count_tokens",
          );
          if (!isPassthrough(source, entry) || ctRoute === undefined) {
            // Not relayable — the local estimate answers (below).
            return { upstream: undefined };
          }
          if (entry.gaps?.includes("count_tokens") === true) {
            // §3.3 (Task 9): the declared gap suppresses the forward;
            // the local estimate answers (below).
            recordNote(
              {
                stage: "encode",
                adapter: source,
                code: "count_tokens_estimated",
              },
              `count_tokens gap on "${target.provider}": answered locally`,
            );
            return { upstream: undefined };
          }
          const body = await gapFixedBody(
            entry,
            {
              ...(sourceBody !== null && typeof sourceBody === "object"
                ? (sourceBody as Obj)
                : {}),
              model: target.model,
            },
            config.media,
          );
          snapshot("target", body);
          const upstream = await postJson({
            url: `${entry.baseUrl}${ctRoute.requestPath()}`,
            headers: authHeaders(entry),
            body,
            timeoutMs: entry.timeoutMs ?? config.upstreamTimeoutMs,
            retries: config.upstreamRetries,
            requestId,
          }).catch((err) => {
            throw err instanceof UpstreamError
              ? toClientFacing(err, entry.type)
              : err;
          });
          if (upstream.status < 200 || upstream.status >= 300) {
            const err = new UpstreamError(
              `Upstream ${entry.type} returned ${upstream.status}`,
              upstream.status,
              upstream.body,
            );
            err.retryAfterSeconds = upstream.retryAfterSeconds;
            throw toClientFacing(err, entry.type);
          }
          return { upstream };
        },
      ),
    { requestId, signal: opts.signal },
    config.breakers,
  );

  // The first non-relayable target: the §3.5 local answer.
  if (result.value.upstream === undefined) {
    logger.info(
      { requestId, sourceApi: source },
      "count_tokens answered locally",
    );
    return {
      body: opts.countTokensBody(opts.estimate),
      headers: { "x-babelgate-token-estimate": "true" },
    };
  }

  return {
    body: result.value.upstream.body,
    headers: {
      ...relayResponseHeaders(result.value.upstream.headers),
      "x-babelgate-provider": result.target.provider,
      "x-babelgate-model": result.target.model,
      "x-babelgate-attempts": String(result.attempts),
    },
  };
}
