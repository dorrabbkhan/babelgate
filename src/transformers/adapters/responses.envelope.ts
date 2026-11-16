/**
 * v1.5 Task 2 (spec §3.1, §3.2.1): the `bg1.` reasoning envelope moved
 * to the shared module `../reasoning-envelope` so Anthropic and Gemini
 * clients can carry foreign reasoning too, not only Responses clients.
 * This file only re-exports it — Responses behaviour and the 1 MiB cap
 * are unchanged.
 */
export {
  ENVELOPE_CAP_BYTES,
  ENVELOPE_PREFIX,
  packEnvelope,
  unpackEnvelope,
} from "../reasoning-envelope";
export type { EnvelopePayload } from "../reasoning-envelope";
