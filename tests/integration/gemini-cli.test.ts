import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { setupServer } from "msw/node";
import request from "supertest";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import { adapters } from "../../src/transformers";
import { makeCanonicalError } from "../../src/utils/canonical-error";
import {
  upstreamHandlers,
  capturedRequests,
  resetCaptured,
  resetOverrides,
  resetReplyOptins,
  resetStreamCase,
  reasoningReply,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";
import {
  packEnvelope,
  unpackEnvelope,
} from "../../src/transformers/reasoning-envelope";
import {
  fromGeminiSignature,
  toGeminiSignature,
} from "../../src/transformers/adapters/gemini.signature";

/**
 * Gemini CLI essentials (spec §3.10, evidence E10–E12 from the
 * record-gemini-cli.sh run against Gemini CLI 0.66.0): the locally
 * answered :countTokens, 501 for unsupported methods, and the wire
 * shapes the CLI actually sends — functionDeclarations with
 * `parametersJsonSchema` (never `parameters`) and history functionCall
 * parts carrying `id` plus a sibling `thoughtSignature`.
 */
const server = setupServer(...upstreamHandlers);

const providers = ["openai", "gemini", "ollama", "anthropic"] as const;

function setPair(source: string, target: string): void {
  process.env.SOURCE_API = source;
  process.env.TARGET_API = target;
  resetConfig();
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  for (const p of providers) {
    process.env[`${p.toUpperCase()}_API_BASE_URL`] = MOCK_BASE_URLS[p];
    process.env[`${p.toUpperCase()}_API_KEY`] = "test-key";
  }
});

beforeEach(() => {
  process.env.UPSTREAM_RETRIES = "0";
  setPair("gemini", "ollama");
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  resetReplyOptins();
  resetStreamCase();
  delete process.env.UPSTREAM_RETRIES;
  resetConfig();
});

afterAll(() => {
  server.close();
});

/**
 * The edit-task history shape Gemini CLI 0.66.0 sends (recorded
 * 2026-11-04): a model turn whose functionCall part carries a wire
 * `id` and a part-level sibling `thoughtSignature`, a user turn with a
 * matching `functionResponse`, and tools whose functionDeclarations
 * use `parametersJsonSchema`.
 */
const RECORDED_HISTORY_BODY = {
  contents: [
    { role: "user", parts: [{ text: "make the failing test pass" }] },
    {
      role: "model",
      parts: [
        {
          functionCall: {
            id: "call_1",
            name: "update_topic",
            args: { title: "t", summary: "s" },
          },
          thoughtSignature: "sig",
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call_1",
            name: "update_topic",
            response: { content: "done" },
          },
        },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: "update_topic",
          description: "Update the current topic",
          parametersJsonSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short title" },
              summary: { type: "string", description: "Longer summary" },
            },
            required: ["title"],
          },
        },
      ],
    },
  ],
};

describe("Gemini CLI essentials (spec §3.10)", () => {
  it("countTokens answered locally", async () => {
    setPair("gemini", "ollama");

    const res = await request(app)
      .post("/v1beta/models/gemini-2.5-pro:countTokens")
      .send({
        contents: [{ role: "user", parts: [{ text: "count my tokens" }] }],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["x-babelgate-token-estimate"]).toBe("true");
    expect(res.body.totalTokens).toBeGreaterThan(0);
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it("countTokens accepts the generateContentRequest form", async () => {
    // models.countTokens bodies take either `contents[]` or a full
    // GenerateContentRequest under `generateContentRequest`
    // (https://ai.google.dev/api/tokens) — the estimate counts the
    // same input the same body sent to :generateContent would.
    setPair("gemini", "ollama");

    const res = await request(app)
      .post("/v1beta/models/gemini-2.5-pro:countTokens")
      .send({
        generateContentRequest: {
          contents: [
            { role: "user", parts: [{ text: "count my tokens" }] },
          ],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["x-babelgate-token-estimate"]).toBe("true");
    expect(res.body.totalTokens).toBeGreaterThan(0);
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it("unsupported gemini method is a gemini 501", async () => {
    setPair("gemini", "ollama");

    const res = await request(app)
      .post("/v1beta/models/gemini-2.5-pro:embedContent")
      .send({ contents: [{ role: "user", parts: [{ text: "x" }] }] });

    expect(res.status, JSON.stringify(res.body)).toBe(501);
    expect(res.body).toEqual(
      adapters.gemini.fromCanonicalError(
        makeCanonicalError("unsupported", "embedContent is not supported"),
      ),
    );
    expect(capturedRequests.ollama).toHaveLength(0);
  });

  it("history functionCall parts send the thoughtSignature placeholder", async () => {
    // The canonical format can't carry thoughtSignatures yet (v1.3
    // owner decision 1a; real carry-through is a Task-3-window
    // follow-up), so the request encoder emits Google's documented
    // `skip_thought_signature_validator` placeholder on every outgoing
    // functionCall part — without it Gemini 3.x upstreams 400 the
    // first tool-history turn.
    setPair("gemini", "gemini");

    const res = await request(app)
      .post("/v1beta/models/gemini-2.5-pro:generateContent")
      .send(RECORDED_HISTORY_BODY);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests.gemini).toHaveLength(1);
    const upstream = capturedRequests.gemini[0] as {
      contents?: { parts?: Record<string, unknown>[] }[];
    };
    const callPart = upstream.contents
      ?.flatMap((c) => c.parts ?? [])
      .find((p) => p.functionCall !== undefined);
    expect(callPart).toEqual({
      functionCall: {
        name: "update_topic",
        args: { title: "t", summary: "s" },
      },
      thoughtSignature: "skip_thought_signature_validator",
    });
  });

  it("parametersJsonSchema decodes to tool parameters (recorded shape)", async () => {
    setPair("gemini", "gemini");

    const res = await request(app)
      .post("/v1beta/models/gemini-2.5-pro:generateContent")
      .send(RECORDED_HISTORY_BODY);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests.gemini).toHaveLength(1);
    const upstream = capturedRequests.gemini[0] as {
      tools?: { functionDeclarations?: { name?: string; parameters?: unknown }[] }[];
    };
    const decl = upstream.tools?.[0]?.functionDeclarations?.[0];
    expect(decl?.name).toBe("update_topic");
    expect(decl?.parameters).toEqual({
      type: "object",
      properties: {
        title: { type: "string", description: "Short title" },
        summary: { type: "string", description: "Longer summary" },
      },
      required: ["title"],
    });
  });

  it("envelope thoughtSignature round-trips through a Gemini-3-style upstream", async () => {
    // Task 14 live-pass fix: the client-facing thoughtSignature is
    // standard base64 of the bg1. envelope (a bytes field — Go genai's
    // []uint8). A client echoing it — verbatim or Go-style
    // decode→re-encode — sends the original upstream signature back
    // on turn two (continuity, nothing foreign).
    setPair("gemini", "gemini");
    reasoningReply.gemini = true;

    const turn1 = await request(app)
      .post("/v1beta/models/gemini-3.8-flash:generateContent")
      .send({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      });
    expect(turn1.status, JSON.stringify(turn1.body)).toBe(200);

    const parts = turn1.body.candidates?.[0]?.content?.parts as {
      text?: string;
      thought?: boolean;
      functionCall?: { name: string; args: unknown };
      thoughtSignature?: string;
    }[];
    const sig = parts.find((p) => p.thought === true)?.thoughtSignature;
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(unpackEnvelope(fromGeminiSignature(sig!))).toMatchObject({
      v: 1,
      signatures: [
        {
          toolCallId: expect.any(String),
          signature: { data: "sig-gem-1-call" },
        },
      ],
    });

    // Turn two: the client echoes the model turn. Once verbatim and
    // once as the Go-style re-encoded string (decode → standard
    // base64 — the identical bytes, exactly what genai's []uint8
    // round trip sends).
    for (const echoSig of [
      sig,
      Buffer.from(sig!, "base64").toString("base64"),
    ]) {
      const echoed = parts.map((p) =>
        p.thought === true ? { ...p, thoughtSignature: echoSig } : p,
      );
      const turn2 = await request(app)
        .post("/v1beta/models/gemini-3.8-flash:generateContent")
        .send({
          contents: [
            { role: "user", parts: [{ text: "hi" }] },
            { role: "model", parts: echoed },
          ],
        });
      expect(turn2.status, JSON.stringify(turn2.body)).toBe(200);
    }

    // Two upstream requests per echoed turn pair's second leg —
    // turn 1 plus the two echo turns.
    expect(capturedRequests.gemini).toHaveLength(3);
    for (const upstream of capturedRequests.gemini.slice(1) as {
      contents?: { role?: string; parts?: Record<string, unknown>[] }[];
    }[]) {
      const modelParts = upstream.contents?.find(
        (c) => c.role === "model",
      )?.parts;
      const thoughtPart = modelParts?.find((p) => p.thought === true);
      const callPart = modelParts?.find(
        (p) => p.functionCall !== undefined,
      );
      expect(thoughtPart?.thoughtSignature).toBe("sig-gem-1-think");
      expect(callPart?.thoughtSignature).toBe("sig-gem-1-call");
    }
  });

  it("model-role functionResponse reaches Gemini, OpenAI and Ollama upstreams as a tool result", async () => {
    // Live-pass finding 4 (round 4): the captured agy 1.5.11 turn-2
    // request sends the tool result in a "model"-role content — the
    // function-calling docs show it under "user"
    // (https://ai.google.dev/gemini-api/docs/function-calling) but
    // Google's API accepts the "model" form. Without the decode fix
    // the forwarded request ended on a model turn and Google answered
    // 400 "Requests ending with a model turn are not supported". The
    // signature is the wire form toGeminiSignature emits for a
    // turn-1 envelope; its origin names the Gemini attempt so the
    // upstream signature is restored verbatim.
    const upstreamSig = "sig-upstream-1";
    const envelope = packEnvelope({
      v: 1,
      reasoning: [],
      signatures: [
        {
          toolCallId: "call_1",
          signature: {
            origin: { provider: "gemini", model: "gemini-3.8-flash" },
            data: upstreamSig,
          },
        },
      ],
    })!;
    // The captured turn-2 shape verbatim (values shortened): user
    // text, a model turn whose functionCall carries the
    // thoughtSignature, then a model turn with the functionResponse.
    const agyTurn2 = {
      contents: [
        { role: "user", parts: [{ text: "make the failing test pass" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call_1",
                name: "update_topic",
                args: { title: "t", summary: "s" },
              },
              thoughtSignature: toGeminiSignature(envelope),
            },
          ],
        },
        {
          role: "model",
          parts: [
            {
              functionResponse: {
                id: "call_1",
                name: "update_topic",
                response: { output: "done" },
              },
            },
          ],
        },
      ],
    };

    setPair("gemini", "gemini");
    const geminiRes = await request(app)
      .post("/v1beta/models/gemini-3.8-flash:generateContent")
      .send(agyTurn2);
    expect(geminiRes.status, JSON.stringify(geminiRes.body)).toBe(200);
    expect(capturedRequests.gemini).toHaveLength(1);
    const geminiUp = capturedRequests.gemini[0] as {
      contents?: unknown[];
    };
    // The tool result lands as a user-role functionResponse content —
    // the documented wire shape — and the model turn's signature is
    // the restored upstream one, not the envelope.
    expect(geminiUp.contents).toEqual([
      { role: "user", parts: [{ text: "make the failing test pass" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "update_topic",
              args: { title: "t", summary: "s" },
            },
            thoughtSignature: upstreamSig,
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "update_topic",
              response: { output: "done" },
            },
          },
        ],
      },
    ]);

    setPair("gemini", "openai");
    const openaiRes = await request(app)
      .post("/v1beta/models/gemini-3.8-flash:generateContent")
      .send(agyTurn2);
    expect(openaiRes.status, JSON.stringify(openaiRes.body)).toBe(200);
    expect(capturedRequests.openai).toHaveLength(1);
    const openaiUp = capturedRequests.openai[0] as {
      messages?: unknown[];
    };
    expect(openaiUp.messages).toEqual([
      { role: "user", content: "make the failing test pass" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "update_topic",
              arguments: '{"title":"t","summary":"s"}',
            },
          },
        ],
      },
      {
        role: "tool",
        content: '{"output":"done"}',
        tool_call_id: "call_1",
      },
    ]);

    setPair("gemini", "ollama");
    const ollamaRes = await request(app)
      .post("/v1beta/models/gemini-3.8-flash:generateContent")
      .send(agyTurn2);
    expect(ollamaRes.status, JSON.stringify(ollamaRes.body)).toBe(200);
    expect(capturedRequests.ollama).toHaveLength(1);
    const ollamaUp = capturedRequests.ollama[0] as {
      messages?: unknown[];
    };
    // Ollama pairs a tool result to its call by `tool_name`
    // (docs.ollama.com api.md), resolved from the call id.
    expect(ollamaUp.messages).toEqual([
      { role: "user", content: "make the failing test pass" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            function: {
              index: 0,
              name: "update_topic",
              arguments: { title: "t", summary: "s" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: '{"output":"done"}',
        tool_name: "update_topic",
      },
    ]);
  });

  it("thinkingBudget -1 and 0 survive the streamGenerateContent route", async () => {
    // Antigravity CLI custom models send thinkingBudget -1 (dynamic
    // budget); 0 is thinking off — both documented ThinkingConfig
    // values (https://ai.google.dev/api/generate-content#ThinkingConfig)
    // that used to 400 on the positive() budgetTokens schema.
    setPair("gemini", "gemini");

    const dynamic = await request(app)
      .post("/v1beta/models/gemini-2.5-flash:streamGenerateContent")
      .send({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
      });
    expect(dynamic.status, JSON.stringify(dynamic.body)).toBe(200);

    const off = await request(app)
      .post("/v1beta/models/gemini-2.5-flash:streamGenerateContent")
      .send({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      });
    expect(off.status, JSON.stringify(off.body)).toBe(200);

    // -1 decodes to "provider chooses" — no thinkingConfig upstream;
    // 0 decodes to effort "none" — thinkingBudget 0 back on the wire
    // (2.5-flash takes a budget and can disable thinking).
    expect(capturedRequests.gemini).toHaveLength(2);
    const [dynamicUp, offUp] = capturedRequests.gemini as {
      generationConfig?: { thinkingConfig?: unknown };
    }[];
    expect(dynamicUp.generationConfig?.thinkingConfig).toBeUndefined();
    expect(offUp.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    });
  });
});
