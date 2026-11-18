/**
 * Gap fixes on the same-format pass-through path (v1.5 spec §3.3).
 *
 * A provider entry's `gaps` list declares what its upstream's
 * same-format endpoint lacks; each gap has exactly one fix (§3.3's
 * table). The source adapter's `patchGaps` owns ALL the format
 * knowledge — where `tool_choice`, `cache_control`, image sources
 * and document blocks live in its JSON and what each fix is. This
 * service only orchestrates, twice:
 *
 *   1. `patchGaps` strips/refuses and reports `needsMedia`: JSON
 *      paths of URL-image leaves the upstream cannot read by URL.
 *   2. Each leaf is fetched (media-fetch's SSRF guard) and a
 *      `{data, mimeType}` placeholder is written in its place;
 *      `patchGaps` then runs again and renders every placeholder in
 *      the format's own inline shape — so the bytes' destination
 *      never leaves the adapter.
 *
 * A `documents` gap refuses inside `patchGaps` with a
 * ValidationError — the error handler renders it in the source's
 * dialect and the request never leaves. `count_tokens` and
 * `stream_usage` carry no body patch: the former suppresses the
 * count_tokens forward so the local estimate answers
 * (passthrough.ts), the latter asks the format for usage where a
 * field exists and otherwise flags the trace estimate
 * (passthrough-trace.ts).
 */
import { currentAttempt } from "../observe/context";
import type { TranslationNote } from "../observe/trace";
import type { Gap } from "../config/provider-presets";
import { PATCH_GAPS, type Provider } from "../transformers";
import { ProxyError, ValidationError } from "../utils/errors";
import { fetchMedia, MediaFetchError } from "./media-fetch";
import type { MediaOptions } from "./media-inline";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/** What the source adapter's `patchGaps` returns (spec §3.3). */
export interface GapPatch {
  /** The patched request body — the input is never mutated. */
  body: Obj;
  /** Notes the fixes raised (codes and paths, never content). */
  notes: TranslationNote[];
  /** JSON paths of URL-image leaves to fetch and inline. */
  needsMedia: string[];
}

/**
 * The per-format patch function each pass-through-capable adapter
 * exports — format knowledge only, keyed by gap name.
 */
export type PatchGaps = (
  body: Obj,
  gaps: readonly Gap[],
) => GapPatch;

function targetName(): string {
  return currentAttempt()?.providerName ?? "the target";
}

function refuse(path: string, why: string): never {
  throw new ValidationError(
    `Unsupported media at ${path} for target "${targetName()}": ${why}`,
  );
}

/**
 * One media URL → inline bytes, with media-inline's error mapping:
 * `media.fetch: false` and fetch failures refuse (400 in the
 * source's dialect); a timeout is a 504-mapped ProxyError — not an
 * UpstreamError, so it is no fallback hop (Review Focus 4).
 */
async function fetchForInline(
  url: string,
  path: string,
  media: MediaOptions,
): Promise<{ data: string; mimeType: string }> {
  if (!media.fetch) {
    refuse(path, "the target needs bytes and media.fetch is off");
  }
  try {
    return await fetchMedia(url, media);
  } catch (err) {
    if (err instanceof MediaFetchError && err.reason === "timeout") {
      throw new ProxyError(
        `Media fetch timed out at ${path} for target "${targetName()}" (host "${err.host}")`,
        504,
        "MEDIA_FETCH_TIMEOUT",
      );
    }
    if (err instanceof MediaFetchError) {
      refuse(
        path,
        `media fetch failed (${err.reason}) for host "${err.host}"`,
      );
    }
    throw err;
  }
}

/** "a[0].b[1]" → ["a", 0, "b", 1] — the needsMedia path syntax. */
function pathSegments(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    segments.push(
      match[2] !== undefined ? Number(match[2]) : (match[1] as string),
    );
  }
  return segments;
}

function leafAt(body: Obj, path: string): Obj | undefined {
  let node: unknown = body;
  for (const segment of pathSegments(path)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Obj)[segment];
  }
  return node === null || typeof node !== "object"
    ? undefined
    : (node as Obj);
}

// The image mimes every format's inline shape accepts — the same set
// media-inline admits into the canonical format (§3.2.1).
const INLINE_IMAGE_MIMES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Run the source format's `patchGaps` for the entry's declared gaps,
 * fetch every URL image it marked and let a second patch pass render
 * the fetched bytes inline. The client's body is never mutated —
 * the adapter returns a patched copy each pass. Providers without a
 * pass-through shim (no patchGaps) or an empty gap list pass through
 * untouched.
 */
export async function applyGapFixes(
  source: Provider,
  body: Obj,
  gaps: readonly Gap[],
  media: MediaOptions,
): Promise<{ body: Obj; notes: TranslationNote[] }> {
  const patch = PATCH_GAPS[source];
  if (patch === undefined || gaps.length === 0) {
    return { body, notes: [] };
  }
  // Throws ValidationError on a `documents` gap — the refusal is the
  // fix; it never reaches the wire.
  let patched = patch(body, gaps);
  const notes = [...patched.notes];
  while (patched.needsMedia.length > 0) {
    for (const path of patched.needsMedia) {
      const leaf = leafAt(patched.body, path);
      const url =
        leaf !== undefined && typeof leaf.url === "string"
          ? leaf.url
          : undefined;
      if (leaf === undefined || url === undefined) continue;
      const fetched = await fetchForInline(url, path, media);
      if (!INLINE_IMAGE_MIMES.includes(fetched.mimeType)) {
        refuse(
          path,
          `fetched media type "${fetched.mimeType}" is not a supported image type`,
        );
      }
      // The {data, mimeType} placeholder the next pass renders —
      // the URL (and any URL marker, e.g. Anthropic's type:"url")
      // comes off so the leaf is just fetched bytes.
      delete leaf.url;
      delete leaf.type;
      leaf.data = fetched.data;
      leaf.mimeType = fetched.mimeType;
      notes.push({
        stage: "encode",
        adapter: source,
        code: "url_image_inlined",
        path,
      });
    }
    // Second pass renders the placeholders; its needsMedia is empty
    // (nothing URL-shaped remains), so the loop ends.
    patched = patch(patched.body, gaps);
    notes.push(...patched.notes);
  }
  return { body: patched.body, notes };
}
