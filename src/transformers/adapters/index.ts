import { openaiAdapter } from "./openai.adapter";
import { geminiAdapter } from "./gemini.adapter";
import { ollamaAdapter } from "./ollama.adapter";
import { anthropicAdapter } from "./anthropic.adapter";
import { responsesAdapter } from "./responses.adapter";
import type { ProviderAdapter } from "../../types/canonical.types";

export type Provider =
  | "openai"
  | "gemini"
  | "ollama"
  | "anthropic"
  | "responses";

export const adapters: Record<Provider, ProviderAdapter<unknown, unknown>> = {
  openai: openaiAdapter as ProviderAdapter<unknown, unknown>,
  gemini: geminiAdapter as ProviderAdapter<unknown, unknown>,
  ollama: ollamaAdapter as ProviderAdapter<unknown, unknown>,
  anthropic: anthropicAdapter as ProviderAdapter<unknown, unknown>,
  responses: responsesAdapter as ProviderAdapter<unknown, unknown>,
};

export type RouteKind = "chat" | "models" | "count_tokens";

/** Fields shared by every route kind. */
interface ProviderRouteBase {
  /** HTTP method on the incoming request */
  method: "GET" | "POST";
  /** Incoming request path prefix */
  pathPrefix: string;
  /** Upstream endpoint path (model only used by gemini chat) */
  requestPath: (model?: string) => string;
  /** Upstream streaming endpoint path when it differs from requestPath */
  streamRequestPath?: (model?: string) => string;
  /** Model id carried in the incoming path (gemini chat only) */
  modelFromPath?: (path: string) => string | undefined;
  /** Path names the provider's streaming endpoint (gemini chat only) */
  isStreamPath?: (path: string) => boolean;
  /** Path names a method this route serves (gemini chat only) */
  isSupportedPath?: (path: string) => boolean;
  /** Claim test when the prefix alone is ambiguous (gemini count_tokens shares the chat prefix) */
  matchesPath?: (path: string) => boolean;
}

/**
 * A route is a discriminated union on `kind`: only `count_tokens`
 * carries the reply/input shapes of the locally answered endpoint,
 * and on it `countTokensBody` is required — the local answer can't
 * exist without it.
 */
export type ProviderRoute = ProviderRouteBase &
  (
    | { kind: "chat" | "models" }
    | {
        kind: "count_tokens";
        /** Local count_tokens reply in this provider's dialect */
        countTokensBody: (estimate: number) => unknown;
        /**
         * Unwraps the provider's count-tokens request body into the
         * chat-request shape the source adapter decodes. Gemini's
         * `models.countTokens` takes either `contents[]` or a full
         * `GenerateContentRequest` under `generateContentRequest`
         * (googleapis proto google/ai/generativelanguage/v1beta/
         * generative_service.proto, `CountTokensRequest` — `contents`
         * is ignored when it is set); absent on providers whose
         * count-tokens body already is the chat request (Anthropic).
         */
        countTokensRequest?: (body: unknown) => unknown;
      }
  );

/**
 * The "<model>:<method>" pair carried in a gemini chat path
 * (/v1beta/models/<model>:<method>). The method suffix is
 * ":"-separated; the model id may be percent-encoded and may contain
 * "/" (e.g. tunedModels/x). Undefined when the path has no such pair.
 */
function geminiPathParts(
  path: string,
): { model: string; method: string } | undefined {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // malformed escapes — fall back to the raw path
  }
  const prefix = "/v1beta/models/";
  if (!decoded.startsWith(prefix)) return undefined;
  const rest = decoded.slice(prefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon === -1) return undefined;
  return { model: rest.slice(0, colon), method: rest.slice(colon + 1) };
}

/**
 * Route conventions per provider. Each provider exposes routes for every
 * endpoint kind it supports — matched by method + pathPrefix.
 */
export const PROVIDER_ROUTES: Record<Provider, ProviderRoute[]> = {
  openai: [
    {
      kind: "chat",
      method: "POST",
      pathPrefix: "/v1/chat/completions",
      requestPath: () => "/v1/chat/completions",
    },
    {
      kind: "models",
      method: "GET",
      pathPrefix: "/v1/models",
      requestPath: () => "/v1/models",
    },
  ],
  gemini: [
    {
      // Answered locally (spec §3.10, E4) — must precede the
      // /v1beta/models chat route: it shares that prefix and routes
      // match in order. Claims only "<model>:countTokens" paths.
      kind: "count_tokens",
      method: "POST",
      pathPrefix: "/v1beta/models",
      requestPath: () => "/v1beta/models",
      matchesPath: (path) =>
        geminiPathParts(path)?.method === "countTokens",
      countTokensBody: (estimate) => ({ totalTokens: estimate }),
      // googleapis proto google/ai/generativelanguage/v1beta/
      // generative_service.proto, `CountTokensRequest`: the body
      // takes `contents[]` or a full GenerateContentRequest under
      // `generateContentRequest`; `contents` is ignored when it is
      // set. Unwrapping makes the estimate count the same input the
      // same body sent to :generateContent would.
      countTokensRequest: (body) =>
        (body as { generateContentRequest?: unknown } | null)
          ?.generateContentRequest ?? body,
    },
    {
      kind: "chat",
      method: "POST",
      pathPrefix: "/v1beta/models",
      requestPath: (model) => `/v1beta/models/${model}:generateContent`,
      streamRequestPath: (model) =>
        `/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      modelFromPath: (path) => geminiPathParts(path)?.model,
      isStreamPath: (path) =>
        geminiPathParts(path)?.method === "streamGenerateContent",
      // A path without a "<m>:<method>" pair isn't claimed here — it
      // falls through to the model-from-body flow as before.
      isSupportedPath: (path) => {
        const method = geminiPathParts(path)?.method;
        return (
          method === undefined ||
          method === "generateContent" ||
          method === "streamGenerateContent"
        );
      },
    },
    {
      kind: "models",
      method: "GET",
      pathPrefix: "/v1beta/models",
      requestPath: () => "/v1beta/models",
    },
  ],
  ollama: [
    {
      kind: "chat",
      method: "POST",
      pathPrefix: "/api/chat",
      requestPath: () => "/api/chat",
    },
    {
      kind: "models",
      method: "GET",
      pathPrefix: "/api/tags",
      requestPath: () => "/api/tags",
    },
  ],
  anthropic: [
    {
      // Answered locally (spec §3.5) — must precede the /v1/messages
      // chat route: it shares that prefix and routes match in order.
      kind: "count_tokens",
      method: "POST",
      pathPrefix: "/v1/messages/count_tokens",
      requestPath: () => "/v1/messages",
      countTokensBody: (estimate) => ({ input_tokens: estimate }),
    },
    {
      kind: "chat",
      method: "POST",
      pathPrefix: "/v1/messages",
      requestPath: () => "/v1/messages",
    },
    {
      kind: "models",
      method: "GET",
      pathPrefix: "/v1/models",
      requestPath: () => "/v1/models",
    },
  ],
  responses: [
    {
      // Only the create endpoint is proxied — GET/DELETE /v1/responses/<id>
      // and POST /v1/responses/compact are stateful surfaces refused by
      // proxy.service before routing (v1.4 spec §2.2). detect-source
      // still claims the whole prefix so their rejections render in the
      // responses envelope.
      kind: "chat",
      method: "POST",
      pathPrefix: "/v1/responses",
      requestPath: () => "/v1/responses",
      matchesPath: (path) => path === "/v1/responses",
    },
    {
      // Clients whose base URL already ends in /v1 POST to /responses.
      kind: "chat",
      method: "POST",
      pathPrefix: "/responses",
      requestPath: () => "/v1/responses",
      matchesPath: (path) => path === "/responses",
    },
    {
      // A responses upstream answers the OpenAI model-list shape.
      kind: "models",
      method: "GET",
      pathPrefix: "/v1/models",
      requestPath: () => "/v1/models",
    },
  ],
};

/**
 * Match an incoming request to a route on the given source provider
 * (method + path prefix). Used by proxy.service.
 */
export function findSourceRoute(
  source: Provider,
  method: string,
  path: string,
): ProviderRoute | undefined {
  return PROVIDER_ROUTES[source].find(
    (r) =>
      r.method === method &&
      path.startsWith(r.pathPrefix) &&
      (r.matchesPath?.(path) ?? true),
  );
}

/**
 * Back-compat view of the chat routes — chat endpoint per provider.
 * Prefer PROVIDER_ROUTES for new code.
 */
export const PROVIDER_PATHS: Record<
  Provider,
  { pathPrefix: string; requestPath: (model: string) => string }
> = Object.fromEntries(
  (Object.keys(PROVIDER_ROUTES) as Provider[]).map((provider) => {
    const chat = PROVIDER_ROUTES[provider].find((r) => r.kind === "chat")!;
    return [
      provider,
      { pathPrefix: chat.pathPrefix, requestPath: chat.requestPath },
    ];
  }),
) as Record<
  Provider,
  { pathPrefix: string; requestPath: (model: string) => string }
>;

export {
  openaiAdapter,
  geminiAdapter,
  ollamaAdapter,
  anthropicAdapter,
  responsesAdapter,
};
