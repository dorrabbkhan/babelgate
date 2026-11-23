import { adapters, type Provider } from "../transformers";
import type { RouteTarget } from "../routing/plan-route";
import type { Hop } from "../routing/route-log";
import { currentTrace, snapshot } from "../observe/context";
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
import { logger } from "../utils/logger";
import { maxTokensClampOf } from "./attempt-targets";
import { assertBridgeableBody, isPassthrough } from "./passthrough";
import type { ChatInput } from "./chat.service";
import type { ProxyResult } from "./proxy.service";
import {
  entryResponse,
  probeCache,
  type CachedEntry,
} from "./response-cache";

/**
 * The §3.5 response-cache hit path shared by `proxyChat` and
 * `proxyChatStream`: probe the opt-in store for an identical
 * canonical request, and serve a hit by re-shaping the stored reply
 * exactly as a fresh decode would have been — raise/repair/encode
 * against THIS client's source dialect. Split out of chat.service
 * (the ~400-line file rule); the stream half lives next to
 * `proxyChatStream` because it needs the route's chunk generator
 * shape.
 */

/**
 * §3.5: the first cache entry this request may serve — plan targets
 * are probed in order, skipping any whose entry passes this source
 * through (a relay is never translated and never cached). Requests
 * the bridge would reject stay out too: a deferred canonical schema
 * failure and responses-lite markers keep their relay-or-400 paths,
 * never an answer from the store.
 */
export function probeRequestCache(
  input: ChatInput,
): { target: RouteTarget; entry: CachedEntry } | undefined {
  const cache = input.config.cache;
  if (cache === undefined || input.deferredValidation !== undefined) {
    return undefined;
  }
  if (input.source === "responses") {
    try {
      assertBridgeableBody(input.sourceBody);
    } catch {
      return undefined;
    }
  }
  return probeCache(
    cache,
    input.canonical,
    input.plan.targets.filter(
      (t) =>
        !isPassthrough(
          input.source,
          input.config.registry.get(t.provider),
        ),
    ),
  );
}

/**
 * §3.5: serve a cache hit — the stored canonical (the pristine decode
 * for a unary win, a recorded event sequence folded back for a
 * stream) is re-shaped and encoded exactly as a fresh reply, so a hit
 * replays in the asking client's own format. The trace marks
 * `cacheHit`, the row prices $0, and `x-babelgate-attempts: 0` says no
 * upstream was called. Returns undefined when the entry can't be
 * served — a poisoned entry never takes the request down.
 */
export async function serveCacheHit(
  input: ChatInput,
  hit: { target: RouteTarget; entry: CachedEntry },
): Promise<ProxyResult | undefined> {
  const { source, canonical, requestedModel, plan, config, requestId } =
    input;
  try {
    const entry = config.registry.get(hit.target.provider);
    const resp = entryResponse(hit.entry);
    resp.model = requestedModel;
    const { body, response } = encodeResponseForClient(
      resp,
      canonical,
      source,
      entry.repairToolCalls === true,
      requestId,
    );
    const hops: Hop[] = [
      {
        provider: hit.target.provider,
        model: hit.target.model,
        outcome: "ok",
        ms: 0,
      },
    ];
    const trace = currentTrace();
    await finishTrace({
      reason: plan.reason,
      requestedModel,
      hops,
      winner: hit.target.provider,
      stream: false,
      status: "ok",
      httpStatus: 200,
      cacheHit: true,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      cacheReadTokens: response.usage?.cacheReadTokens,
      cacheWriteTokens: response.usage?.cacheWriteTokens,
      reasoningTokens: response.usage?.reasoningTokens,
      finishReason: response.finishReason,
      maxTokensClamp: maxTokensClampOf(canonical, entry),
      ttfbMs:
        trace === undefined ? undefined : Date.now() - trace.startedAt,
    });
    return {
      body,
      headers: {
        "x-babelgate-provider": hit.target.provider,
        "x-babelgate-model": hit.target.model,
        "x-babelgate-attempts": "0",
        "x-babelgate-cache": "hit",
      },
    };
  } catch (err) {
    logger.debug(
      { requestId, err },
      "Cache hit could not be served — fetching fresh",
    );
    return undefined;
  }
}

/**
 * The post-decode half shared by a fresh upstream reply and a §3.5
 * cache hit: raise lowered custom/namespace calls back to this
 * source's form (§3.6), diagnose and — opt-in per provider — repair
 * tool arguments (§3.7), then encode for the client. The ring's
 * response.canonical shows the ORIGINAL arguments, so a deep copy is
 * taken before the repair loop rewrites them (skipped when the ring
 * is off). Repairs mutate the response's calls in place.
 */
export function encodeResponseForClient(
  resp: CanonicalResponse,
  canonical: CanonicalRequest,
  source: Provider,
  repairToolCalls: boolean,
  requestId: string,
): { body: unknown; response: CanonicalResponse } {
  // §3.6: calls to lowered custom/namespace tools are raised back
  // to the client's form (custom: true raw input, {name, namespace})
  // before diagnostics and the source encode — a no-op when the
  // request declared neither.
  const response = raiseCustomCalls(resp, canonical, source);

  // §3.5 + §3.7: the ring's response.canonical shows the ORIGINAL
  // arguments — snapshot() stores the object by reference, so a deep
  // copy is taken before the repair loop rewrites them (skipped when
  // the ring is off: snapshot() would no-op anyway).
  const preRepair =
    currentTrace()?.bodies === undefined
      ? response
      : structuredClone(response);

  // §3.7: diagnose on the decoded (original) arguments; repair is
  // opt-in per provider and rewrites them before the client encode,
  // so fixed arguments are what the client receives. Diagnostics and
  // repairs land on the ambient trace — the recordNote pattern.
  {
    const trace = currentTrace();
    const calls = response.message.toolCalls ?? [];
    trace?.diagnostics.push(
      ...diagnoseToolCalls(calls, canonical.tools),
    );
    if (repairToolCalls) {
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
    const respParsed = canonicalResponseSchema.safeParse(response);
    if (!respParsed.success) {
      logger.error(
        { requestId, issues: respParsed.error.issues },
        "Canonical response failed schema validation — adapter bug",
      );
    }
  }

  const body = adapters[source].fromCanonicalResponse(response);
  snapshot("response.canonical", preRepair);
  return { body, response };
}
