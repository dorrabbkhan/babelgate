import { ConfigurationError } from "../utils/errors";
import { adapters, type Provider } from "./adapters";
import type {
  CanonicalRequest,
  CanonicalResponse,
} from "../types/canonical.types";

// Re-export adapters
export {
  adapters,
  MEDIA_SUPPORT,
  PATCH_GAPS,
  PROVIDER_PATHS,
  PROVIDER_ROUTES,
  type Provider,
  type ProviderRoute,
  type RouteKind,
} from "./adapters";
export * from "../types/canonical.types";

/**
 * Transform a request from source provider format to target provider format.
 * Uses canonical format as intermediate representation.
 *
 * Flow: Source Request → Canonical → Target Request
 */
export function transformRequest(
  sourceProvider: Provider,
  targetProvider: Provider,
  request: unknown,
): unknown {
  const sourceAdapter = adapters[sourceProvider];
  const targetAdapter = adapters[targetProvider];

  if (!sourceAdapter) {
    throw new ConfigurationError(`Unknown source provider: ${sourceProvider}`, {
      availableProviders: Object.keys(adapters),
    });
  }

  if (!targetAdapter) {
    throw new ConfigurationError(`Unknown target provider: ${targetProvider}`, {
      availableProviders: Object.keys(adapters),
    });
  }

  // Source → Canonical → Target
  const canonical = sourceAdapter.toCanonicalRequest(request);
  return targetAdapter.fromCanonicalRequest(canonical);
}

/**
 * Transform a response from target provider format back to source provider format.
 * Uses canonical format as intermediate representation.
 *
 * Flow: Target Response → Canonical → Source Response
 */
export function transformResponse(
  sourceProvider: Provider,
  targetProvider: Provider,
  response: unknown,
  model: string,
): unknown {
  const sourceAdapter = adapters[sourceProvider];
  const targetAdapter = adapters[targetProvider];

  if (!sourceAdapter) {
    throw new ConfigurationError(`Unknown source provider: ${sourceProvider}`, {
      availableProviders: Object.keys(adapters),
    });
  }

  if (!targetAdapter) {
    throw new ConfigurationError(`Unknown target provider: ${targetProvider}`, {
      availableProviders: Object.keys(adapters),
    });
  }

  // Target → Canonical → Source
  const canonical = targetAdapter.toCanonicalResponse(response, model);
  return sourceAdapter.fromCanonicalResponse(canonical);
}

/**
 * Get transformer functions for a source-target pair.
 * Returns functions that handle the full transformation pipeline.
 */
export function getTransformers(
  sourceProvider: Provider,
  targetProvider: Provider,
): {
  transformRequest: (request: unknown) => unknown;
  transformResponse: (response: unknown, model: string) => unknown;
} {
  return {
    transformRequest: (request: unknown) =>
      transformRequest(sourceProvider, targetProvider, request),
    transformResponse: (response: unknown, model: string) =>
      transformResponse(sourceProvider, targetProvider, response, model),
  };
}

/**
 * Convert any provider request to canonical format.
 */
export function toCanonical(
  provider: Provider,
  request: unknown,
): CanonicalRequest {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new ConfigurationError(`Unknown provider: ${provider}`, {
      availableProviders: Object.keys(adapters),
    });
  }
  return adapter.toCanonicalRequest(request);
}

/**
 * Convert canonical request to any provider format.
 */
export function fromCanonical(
  provider: Provider,
  request: CanonicalRequest,
): unknown {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new ConfigurationError(`Unknown provider: ${provider}`, {
      availableProviders: Object.keys(adapters),
    });
  }
  return adapter.fromCanonicalRequest(request);
}
