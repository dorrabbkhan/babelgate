import type { GatewayConfig } from "../config/env-config";
import {
  adapters,
  PROVIDER_ROUTES,
  type Provider,
  type ProviderRoute,
} from "../transformers";
import { authHeaders, type ProviderEntry } from "../routing/registry";
import { hopOutcome } from "../routing/fallback";
import { currentTrace } from "../observe/context";
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
 * Task 8: the cache holds the RAW upstream body — proxyModelList
 * decodes it per provider on read, and live prices read `pricing`
 * fields the canonical decode would drop.
 */
export interface ModelListCache {
  get(provider: string, baseUrl: string): unknown;
  set(provider: string, baseUrl: string, body: unknown): void;
  clear(): void;
}

export function createModelListCache(
  ttlMs = MODEL_LIST_TTL_MS,
  now: () => number = Date.now,
): ModelListCache {
  const entries = new Map<string, { body: unknown; fetchedAt: number }>();
  return {
    get(provider, baseUrl) {
      const hit = entries.get(`${provider} ${baseUrl}`);
      if (hit === undefined || now() - hit.fetchedAt >= ttlMs) {
        return undefined;
      }
      return hit.body;
    },
    set(provider, baseUrl, body) {
      entries.set(`${provider} ${baseUrl}`, { body, fetchedAt: now() });
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
 * One provider's model-list body as the upstream sent it. Non-2xx
 * upstream replies become an UpstreamError carrying upstreamStatus,
 * exactly as the v1.1 single-provider flow.
 */
async function fetchRawModelList(
  entry: ProviderEntry,
  config: GatewayConfig,
  requestId: string,
  source?: Provider | "playground",
): Promise<unknown> {
  const targetRoute = PROVIDER_ROUTES[entry.type].find(
    (r) => r.kind === "models",
  )!;
  const url = `${entry.baseUrl}${targetRoute.requestPath()}`;

  logger.info(
    {
      requestId,
      ...(source !== undefined ? { sourceApi: source } : {}),
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

  return upstream.body;
}

/**
 * The raw model-list body, 60 s cached per provider (spec §3.6): the
 * /models flow decodes it per provider, live prices (Task 8) read
 * `pricing` straight off it.
 */
export async function getRawModelList(
  entry: ProviderEntry,
  config: GatewayConfig,
  requestId: string,
  source?: Provider | "playground",
): Promise<unknown> {
  const cached = sharedCache.get(entry.name, entry.baseUrl);
  if (cached !== undefined) return cached;
  const body = await fetchRawModelList(
    entry,
    config,
    requestId,
    source ?? currentTrace()?.sourceApi,
  );
  sharedCache.set(entry.name, entry.baseUrl, body);
  return body;
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
    return adapters[entry.type].toCanonicalModelList(
      await getRawModelList(entry, config, requestId, source),
    );
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
