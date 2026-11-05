import type { GatewayConfig } from "../config/env-config";
import {
  adapters,
  PROVIDER_ROUTES,
  type Provider,
} from "../transformers";
import type { RoutePlan } from "../routing/plan-route";
import { authHeaders } from "../routing/registry";
import type { Hop } from "../routing/route-log";
import { currentTrace } from "../observe/context";
import { finishTrace } from "../observe/emit";
import type { CanonicalRequest } from "../types/canonical.types";
import { canonicalResponseSchema } from "../types/canonical.schema";
import { UpstreamError } from "../utils/errors";
import { logger } from "../utils/logger";
import { postJson } from "./http-client";
import {
  attemptTargets,
  canonicalForTarget,
  errorTraceFields,
  maxTokensClampOf,
  toClientFacing,
} from "./attempt-targets";
import type {
  ProxyRequestOptions,
  ProxyResult,
} from "./proxy.service";

/** Everything a chat service needs — explicit inputs, no globals. */
export interface ChatInput {
  source: Provider;
  /** The client's original request body (stream encoders need it) */
  sourceBody: unknown;
  /** Validated canonical request — never mutated by the services */
  canonical: CanonicalRequest;
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
      async (entry, target) => {
        const targetBody = adapters[entry.type].fromCanonicalRequest(
          canonicalForTarget(canonical, entry, target),
        );
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
      { requestId, signal: input.opts?.signal, hops },
    );
  } catch (err) {
    await finishTrace({
      reason: plan.reason,
      requestedModel,
      hops,
      stream: false,
      ...errorTraceFields(err, input.opts?.signal?.aborted === true),
    });
    throw err;
  }

  // Target → Canonical → Source. §3.5: replies carry the model name the
  // client asked for, not the routed name sent upstream.
  const canonicalResp = adapters[result.entry.type].toCanonicalResponse(
    result.value.body,
    result.target.model,
  );
  canonicalResp.model = requestedModel;

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
    finishReason: canonicalResp.finishReason,
    maxTokensClamp: maxTokensClampOf(canonical, result.entry),
    ttfbMs:
      trace === undefined ? undefined : Date.now() - trace.startedAt,
  });

  return {
    body: adapters[source].fromCanonicalResponse(canonicalResp),
    headers: {
      "x-babelgate-provider": result.target.provider,
      "x-babelgate-model": result.target.model,
      "x-babelgate-attempts": String(result.hops.length),
    },
  };
}
