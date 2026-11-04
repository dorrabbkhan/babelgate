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
  resetStreamCase,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";

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
});
