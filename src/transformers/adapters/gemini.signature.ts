import { ENVELOPE_PREFIX } from "../reasoning-envelope";

/**
 * Gemini wire encoding for the `bg1.` reasoning envelope (v1.5 Task
 * 14 live-pass fix). `thoughtSignature` is an opaque bytes field on
 * the wire — https://ai.google.dev/api/generate-content#Part —
 * which clients (e.g. the Go genai SDK's `[]uint8`) decode as
 * standard padded base64. The `bg1.…` string itself is not base64
 * (its `.` is byte 3), so emitting it raw broke Go clients; the
 * envelope now crosses the wire as base64 of its UTF-8 bytes while
 * the pack/unpack contract stays `bg1.` + base64url unchanged.
 */

/**
 * The string a Gemini client sees for `envelope`: standard padded
 * base64 of the `bg1.…` UTF-8 bytes. A Go client decodes it to those
 * bytes and re-encodes them with standard base64 on the next turn —
 * the identical string; a TS client echoes it verbatim.
 */
export function toGeminiSignature(envelope: string): string {
  return Buffer.from(envelope, "utf8").toString("base64");
}

/**
 * Invert `toGeminiSignature` for an echoed `thoughtSignature`. A
 * value already starting with `bg1.` returns unchanged (legacy
 * envelopes issued before this change keep working). Anything else
 * decodes leniently — Node's `base64` accepts the standard and the
 * URL-safe alphabet and missing padding, which covers the Python
 * SDK too; decoded text starting with `bg1.` returns as the
 * envelope, everything else returns `s` unchanged so the caller's
 * "not a bg1. envelope" drop path and its notes behave as before.
 */
export function fromGeminiSignature(s: string): string {
  if (s.startsWith(ENVELOPE_PREFIX)) return s;
  const decoded = Buffer.from(s, "base64").toString("utf8");
  return decoded.startsWith(ENVELOPE_PREFIX) ? decoded : s;
}
