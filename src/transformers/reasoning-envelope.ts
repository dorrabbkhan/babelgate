import type {
  CanonicalContentPart,
  CanonicalReasoningSignature,
} from "../types/canonical.types";

/**
 * v1.4 spec §3.3 — the `bg1.` reasoning envelope. A Responses client
 * (Codex) gets one `reasoning` output item per assistant turn that
 * has reasoning parts or signatures; `encrypted_content` is
 * `"bg1." + base64url(JSON)` carrying the turn's canonical reasoning
 * parts and its tool-call/text signatures, verbatim. Capped at
 * 1 MiB — past that the item is emitted without `encrypted_content`
 * and a `reasoning_dropped`/`envelope_too_large` note is recorded by
 * the caller.
 */
export type EnvelopePayload = {
  v: 1;
  reasoning: CanonicalContentPart[];
  signatures: {
    toolCallId?: string;
    textIndex?: number;
    signature: CanonicalReasoningSignature;
  }[];
};

export const ENVELOPE_PREFIX = "bg1.";
export const ENVELOPE_CAP_BYTES = 1_048_576;

/**
 * Pack a turn's reasoning payload into `encrypted_content` form.
 * Returns undefined when the packed envelope exceeds the cap — the
 * caller emits the reasoning item without `encrypted_content` and
 * records `reasoning_dropped`/`envelope_too_large`.
 */
export function packEnvelope(parts: EnvelopePayload): string | undefined {
  const out = ENVELOPE_PREFIX + Buffer.from(JSON.stringify(parts), "utf8")
    .toString("base64url");
  return Buffer.byteLength(out, "utf8") <= ENVELOPE_CAP_BYTES
    ? out
    : undefined;
}

/**
 * Unpack `encrypted_content`. Anything that isn't a well-formed
 * `bg1.` payload — another upstream's opaque blob, corrupt base64,
 * JSON of the wrong shape — decodes to undefined without throwing.
 */
export function unpackEnvelope(s: string): EnvelopePayload | undefined {
  if (!s.startsWith(ENVELOPE_PREFIX)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(s.slice(ENVELOPE_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    return undefined;
  }
  if (!isEnvelopePayload(payload)) return undefined;
  return payload;
}

function isEnvelopePayload(v: unknown): v is EnvelopePayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.v === 1 && Array.isArray(o.reasoning) && Array.isArray(o.signatures);
}
