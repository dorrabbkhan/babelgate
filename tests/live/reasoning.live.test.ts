import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { unpackEnvelope } from '../../src/transformers/reasoning-envelope';
import { fromGeminiSignature } from '../../src/transformers/adapters/gemini.signature';
import {
  requireOllama,
  useTarget,
  useYamlConfig,
  liveModel,
  waitForClientRow,
  SOURCE_FORMAT_CHECKS,
  LIVE_OLLAMA_URL,
  LIVE_OLLAMA_SHIM_MODEL,
} from './live.helpers';

/**
 * Live reasoning loops (spec §4): the two signed-signature paths —
 * Claude-Code-shaped requests on a Gemini upstream and
 * Gemini-SDK-shaped requests on an Anthropic upstream — plus the
 * ollama-anthropic preset pass-through, which needs only the local
 * Ollama and keeps the file non-empty when no key is set (a suite
 * with no tests is a vitest collect error). Each keyed case is
 * conditionally included, the suite's convention: `it` inside
 * `if (KEY)`, never a skip API.
 */

beforeAll(requireOllama);

interface AnthropicContentBlock {
  type: string;
  id?: string;
  thinking?: string;
  signature?: string;
}

// One weather tool in Anthropic's dialect — Claude Code's calls are
// tool calls, and `tool_choice: "any"` keeps every turn ending in a
// signed functionCall part so the loop always has an envelope to
// carry (Gemini 3 signs the call even when no thought text comes
// back — Task 1's recording, tests/fixtures/recordings/
// gemini-sdk-thinking.jsonl).
const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

/**
 * The shape the Task 1 recording shows Claude Code sending (system
 * as a block array, tools, metadata.user_id, thinking enabled) —
 * minus the stream flag, which this suite leaves off so replies
 * parse as JSON.
 */
function claudeCodeBody(model: string, messages: unknown[]): object {
  return {
    model,
    max_tokens: 2048,
    temperature: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    system: [
      { type: 'text', text: 'You are Claude Code, a CLI coding assistant.' },
    ],
    tools: [WEATHER_TOOL],
    tool_choice: { type: 'any' },
    metadata: { user_id: 'babelgate-live-suite' },
    messages,
  };
}

if (process.env.GEMINI_API_KEY) {
  describe('live reasoning: anthropic → gemini', () => {
    it('claude code shape on gemini, three-turn reasoning loop', async () => {
      useTarget('anthropic', 'gemini');
      const model = liveModel('gemini');

      let messages: unknown[] = [
        {
          role: 'user',
          content: 'What is the weather in Paris? Use the get_weather tool.',
        },
      ];
      for (let turn = 1; turn <= 3; turn += 1) {
        const res = await request(app)
          .post('/v1/messages')
          .send(claudeCodeBody(model, messages));
        expect(res.status, `turn ${turn}: ${JSON.stringify(res.body)}`).toBe(
          200,
        );
        SOURCE_FORMAT_CHECKS.anthropic(res.body);

        // Every signed part on the Gemini reply (thought or
        // functionCall signature) rides back inside a `bg1.`
        // envelope on a thinking block — the conductor's call (a).
        const content = (res.body.content ?? []) as AnthropicContentBlock[];
        const thinking = content.find((b) => b.type === 'thinking');
        expect(
          thinking?.signature,
          `turn ${turn}: no bg1. envelope on the reply`,
        ).toMatch(/^bg1\./);
        expect(unpackEnvelope(thinking!.signature!)).toMatchObject({ v: 1 });

        // tool_choice "any" must end the turn in a call.
        const toolUse = content.find((b) => b.type === 'tool_use');
        expect(toolUse, `turn ${turn}: no tool_use in reply`).toBeDefined();

        // Resend the turn exactly like Claude Code does: the
        // assistant content — envelope signature included — plus a
        // tool_result user turn.
        messages = [
          ...messages,
          { role: 'assistant', content },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUse!.id,
                content: '18C, sunny',
              },
            ],
          },
        ];
      }
    });
  });
} else {
  console.log(
    'live suite: skipping the claude-code → gemini reasoning loop — GEMINI_API_KEY not set',
  );
}

if (process.env.ANTHROPIC_API_KEY) {
  describe('live reasoning: gemini → anthropic', () => {
    it('gemini sdk shape on claude with thinking', async () => {
      useTarget('gemini', 'anthropic');
      const model = liveModel('anthropic');
      const path = `/v1beta/models/${model}:generateContent`;

      // The shape the Task 1 recording shows the Gemini SDK sending:
      // generationConfig.thinkingConfig {thinkingBudget,
      // includeThoughts} — here aimed at Claude. The functionCallingConfig
      // ANY is the recording's sequential-call loop: Claude's adaptive
      // thinking is only guaranteed at a tool loop's start (PR #108
      // gate B), so a forced call is what makes the signed thinking
      // block deterministic.
      const body = (contents: unknown[], forceCall = true) => ({
        contents,
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Get the current weather for a city.',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            ],
          },
        ],
        // ANY on turn 1 only — turn 2 answers the tool result with text.
        // Forced tool use works with adaptive thinking on Haiku 5.5
        // (https://platform.claude.com/docs/en/build-with-claude/thinking,
        // "Response prefill and forced tool use"); the same page says
        // Opus 5.5, Sonnet 5.5, Fable 5.2/5.1 and Mythos 5.2/5.1 reject
        // it with a 400 — a LIVE_ANTHROPIC_MODEL override to one of
        // those needs AUTO on turn 1 instead.
        toolConfig: {
          functionCallingConfig: { mode: forceCall ? 'ANY' : 'AUTO' },
        },
        generationConfig: {
          maxOutputTokens: 16384,
          // thinkingBudget 8192 decodes to effort "medium"
          // (effortForBudget, src/transformers/reasoning-effort.ts:47 —
          // minimal = 1024, low = 2048). The previous 1024 decoded to
          // "minimal", and the default live model claude-haiku-5-5 uses
          // adaptive thinking, for which the encoder omits `thinking`
          // on "minimal" + records reasoning_effort_lowered
          // (docs/decisions.md ≈ l.4343, the owner-reviewed v1.5 Task
          // 3/4 behaviour) — the upstream body carried no `thinking`
          // and no `output_config` for ANY, AUTO and no-tools alike,
          // so the reply had no thought part. The budget was the
          // test's bug, not the product's.
          thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
        },
      });

      const first = await request(app)
        .post(path)
        .send(
          body([
            {
              role: 'user',
              parts: [{ text: 'What is the weather in Paris?' }],
            },
          ]),
        );
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      SOURCE_FORMAT_CHECKS.gemini(first.body);

      // Anthropic's signed thinking comes back to the Gemini client
      // as a thought part whose thoughtSignature is standard base64
      // of the bg1. envelope (v1.5 Task 14) — the conductor's call (a).
      const modelParts = (
        (first.body.candidates?.[0]?.content?.parts ?? []) as {
          thought?: boolean;
          text?: string;
          thoughtSignature?: string;
          functionCall?: { name?: string; args?: unknown; id?: string };
        }[]
      );
      const thought = modelParts.find((p) => p.thought === true);
      expect(thought, 'no thought part in the reply').toBeDefined();
      expect(
        unpackEnvelope(fromGeminiSignature(thought!.thoughtSignature!)),
      ).toMatchObject({ v: 1 });
      const call = modelParts.find((p) => p.functionCall !== undefined);
      expect(call, 'no functionCall in the reply (mode ANY)').toBeDefined();

      // The SDK appends the candidate's parts unchanged — signature
      // included — and answers the call with a functionResponse, so
      // turn 2 carries the envelope back to Claude. Asserting the
      // loop survived (200, Gemini shape) is the point: whether this
      // reply carries another thought part is the model's call.
      const second = await request(app)
        .post(path)
        .send(
          body(
            [
              {
                role: 'user',
                parts: [{ text: 'What is the weather in Paris?' }],
              },
              { role: 'model', parts: modelParts },
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: call!.functionCall!.id ?? 'call_1',
                      name: 'get_weather',
                      response: { weather: '18C, sunny' },
                    },
                  },
                ],
              },
            ],
            false,
          ),
        );
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      SOURCE_FORMAT_CHECKS.gemini(second.body);
      // AUTO lets the model close the loop or call again — either is a
      // well-formed reply, so the parts array just has to be non-empty.
      expect(
        (
          (second.body.candidates?.[0]?.content?.parts ?? []) as unknown[]
        ).length,
        'turn 2: reply has no content parts',
      ).toBeGreaterThan(0);
    });
  });
} else {
  console.log(
    'live suite: skipping the gemini → claude thinking case — ANTHROPIC_API_KEY not set',
  );
}

describe('live shim preset', () => {
  it('ollama-anthropic preset pass-through with tools', async () => {
    // The preset's own base_url is localhost:11434; the explicit key
    // overrides it so the suite's OLLAMA_API_BASE_URL still wins. The
    // usage store gets a throwaway path — the owner's real
    // ~/.babelgate/usage.db is untouched when this is the first test
    // to create the store.
    const usageDb = join(
      mkdtempSync(join(tmpdir(), 'babelgate-live-shim-')),
      'usage.db',
    );
    const restore = useYamlConfig(`default: ollama
providers:
  ollama:
    preset: ollama-anthropic
    base_url: ${LIVE_OLLAMA_URL}
    context_window: 32768
observe:
  usage_db: ${usageDb}
routes:
  - match: "*"
    to: ollama/${LIVE_OLLAMA_SHIM_MODEL}
`);
    try {
      // Create the usage store (and register its trace sink) before
      // the request — it binds lazily on the first /ui/api hit.
      await waitForClientRow('live-shim', 100);

      const res = await request(app)
        .post('/v1/messages')
        .set('x-babelgate-client', 'live-shim')
        .send({
          model: 'claude-live-shim',
          max_tokens: 512,
          tools: [WEATHER_TOOL],
          tool_choice: { type: 'any' },
          messages: [
            {
              role: 'user',
              content: 'What is the weather in Paris?',
            },
          ],
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.headers['x-babelgate-provider']).toBe('ollama');
      expect(res.headers['x-babelgate-model']).toBe(LIVE_OLLAMA_SHIM_MODEL);
      SOURCE_FORMAT_CHECKS.anthropic(res.body);
      // A well-formed reply is text, thinking or a tool call — a
      // tool-capable model should call, but a small local model may
      // answer directly (same convention as stream.live.test.ts).
      const content = (res.body.content ?? []) as { type?: string }[];
      expect(content.length).toBeGreaterThan(0);
      expect(
        content.some(
          (b) =>
            b.type === 'tool_use' || b.type === 'text' || b.type === 'thinking',
        ),
        JSON.stringify(content.map((b) => b.type)),
      ).toBe(true);

      // The row is what gate B's --expect-passthrough/--expect-preset
      // assert: pass-through, preset ollama-anthropic.
      const row = await waitForClientRow('live-shim');
      expect(row, 'no usage-store row for client live-shim').toBeDefined();
      expect(row!.passthrough).toBe(true);
      expect(row!.preset).toBe('ollama-anthropic');
    } finally {
      restore();
    }
  });
});
