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
  resetReplyOptins,
  reasoningReply,
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
  resetReplyOptins();
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

// ===== v1.4 Task 5: custom tools, namespace tools, parallel_tool_calls =====

import { http, HttpResponse } from "msw";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responseOverrides } from "../mocks/upstreams";
import { canonicalForTarget } from "../../src/services/attempt-targets";
import type { ProviderEntry } from "../../src/routing/registry";
import type { Provider } from "../../src/transformers";
import { registerSink, type TraceSink } from "../../src/observe/emit";
import type { RequestTrace } from "../../src/observe/trace";

/**
 * Owner decision A: `{type:"namespace"}` tools flatten to
 * `ns__leaf` function tools on every non-Responses target and calls
 * come back as `{name: leaf, namespace: ns}` — the explicit field
 * Codex's router reads (codex-rs/core/src/tools/router.rs at
 * 0.169.0). Custom tools lower to one-string functions and come
 * back as `custom_tool_call`.
 */

const traces: RequestTrace[] = [];
const recorder: TraceSink = { name: "recorder", accept: (t) => traces.push(t) };
registerSink(recorder);

const TMP_DIR = mkdtempSync(join(tmpdir(), "bg-codex5-"));

const NAMESPACE_TOOL = {
  type: "namespace",
  name: "multi_agent_v1",
  description: "Tools for spawning and managing sub-agents.",
  tools: [
    {
      type: "function",
      name: "spawn_agent",
      description: "Spawn a sub-agent",
      parameters: { type: "object" },
    },
  ],
};

const CUSTOM_TOOL = {
  type: "custom",
  name: "apply_patch",
  description: "Apply a patch",
  format: { type: "grammar", syntax: "lark", definition: "start: patch" },
};

const namespacedRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-5-codex",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "spawn an agent" }],
    },
  ],
  store: false,
  tools: [NAMESPACE_TOOL],
  ...extra,
});

const customRequest = (extra: Record<string, unknown> = {}) => ({
  model: "gpt-5-codex",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "patch it" }],
    },
  ],
  store: false,
  tools: [CUSTOM_TOOL],
  ...extra,
});

function useTarget(t: Provider, yaml?: string): void {
  process.env.TARGET_API = t;
  process.env[`${t.toUpperCase()}_API_BASE_URL`] = MOCK_BASE_URLS[t];
  process.env[`${t.toUpperCase()}_API_KEY`] = "test-key";
  if (yaml !== undefined) {
    const file = join(TMP_DIR, `gw-${t}-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(file, yaml);
    process.env.BABELGATE_CONFIG = file;
  } else {
    delete process.env.BABELGATE_CONFIG;
  }
  resetConfig();
}

/** A tool-call reply in each dialect naming the flattened call. */
const FLAT_CALL_REPLIES: Record<string, unknown> = {
  openai: {
    id: "chatcmpl-tc",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "multi_agent_v1__spawn_agent",
                arguments: "{}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
  anthropic: {
    id: "msg_tc",
    type: "message",
    role: "assistant",
    model: "m",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "multi_agent_v1__spawn_agent",
        input: {},
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  gemini: {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "multi_agent_v1__spawn_agent",
                args: {},
              },
            },
          ],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    modelVersion: "m",
  },
  ollama: {
    model: "m",
    created_at: "2024-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          function: {
            name: "multi_agent_v1__spawn_agent",
            arguments: {},
          },
        },
      ],
    },
    done: true,
    done_reason: "stop",
  },
};

/** Minimal dialect SSE/NDJSON streams carrying the flattened call. */
function flatCallStream(t: Provider): { text: string; contentType: string } {
  switch (t) {
    case "openai":
      return {
        contentType: "text/event-stream",
        text: [
          'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"multi_agent_v1__spawn_agent","arguments":""}}]},"finish_reason":null}]}',
          "",
          'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]}',
          "",
          'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      };
    case "anthropic":
      return {
        contentType: "text/event-stream",
        text: [
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}',
          "",
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"multi_agent_v1__spawn_agent","input":{}}}',
          "",
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
          "",
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          "",
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}',
          "",
          "event: message_stop",
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"),
      };
    case "gemini":
      return {
        contentType: "text/event-stream",
        text: [
          'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"multi_agent_v1__spawn_agent","args":{}}}]},"finishReason":"STOP","index":0}],"modelVersion":"m"}',
          "",
        ].join("\n"),
      };
    case "ollama":
      return {
        contentType: "application/x-ndjson",
        text: [
          '{"model":"m","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"multi_agent_v1__spawn_agent","arguments":{}}}]},"done":false}',
          '{"model":"m","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}',
          "",
        ].join("\n"),
      };
    default:
      throw new Error(`no stream for ${t}`);
  }
}

const TARGET_PATHS: Record<string, string> = {
  openai: `${MOCK_BASE_URLS.openai}/v1/chat/completions`,
  anthropic: `${MOCK_BASE_URLS.anthropic}/v1/messages`,
  gemini: `${MOCK_BASE_URLS.gemini}/v1beta/models/*`,
  ollama: `${MOCK_BASE_URLS.ollama}/api/chat`,
};

/** OpenAI-dialect SSE carrying one function call whose arguments
 *  arrive in `pieces`. */
function openaiCallStream(name: string, pieces: string[]): string {
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) =>
    `data: ${JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}`;
  return [
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name, arguments: "" },
        },
      ],
    }),
    ...pieces.map((p) =>
      chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] }),
    ),
    chunk({}, "tool_calls"),
    "data: [DONE]",
    "",
  ].join("\n\n");
}

/** supertest parses SSE as an opaque body — collect it as text. */
function postResponsesStream(body: unknown): request.Test {
  return request(app)
    .post("/v1/responses")
    .send(body)
    .buffer(true)
    .parse((res, cb) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => cb(null, text));
    });
}

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f !== "")
    .flatMap((frame) =>
      frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, "")),
    )
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d) as Record<string, unknown>);
}

describe("custom and namespace tools (v1.4 spec §3.6)", () => {
  it("custom tool reaches a gemini upstream as a function and returns as custom_tool_call", async () => {
    useTarget("gemini");
    responseOverrides.gemini = {
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "apply_patch",
                    args: { input: "*** Begin Patch\n@@" },
                  },
                },
              ],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        modelVersion: "m",
      },
    };

    const res = await request(app)
      .post("/v1/responses")
      .send(customRequest());
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The custom tool went upstream as a one-string function tool.
    const upstream = capturedRequests.gemini[0] as {
      tools?: Array<{ functionDeclarations?: Array<Record<string, unknown>> }>;
    };
    expect(upstream.tools?.[0].functionDeclarations).toEqual([
      {
        name: "apply_patch",
        description: expect.stringContaining("Apply a patch"),
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      },
    ]);

    // …and the call came back as a custom_tool_call, input raw.
    expect(res.body.output).toEqual([
      {
        type: "custom_tool_call",
        id: expect.any(String),
        call_id: expect.any(String),
        name: "apply_patch",
        input: "*** Begin Patch\n@@",
        status: "completed",
      },
    ]);
  });

  it("custom tool input is never diagnosed or repaired", async () => {
    // Review Focus 4: apply_patch-style input containing fences and
    // braces, with repair_tool_calls on — the client receives the
    // input byte-identical; zero diagnostics, zero repairs.
    const INPUT = "*** Begin Patch\n```\n{\n```";
    const yaml = `default: fix
providers:
  fix:
    type: openai
    base_url: ${MOCK_BASE_URLS.openai}
    api_key_env: OPENAI_API_KEY
    repair_tool_calls: true
routes:
  - match: "*"
    to: fix/m
`;
    useTarget("openai", yaml);
    responseOverrides.openai = {
      body: {
        id: "chatcmpl-tc",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "apply_patch",
                    arguments: JSON.stringify({ input: INPUT }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    };

    const before = traces.length;
    const res = await request(app)
      .post("/v1/responses")
      .send(customRequest());
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(res.body.output).toEqual([
      {
        type: "custom_tool_call",
        id: expect.any(String),
        call_id: expect.any(String),
        name: "apply_patch",
        input: INPUT,
        status: "completed",
      },
    ]);

    const trace = traces[before];
    expect(trace).toBeDefined();
    expect(trace.diagnostics).toEqual([]);
    expect(trace.repairs).toEqual([]);
  });

  it("custom input streams byte-identical end to end with repair on (Review Focus 4)", async () => {
    // A streaming Responses request with apply_patch and
    // repair_tool_calls on, routed to a non-Responses target that
    // streams the lowered {"input": …} call across several deltas —
    // the input must arrive byte-identical, never diagnosed or
    // repaired.
    const INPUT = "*** Begin Patch\n```\n{\n```";
    const yaml = `default: fix
providers:
  fix:
    type: openai
    base_url: ${MOCK_BASE_URLS.openai}
    api_key_env: OPENAI_API_KEY
    repair_tool_calls: true
routes:
  - match: "*"
    to: fix/m
`;
    useTarget("openai", yaml);
    const args = JSON.stringify({ input: INPUT });
    // Split mid-string and mid-fence.
    const pieces = [args.slice(0, 25), args.slice(25, 42), args.slice(42)];
    server.use(
      http.post(TARGET_PATHS.openai, () =>
        new HttpResponse(openaiCallStream("apply_patch", pieces), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const before = traces.length;
    const res = await postResponsesStream(customRequest({ stream: true }));
    expect(res.status).toBe(200);

    const frames = parseSseFrames(res.body as unknown as string);
    const joined = frames
      .filter((f) => f.type === "response.custom_tool_call_input.delta")
      .map((f) => f.delta as string)
      .join("");
    expect(joined).toBe(INPUT);
    const inputDone = frames.find(
      (f) => f.type === "response.custom_tool_call_input.done",
    );
    expect(inputDone?.input).toBe(INPUT);
    const item = frames.find(
      (f) =>
        f.type === "response.output_item.done" &&
        (f.item as Record<string, unknown>)?.type === "custom_tool_call",
    )?.item as Record<string, unknown> | undefined;
    expect(item?.input).toBe(INPUT);

    const trace = traces[before];
    expect(trace).toBeDefined();
    expect(trace.diagnostics).toEqual([]);
    expect(trace.repairs).toEqual([]);
  });

  it("a split {input} wrapper with fences produces no diagnostics (streaming)", async () => {
    // fix round 2: finishStreamTrace diagnoses the RAISED calls, the
    // same as the unary path — a lowered {input} wrapper never shows
    // as a diagnostic.
    useTarget("openai");
    const INPUT = "*** Begin Patch\n```\n{\n```";
    const args = JSON.stringify({ input: INPUT });
    const pieces = [args.slice(0, 25), args.slice(25, 42), args.slice(42)];
    server.use(
      http.post(TARGET_PATHS.openai, () =>
        new HttpResponse(openaiCallStream("apply_patch", pieces), {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const before = traces.length;
    const res = await postResponsesStream(customRequest({ stream: true }));
    expect(res.status).toBe(200);

    const frames = parseSseFrames(res.body as unknown as string);
    const inputDone = frames.find(
      (f) => f.type === "response.custom_tool_call_input.done",
    );
    expect(inputDone?.input).toBe(INPUT);
    expect(traces[before]?.diagnostics).toEqual([]);
  });

  it("a namespaced custom-leaf call streams with no diagnostics", async () => {
    // fix round 2: the observed call carries the lowered ns__leaf
    // name; diagnosing the raised call keeps a custom leaf's raw
    // input out of unknown_tool/invalid_json checks.
    useTarget("openai");
    const args = JSON.stringify({ input: "echo hi" });
    server.use(
      http.post(TARGET_PATHS.openai, () =>
        new HttpResponse(
          openaiCallStream("functions__exec", [
            args.slice(0, 11),
            args.slice(11),
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const before = traces.length;
    const res = await postResponsesStream({
      model: "gpt-5-codex",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "run it" }],
        },
      ],
      store: false,
      stream: true,
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "custom", name: "exec" }],
        },
      ],
    });
    expect(res.status).toBe(200);

    const frames = parseSseFrames(res.body as unknown as string);
    const item = frames.find(
      (f) =>
        f.type === "response.output_item.done" &&
        (f.item as Record<string, unknown>)?.type === "custom_tool_call",
    )?.item as Record<string, unknown> | undefined;
    expect(item).toMatchObject({
      name: "exec",
      namespace: "functions",
      input: "echo hi",
    });
    expect(traces[before]?.diagnostics).toEqual([]);
  });

  it("tool_choice naming a custom tool round-trips as {type:custom} on a responses target", async () => {
    // {type:"custom", name} per the Responses create reference +
    // openai 7.30.1 SDK ToolChoiceCustom (fix round 2).
    useTarget("responses");
    const res = await request(app)
      .post("/v1/responses")
      .send(
        customRequest({
          tool_choice: { type: "custom", name: "apply_patch" },
        }),
      );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(capturedRequests.responses[0]).toMatchObject({
      tool_choice: { type: "custom", name: "apply_patch" },
    });
  });

  it.each(["openai", "anthropic", "gemini", "ollama"] as const)(
    "namespace round-trip on %s (unary)",
    async (target) => {
      useTarget(target);
      responseOverrides[target] = { body: FLAT_CALL_REPLIES[target] };

      const res = await request(app)
        .post("/v1/responses")
        .send(namespacedRequest());
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // The upstream saw a flattened function tool named
      // multi_agent_v1__spawn_agent.
      expect(
        JSON.stringify(capturedRequests[target][0]),
      ).toContain("multi_agent_v1__spawn_agent");

      // The client sees the namespaced form.
      expect(res.body.output).toEqual([
        {
          type: "function_call",
          id: expect.any(String),
          call_id: expect.any(String),
          name: "spawn_agent",
          namespace: "multi_agent_v1",
          arguments: "{}",
          status: "completed",
        },
      ]);
    },
  );

  it.each(["openai", "anthropic", "gemini", "ollama"] as const)(
    "namespace round-trip on %s (streaming)",
    async (target) => {
      useTarget(target);
      const stream = flatCallStream(target);
      server.use(
        http.post(TARGET_PATHS[target], () =>
          new HttpResponse(stream.text, {
            headers: { "content-type": stream.contentType },
          }),
        ),
      );

      const res = await request(app)
        .post("/v1/responses")
        .send(namespacedRequest({ stream: true }))
        .buffer(true)
        .parse((r, cb) => {
          let text = "";
          r.setEncoding("utf8");
          r.on("data", (c: string) => (text += c));
          r.on("end", () => cb(null, text));
        });
      expect(res.status).toBe(200);

      const frames = parseSseFrames(res.body as unknown as string);
      const doneItem = frames.find(
        (f) =>
          f.type === "response.output_item.done" &&
          (f.item as Record<string, unknown>)?.type === "function_call",
      )?.item as Record<string, unknown> | undefined;
      expect(doneItem).toMatchObject({
        name: "spawn_agent",
        namespace: "multi_agent_v1",
      });
    },
  );
});

/**
 * Conductor pin: for requests carrying only function tools, the full
 * encoded upstream body is byte-identical to what 1.3 produced — for
 * every target, and for Anthropic, Chat, Gemini and Ollama sources.
 * The literals below were captured from the 1.3 encoders before this
 * task's changes landed; `canonicalForTarget` is included so the
 * lowering path itself is exercised.
 */
describe("non-Responses sources are byte-identical to 1.3", () => {
  const SOURCE_REQUESTS: Record<string, unknown> = {
    anthropic: {
      model: "claude-3-opus-20240229",
      max_tokens: 1024,
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          name: "get_weather",
          description: "Weather for a city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: { type: "auto" },
    },
    openai: {
      model: "gpt-4",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "auto",
    },
    gemini: {
      contents: [{ role: "user", parts: [{ text: "weather?" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Weather for a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
        },
      ],
    },
    ollama: {
      model: "llama3",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
    },
  };

  const EXPECTED: Record<string, Record<string, string>> = {
    anthropic: {
      openai:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"max_tokens":1024,"tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"auto"}',
      gemini:
        '{"contents":[{"role":"user","parts":[{"text":"weather?"}]}],"tools":[{"functionDeclarations":[{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}],"toolConfig":{"functionCallingConfig":{"mode":"AUTO"}},"generationConfig":{"maxOutputTokens":1024}}',
      ollama:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"options":{"num_predict":1024},"stream":false}',
      anthropic:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"max_tokens":1024,"tools":[{"name":"get_weather","description":"Weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"tool_choice":{"type":"auto"}}',
      responses:
        '{"model":"m","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"weather?"}]}],"store":false,"max_output_tokens":1024,"tools":[{"type":"function","name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},"strict":null}],"tool_choice":"auto"}',
    },
    openai: {
      openai:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"tool_choice":"auto"}',
      gemini:
        '{"contents":[{"role":"user","parts":[{"text":"weather?"}]}],"tools":[{"functionDeclarations":[{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}],"toolConfig":{"functionCallingConfig":{"mode":"AUTO"}},"generationConfig":{}}',
      ollama:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"stream":false}',
      anthropic:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"max_tokens":4096,"tools":[{"name":"get_weather","description":"Weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"tool_choice":{"type":"auto"}}',
      responses:
        '{"model":"m","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"weather?"}]}],"store":false,"tools":[{"type":"function","name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},"strict":null}],"tool_choice":"auto"}',
    },
    gemini: {
      openai:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}',
      gemini:
        '{"contents":[{"role":"user","parts":[{"text":"weather?"}]}],"tools":[{"functionDeclarations":[{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}]}',
      ollama:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"stream":false}',
      anthropic:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"max_tokens":4096,"tools":[{"name":"get_weather","description":"Weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}',
      responses:
        '{"model":"m","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"weather?"}]}],"store":false,"tools":[{"type":"function","name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},"strict":null}]}',
    },
    ollama: {
      openai:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"stream":true,"stream_options":{"include_usage":true}}',
      gemini:
        '{"contents":[{"role":"user","parts":[{"text":"weather?"}]}],"tools":[{"functionDeclarations":[{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]}]}',
      ollama:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"stream":true}',
      anthropic:
        '{"model":"m","messages":[{"role":"user","content":"weather?"}],"max_tokens":4096,"tools":[{"name":"get_weather","description":"Weather for a city","input_schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"stream":true}',
      responses:
        '{"model":"m","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"weather?"}]}],"store":false,"stream":true,"tools":[{"type":"function","name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},"strict":null}]}',
    },
  };

  it.each(Object.keys(SOURCE_REQUESTS))(
    "%s source unchanged on every target",
    (source) => {
      const canonical = (adapters as Record<string, typeof adapters.openai>)[
        source
      ].toCanonicalRequest(SOURCE_REQUESTS[source] as never);
      for (const [target, expected] of Object.entries(EXPECTED[source])) {
        const entry = {
          name: target,
          type: target,
          baseUrl: "http://x",
        } as ProviderEntry;
        const out = canonicalForTarget(canonical, entry, {
          provider: target,
          model: "m",
        });
        const wire = (adapters as Record<string, typeof adapters.openai>)[
          target
        ].fromCanonicalRequest(out);
        expect(JSON.stringify(wire), `${source} -> ${target}`).toBe(expected);
      }
    },
  );
});

// ===== v1.4 Task 9: structured output (spec §3.5) =====

describe("structured output (v1.4 spec §3.5)", () => {
  const SCHEMA = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  };

  it("schema rejected upstream surfaces as a responses error (Review Focus 5)", async () => {
    // A streaming Responses request whose Gemini upstream answers 400
    // before the first byte: the client gets an HTTP 400 JSON body in
    // the Responses error envelope (never a half-open SSE), the trace
    // records the error, and the 400 is non-retryable — the openai
    // fallback is never tried.
    const yaml = `default: main
providers:
  main:
    type: gemini
    base_url: ${MOCK_BASE_URLS.gemini}
    api_key_env: GEMINI_API_KEY
  good:
    type: openai
    base_url: ${MOCK_BASE_URLS.openai}
    api_key_env: OPENAI_API_KEY
routes:
  - match: "*"
    to: main/m
    fallback: [good/m]
`;
    useTarget("gemini", yaml);
    // Gemini error envelope: https://ai.google.dev/api/rest#body.Error
    responseOverrides.gemini = {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "Invalid JSON payload received. Schema unsupported.",
          status: "INVALID_ARGUMENT",
        },
      },
    };

    const before = traces.length;
    const res = await postResponsesStream({
      model: "gpt-5-codex",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "extract a name" }],
        },
      ],
      store: false,
      stream: true,
      text: {
        format: { type: "json_schema", name: "extract", schema: SCHEMA },
      },
    });

    // JSON error envelope, not an SSE stream.
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    const body =
      typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      message: "Invalid JSON payload received. Schema unsupported.",
    });
    expect(res.headers["x-babelgate-attempts"]).toBe("1");

    // One upstream hop; the schema reached Gemini unchanged.
    expect(capturedRequests.gemini).toHaveLength(1);
    expect(
      (capturedRequests.gemini[0] as Record<string, unknown>)
        .generationConfig,
    ).toMatchObject({
      responseJsonSchema: SCHEMA,
      responseMimeType: "application/json",
    });
    // A 400 is not fallback-eligible: the openai fallback is untouched.
    expect(capturedRequests.openai).toHaveLength(0);

    const trace = traces[before];
    expect(trace?.status).toBe("error");
    expect(trace?.hops).toHaveLength(1);
    expect(trace?.hops[0]).toMatchObject({
      provider: "main",
      outcome: "http_error",
      status: 400,
    });
  });
});

// ===== v1.4 Task 10: pass-through (spec §3.4) =====

/**
 * Responses → `type: responses` entry: the request is relayed with
 * only `model` rewritten (+ the max_output_tokens clamp), the reply
 * byte for byte with `response.model` restored inside the lifecycle
 * events only. Fallbacks to non-Responses entries stay bridged.
 *
 * Lifecycle event/field names cited per
 * https://platform.openai.com/docs/api-reference/responses-streaming
 * and `response.*.response` per /docs/api-reference/responses/object.
 */
describe("pass-through (v1.4 spec §3.4)", () => {
  async function waitForTraces(n: number, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (traces.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** A `type: responses` provider + a gemini entry for fallbacks. */
  const passYaml = (route = "pass-*", repair = false) => `default: or
providers:
  or:
    type: responses
    base_url: ${MOCK_BASE_URLS.responses}
    api_key_env: RESPONSES_API_KEY${repair ? "\n    repair_tool_calls: true" : ""}
  gem:
    type: gemini
    base_url: ${MOCK_BASE_URLS.gemini}
    api_key_env: GEMINI_API_KEY
routes:
  - match: "${route}"
    to: or/upstream-model
  - match: fall-*
    to: or/upstream-model
    fallback: [gem/gem-model]
prices:
  or/*: {input: 1, output: 2}
`;

  it("only model is rewritten in the forwarded body", async () => {
    useTarget("responses", passYaml());
    const clientBody = {
      model: "pass-codex",
      stream: false,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium" },
      tools: [
        { type: "web_search", external_web_access: true },
        {
          type: "function",
          name: "get_weather",
          parameters: { type: "object" },
        },
      ],
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
        { type: "reasoning", encrypted_content: "bg1.sig" },
      ],
      metadata: { caller: "codex" },
      max_output_tokens: 512,
    };
    const res = await request(app).post("/v1/responses").send(clientBody);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Byte compare after replacing model — nothing else was touched.
    expect(capturedRequests.responses).toHaveLength(1);
    expect(JSON.stringify(capturedRequests.responses[0])).toBe(
      JSON.stringify({ ...clientBody, model: "upstream-model" }),
    );

    // The non-stream reply's `response.model` is restored to the
    // client's model (the mock body carries the upstream name).
    responseOverrides.responses = {
      status: 200,
      body: {
        ...(responseOverrides.responses?.body as object | undefined),
        id: "resp_pt",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "upstream-model",
        output: [],
        usage: null,
      },
    };
    const res2 = await request(app)
      .post("/v1/responses")
      .send(clientBody);
    expect(res2.status).toBe(200);
    expect(res2.body.model).toBe("pass-codex");
    expect(res2.body.id).toBe("resp_pt");
    expect(res2.body.status).toBe("completed");
  });

  it("clamps max_output_tokens on the forwarded body", async () => {
    const yaml = `default: or
providers:
  or:
    type: responses
    base_url: ${MOCK_BASE_URLS.responses}
    api_key_env: RESPONSES_API_KEY
    max_output_tokens: 100
routes:
  - match: "*"
    to: or/upstream-model
`;
    useTarget("responses", yaml);
    const res = await request(app).post("/v1/responses").send({
      model: "pass-codex",
      input: [],
      max_output_tokens: 512,
    });
    expect(res.status).toBe(200);
    expect(
      (capturedRequests.responses[0] as Record<string, unknown>)
        .max_output_tokens,
    ).toBe(100);
    // An unset one is filled with the cap, matching the bridge.
    capturedRequests.responses.length = 0;
    const res2 = await request(app).post("/v1/responses").send({
      model: "pass-codex",
      input: [],
    });
    expect(res2.status).toBe(200);
    expect(
      (capturedRequests.responses[0] as Record<string, unknown>)
        .max_output_tokens,
    ).toBe(100);
  });

  it("stream relayed byte-identical except model in lifecycle events", async () => {
    useTarget("responses", passYaml());
    const lifecycle = (type: string, extra = "") =>
      JSON.stringify({
        type,
        sequence_number: 0,
        response: {
          id: "resp_pt",
          object: "response",
          created_at: 1,
          status:
            type === "response.completed" ? "completed" : "in_progress",
          model: "upstream-model",
          output: [],
          usage: null,
          ...(extra ? { note: extra } : {}),
        },
      });
    // A realistic mix: `event:` lines, the no-event-line OpenRouter
    // shape, an oddly-formatted non-lifecycle event (kept verbatim),
    // several events in one chunk, and `data: [DONE]`.
    const oddDelta =
      'data:  {"type":"response.output_text.delta", "delta" :"weird",  "spacing":true}\n\n';
    const created = `event: response.created\ndata: ${lifecycle("response.created")}\n\n`;
    const inProgress = `data: ${lifecycle("response.in_progress")}\n\n`;
    const delta = `data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}\n\n`;
    const completed = `event: response.completed\ndata: ${lifecycle("response.completed")}\n\n`;
    const done = "data: [DONE]\n\n";
    const upstreamText =
      created + inProgress + oddDelta + delta + completed + done;

    server.use(
      http.post(`${MOCK_BASE_URLS.responses}/v1/responses`, () => {
        const bytes = new TextEncoder().encode(upstreamText);
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes.subarray(0, created.length));
            c.enqueue(
              bytes.subarray(
                created.length,
                created.length + inProgress.length + oddDelta.length,
              ),
            );
            c.enqueue(bytes.subarray(created.length + inProgress.length + oddDelta.length));
            c.close();
          },
        });
        return new HttpResponse(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const res = await postResponsesStream({
      model: "pass-codex",
      input: [],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const text = res.body as unknown as string;
    const blocks = text.split("\n\n").filter((b) => b !== "");

    // Byte-compare per block: only the lifecycle events differ, and
    // only inside `response.model`.
    const upstreamBlocks = upstreamText
      .split("\n\n")
      .filter((b) => b !== "");
    expect(blocks).toHaveLength(upstreamBlocks.length);
    for (const [i, block] of blocks.entries()) {
      const lines = block.split("\n");
      const dataLine = lines.find((l) => l.startsWith("data:"));
      const dataText = dataLine?.slice(5).replace(/^ /, "") ?? "";
      let parsed:
        | { type?: string; response?: { model?: string } }
        | undefined;
      if (dataText !== "" && dataText !== "[DONE]") {
        parsed = JSON.parse(dataText) as {
          type?: string;
          response?: { model?: string };
        };
      }
      const isLifecycle =
        parsed !== undefined &&
        [
          "response.created",
          "response.in_progress",
          "response.completed",
          "response.incomplete",
          "response.failed",
        ].includes(parsed.type ?? "");
      if (!isLifecycle) {
        expect(block).toBe(upstreamBlocks[i]);
        continue;
      }
      // Same event: line; data parses with the client model restored.
      expect(parsed?.response?.model).toBe("pass-codex");
      const upstreamData = JSON.parse(
        upstreamBlocks[i]
          .split("\n")
          .find((l) => l.startsWith("data:"))!
          .slice(5)
          .replace(/^ /, ""),
      ) as { response?: { model?: string } };
      expect({ ...parsed, response: { ...parsed?.response } })
        .toMatchObject({
          type: parsed?.type,
        });
      expect(upstreamData.response?.model).toBe("upstream-model");
      if (block.startsWith("event:")) {
        expect(block.split("\n")[0]).toBe(
          upstreamBlocks[i].split("\n")[0],
        );
      }
    }
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("usage and cost from response.completed", async () => {
    useTarget("responses", passYaml());
    // `response.completed.response.usage` per
    // https://platform.openai.com/docs/api-reference/responses-streaming
    // — input_tokens_details.cached_tokens → cacheReadTokens.
    const completed = JSON.stringify({
      type: "response.completed",
      sequence_number: 4,
      response: {
        id: "resp_usage",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "upstream-model",
        output: [],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 130,
        },
      },
    });
    server.use(
      http.post(`${MOCK_BASE_URLS.responses}/v1/responses`, () =>
        new HttpResponse(`data: ${completed}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const before = traces.length;
    const res = await postResponsesStream({
      model: "pass-codex",
      input: [],
      stream: true,
    });
    expect(res.status).toBe(200);
    await waitForTraces(before + 1);

    const trace = traces[before];
    expect(trace).toMatchObject({
      status: "ok",
      stream: true,
      passthrough: true,
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 40,
      finishReason: "stop",
      priceSource: "override",
    });
    // (100*1 + 30*2) USD per 1M from the or/* price glob.
    expect(trace.costUsd).toBeCloseTo((100 + 60) / 1e6, 12);
  });

  it("fallback to a gemini entry is bridged", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    useTarget("responses", passYaml());
    responseOverrides.responses = { status: 503, body: { error: "down" } };

    const clientBody = {
      model: "fall-codex",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
      tools: [{ type: "web_search" }],
      store: false,
    };
    const res = await request(app).post("/v1/responses").send(clientBody);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The Gemini fallback received the BRIDGED request — a Gemini
    // `contents` body built from canonical, not the client body
    // (Gemini carries the model in its URL path, not the body — the
    // winning hop proves routing).
    expect(res.headers["x-babelgate-provider"]).toBe("gem");
    expect(res.headers["x-babelgate-attempts"]).toBe("2");
    expect(capturedRequests.gemini).toHaveLength(1);
    expect(capturedRequests.gemini[0]).toMatchObject({
      contents: expect.any(Array),
    });
    expect(capturedRequests.gemini[0]).not.toHaveProperty("input");
    // The reply is the normal Responses envelope (encoded by the
    // responses adapter), not a relayed body.
    expect(res.body.object).toBe("response");
  });

  it("a 4xx before the first byte follows the normal error mapping", async () => {
    useTarget("responses", passYaml());
    responseOverrides.responses = {
      status: 400,
      body: { error: { message: "bad request", type: "invalid_request_error" } },
    };

    const res = await request(app).post("/v1/responses").send({
      model: "pass-codex",
      input: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      type: "invalid_request_error",
      message: "bad request",
    });
    // A 400 is never fallback-eligible — the gemini entry saw nothing.
    expect(capturedRequests.gemini).toHaveLength(0);
    expect(res.headers["x-babelgate-attempts"]).toBe("1");
  });

  it("repair_tool_calls ignored on pass-through", async () => {
    useTarget("responses", passYaml("*", true));
    // Fenced, valid JSON inside — diagnoseArguments codes this
    // `fenced_json` (a fence around non-JSON is plain `invalid_json`).
    const fenced = '```json\n{"city":"Paris"}\n```';
    responseOverrides.responses = {
      status: 200,
      body: {
        id: "resp_repair",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "upstream-model",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "get_weather",
            arguments: fenced,
            status: "completed",
          },
        ],
        usage: null,
      },
    };

    const before = traces.length;
    const res = await request(app).post("/v1/responses").send({
      model: "pass-codex",
      input: [],
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    expect(res.status).toBe(200);

    // The client received the arguments verbatim — repair would have
    // altered bytes, so it never runs on pass-through.
    const call = (res.body.output as Record<string, unknown>[])[0];
    expect(call.arguments).toBe(fenced);

    await waitForTraces(before + 1);
    // Diagnostics still run on the relayed call; repairs stay empty.
    const trace = traces[before];
    expect(trace.passthrough).toBe(true);
    expect(trace.diagnostics).toContainEqual(
      expect.objectContaining({ code: "fenced_json" }),
    );
    expect(trace.repairs).toEqual([]);
  });

  it("responses-lite bodies relay to a pass-through target", async () => {
    useTarget("responses", passYaml());
    const res = await request(app).post("/v1/responses").send({
      model: "pass-codex",
      input: [
        { type: "additional_tools", tools: [{ type: "namespace" }] },
        { type: "message", role: "user", phase: "commentary", content: [] },
      ],
      reasoning: { context: "…" },
      store: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests.responses).toHaveLength(1);
    expect(
      JSON.stringify(capturedRequests.responses[0]),
    ).toContain("additional_tools");
  });

  // A non-string model survives the adapter's missing-field guard and
  // fails the canonical schema — but routing itself reads it
  // (planRoute → parseTarget), so the deferred 400 fires before
  // routing on every route kind. Same body main returns for these.
  const malformedModelBody = {
    error: {
      message: "Malformed request body",
      type: "invalid_request_error",
      param: null,
      code: "invalid_request",
    },
  };

  it.each([5, {}, true, []])(
    "non-string model %j is a 400 on a pass-through route",
    async (model) => {
      useTarget("responses", passYaml());
      const res = await request(app)
        .post("/v1/responses")
        .send({ model, input: [] });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(malformedModelBody);
      expect(capturedRequests.responses).toHaveLength(0);
    },
  );

  it.each([5, {}, true, []])(
    "non-string model %j is a 400 on a bridged route",
    async (model) => {
      useTarget("openai");
      const res = await request(app)
        .post("/v1/responses")
        .send({ model, input: [] });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(malformedModelBody);
      expect(capturedRequests.openai).toHaveLength(0);
    },
  );

  // An empty-string model is still a string: it routes (no glob
  // match → the `or` default) and a `type: responses` entry relays it
  // verbatim — the upstream's problem to reject, not ours.
  it("empty-string model relays to a pass-through target", async () => {
    useTarget("responses", passYaml());
    const res = await request(app)
      .post("/v1/responses")
      .send({ model: "", input: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests.responses).toHaveLength(1);
    expect(capturedRequests.responses[0]).toMatchObject({ model: "" });
    expect(res.body.model).toBe("");
  });
});

describe("reasoning carry-over (v1.4 spec §3.2, Task 8)", () => {
  const REASONING_YAML = `default: gem
providers:
  gem:
    type: gemini
    base_url: ${MOCK_BASE_URLS.gemini}
    api_key_env: GEMINI_API_KEY
  ant:
    type: anthropic
    base_url: ${MOCK_BASE_URLS.anthropic}
    api_key_env: ANTHROPIC_API_KEY
routes:
  - match: "*"
    to: gem/gem-1
    fallback: [ant/ant-m]
`;

  const userMsg = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
  const reasoningConf = { reasoning: { effort: "medium" } };

  /** Turn-1 Gemini reply: a signed thought part + a signed call. */
  const GEMINI_TURN1 = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              text: "thinking about weather",
              thought: true,
              thoughtSignature: "sig-gem-turn1",
            },
            {
              functionCall: {
                name: "get_weather",
                args: { city: "Paris" },
              },
              thoughtSignature: "sig-gem-call1",
            },
          ],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    modelVersion: "gem-1",
  };

  it("provider switch mid-session drops foreign reasoning", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "test-key";
    useTarget("gemini", REASONING_YAML);

    // ── Turn 1: served by Gemini, returns a signed reasoning turn ──
    responseOverrides.gemini = { body: GEMINI_TURN1 };
    const t1 = await request(app)
      .post("/v1/responses")
      .send({
        model: "gem-1",
        input: [userMsg("weather?")],
        store: false,
        ...reasoningConf,
      });
    expect(t1.status, JSON.stringify(t1.body)).toBe(200);
    const reasoningItem1 = (t1.body.output as Array<{ type: string }>).find(
      (i) => i.type === "reasoning",
    );
    expect(reasoningItem1).toBeDefined();

    // ── Turn 2: client replays turn 1; Gemini 500 → Anthropic hop ──
    const t1Call = (t1.body.output as Array<{ type: string }>).find(
      (i) => i.type === "function_call",
    );
    responseOverrides.gemini = { status: 500, body: { error: "down" } };
    responseOverrides.anthropic = {
      body: {
        id: "msg_t2",
        type: "message",
        role: "assistant",
        model: "ant-m",
        content: [
          {
            type: "thinking",
            thinking: "anthropic thinks",
            signature: "sig-ant-turn2",
          },
          { type: "text", text: "fallback answer" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    };
    const t2 = await request(app)
      .post("/v1/responses")
      .send({
        model: "gem-1",
        input: [
          userMsg("weather?"),
          reasoningItem1,
          t1Call,
          userMsg("try again"),
        ],
        store: false,
        ...reasoningConf,
      });
    expect(t2.status, JSON.stringify(t2.body)).toBe(200);

    // The Anthropic hop saw no Gemini data and no `thinking` — the
    // continuity guard disabled it (foreign tool-call turn).
    const antBody = JSON.stringify(capturedRequests.anthropic[0]);
    expect(antBody).not.toContain("sig-gem-turn1");
    expect(antBody).not.toContain("sig-gem-call1");
    expect(antBody).not.toContain("thinking about weather");
    expect(antBody).not.toContain('"thinking"');

    const reasoningItem2 = (t2.body.output as Array<{ type: string }>).find(
      (i) => i.type === "reasoning",
    );
    expect(reasoningItem2).toBeDefined();

    // ── Turn 3: back on Gemini; turn-1 signature reaches it ──
    delete responseOverrides.gemini;
    const t2Text = (t2.body.output as Array<{ type: string }>).find(
      (i) => i.type === "message",
    );
    capturedRequests.gemini.length = 0;
    const t3 = await request(app)
      .post("/v1/responses")
      .send({
        model: "gem-1",
        input: [
          userMsg("weather?"),
          reasoningItem1,
          t1Call,
          reasoningItem2,
          t2Text,
          userMsg("once more"),
        ],
        store: false,
        ...reasoningConf,
      });
    expect(t3.status, JSON.stringify(t3.body)).toBe(200);

    const gem3 = JSON.stringify(capturedRequests.gemini[0]);
    expect(gem3).toContain("sig-gem-turn1");
    expect(gem3).not.toContain("sig-ant-turn2");
    expect(gem3).not.toContain("anthropic thinks");
  });

  it("openai client via gemini receives reasoning_content and the answer text", async () => {
    // v1.5 spec §3.1 (Task 5): a Gemini upstream reply that carries a
    // thought part and a signed text part decodes to a parts array —
    // the OpenAI client gets the thought text in
    // `message.reasoning_content` and the signed part's text in
    // `content`; the signature is never emitted.
    process.env.GEMINI_API_KEY = "test-key";
    useTarget("gemini", REASONING_YAML);
    responseOverrides.gemini = {
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "thinking…", thought: true },
                { text: "the answer", thoughtSignature: "SIG" },
              ],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        modelVersion: "gem-1",
      },
    };

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "gem-1",
        messages: [{ role: "user", content: "hi" }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.choices[0].message.content).toBe("the answer");
    expect(res.body.choices[0].message.reasoning_content).toBe(
      "thinking…",
    );
    expect(JSON.stringify(res.body)).not.toContain("SIG");
  });

  it("envelope over cap is omitted with a note (request)", async () => {
    // Review Focus 3: the request-level 200 — a >1MB reasoning text
    // from the upstream still answers, with the reasoning item's
    // `encrypted_content` omitted and the drop noted on the trace.
    useTarget("openai");
    responseOverrides.openai = {
      body: {
        id: "chatcmpl-big",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "the answer",
              reasoning_content: "x".repeat(1_200_000),
            },
            finish_reason: "stop",
          },
        ],
      },
    };

    const before = traces.length;
    const res = await request(app)
      .post("/v1/responses")
      .send({ model: "m", input: [userMsg("hi")], store: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const reasoningItem = (
      res.body.output as Array<Record<string, unknown>>
    ).find((i) => i.type === "reasoning");
    expect(reasoningItem).toBeDefined();
    expect(reasoningItem).not.toHaveProperty("encrypted_content");

    const trace = traces[before];
    expect(trace).toBeDefined();
    expect(trace.notes).toContainEqual({
      stage: "encode",
      adapter: "responses",
      code: "reasoning_dropped",
      path: "envelope_too_large",
    });
  });
});

// ===== v1.4 Task 11: recorded Codex turns replayed (spec §4.2) =====

/**
 * tests/fixtures/codex/turns.json holds the three recorded Codex
 * request bodies shape-masked by record-shapes ("<string:N>",
 * "<bool>"). The replay hydrates them just enough for the bridge —
 * real roles and flags — and, where the recording echoes a prior
 * response (a `message` item with `status` plus a `function_call`),
 * substitutes the live output items the previous turn returned, so
 * turn N's request carries turn N−1's real reasoning items and call
 * ids exactly as a stateless Codex client resends them.
 */

type RecordedItem = Record<string, unknown>;

interface LiveTurn {
  /** The response's output items, echoed into the next turn's input. */
  items: RecordedItem[];
  /** The call_id of the first function_call item, for output pairing. */
  callId?: string;
}

function hydrateValue(value: unknown, key: string): unknown {
  if (typeof value === "string" && /^<string:\d+>$/.test(value)) {
    // Masked scalars: roles are resolved by the caller; status is
    // always "completed" in the recording; anything else is content.
    if (key === "status") return "completed";
    return "codex";
  }
  if (value === "<bool>") return false;
  if (Array.isArray(value)) {
    return value.map((v) => hydrateValue(v, key));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, hydrateValue(v, k)]),
    );
  }
  return value;
}

function hydrateItem(item: RecordedItem): RecordedItem {
  const out: RecordedItem = {};
  for (const [key, v] of Object.entries(item)) {
    if (key === "role" && typeof v === "string" && v.startsWith("<string:")) {
      // "<string:4>" is user; the longer developer/assistant roles are
      // told apart by `status` (only echoed assistant items carry it).
      out[key] =
        v === "<string:4>"
          ? "user"
          : item.status !== undefined
            ? "assistant"
            : "developer";
      continue;
    }
    out[key] = hydrateValue(v, key);
  }
  return out;
}

/**
 * One replayable request body from a recorded turn: every masked
 * field hydrated, and each echoed prior-turn block
 * (message-with-status + function_call + function_call_output)
 * replaced by the live items from that turn's response — including
 * its `reasoning` items with bg1 envelopes. `reasoning` gains
 * `effort: "medium"` on top of the recorded `{summary:"auto"}` so the
 * reasoning encoders engage on every target.
 */
function replayBody(
  recorded: RecordedItem,
  priors: LiveTurn[],
  stream = false,
): RecordedItem {
  const input: RecordedItem[] = [];
  let k = 0;
  let pendingCallId: string | undefined;
  for (const item of recorded.input as RecordedItem[]) {
    if (item.type === "message" && item.status !== undefined) {
      input.push(...priors[k].items);
      pendingCallId = priors[k].callId;
      continue;
    }
    if (item.type === "function_call") {
      // The live call item was already pushed with the prior output.
      continue;
    }
    if (item.type === "function_call_output") {
      input.push({ ...hydrateItem(item), call_id: pendingCallId });
      k += 1;
      continue;
    }
    input.push(hydrateItem(item));
  }
  const body: RecordedItem = {};
  for (const [key, v] of Object.entries(recorded)) {
    if (key !== "input") body[key] = hydrateValue(v, key);
  }
  body.input = input;
  body.stream = stream;
  body.store = false;
  body.parallel_tool_calls = true;
  body.reasoning = {
    ...(recorded.reasoning as RecordedItem),
    effort: "medium",
  };
  return body;
}

function liveTurn(res: request.Response): LiveTurn {
  const items = (res.body.output ?? []) as RecordedItem[];
  const call = items.find((i) => i.type === "function_call");
  return { items, callId: call?.call_id as string | undefined };
}

async function waitForTracesLocal(n: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (traces.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("codex replay three turns (v1.4 spec §4.2)", () => {
  /**
   * The signatures each target's reasoningReply mock plants per turn
   * (the ordinal is the upstream's 1-based request count).
   */
  const TURNS = codexTurns.turns as RecordedItem[];
  const CASES: Array<{
    target: "gemini" | "anthropic";
    sigs: (turn: number) => string[];
  }> = [
    {
      target: "gemini",
      sigs: (n) => [`sig-gem-${n}-think`, `sig-gem-${n}-call`],
    },
    { target: "anthropic", sigs: (n) => [`sig-ant-${n}-think`] },
  ];

  it.each(CASES)(
    "codex replay three turns on $target",
    async ({ target, sigs }) => {
      useTarget(target);
      reasoningReply[target] = true;

      const priors: LiveTurn[] = [];
      const traceStarts: number[] = [];
      for (const recorded of TURNS) {
        traceStarts.push(traces.length);
        const res = await request(app)
          .post("/v1/responses")
          .send(replayBody(recorded, priors));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await waitForTracesLocal(traceStarts.at(-1)! + 1);
        priors.push(liveTurn(res));
      }

      const upstream = capturedRequests[target].map((b) =>
        JSON.stringify(b),
      );
      expect(upstream).toHaveLength(3);
      // Turn 2's upstream body carries turn 1's signatures; turn 3's
      // carries both prior turns' (spec §4.2).
      for (const s of sigs(1)) expect(upstream[1]).toContain(s);
      for (const s of [...sigs(1), ...sigs(2)]) {
        expect(upstream[2]).toContain(s);
      }

      const notes = traces
        .slice(traceStarts[0])
        .flatMap((t) => t.notes.map((n) => n.code));
      expect(notes).not.toContain("reasoning_dropped");
    },
  );

  /**
   * The same replay streamed — the path real Codex takes (it always
   * sends `stream: true`, spec §2 E1, `codex-rs/core/src/client.rs`
   * `build_responses_request`). The live items resent each turn are
   * the `item`s of every `response.output_item.done` event in order
   * — what Codex's parser accumulates (spec §2 E2,
   * `codex-rs/codex-api/src/sse/responses.rs`).
   */
  it.each(CASES)(
    "codex replay three turns on $target, streamed",
    async ({ target, sigs }) => {
      useTarget(target);
      reasoningReply[target] = true;
      // Gemini asks for a stream by URL (`:streamGenerateContent`),
      // not a body flag — capture upstream URLs like
      // stream.test.ts's captureUpstreamUrls.
      const urls: string[] = [];
      const onRequest = ({ request: req }: { request: Request }) => {
        if (req.url.startsWith(MOCK_BASE_URLS[target])) urls.push(req.url);
      };
      server.events.on("request:start", onRequest);

      try {
        const priors: LiveTurn[] = [];
        const traceStarts: number[] = [];
        for (const recorded of TURNS) {
          traceStarts.push(traces.length);
          const res = await postResponsesStream(
            replayBody(recorded, priors, true),
          );
          expect(res.status).toBe(200);
          expect(res.headers["content-type"]).toContain(
            "text/event-stream",
          );
          const wire = res.body as unknown as string;
          expect(wire).toContain("response.completed");
          const items = parseSseFrames(wire)
            .filter((f) => f.type === "response.output_item.done")
            .map((f) => f.item as RecordedItem);
          const call = items.find((i) => i.type === "function_call");
          priors.push({
            items,
            callId: call?.call_id as string | undefined,
          });
          await waitForTracesLocal(traceStarts.at(-1)! + 1);
        }

        // At least one resent item is a reasoning envelope.
        expect(
          priors
            .flatMap((p) => p.items)
            .some(
              (i) =>
                i.type === "reasoning" &&
                typeof i.encrypted_content === "string" &&
                i.encrypted_content.startsWith("bg1."),
            ),
        ).toBe(true);

        const upstream = capturedRequests[target].map((b) =>
          JSON.stringify(b),
        );
        expect(upstream).toHaveLength(3);
        // Every upstream request asked for a stream.
        if (target === "gemini") {
          expect(urls).toHaveLength(3);
          for (const u of urls) {
            expect(u).toContain(":streamGenerateContent");
          }
        } else {
          for (const b of capturedRequests.anthropic) {
            expect((b as { stream?: unknown }).stream).toBe(true);
          }
        }
        // Turn 2's upstream body carries turn 1's signatures; turn
        // 3's carries both prior turns' (spec §4.2).
        for (const s of sigs(1)) expect(upstream[1]).toContain(s);
        for (const s of [...sigs(1), ...sigs(2)]) {
          expect(upstream[2]).toContain(s);
        }

        const notes = traces
          .slice(traceStarts[0])
          .flatMap((t) => t.notes.map((n) => n.code));
        expect(notes).not.toContain("reasoning_dropped");
      } finally {
        server.events.removeListener("request:start", onRequest);
      }
    },
  );
});
