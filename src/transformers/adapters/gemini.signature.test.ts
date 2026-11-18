import { describe, expect, it } from 'vitest';
import {
  fromGeminiSignature,
  toGeminiSignature,
} from './gemini.signature';
import { packEnvelope, unpackEnvelope } from '../reasoning-envelope';

/**
 * v1.5 Task 14 live-pass fix: `thoughtSignature` is a bytes field on
 * the wire — the `bg1.` envelope crosses it as standard padded
 * base64 so Go genai's `[]uint8` decoding works. The envelope
 * payload itself is unchanged (pack/unpack contract untouched).
 */
describe('gemini signature encoding', () => {
  const envelope = packEnvelope({
    v: 1,
    reasoning: [
      {
        type: 'reasoning',
        reasoning: {
          text: 'hmm',
          origin: { provider: 'p', model: 'm' },
        },
      },
    ],
    signatures: [],
  })!;

  it('toGeminiSignature output is standard padded base64', () => {
    const sig = toGeminiSignature(envelope);
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(sig).toBe(Buffer.from(envelope, 'utf8').toString('base64'));
    expect(sig).not.toContain('bg1.');
  });

  it('fromGeminiSignature round trips', () => {
    expect(fromGeminiSignature(toGeminiSignature(envelope))).toBe(
      envelope,
    );
    expect(
      unpackEnvelope(fromGeminiSignature(toGeminiSignature(envelope))),
    ).toEqual(unpackEnvelope(envelope));
  });

  it('fromGeminiSignature accepts the legacy bg1. form', () => {
    // Envelopes issued before the base64 wrap keep working.
    expect(fromGeminiSignature(envelope)).toBe(envelope);
  });

  it('fromGeminiSignature accepts the url-safe unpadded form', () => {
    // Python's SDK may send url-safe alphabet without padding.
    const urlsafe = Buffer.from(envelope, 'utf8')
      .toString('base64url')
      .replace(/=+$/, '');
    expect(fromGeminiSignature(urlsafe)).toBe(envelope);
  });

  it('fromGeminiSignature leaves a foreign signature unchanged', () => {
    // A real upstream signature — opaque base64 whose bytes don't
    // decode to a `bg1.` envelope — passes through so the caller's
    // "not a bg1. envelope" drop path sees exactly what it saw before.
    const foreign = Buffer.from('opaque sig bytes').toString('base64');
    expect(fromGeminiSignature(foreign)).toBe(foreign);
    expect(fromGeminiSignature('opaque-upstream-sig')).toBe(
      'opaque-upstream-sig',
    );
  });

  it('a Go client round trip returns the identical string', () => {
    // Go's genai SDK unmarshals thoughtSignature into []uint8 and
    // marshals it back with standard padded base64 — decode to bytes,
    // re-encode, and the client echoes the identical string.
    const wire = toGeminiSignature(envelope);
    const goBytes = Buffer.from(wire, 'base64');
    const goResend = goBytes.toString('base64');
    expect(goResend).toBe(wire);
    expect(fromGeminiSignature(goResend)).toBe(envelope);
  });
});
