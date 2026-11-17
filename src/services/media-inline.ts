import type {
  CanonicalContentPart,
  CanonicalDocument,
  CanonicalImage,
  CanonicalImageMimeType,
  CanonicalMessage,
  CanonicalRequest,
} from "../types/canonical.types";
import { currentAttempt } from "../observe/context";
import { ProxyError, ValidationError } from "../utils/errors";
import { fetchMedia, MediaFetchError } from "./media-fetch";

/**
 * Media shaping per target attempt (v1.5 spec §3.2.2): the services
 * run this on the canonicalForTarget copy, after policy shaping and
 * before the adapter's encode.
 *
 *  - A URL the target accepts by URL passes through untouched.
 *  - A URL the target needs as bytes is fetched (media-fetch's SSRF
 *    guard) and inlined as base64 data.
 *  - A part the target cannot take at all — a document on a target
 *    without document support, an image on a tool message the target
 *    can't carry — is a ValidationError (400 in the source's dialect)
 *    naming the canonical field path and the target. `media.fetch:
 *    false` and any MediaFetchError become the same refusal.
 *  - `text/plain` documents decode to ordinary text parts — every
 *    target takes text (spec: "Text documents become text parts for
 *    every target").
 *
 * The canonical request is never mutated; a request needing no media
 * work returns by reference.
 */

/** What the target's wire format can carry (values per provider docs). */
export type MediaSupport = {
  /** URL-bearing images (Anthropic source.url, OpenAI image_url,
   *  Responses input_image, Gemini fileData.fileUri) */
  imageUrl: boolean;
  /** Inline documents (Anthropic document base64, OpenAI file_data,
   *  Responses input_file, Gemini inlineData pdf) */
  documentData: boolean;
  /** URL-bearing documents (Anthropic source.url, Responses
   *  input_file.file_url, Gemini fileData.fileUri) */
  documentUrl: boolean;
  /** Images inside tool-result content (Task 7 wires the encoders). */
  toolMessageImages: boolean;
};

/** media.fetch/allow_private + the test-injected DNS resolver. */
export interface MediaOptions {
  fetch: boolean;
  allowPrivate: boolean;
  resolve?: (host: string) => Promise<string[]>;
}

/**
 * The §3.2.2 defaults — used when a hand-built (cast) config carries
 * no `media` block; the loaders always set one.
 */
export const MEDIA_DEFAULTS: MediaOptions = {
  fetch: true,
  allowPrivate: false,
};

const CANONICAL_IMAGE_MIMES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

function targetName(): string {
  return currentAttempt()?.providerName ?? "the target";
}

function pathOf(messageIndex: number, partIndex: number): string {
  return `messages[${messageIndex}].content[${partIndex}]`;
}

function refuse(path: string, why: string): never {
  throw new ValidationError(
    `Unsupported media at ${path} for target "${targetName()}": ${why}`,
  );
}

/** A media URL stays a URL, or is fetched into inline data. */
async function fetchToInline(
  url: string,
  path: string,
  media: MediaOptions,
): Promise<{ data: string; mimeType: string }> {
  if (!media.fetch) {
    refuse(
      path,
      "the target needs bytes and media.fetch is off",
    );
  }
  try {
    return await fetchMedia(url, media);
  } catch (err) {
    if (err instanceof MediaFetchError && err.reason === "timeout") {
      // Review Focus 4: a slow media host is a 504-mapped error in
      // the source's dialect — a ProxyError (not UpstreamError, so it
      // is no fallback hop: the provider request never left).
      throw new ProxyError(
        `Media fetch timed out at ${path} for target "${targetName()}" (host "${err.host}")`,
        504,
        "MEDIA_FETCH_TIMEOUT",
      );
    }
    if (err instanceof MediaFetchError) {
      refuse(path, `media fetch failed (${err.reason}) for host "${err.host}"`);
    }
    throw err;
  }
}

async function inlineImage(
  image: CanonicalImage,
  path: string,
  support: MediaSupport,
  media: MediaOptions,
): Promise<CanonicalImage> {
  if (image.url === undefined) return image;
  if (support.imageUrl) return image;
  const fetched = await fetchToInline(image.url, path, media);
  // The server's content-type describes the bytes; a mime the
  // canonical 4 can't carry can't be encoded by any target.
  if (!CANONICAL_IMAGE_MIMES.includes(fetched.mimeType)) {
    refuse(
      path,
      `fetched media type "${fetched.mimeType}" is not a supported image type`,
    );
  }
  return {
    data: fetched.data,
    mimeType: fetched.mimeType as CanonicalImageMimeType,
  };
}

/** Returns the replacement part, or undefined when unchanged. */
async function inlineDocument(
  document: CanonicalDocument,
  path: string,
  support: MediaSupport,
  media: MediaOptions,
): Promise<CanonicalContentPart | undefined> {
  // Text documents become text parts for every target (§3.2.2) — the
  // bytes decode to utf-8; a URL text document needs the same fetch.
  if (document.mimeType === "text/plain") {
    const data =
      document.data ??
      (document.url !== undefined
        ? (
            await fetchDocumentBytes(
              document.url,
              "text/plain",
              path,
              media,
            )
          ).data
        : refuse(path, "document has neither data nor url"));
    return { type: "text", text: Buffer.from(data, "base64").toString("utf8") };
  }
  if (document.url !== undefined) {
    if (support.documentUrl) return undefined;
    if (!support.documentData) {
      refuse(path, "documents are not supported by the target");
    }
    const fetched = await fetchDocumentBytes(
      document.url,
      document.mimeType,
      path,
      media,
    );
    return {
      type: "document",
      document: {
        data: fetched.data,
        mimeType: document.mimeType,
        ...(document.name !== undefined && { name: document.name }),
      },
    };
  }
  if (!support.documentData) {
    refuse(path, "documents are not supported by the target");
  }
  return undefined;
}

/** Fetched document bytes must match the declared document mime —
 *  octet-stream is "unknown" and is trusted. */
async function fetchDocumentBytes(
  url: string,
  declaredMime: CanonicalDocument["mimeType"],
  path: string,
  media: MediaOptions,
): Promise<{ data: string; mimeType: string }> {
  const fetched = await fetchToInline(url, path, media);
  if (
    fetched.mimeType !== declaredMime &&
    fetched.mimeType !== "application/octet-stream"
  ) {
    refuse(
      path,
      `fetched media type "${fetched.mimeType}" does not match the declared "${declaredMime}"`,
    );
  }
  return fetched;
}

async function inlinePart(
  part: CanonicalContentPart,
  role: CanonicalMessage["role"],
  path: string,
  support: MediaSupport,
  media: MediaOptions,
): Promise<CanonicalContentPart> {
  if (part.type === "image" && part.image !== undefined) {
    if (role === "tool" && !support.toolMessageImages) {
      refuse(path, "images in tool messages are not supported by the target");
    }
    const image = await inlineImage(part.image, path, support, media);
    return image === part.image ? part : { ...part, image };
  }
  if (part.type === "document" && part.document !== undefined) {
    const inlined = await inlineDocument(
      part.document,
      path,
      support,
      media,
    );
    if (inlined === undefined) return part;
    return part.cache === undefined
      ? inlined
      : { ...inlined, cache: part.cache };
  }
  return part;
}

export async function inlineMediaForTarget(
  req: CanonicalRequest,
  support: MediaSupport,
  media: MediaOptions,
): Promise<CanonicalRequest> {
  let changed = false;
  const messages = await Promise.all(
    req.messages.map(async (message, messageIndex) => {
      if (!Array.isArray(message.content)) return message;
      const content = await Promise.all(
        message.content.map((part, partIndex) =>
          inlinePart(
            part,
            message.role,
            pathOf(messageIndex, partIndex),
            support,
            media,
          ),
        ),
      );
      const same = content.every((p, i) => p === message.content[i]);
      if (same) return message;
      changed = true;
      return { ...message, content };
    }),
  );
  return changed ? { ...req, messages } : req;
}
