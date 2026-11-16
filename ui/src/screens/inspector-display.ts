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

/**
 * The display form of one body value. Canonical reasoning parts become
 * labelled `reasoning` blocks; canonical signatures become
 * `<signature: N bytes, origin provider/model>`; wire-level
 * `signature`/`thoughtSignature` strings, a `data` string inside a
 * `redacted_thinking` block, and `encrypted_content` (the bg1
 * envelope or an upstream blob) become byte-count placeholders. A
 * keyless string that holds a raw stream (SSE or NDJSON) is masked
 * line by line — the bytes never reach the DOM.
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
    if (key === undefined) {
      // A raw upstream stream snapshot is a bare string on the
      // snapshot itself (or nested in an array): mask each line.
      return displayStreamText(value);
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
      out[k] =
        k === "data" &&
        o.type === "redacted_thinking" &&
        typeof v === "string"
          ? `<signature: ${byteLen(v)} bytes>`
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
 * payloads) pass through unchanged. A multi-line string that isn't a
 * stream is returned as-is.
 */
function displayStreamText(text: string): string {
  const lines = text.split("\n");
  if (lines.some((l) => l.startsWith("data:"))) {
    return lines
      .map((l) => {
        if (!l.startsWith("data:")) return l;
        try {
          return `data: ${JSON.stringify(
            displayValue(JSON.parse(l.slice(5))),
          )}`;
        } catch {
          return l;
        }
      })
      .join("\n");
  }
  const masked: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") {
      masked.push(l);
      continue;
    }
    try {
      masked.push(JSON.stringify(displayValue(JSON.parse(l))));
    } catch {
      return text;
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
  return { ...snapshot, value: displayValue(snapshot.value) };
}
