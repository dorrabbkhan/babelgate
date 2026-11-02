import type { GatewayConfig } from "../config/env-config";
import {
  adapters,
  PROVIDER_ROUTES,
  type Provider,
  type ProviderRoute,
} from "../transformers";
import { authHeaders, type ProviderEntry } from "../routing/registry";
import { hopOutcome } from "../routing/fallback";
import { canonicalModelListSchema } from "../types/canonical.schema";
import type {
  CanonicalModel,
  CanonicalModelList,
} from "../types/canonical.types";
import { UpstreamError } from "../utils/errors";
import { logger } from "../utils/logger";
import { getJson } from "./http-client";
import { toClientFacing } from "./attempt-targets";
import type { ProxyResult } from "./proxy.service";

/** spec §3.6: each provider's model list is cached in memory for 60 s. */
const MODEL_LIST_TTL_MS = 60_000;

/**
 * Per-provider model-list cache keyed on provider name + base URL
 * (spec §3.6). Successful fetches only; `now` is injectable so tests
 * can pin the TTL boundary (fetched at t → fresh until t + ttlMs).
 */
export interface ModelListCache {
  get(provider: string, baseUrl: string): CanonicalModelList | undefined;
  set(provider: string, baseUrl: string, list: CanonicalModelList): void;
  clear(): void;
}

export function createModelListCache(
  ttlMs = MODEL_LIST_TTL_MS,
  now: () => number = Date.now,
): ModelListCache {
  const entries = new Map<
    string,
    { list: CanonicalModelList; fetchedAt: number }
  >();
  return {
    get(provider, baseUrl) {
      const hit = entries.get(`${provider} ${baseUrl}`);
      if (hit === undefined || now() - hit.fetchedAt >= ttlMs) {
        return undefined;
      }
      return hit.list;
    },
    set(provider, baseUrl, list) {
      entries.set(`${provider} ${baseUrl}`, { list, fetchedAt: now() });
    },
    clear() {
      entries.clear();
    },
  };
}

const sharedCache = createModelListCache();

/** Tests reset the process-wide cache between cases. */
export function resetModelListCache(): void {
  sharedCache.clear();
}

/**
 * One provider's model list, decoded by that provider's own adapter
 * into canonical. Non-2xx upstream replies become an UpstreamError
 * carrying upstreamStatus, exactly as the v1.1 single-provider flow.
 */
async function fetchProviderModels(
  entry: ProviderEntry,
  source: Provider,
  config: GatewayConfig,
  requestId: string,
): Promise<CanonicalModelList> {
  const targetRoute = PROVIDER_ROUTES[entry.type].find(
    (r) => r.kind === "models",
  )!;
  const url = `${entry.baseUrl}${targetRoute.requestPath()}`;

  logger.info(
    {
      requestId,
      sourceApi: source,
      provider: entry.name,
      targetApi: entry.type,
      url,
    },
    "Forwarding models list request to upstream",
  );

  const upstream = await getJson({
    url,
    headers: authHeaders(entry),
    timeoutMs: entry.timeoutMs ?? config.upstreamTimeoutMs,
    retries: config.upstreamRetries,
    requestId,
  });

  if (upstream.status < 200 || upstream.status >= 300) {
    const err = new UpstreamError(
      `Upstream ${entry.type} returned ${upstream.status}`,
      upstream.status,
      upstream.body,
    );
    err.retryAfterSeconds = upstream.retryAfterSeconds;
    throw err;
  }

  return adapters[entry.type].toCanonicalModelList(upstream.body);
}

/**
 * GET /models flow, spec §3.6: every registered provider's list is
 * fetched in parallel (60 s cache, successful fetches only), merged
 * and encoded once in the client's format. Order: aliases as bare
 * names; the default provider's models bare (the v1.1 list); every
 * other provider's models as <provider>/<model>. First occurrence
 * wins on a duplicate id. A failed provider is omitted with a warn
 * and x-babelgate-partial: true; if every provider fails, the default
 * provider's error is returned exactly as v1.1 did.
 */
export async function proxyModelList(
  source: Provider,
  route: ProviderRoute,
  config: GatewayConfig,
  requestId: string,
): Promise<ProxyResult> {
  const names = config.registry.names();
  const defaultName = config.routing.defaultProvider;

  const fetchCached = async (
    entry: ProviderEntry,
  ): Promise<CanonicalModelList> => {
    const cached = sharedCache.get(entry.name, entry.baseUrl);
    if (cached !== undefined) return cached;
    const list = await fetchProviderModels(entry, source, config, requestId);
    sharedCache.set(entry.name, entry.baseUrl, list);
    return list;
  };

  const settled = await Promise.allSettled(
    names.map((name) => fetchCached(config.registry.get(name))),
  );

  const failed = settled
    .map((r, i) =>
      r.status === "rejected" ? { name: names[i]!, reason: r.reason } : null,
    )
    .filter((f): f is { name: string; reason: unknown } => f !== null);

  if (failed.length === names.length) {
    const reason = (
      settled[names.indexOf(defaultName)] as PromiseRejectedResult
    ).reason;
    const entry = config.registry.get(defaultName);
    throw reason instanceof UpstreamError
      ? toClientFacing(reason, entry.type)
      : reason;
  }

  // One warn per failed provider: name and status/outcome only —
  // never a key or a response body.
  for (const f of failed) {
    const err = f.reason;
    logger.warn(
      {
        requestId,
        provider: f.name,
        outcome:
          err instanceof UpstreamError
            ? (hopOutcome(err) ?? "error")
            : "error",
        ...(err instanceof UpstreamError &&
        err.upstreamStatus !== undefined
          ? { status: err.upstreamStatus }
          : {}),
      },
      "Model list fetch failed; provider omitted",
    );
  }

  const seen = new Set<string>();
  const merged: CanonicalModel[] = [];
  const push = (model: CanonicalModel, id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    merged.push({ ...model, id });
  };

  for (const alias of Object.keys(config.routing.aliases)) {
    push({ id: alias }, alias);
  }

  const pushProvider = (name: string, prefix: boolean) => {
    const r = settled[names.indexOf(name)];
    if (r?.status !== "fulfilled") return;
    for (const m of r.value.models) {
      push(m, prefix ? `${name}/${m.id}` : m.id);
    }
  };

  pushProvider(defaultName, false);
  for (const name of names) {
    if (name !== defaultName) pushProvider(name, true);
  }

  const mergedList: CanonicalModelList = { models: merged };

  if (process.env.NODE_ENV !== "production") {
    const parsed = canonicalModelListSchema.safeParse(mergedList);
    if (!parsed.success) {
      logger.error(
        { requestId, issues: parsed.error.issues },
        "Canonical model list failed schema validation — adapter bug",
      );
    }
  }

  logger.info(
    {
      requestId,
      sourceApi: source,
      modelCount: merged.length,
      ...(failed.length > 0 ? { partial: true } : {}),
    },
    "Models list completed",
  );

  const result: ProxyResult = {
    body: adapters[source].fromCanonicalModelList(mergedList),
  };
  if (failed.length > 0) {
    result.headers = { "x-babelgate-partial": "true" };
  }
  return result;
}
