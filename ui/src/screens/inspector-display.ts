import type { BodySnapshot } from "../api";

// ============ Opaque-artifact rendering (v1.4 spec §3.4) ============
// Signature and envelope bytes are content: they may sit in the body
// ring, but the inspector never paints them — a placeholder carries
// the byte count and the origin instead.

interface ReasoningOrigin {
  provider: string;
  model: string;
}

function isOrigin(v: unknown): v is ReasoningOrigin {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).provider === "string" &&
    typeof (v as Record<string, unknown>).model === "string"
  );
}

/** Canonical signature: {origin: {provider, model}, data: string}. */
function isSignature(
  v: unknown,
): v is { origin: ReasoningOrigin; data: string } {
  return (
    v !== null &&
    typeof v === "object" &&
    isOrigin((v as Record<string, unknown>).origin) &&
    typeof (v as Record<string, unknown>).data === "string"
  );
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ============ Media rendering (v1.5 spec §3.2.2) ============
// Media bytes are content too: image and document parts render as
// `image (url: <host>/…)` / `image (<mimeType>, <KB> KB)` /
// `document (<mimeType>, <name>, <KB> KB)` — the URL's host and the
// byte size, never the bytes. One label covers every wire carrier:
// canonical image/document parts, Anthropic `source` blocks, chat
// `image_url`/`file` parts, Responses `input_image`/`input_file`,
// Gemini `inlineData`/`fileData` and Ollama `images[]` strings.

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function kbLabel(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** Decoded byte count of a base64 string → "<n> KB" (min 1). */
function kbOf(base64: string): string {
  return kbLabel(Math.floor((base64.length * 3) / 4));
}

/** A URL ref → "url: <host>/…"; a data: URI → mime + size. */
function refLabel(url: string): string {
  const d = DATA_URL.exec(url);
  return d !== null
    ? `${d[1]}, ${kbOf(d[2]!)}`
    : `url: ${hostOf(url)}/…`;
}

function join(parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => p !== undefined).join(", ");
}

/** Byte size of a media ref — base64-decoded, or plain when `text`. */
function sizeOf(ref: { data?: string; text?: boolean }): string | undefined {
  if (ref.data === undefined) return undefined;
  return ref.text === true ? kbLabel(byteLen(ref.data)) : kbOf(ref.data);
}

/** `image (<mimeType>, <KB> KB)` for bytes, `image (url: <host>/…)` for a ref. */
function imageLabel(ref: {
  url?: string;
  data?: string;
  text?: boolean;
  mime?: string;
}): string {
  if (ref.url !== undefined) return `image (${refLabel(ref.url)})`;
  if (ref.data !== undefined) {
    return `image (${join([ref.mime, sizeOf(ref)])})`;
  }
  return "image";
}

/** `document (<mimeType>, <name>, <KB> KB)` — name absent when the wire has none. */
function documentLabel(ref: {
  url?: string;
  data?: string;
  text?: boolean;
  mime?: string;
  name?: string;
}): string {
  const inner = join([
    ref.mime,
    ref.name,
    ref.url !== undefined ? refLabel(ref.url) : sizeOf(ref),
  ]);
  return inner === "" ? "document" : `document (${inner})`;
}

/** file/file_data carriers (chat `file`, Responses `input_file`) → a document. */
function fileLabel(f: Rec): string {
  const fd = strOf(f.file_data);
  const d = fd !== undefined ? DATA_URL.exec(fd) : null;
  return documentLabel({
    url: d === null ? strOf(f.file_url) : undefined,
    data: d !== null ? d[2] : fd,
    mime: d !== null ? d[1] : undefined,
    name: strOf(f.filename),
  });
}

/**
 * The media label for one object, or undefined when it carries no
 * media. Detection is structural — a shape is media in every stage,
 * so the same label serves source, canonical, target and response.
 */
function mediaOf(o: Rec): string | undefined {
  switch (o.type) {
    case "image":
    case "document": {
      // Canonical part (`image`/`document` key) or Anthropic wire
      // block (`source` key — image, document and text sources).
      const part = o[o.type];
      const box = isRec(part)
        ? part
        : isRec(o.source)
          ? o.source
          : undefined;
      if (box === undefined) return undefined;
      const ref = {
        url: strOf(box.url),
        data: strOf(box.data),
        // Anthropic `source.type:"text"` data is plain text, not
        // base64 — its size is its byte length.
        text: box.type === "text" || undefined,
        mime: strOf(box.mimeType) ?? strOf(box.media_type),
      };
      return o.type === "image"
        ? imageLabel(ref)
        : documentLabel({ ...ref, name: strOf(box.name) });
    }
    case "image_url":
    case "input_image": {
      const url = isRec(o.image_url)
        ? strOf(o.image_url.url)
        : strOf(o.image_url);
      return url !== undefined ? imageLabel({ url }) : undefined;
    }
    case "file":
      return isRec(o.file) ? fileLabel(o.file) : undefined;
    case "input_file":
      return fileLabel(o);
  }
  // Gemini parts carry no `type` — inlineData is bytes, fileData a ref.
  const inline = isRec(o.inlineData) ? o.inlineData : undefined;
  if (inline !== undefined) {
    const data = strOf(inline.data);
    if (data === undefined) return undefined;
    const mime = strOf(inline.mimeType);
    return mime !== undefined && mime.startsWith("image/")
      ? imageLabel({ data, mime })
      : documentLabel({ data, mime });
  }
  const fileData = isRec(o.fileData) ? o.fileData : undefined;
  if (fileData !== undefined) {
    const url = strOf(fileData.fileUri);
    if (url === undefined) return undefined;
    const mime = strOf(fileData.mimeType);
    return mime !== undefined && mime.startsWith("image/")
      ? imageLabel({ url, mime })
      : documentLabel({ url, mime });
  }
  return undefined;
}

/**
 * The display form of one body value. Canonical reasoning parts become
 * labelled `reasoning` blocks; canonical signatures become
 * `<signature: N bytes, origin provider/model>`; wire-level
 * `signature`/`thoughtSignature` strings, a `data` string inside a
 * `redacted_thinking` block, and `encrypted_content` (the bg1
 * envelope or an upstream blob) become byte-count placeholders.
 * Nested and array-element strings are content and render unchanged;
 * raw-stream masking happens only on the snapshot's own top-level
 * string (see displaySnapshot).
 */
function displayValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key === "signature" || key === "thoughtSignature") {
      return `<signature: ${byteLen(value)} bytes>`;
    }
    if (key === "encrypted_content") {
      return value.startsWith("bg1.")
        ? `<envelope: ${byteLen(value)} bytes>`
        : `<encrypted_content: ${byteLen(value)} bytes>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => displayValue(v));
  }
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (isSignature(o)) {
      return (
        `<signature: ${byteLen(o.data)} bytes, ` +
        `origin ${o.origin.provider}/${o.origin.model}>`
      );
    }
    // Media parts → `image (…)`/`document (…)` labels — the host and
    // byte size, never the bytes (v1.5 spec §3.2.2).
    const media = mediaOf(o);
    if (media !== undefined) return media;
    // A canonical reasoning part → one labelled, collapsible block.
    if (
      o.type === "reasoning" &&
      o.reasoning !== null &&
      typeof o.reasoning === "object"
    ) {
      const block: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(
        o.reasoning as Record<string, unknown>,
      )) {
        block[k] =
          k === "origin" && isOrigin(v)
            ? `${v.provider}/${v.model}`
            : displayValue(v, k);
      }
      if (o.signature !== undefined) {
        block.signature = displayValue(o.signature, "signature");
      }
      if (o.cache !== undefined) {
        block.cache = displayValue(o.cache, "cache");
      }
      return { reasoning: block };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      // Anthropic redacted_thinking.data carries signature bytes —
      // masked parent-aware, so an ordinary `data` key stays visible.
      // Ollama `images[]` carries raw base64 strings — each becomes an
      // `image (<KB> KB)` label (v1.5 §3.2.2).
      out[k] =
        k === "data" &&
        o.type === "redacted_thinking" &&
        typeof v === "string"
          ? `<signature: ${byteLen(v)} bytes>`
          : k === "images" &&
              Array.isArray(v) &&
              v.every((s) => typeof s === "string")
            ? v.map((s) => `image (${kbOf(s as string)})`)
            : displayValue(v, k);
    }
    return out;
  }
  return value;
}

/**
 * A raw stream snapshot — SSE (`data:` lines) or NDJSON (one JSON
 * object per line, no `data:`). Each `data:` payload or NDJSON line
 * that parses as JSON is masked through displayValue and re-encoded;
 * framing lines (`event:`, blanks, `data: [DONE]`, unparseable
 * payloads) pass through unchanged — except the last non-blank line:
 * a client abort or the wire cap can cut the stream mid-line, and the
 * partial payload may carry the first bytes of a signature, so it
 * renders as `<truncated: N bytes>` instead. A multi-line string that
 * isn't a stream is returned as-is. Text counts as NDJSON only with
 * at least two non-blank lines: a lone line that doesn't parse as
 * JSON is a plain string (e.g. "Bad Gateway"), not a cut stream, and
 * renders unchanged.
 */
function displayStreamText(text: string): string {
  const lines = text.split("\n");
  let lastNonBlank = -1;
  let nonBlank = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      if (lastNonBlank === -1) lastNonBlank = i;
      nonBlank++;
    }
  }
  if (lines.some((l) => l.startsWith("data:"))) {
    return lines
      .map((l, i) => {
        if (!l.startsWith("data:")) return l;
        const payload = l.slice(5);
        try {
          return `data: ${JSON.stringify(
            displayValue(JSON.parse(payload)),
          )}`;
        } catch {
          return i === lastNonBlank && payload.trim() !== "[DONE]"
            ? `data: <truncated: ${byteLen(payload)} bytes>`
            : l;
        }
      })
      .join("\n");
  }
  if (nonBlank < 2) {
    // A lone line isn't a stream: mask it only when it parses as
    // JSON, otherwise render the plain string unchanged.
    if (lastNonBlank === -1) return text;
    try {
      lines[lastNonBlank] = JSON.stringify(
        displayValue(JSON.parse(lines[lastNonBlank])),
      );
      return lines.join("\n");
    } catch {
      return text;
    }
  }
  const masked: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      masked.push(l);
      continue;
    }
    try {
      masked.push(JSON.stringify(displayValue(JSON.parse(l))));
    } catch {
      if (i !== lastNonBlank) return text;
      masked.push(`<truncated: ${byteLen(l)} bytes>`);
    }
  }
  return masked.join("\n");
}

/** A snapshot with its opaque bytes swapped for placeholders. */
export function displaySnapshot(snapshot: BodySnapshot): BodySnapshot;
export function displaySnapshot(
  snapshot: BodySnapshot | undefined,
): BodySnapshot | undefined;
export function displaySnapshot(
  snapshot: BodySnapshot | undefined,
): BodySnapshot | undefined {
  if (snapshot === undefined) return undefined;
  return {
    ...snapshot,
    value:
      typeof snapshot.value === "string"
        ? displayStreamText(snapshot.value)
        : displayValue(snapshot.value),
  };
}
