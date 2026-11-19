import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { MEDIA_SUPPORT, type Provider } from '../../src/transformers';
import {
  useTarget,
  liveTargets,
  liveModel,
  SOURCE_FORMAT_CHECKS,
  ASSISTANT_TEXT,
  LIVE_MEDIA_IMAGE_URL,
  LIVE_MEDIA_PDF_URL,
  type LiveTarget,
} from './live.helpers';

/**
 * Live media cases (spec §4): one URL image and one URL PDF per
 * capable provider, sent in Anthropic's dialect — the source format
 * that expresses both natively (`source.type: "url"` on image and
 * document blocks). "Capable" is declared, not guessed: a provider
 * whose adapter takes a URL image and a document (by URL or by
 * fetched bytes — MEDIA_SUPPORT in src/transformers/adapters). The
 * "openrouter" target is excluded — it is an OpenAI-shaped endpoint
 * whose model's media capability is whoever owns the key's choice,
 * not a declared provider feature. Ollama is covered by the
 * always-on refusal case below: its dialect carries neither.
 *
 * Model capability is the owner's env: each LIVE_<TARGET>_MODEL must
 * be one that accepts the media (the bundled defaults do —
 * gpt-4o-mini, gemini-3.8-flash, claude-haiku-5-5; Responses'
 * gpt-5-codex may not, and a refusal there is a real finding).
 */

interface MediaBody {
  model: string;
  max_tokens: number;
  messages: {
    role: string;
    content: (
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'url'; url: string } }
      | { type: 'document'; source: { type: 'url'; url: string } }
    )[];
  }[];
}

function mediaBody(model: string, kind: 'image' | 'pdf'): MediaBody {
  const media =
    kind === 'image'
      ? ({
          type: 'image',
          source: { type: 'url', url: LIVE_MEDIA_IMAGE_URL },
        } as const)
      : ({
          type: 'document',
          source: { type: 'url', url: LIVE_MEDIA_PDF_URL },
        } as const);
  return {
    model,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              kind === 'image'
                ? 'What is in this image? Answer in one word.'
                : 'How many pages does this document have? Answer with a number.',
          },
          media,
        ],
      },
    ],
  };
}

function providerType(target: LiveTarget): Provider {
  return target === 'openrouter' ? 'openai' : target;
}

const CAPABLE_TARGETS = liveTargets().filter(
  (target) =>
    target !== 'openrouter' &&
    MEDIA_SUPPORT[providerType(target)].imageUrl === true &&
    (MEDIA_SUPPORT[providerType(target)].documentData === true ||
      MEDIA_SUPPORT[providerType(target)].documentUrl === true),
);

describe('live media', () => {
  // Always-on, no upstream: the refusal lands in canonical shaping,
  // before any provider request — Ollama carries neither URL images
  // nor documents (MEDIA_SUPPORT), so its row is the refusal path,
  // not a media case. Keeps the file non-empty with no keys set.
  it('document to an incapable target is refused in the source dialect', async () => {
    useTarget('anthropic', 'ollama');
    const res = await request(app)
      .post('/v1/messages')
      .send(mediaBody('refusal-model', 'pdf'));

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'documents are not supported',
    );
  });

  if (CAPABLE_TARGETS.length === 0) {
    console.log(
      'live suite: skipping the url image and pdf cases — no media-capable target has a key',
    );
  }
  it.each(CAPABLE_TARGETS.map((target) => ({ target })))(
    'url image and pdf per capable provider: $target',
    async ({ target }) => {
      useTarget('anthropic', target);
      const model = liveModel(target);

      const image = await request(app)
        .post('/v1/messages')
        .send(mediaBody(model, 'image'));
      expect(image.status, `image: ${JSON.stringify(image.body)}`).toBe(200);
      SOURCE_FORMAT_CHECKS.anthropic(image.body);
      expect(ASSISTANT_TEXT.anthropic(image.body)).toBeTruthy();

      const pdf = await request(app)
        .post('/v1/messages')
        .send(mediaBody(model, 'pdf'));
      expect(pdf.status, `pdf: ${JSON.stringify(pdf.body)}`).toBe(200);
      SOURCE_FORMAT_CHECKS.anthropic(pdf.body);
      expect(ASSISTANT_TEXT.anthropic(pdf.body)).toBeTruthy();
    },
  );
});
