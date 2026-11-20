import type { GatewayConfig } from "../config/env-config";
import {
  adapters,
  PROVIDER_ROUTES,
  type Provider,
} from "../transformers";
import type { RoutePlan } from "../routing/plan-route";
import { authHeaders } from "../routing/registry";
import type { Hop } from "../routing/route-log";
import {
  currentTrace,
  runWithAttempt,
  snapshot,
} from "../observe/context";
import { finishTrace } from "../observe/emit";
import {
  diagnoseToolCalls,
  repairArguments,
} from "../observe/tool-diagnostics";
import { raiseCustomCalls } from "../transformers/custom-tools";
import type {
  CanonicalRequest,
  CanonicalResponse,
} from "../types/canonical.types";
import { canonicalResponseSchema } from "../types/canonical.schema";
import { UpstreamError, ValidationError } from "../utils/errors";
import { logger } from "../utils/logger";
import { postJson } from "./http-client";
import {
  attemptTargets,
  canonicalForTarget,
  errorTraceFields,
  maxTokensClampOf,
  toClientFacing,
} from "./attempt-targets";
import {
  assertBridgeableBody,
  isPassthrough,
  passthroughUnaryAttempt,
} from "./passthrough";
import {
  finishPassthroughUnary,
  markFailedPassthroughHop,
} from "./passthrough-trace";
import type {
  ProxyRequestOptions,
  ProxyResult,
} from "./proxy.service";
import {
  inlineMediaForTarget,
  MEDIA_DEFAULTS,
} from "./media-inline";
import { MEDIA_SUPPORT } from "../transformers";

/** Everything a chat service needs — explicit inputs, no globals. */
export interface ChatInput {
  source: Provider;
  /** The client's original request body (stream encoders need it) */
  sourceBody: unknown;
  /**
   * Decoded canonical request — validated, except on a responses
   * source that failed the boundary schema (then deferredValidation
   * is set and a bridged attempt must throw it before encoding).
   * Never mutated by the services.
   */
  canonical: CanonicalRequest;
  /**
   * §3.4: the 400 a responses-source request owes when its canonical
   * fails the boundary schema — deferred so a pass-through entry can
   * still relay it; thrown by the first bridged attempt.
   */
  deferredValidation?: ValidationError;
  /** The model name the client asked for (§3.5 reply model) */
  requestedModel: string;
  plan: RoutePlan;
  config: GatewayConfig;
  requestId: string;
  opts?: ProxyRequestOptions;
}

/**
 * Non-streaming chat over a RoutePlan: per target — encode with the
 * registry provider's adapter, postJson with its URL, auth and
 * timeouts; decode the reply → model := requestedModel → encode in the
 * client's format (moved from proxy.service, spec §3.1). The route log
 * line and the x-babelgate-* reply headers come from spec §3.4.
 */
export async function proxyChat(input: ChatInput): Promise<ProxyResult> {
  const { source, canonical, requestedModel, plan, config, requestId } =
    input;

  const hops: Hop[] = [];
  let result;
  try {
    result = await attemptTargets(
      plan,
      config.registry,
      async (entry, target) =>
        // v1.4 §3.2: the attempt's provider name and upstream model are
        // ambient for its encode and upstream call — every hop gets
        // its own scope, so a fallback never sees the previous hop's.
        runWithAttempt(
          {
            providerName: target.provider,
            upstreamModel: target.model,
          },
          async () => {
            // §3.4: a `type: responses` entry on a responses source is
            // pass-through — the request is relayed, never encoded.
            if (isPassthrough(source, entry)) {
              return passthroughUnaryAttempt(entry, target, {
                sourceBody: input.sourceBody,
                canonical,
                config,
                requestId,
              });
            }
            // §2.2: responses-lite bodies are pass-through-only — on
            // the bridge each marker is a 400 naming the item.
            if (source === "responses") {
              assertBridgeableBody(input.sourceBody);
            }
            // §3.4: the canonical couldn't be validated — it could
            // only have been relayed, never encoded.
            if (input.deferredValidation !== undefined) {
              throw input.deferredValidation;
            }
            // §3.2.2: per attempt, URL media the target can't take
            // by URL is fetched and inlined; what it can't take at
            // all is refused before encode, naming the field path.
            const shaped = await inlineMediaForTarget(
              canonicalForTarget(canonical, entry, target, {
                source,
                sourceBody: input.sourceBody,
              }),
              MEDIA_SUPPORT[entry.type],
              config.media ?? MEDIA_DEFAULTS,
            );
            const targetBody =
              adapters[entry.type].fromCanonicalRequest(shaped);
            // §3.5: one target snapshot per hop (fallbacks included).
            snapshot("target", targetBody);
            const targetRoute = PROVIDER_ROUTES[entry.type].find(
              (r) => r.kind === "chat",
            )!;
            const url = `${entry.baseUrl}${targetRoute.requestPath(target.model)}`;

            const upstream = await postJson({
              url,
              headers: authHeaders(entry),
              body: targetBody,
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

            return upstream;
          },
        ),
      { requestId, signal: input.opts?.signal, hops },
    );
  } catch (err) {
    // v1.5 follow-up: a failed attempt whose last hop was a
    // pass-through relay is marked like a won one — a failed shim
    // call is not a translated request.
    markFailedPassthroughHop(source, hops, config.registry);
    await finishTrace({
      reason: plan.reason,
      requestedModel,
      hops,
      stream: false,
      ...errorTraceFields(err, input.opts?.signal?.aborted === true),
    });
    throw err;
  }

  // §3.4: a won pass-through hop relays the upstream body — no
  // decode, no diagnostics repair, no canonical stage.
  if (isPassthrough(source, result.entry)) {
    return finishPassthroughUnary({
      reason: plan.reason,
      requestedModel,
      canonical,
      result,
    });
  }

  // §3.5: the upstream JSON body lands in the ring even when decoding
  // it below throws.
  snapshot("response.wire", result.value.body);

  // Target → Canonical → Source. §3.5: replies carry the model name the
  // client asked for, not the routed name sent upstream. A throwing
  // decode or source encode after a won attempt is still traced.
  let canonicalResp: CanonicalResponse;
  let body: unknown;
  try {
    // v1.4 §3.2: the winning attempt's context is ambient for its
    // decode — reasoning parts are tagged with the origin that
    // produced them. The client-facing encode below is no attempt.
    canonicalResp = runWithAttempt(
      {
        providerName: result.target.provider,
        upstreamModel: result.target.model,
      },
      () =>
        adapters[result.entry.type].toCanonicalResponse(
          result.value.body,
          result.target.model,
        ),
    );
    canonicalResp.model = requestedModel;

    // §3.6: calls to lowered custom/namespace tools are raised back
    // to the client's form (custom: true raw input, {name, namespace})
    // before diagnostics and the source encode — a no-op when the
    // request declared neither.
    canonicalResp = raiseCustomCalls(canonicalResp, canonical, source);

    // §3.5 + §3.7: the ring's response.canonical shows the ORIGINAL
    // arguments — snapshot() stores the object by reference, so a deep
    // copy is taken before the repair loop rewrites them (skipped when
    // the ring is off: snapshot() would no-op anyway).
    const preRepair =
      currentTrace()?.bodies === undefined
        ? canonicalResp
        : structuredClone(canonicalResp);

    // §3.7: diagnose on the decoded (original) arguments; repair is
    // opt-in per provider and rewrites them before the client encode,
    // so fixed arguments are what the client receives. Diagnostics and
    // repairs land on the ambient trace — the recordNote pattern.
    {
      const trace = currentTrace();
      const calls = canonicalResp.message.toolCalls ?? [];
      trace?.diagnostics.push(
        ...diagnoseToolCalls(calls, canonical.tools),
      );
      if (result.entry.repairToolCalls === true) {
        for (const call of calls) {
          // §3.6: a custom call's arguments are raw input — never
          // parsed as JSON, never repaired.
          if (call.custom === true) continue;
          const repair = repairArguments(call.function.arguments);
          if (repair !== undefined) {
            call.function.arguments = repair.args;
            trace?.repairs.push({
              toolCallId: call.id,
              steps: repair.steps,
            });
          }
        }
      }
    }

    // Adapter bug detection (non-production only): canonical response
    // should always be schema-valid
    if (process.env.NODE_ENV !== "production") {
      const respParsed = canonicalResponseSchema.safeParse(canonicalResp);
      if (!respParsed.success) {
        logger.error(
          { requestId, issues: respParsed.error.issues },
          "Canonical response failed schema validation — adapter bug",
        );
      }
    }

    body = adapters[source].fromCanonicalResponse(canonicalResp);
    snapshot("response.canonical", preRepair);
  } catch (err) {
    await finishTrace({
      reason: plan.reason,
      requestedModel,
      hops: result.hops,
      winner: result.target.provider,
      stream: false,
      ...errorTraceFields(err, input.opts?.signal?.aborted === true),
    });
    throw err;
  }

  // §3.1: for a JSON reply the first byte to the client goes out when
  // the body is ready — here, right after the source encode.
  const trace = currentTrace();
  await finishTrace({
    reason: plan.reason,
    requestedModel,
    hops: result.hops,
    winner: result.target.provider,
    stream: false,
    status: "ok",
    httpStatus: 200,
    inputTokens: canonicalResp.usage?.inputTokens,
    outputTokens: canonicalResp.usage?.outputTokens,
    cacheReadTokens: canonicalResp.usage?.cacheReadTokens,
    cacheWriteTokens: canonicalResp.usage?.cacheWriteTokens,
    reasoningTokens: canonicalResp.usage?.reasoningTokens,
    finishReason: canonicalResp.finishReason,
    maxTokensClamp: maxTokensClampOf(canonical, result.entry),
    ttfbMs:
      trace === undefined ? undefined : Date.now() - trace.startedAt,
  });

  return {
    body,
    headers: {
      "x-babelgate-provider": result.target.provider,
      "x-babelgate-model": result.target.model,
      "x-babelgate-attempts": String(result.hops.length),
    },
  };
}
