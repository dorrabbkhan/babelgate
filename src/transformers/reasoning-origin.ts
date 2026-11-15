import { currentAttempt } from "../observe/context";
import type {
  CanonicalReasoningOrigin,
  CanonicalReasoningSignature,
} from "../types/canonical.types";

/**
 * The origin a target decoder tags produced reasoning parts and
 * signatures with (v1.4 spec §3.2): the ambient attempt's provider
 * name and upstream model, or the plan's Task 7 convention
 * `{provider: "", model}` outside an attempt (unit tests, fixture
 * harness). Shared by the anthropic and gemini decoders; holds no
 * provider knowledge, same rule as reasoning-effort.ts.
 */
export function decodeOrigin(model: string): CanonicalReasoningOrigin {
  const attempt = currentAttempt();
  return attempt !== undefined
    ? { provider: attempt.providerName, model: attempt.upstreamModel }
    : { provider: "", model };
}

/**
 * Whether `origin` may be sent to the current attempt's upstream —
 * reasoning and signatures never cross provider or model (spec §3.2:
 * "Reasoning never crosses origin"). Outside an attempt nothing
 * matches: encoders drop it (the Task 7 convention).
 */
export function originMatchesCurrent(
  origin: CanonicalReasoningOrigin | undefined,
): boolean {
  const attempt = currentAttempt();
  return (
    attempt !== undefined &&
    origin !== undefined &&
    origin.provider === attempt.providerName &&
    origin.model === attempt.upstreamModel
  );
}

/** `originMatchesCurrent` for an optional signature field. */
export function signatureMatchesCurrent(
  signature: CanonicalReasoningSignature | undefined,
): signature is CanonicalReasoningSignature {
  return (
    signature !== undefined && originMatchesCurrent(signature.origin)
  );
}
