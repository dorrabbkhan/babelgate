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
import type { ResponsesRequest } from "../../src/types/responses.types";
import {
  upstreamHandlers,
  capturedRequests,
  resetCaptured,
  resetOverrides,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";
import codexTurns from "../fixtures/codex/turns.json";

/**
 * Codex-on-the-bridge coverage (v1.4 spec §2.2): the recorded Codex
 * fallback bodies decode without throwing, and the stateful Responses
 * surfaces are refused before routing — a Responses-envelope 400 for
 * stateful fields, a 404 for the retrieval/deletion/compact endpoints.
 */

const server = setupServer(...upstreamHandlers);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });

  process.env.OPENAI_API_BASE_URL = MOCK_BASE_URLS.openai;
  process.env.OPENAI_API_KEY = "test-key";
});

beforeEach(() => {
  process.env.SOURCE_API = "responses";
  process.env.TARGET_API = "openai";
  resetConfig();
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
});

afterAll(() => {
  server.close();
});

const basicBody = {
  model: "gpt-5-codex",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello" }],
    },
  ],
  store: false,
};

describe("codex bridge", () => {
  it("previous_response_id rejected before routing", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .send({ ...basicBody, previous_response_id: "resp_earlier" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        type: "invalid_request_error",
        code: "unsupported_parameter",
        param: "previous_response_id",
        message:
          "babelgate is stateless: previous_response_id is not supported",
      },
    });
    // refused before any upstream call
    expect(capturedRequests.openai).toHaveLength(0);
  });

  it("store true rejected", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .send({ ...basicBody, store: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        type: "invalid_request_error",
        code: "unsupported_parameter",
        param: "store",
        message: "babelgate is stateless: store is not supported",
      },
    });
    expect(capturedRequests.openai).toHaveLength(0);
  });

  it("conversation rejected", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .send({ ...basicBody, conversation: "conv_1" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        type: "invalid_request_error",
        code: "unsupported_parameter",
        param: "conversation",
        message: "babelgate is stateless: conversation is not supported",
      },
    });
    expect(capturedRequests.openai).toHaveLength(0);
  });

  // Owner decision (task3 notes): responses-lite is pass-through only
  // in v1.4 — on the bridge its `additional_tools` input item is a 400
  // naming the unsupported item.
  it("additional_tools input item rejected", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .send({
        ...basicBody,
        input: [
          { type: "additional_tools", tools: [] },
          ...basicBody.input,
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "unsupported_parameter",
      param: "additional_tools",
    });
    expect(capturedRequests.openai).toHaveLength(0);
  });

  it("message phase input item rejected", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .send({
        ...basicBody,
        input: [
          {
            type: "message",
            role: "user",
            phase: "commentary",
            content: [{ type: "input_text", text: "Hello" }],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "unsupported_parameter",
      param: "phase",
    });
    expect(capturedRequests.openai).toHaveLength(0);
  });

  it("reasoning.context rejected", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .send({ ...basicBody, reasoning: { effort: "high", context: 50 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "unsupported_parameter",
      param: "reasoning.context",
    });
    expect(capturedRequests.openai).toHaveLength(0);
  });

  it("namespaced custom_tool_call rejected", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .send({
        ...basicBody,
        input: [
          ...basicBody.input,
          {
            type: "custom_tool_call",
            call_id: "call_1",
            name: "functions.exec",
            namespace: "functions",
            input: "echo hi",
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "unsupported_parameter",
      param: "custom_tool_call",
    });
    expect(capturedRequests.openai).toHaveLength(0);
  });

  it("store false accepted", async () => {
    const res = await request(app).post("/v1/responses").send(basicBody);

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("response");
    expect(capturedRequests.openai).toHaveLength(1);
  });

  it("GET /v1/responses/abc is a responses 404", async () => {
    const res = await request(app).get("/v1/responses/abc");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        type: "not_found_error",
        code: "not_found",
        param: null,
        message:
          "babelgate is stateless: GET /v1/responses/abc is not supported",
      },
    });
    expect(capturedRequests.openai).toHaveLength(0);
  });

  it("DELETE /v1/responses/abc is a responses 404", async () => {
    const res = await request(app).delete("/v1/responses/abc");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "not_found" });
  });

  it("POST /v1/responses/compact is a responses 404", async () => {
    const res = await request(app)
      .post("/v1/responses/compact")
      .send(basicBody);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "not_found" });
    expect(capturedRequests.openai).toHaveLength(0);
  });

  it("recorded codex turns decode without throwing", () => {
    for (const turn of codexTurns.turns) {
      expect(() =>
        adapters.responses.toCanonicalRequest(turn as ResponsesRequest),
      ).not.toThrow();
    }
  });
});
