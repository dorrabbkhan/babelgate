/**
 * multi-turn-reasoning (v1.6 plan Task 13b): three turns, each
 * echoing the prior assistant content (thinking block + text / a
 * reasoning output item) as a real client does in a continued
 * conversation. Pass = reasoning present on every turn's client
 * stream, no non-2xx (the 400-on-echo bug class), and every upstream
 * request from turn 2 on still carries reasoning per the target's
 * wire rules:
 * - OpenRouter Chat: `reasoning` / `reasoning_details` —
 *   https://openrouter.ai/docs/use-cases/reasoning-tokens
 * - DeepSeek Chat: `reasoning_content` —
 *   https://api-docs.deepseek.com/guides/reasoning_model
 * - Gemini: `thought` / `thoughtSignature` on a model part —
 *   https://ai.google.dev/gemini-api/docs/thinking
 */
import {
  anthropicAssistantContent,
  clientStreamHasReasoningBeforeText,
  responsesOutputItems,
  upstreamCarriesReasoning,
} from "./client";
import type { AnthropicBlock } from "./client";
import type { Scenario, TurnResult } from "./types";
import { shape } from "./types";

const QUESTIONS = [
  "What is the weather in Paris?",
  "And in London?",
  "And in Rome?",
];

function anthropicTurn(n: number): {
  request: (prev: TurnResult[]) => unknown;
} {
  return {
    request: (prev: TurnResult[]) => {
      const messages: unknown[] = [
        { role: "user", content: QUESTIONS[0] },
      ];
      for (let i = 0; i < n - 1; i += 1) {
        const content: AnthropicBlock[] = anthropicAssistantContent(
          prev[i].body,
        );
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: QUESTIONS[i + 1] });
      }
      return {
        model: "$MODEL",
        max_tokens: 512,
        stream: true,
        thinking: { type: "enabled", budget_tokens: 256 },
        messages,
      };
    },
  };
}

function responsesTurn(n: number): {
  request: (prev: TurnResult[]) => unknown;
} {
  return {
    request: (prev: TurnResult[]) => {
      const input: unknown[] = [QUESTIONS[0]];
      for (let i = 0; i < n - 1; i += 1) {
        input.push(...responsesOutputItems(prev[i].body));
        input.push(QUESTIONS[i + 1]);
      }
      return {
        model: "$MODEL",
        stream: true,
        reasoning: { effort: "low" },
        input,
      };
    },
  };
}

function build(
  client: "anthropic" | "responses",
  upstream: "openai" | "gemini",
): Scenario {
  const first =
    client === "anthropic"
      ? {
          model: "$MODEL",
          max_tokens: 512,
          stream: true,
          thinking: { type: "enabled", budget_tokens: 256 },
          messages: [{ role: "user", content: QUESTIONS[0] }],
        }
      : {
          model: "$MODEL",
          stream: true,
          reasoning: { effort: "low" },
          input: QUESTIONS[0],
        };
  return {
    name: `multi-turn-reasoning:${client}->${upstream}`,
    client,
    upstream,
    // recorded by the conductor: OpenRouter reasoning, or Gemini
    // includeThoughts — every turn's upstream call gets the same body
    replay:
      upstream === "openai" ? "openai/reasoning.sse" : "gemini/thinking.sse",
    turns: [
      { request: first },
      client === "anthropic" ? anthropicTurn(2) : responsesTurn(2),
      client === "anthropic" ? anthropicTurn(3) : responsesTurn(3),
    ],
    assert: (results) => {
      const evidence = {
        request: shape(
          results.map((t) => ({
            status: t.status,
            upstream: t.upstream.map((u) => u.body),
          })),
        ),
        response: shape(
          results.map((t) => ({ status: t.status, events: t.sseEvents })),
        ),
      };
      for (const [i, t] of results.entries()) {
        if (t.status !== 200) {
          return {
            pass: false,
            reason: `turn ${i + 1} status ${t.status}`,
            evidence,
          };
        }
        if (!clientStreamHasReasoningBeforeText(t, client)) {
          return {
            pass: false,
            reason: `turn ${i + 1} client stream carries no reasoning block`,
            evidence,
          };
        }
        if (i > 0) {
          const carried = t.upstream.some((r) =>
            upstreamCarriesReasoning(r, upstream),
          );
          if (!carried) {
            return {
              pass: false,
              reason: `turn ${i + 1} upstream request dropped the reasoning block`,
              evidence,
            };
          }
        }
      }
      return { pass: true, evidence };
    },
  };
}

export const scenarios: Scenario[] = [
  build("anthropic", "openai"),
  build("responses", "openai"),
  build("anthropic", "gemini"),
  build("responses", "gemini"),
];
