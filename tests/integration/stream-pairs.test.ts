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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import { PROVIDER_PATHS, type Provider } from "../../src/transformers";
import { reassembleStream } from "../../src/utils/stream-reassemble";
import type {
  CanonicalResponse,
  CanonicalStreamEvent,
} from "../../src/types/canonical.types";
import {
  upstreamHandlers,
  capturedRequests,
  resetCaptured,
  resetOverrides,
  resetStreamCase,
  resetCachedUsage,
  cachedUsage,
  CACHED_USAGE,
  streamCase,
  nonStreamSource,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";
import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import ollamaFixtures from "../fixtures/ollama.json";
import anthropicFixtures from "../fixtures/anthropic.json";

/**
 * Full pair matrix (spec §4.5, §5 milestone 2): every ordered pair of
 * the four providers ×
 * {text, tool_call, parallel_tool_calls, after_tool_result} ×
 * {stream, non-stream}. The msw upstream serves the recorded stream
 * corpus for streaming requests and the matching non-stream body
 * otherwise (see tests/mocks/upstreams.ts). For each cell the client
 * must receive its own dialect; tool cases keep the upstream's call
 * names and ids with parsed arguments and distinct ids (ids are not
 * compared for cells touching Gemini: the recorded Gemini upstream
 * sends none — ids are generated per spec §3.4 "id used when
 * present, otherwise generated" — and the Gemini client side treats
 * `id` as optional); and after_tool_result's tool result must reach
 * the upstream request in the target's dialect.
 */
const PROVIDERS: Provider[] = ["openai", "gemini", "ollama", "anthropic"];
const ALL_PAIRS: [Provider, Provider][] = PROVIDERS.flatMap((source) =>
  PROVIDERS.map((target) => [source, target] as [Provider, Provider]),
);

const CASES = [
  "text",
  "tool_call",
  "parallel_tool_calls",
  "after_tool_result",
] as const;
type Case = (typeof CASES)[number];

/** Calls recorded in each provider's parallel_tool_calls oracle. */
const PARALLEL_CALL_COUNTS: Record<Provider, number> = {
  openai: 2,
  anthropic: 2,
  ollama: 2,
  gemini: 3,
};

const STREAMS_DIR = join(__dirname, "..", "fixtures", "streams");
const TOOL_RESULT_TEXT = "72°F and sunny";

// The call id each source sends in its after_tool_result request.
const CLIENT_CALL_ID: Record<Provider, string> = {
  openai: "call_1",
  anthropic: "toolu_1",
  ollama: "call_1",
  gemini: "call_1",
};

const SOURCE_FIXTURES: Record<
  Provider,
  { requests: Record<string, unknown> }
> = {
  openai: openaiFixtures,
  gemini: geminiFixtures,
  ollama: ollamaFixtures,
  anthropic: anthropicFixtures,
};

/**
 * Ollama's `tools[]` is OpenAI-shaped (spec §3.4), and its fixture has
 * no `requests.tools` entry — reuse the recorded OpenAI array as the
 * tool definitions and wrap it in an Ollama-dialect request.
 */
const OLLAMA_TOOLS = (
  openaiFixtures.requests.tools as { tools: unknown[] }
).tools;
const OLLAMA_TOOLS_REQUEST = {
  model: "llama3",
  messages: [{ role: "user", content: "What's the weather?" }],
  tools: OLLAMA_TOOLS,
};

const server = setupServer(...upstreamHandlers);

function setPair(source: Provider, target: Provider): void {
  process.env.SOURCE_API = source;
  process.env.TARGET_API = target;
  resetConfig();
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  for (const p of [
    "openai",
    "gemini",
    "ollama",
    "anthropic",
  ] as Provider[]) {
    process.env[`${p.toUpperCase()}_API_BASE_URL`] = MOCK_BASE_URLS[p];
    process.env[`${p.toUpperCase()}_API_KEY`] = "test-key";
  }
});

beforeEach(() => {
  process.env.UPSTREAM_RETRIES = "0";
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  resetStreamCase();
  resetCachedUsage();
  delete process.env.UPSTREAM_RETRIES;
});

afterAll(() => {
  server.close();
});

/** supertest parses SSE/NDJSON as an opaque body — collect it as text. */
function postStream(path: string, body: unknown): request.Test {
  return request(app)
    .post(path)
    .send(body)
    .buffer(true)
    .parse((res, cb) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => cb(null, text));
    });
}

// ---------- client request bodies ----------

function toolResultRequest(source: Provider): Record<string, unknown> {
  const tools =
    source === "ollama"
      ? OLLAMA_TOOLS
      : (SOURCE_FIXTURES[source].requests.tools as { tools: unknown[] })
          .tools;
  const callId = CLIENT_CALL_ID[source];
  if (source === "openai") {
    return {
      model: "gpt-4",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: callId,
          content: TOOL_RESULT_TEXT,
        },
      ],
      tools,
    };
  }
  if (source === "anthropic") {
    return {
      model: "claude-3-opus-20240229",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: callId,
              name: "get_weather",
              input: { location: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content: TOOL_RESULT_TEXT,
            },
          ],
        },
      ],
      tools,
    };
  }
  if (source === "ollama") {
    // Ollama pairs a tool result to its call by `tool_name`, FIFO by
    // name (docs.ollama.com api.md); the call carries the wire id.
    return {
      model: "llama3",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: {
                name: "get_weather",
                arguments: { location: "Paris" },
              },
            },
          ],
        },
        {
          role: "tool",
          tool_name: "get_weather",
          content: TOOL_RESULT_TEXT,
        },
      ],
      tools,
    };
  }
  if (source === "gemini") {
    // functionResponse is matched to the pending functionCall by name
    // (a wire `id` wins when present — we send one).
    return {
      contents: [
        { role: "user", parts: [{ text: "What's the weather?" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: callId,
                name: "get_weather",
                args: { location: "Paris" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: callId,
                name: "get_weather",
                response: { content: TOOL_RESULT_TEXT },
              },
            },
          ],
        },
      ],
      tools,
    };
  }
  throw new Error(`no tool-result request builder for source ${source}`);
}

function clientRequest(
  source: Provider,
  caseName: Case,
  streaming: boolean,
): { path: string; body: Record<string, unknown> } {
  const base =
    caseName === "after_tool_result"
      ? toolResultRequest(source)
      : caseName === "text"
        ? SOURCE_FIXTURES[source].requests.basic
        : (SOURCE_FIXTURES[source].requests.tools ?? OLLAMA_TOOLS_REQUEST);
  // Gemini picks the stream by URL suffix (`:streamGenerateContent`),
  // not a `stream` body field; `alt=sse` selects SSE over the
  // JSON-array form (spec §3.3). Ollama's /api/chat streams unless
  // stream:false is sent (api.md, default true), so its non-streaming
  // cells must opt out explicitly.
  const path =
    source === "gemini"
      ? `/v1beta/models/gemini-2.0-flash:${
          streaming ? "streamGenerateContent?alt=sse" : "generateContent"
        }`
      : PROVIDER_PATHS[source].pathPrefix;
  return {
    path,
    body: {
      ...(base as Record<string, unknown>),
      ...(streaming && source !== "gemini" && { stream: true }),
      ...(!streaming && source === "ollama" && { stream: false }),
    },
  };
}

// ---------- expected values, from the oracle ----------

interface ExpectedCall {
  id?: string;
  name?: string;
  args: unknown;
}

interface StreamFixture {
  expectedEvents: CanonicalStreamEvent[];
}

function streamFixture(provider: Provider, caseName: Case): StreamFixture {
  return JSON.parse(
    readFileSync(join(STREAMS_DIR, provider, `${caseName}.json`), "utf8"),
  ) as StreamFixture;
}

/** The calls a canonical response carries, in the comparison shape. */
function canonicalCalls(response: CanonicalResponse): ExpectedCall[] {
  return (response.message.toolCalls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: JSON.parse(tc.function.arguments),
  }));
}

/**
 * The calls the upstream reply carries, drawn only from the recorded
 * oracle. When the mock serves a recorded body (named fixture
 * response or recorded non-streaming twin) the expectation parses
 * that recording; when it derives the body from documented
 * expectedEvents the expectation is `reassembleStream` of those
 * events directly — never re-parsed from the adapter-derived body, so
 * a misconfigured or zero-call body cannot pass vacuously.
 */
function expectedCalls(
  target: Provider,
  caseName: Case,
  streaming: boolean,
): ExpectedCall[] {
  if (streaming) {
    return canonicalCalls(
      reassembleStream(streamFixture(target, caseName).expectedEvents),
    );
  }
  const source = nonStreamSource(target);
  if ("expectedEvents" in source) {
    return canonicalCalls(reassembleStream(source.expectedEvents));
  }
  return providerCalls(target, source.body);
}

function expectedText(
  target: Provider,
  caseName: Case,
  streaming: boolean,
): string {
  if (streaming) {
    return reassembleStream(streamFixture(target, caseName).expectedEvents)
      .message.content as string;
  }
  const source = nonStreamSource(target);
  if ("expectedEvents" in source) {
    return reassembleStream(source.expectedEvents).message
      .content as string;
  }
  return providerText(target, source.body);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Tool calls carried by a provider-dialect response body. */
function providerCalls(provider: Provider, body: unknown): ExpectedCall[] {
  const b = body as any;
  switch (provider) {
    case "openai":
      return (b.choices?.[0]?.message?.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        args: JSON.parse(tc.function?.arguments ?? "null"),
      }));
    case "ollama":
      return (b.message?.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        args: tc.function?.arguments,
      }));
    case "anthropic":
      return (b.content ?? [])
        .filter((bl: any) => bl.type === "tool_use")
        .map((bl: any) => ({ id: bl.id, name: bl.name, args: bl.input }));
    case "gemini":
      return (b.candidates?.[0]?.content?.parts ?? [])
        .filter((p: any) => p.functionCall)
        .map((p: any) => ({
          id: p.functionCall.id,
          name: p.functionCall.name,
          args: p.functionCall.args,
        }));
  }
}

function providerText(provider: Provider, body: unknown): string {
  const b = body as any;
  switch (provider) {
    case "openai":
      return b.choices?.[0]?.message?.content ?? "";
    case "ollama":
      return b.message?.content ?? "";
    case "anthropic":
      return (b.content ?? [])
        .filter((x: any) => x.type === "text")
        .map((x: any) => x.text ?? "")
        .join("");
    case "gemini":
      return (b.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p.text ?? "")
        .join("");
  }
}

// ---------- client reply parsers (source dialects) ----------

interface ClientCall {
  id?: string;
  name?: string;
  args: unknown;
}

interface ClientReply {
  text: string;
  calls: ClientCall[];
}

function clientJsonReply(source: Provider, body: any): ClientReply {
  switch (source) {
    case "openai": {
      const msg = body.choices?.[0]?.message ?? {};
      return {
        text: msg.content ?? "",
        calls: (msg.tool_calls ?? []).map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name,
          args: JSON.parse(tc.function?.arguments ?? "null"),
        })),
      };
    }
    case "anthropic": {
      const blocks: any[] = body.content ?? [];
      return {
        text: blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        calls: blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, args: b.input })),
      };
    }
    case "ollama": {
      const msg = body.message ?? {};
      return {
        text: msg.content ?? "",
        // Ollama call arguments are already objects on the wire.
        calls: (msg.tool_calls ?? []).map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name,
          args: tc.function?.arguments,
        })),
      };
    }
    case "gemini": {
      const parts: any[] = body.candidates?.[0]?.content?.parts ?? [];
      return {
        text: parts.map((p) => p.text ?? "").join(""),
        // functionCall.id is optional on the wire (both client-
        // facing encoders, stream and non-stream, send it); ids are
        // generated for Gemini cells and ignored here — see
        // "v1.1 follow-ups" in docs/decisions.md.
        calls: parts
          .filter((p) => p.functionCall)
          .map((p) => ({
            name: p.functionCall.name,
            args: p.functionCall.args,
          })),
      };
    }
    default:
      throw new Error(`no reply parser for source ${source}`);
  }
}

function clientStreamReply(source: Provider, wire: string): ClientReply {
  switch (source) {
    case "openai": {
      let text = "";
      const calls = new Map<
        number,
        { id?: string; name?: string; args: string }
      >();
      for (const line of wire.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).replace(/^ /, "");
        if (data === "" || data === "[DONE]") continue;
        const chunk = JSON.parse(data);
        for (const choice of chunk.choices ?? []) {
          if (typeof choice.delta?.content === "string") {
            text += choice.delta.content;
          }
          for (const tc of choice.delta?.tool_calls ?? []) {
            const c = calls.get(tc.index) ?? { args: "" };
            if (typeof tc.id === "string") c.id = tc.id;
            if (typeof tc.function?.name === "string") {
              c.name = tc.function.name;
            }
            c.args += tc.function?.arguments ?? "";
            calls.set(tc.index, c);
          }
        }
      }
      return {
        text,
        calls: [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, c]) => ({
            id: c.id,
            name: c.name,
            args: JSON.parse(c.args),
          })),
      };
    }
    case "anthropic": {
      let text = "";
      const calls: { id?: string; name?: string; args: string }[] = [];
      const byBlock = new Map<
        number,
        { id?: string; name?: string; args: string }
      >();
      for (const frame of wire.split(/\r?\n\r?\n/)) {
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        const evt = JSON.parse(data);
        if (
          evt.type === "content_block_start" &&
          evt.content_block?.type === "tool_use"
        ) {
          const c = {
            id: evt.content_block.id,
            name: evt.content_block.name,
            args: "",
          };
          calls.push(c);
          byBlock.set(evt.index, c);
        } else if (evt.type === "content_block_delta") {
          if (evt.delta?.type === "text_delta") text += evt.delta.text;
          if (evt.delta?.type === "input_json_delta") {
            byBlock.get(evt.index)!.args += evt.delta.partial_json;
          }
        }
      }
      return {
        text,
        calls: calls.map((c) => ({
          id: c.id,
          name: c.name,
          args: JSON.parse(c.args),
        })),
      };
    }
    case "ollama": {
      let text = "";
      const calls: ClientCall[] = [];
      // NDJSON: one JSON object per line; tool calls arrive whole.
      for (const line of wire.split("\n")) {
        if (line === "") continue;
        const obj = JSON.parse(line);
        if (typeof obj.message?.content === "string") {
          text += obj.message.content;
        }
        for (const tc of obj.message?.tool_calls ?? []) {
          calls.push({
            id: tc.id,
            name: tc.function?.name,
            args: tc.function?.arguments,
          });
        }
      }
      return { text, calls };
    }
    case "gemini": {
      let text = "";
      const calls: ClientCall[] = [];
      for (const line of wire.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).replace(/^ /, "");
        if (data === "") continue;
        const evt = JSON.parse(data);
        for (const part of evt.candidates?.[0]?.content?.parts ?? []) {
          if (typeof part.text === "string") text += part.text;
          // functionCall parts arrive whole; `id` is optional on the
          // wire (the stream encoder sends it) and is ignored here.
          if (part.functionCall) {
            calls.push({
              name: part.functionCall.name,
              args: part.functionCall.args,
            });
          }
        }
      }
      return { text, calls };
    }
    default:
      throw new Error(`no stream parser for source ${source}`);
  }
}

// ---------- shape and upstream assertions ----------

function assertSourceFormat(
  source: Provider,
  streaming: boolean,
  res: request.Response,
): void {
  if (!streaming) {
    if (source === "openai") {
      expect(res.body.object).toBe("chat.completion");
    } else if (source === "anthropic") {
      expect(res.body.type).toBe("message");
      expect(res.body.role).toBe("assistant");
    } else if (source === "ollama") {
      expect(res.body.message).toBeDefined();
      expect(typeof res.body.done).toBe("boolean");
    } else if (source === "gemini") {
      expect(Array.isArray(res.body.candidates)).toBe(true);
    }
    return;
  }
  const wire = res.body as string;
  if (source === "openai") {
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(wire).toContain("data: {");
    expect(wire.trimEnd().endsWith("data: [DONE]")).toBe(true);
  } else if (source === "anthropic") {
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(wire).toContain("event: message_start");
    expect(
      wire.trimEnd().endsWith('data: {"type":"message_stop"}'),
    ).toBe(true);
  } else if (source === "ollama") {
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = wire.split("\n").filter((l) => l !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) JSON.parse(line);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ done: true });
  } else if (source === "gemini") {
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(wire).toContain("data: {");
  }
}

/** The upstream request must carry the tool definitions in its dialect. */
function assertToolsForwarded(target: Provider): void {
  const tools = (capturedRequests[target][0] as any)?.tools;
  const names = (tools ?? []).flatMap((t: any) =>
    // Gemini: tools[].functionDeclarations[]; others: tools[].function.name / .name
    (t.functionDeclarations ?? [t]).map(
      (d: any) => d.function?.name ?? d.name,
    ),
  );
  expect(names).toContain("get_weather");
}

/** The upstream request must carry the client's tool result. */
function assertToolResultForwarded(
  target: Provider,
  source: Provider,
): void {
  if (target === "gemini") {
    const contents = (capturedRequests.gemini[0] as any)?.contents ?? [];
    const parts = contents.flatMap((c: any) => c.parts ?? []);
    expect(
      parts.some((p: any) => p.functionCall?.name === "get_weather"),
      "upstream request carries the assistant tool call",
    ).toBe(true);
    const res = parts.find((p: any) => p.functionResponse);
    expect(res, "upstream request carries the tool result").toBeDefined();
    expect(res.functionResponse.name).toBe("get_weather");
    // A string tool result is wrapped as `{ "content": "<string>" }`
    // (spec §3.4 verbatim).
    expect(res.functionResponse.response).toEqual({
      content: TOOL_RESULT_TEXT,
    });
    return;
  }
  const messages = (capturedRequests[target][0] as any)?.messages ?? [];
  expect(
    messages.some(
      (m: any) =>
        (m.tool_calls ?? []).some(
          (tc: any) => tc.function?.name === "get_weather",
        ) ||
        // Anthropic: assistant tool calls are tool_use content blocks.
        (Array.isArray(m.content) &&
          m.content.some(
            (b: any) => b.type === "tool_use" && b.name === "get_weather",
          )),
    ),
    "upstream request carries the assistant tool call",
  ).toBe(true);
  const toolMsg = messages.find(
    (m: any) =>
      m.role === "tool" ||
      (Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === "tool_result")),
  );
  expect(
    toolMsg,
    "upstream request carries the tool result",
  ).toBeDefined();
  const content =
    typeof toolMsg.content === "string"
      ? toolMsg.content
      : (toolMsg.content ?? [])
          .map((b: any) => b.text ?? b.content ?? "")
          .join("");
  expect(content).toBe(TOOL_RESULT_TEXT);
  if (target === "openai") {
    expect(toolMsg.tool_call_id).toBe(CLIENT_CALL_ID[source]);
  }
  if (target === "ollama") {
    expect(toolMsg.tool_name).toBe("get_weather");
  }
  if (target === "anthropic") {
    const block = (toolMsg.content ?? []).find(
      (b: any) => b.type === "tool_result",
    );
    expect(block.tool_use_id).toBe(CLIENT_CALL_ID[source]);
  }
}

// ---------- the matrix ----------

const matrix = ALL_PAIRS.flatMap(([source, target]) =>
  CASES.flatMap((caseName) =>
    [true, false].map((streaming) => ({
      source,
      target,
      caseName,
      streaming,
    })),
  ),
);

describe("16-pair streaming × tools matrix (spec §4.5, §5)", () => {
  it.each(matrix)(
    "$source → $target $caseName stream=$streaming",
    async ({ source, target, caseName, streaming }) => {
      setPair(source, target);
      streamCase[target] = caseName;
      const { path, body } = clientRequest(source, caseName, streaming);

      const res = streaming
        ? await postStream(path, body)
        : await request(app).post(path).send(body);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      assertSourceFormat(source, streaming, res);

      const reply = streaming
        ? clientStreamReply(source, res.body as string)
        : clientJsonReply(source, res.body);

      if (caseName === "text" || caseName === "after_tool_result") {
        const expected = expectedText(target, caseName, streaming);
        expect(
          expected.length,
          "oracle text must be non-empty",
        ).toBeGreaterThan(0);
        expect(reply.calls).toEqual([]);
        expect(reply.text).toBe(expected);
      } else {
        const expected = expectedCalls(target, caseName, streaming);
        // Exact counts are pinned by the oracle: tool_call → exactly 1
        // call; parallel_tool_calls → what each provider recorded
        // (Gemini's recorded reply carries 3, the others 2) — so a
        // misconfigured mock can't pass with [] == [].
        const wantCalls =
          caseName === "tool_call" ? 1 : PARALLEL_CALL_COUNTS[target];
        expect(
          expected.length,
          `oracle must carry ${wantCalls} call(s) for ${caseName}`,
        ).toBe(wantCalls);
        expect(
          expected.every(
            (c) =>
              typeof c.name === "string" &&
              c.name.length > 0 &&
              typeof c.id === "string" &&
              c.id.length > 0,
          ),
          "oracle calls must carry names and ids",
        ).toBe(true);
        // Ids are not compared for cells touching Gemini: the
        // recorded Gemini upstream sends none, so canonical ids are
        // generated and can differ from the oracle's; and the Gemini
        // client side treats `functionCall.id` as optional. Elsewhere
        // the oracle's ids must survive intact.
        const idsOnWire = source !== "gemini" && target !== "gemini";
        const stripIds = (calls: ExpectedCall[]) =>
          calls.map(({ id: _id, ...rest }) => rest);
        expect(
          idsOnWire ? reply.calls : stripIds(reply.calls),
        ).toEqual(idsOnWire ? expected : stripIds(expected));
        expect(
          new Set(expected.map((c) => c.id)).size,
          "oracle call ids must be distinct",
        ).toBe(wantCalls);
        if (source !== "gemini") {
          expect(
            new Set(reply.calls.map((c) => c.id)).size,
            "client call ids must be distinct",
          ).toBe(reply.calls.length);
        }
      }

      if (caseName === "text") return;

      assertToolsForwarded(target);
      if (caseName === "after_tool_result") {
        assertToolResultForwarded(target, source);
      }
    },
  );
});

// ---------- cached usage matrix (spec §3.2) ----------

/**
 * The canonical usage a target's cached-usage mock decodes to:
 * Ollama's dialect has no cache fields; Gemini's carries reads only.
 */
function expectedCanonical(target: Provider): {
  read?: number;
  write?: number;
} {
  if (target === "ollama") return {};
  if (target === "gemini") return { read: CACHED_USAGE.readTokens };
  return {
    read: CACHED_USAGE.readTokens,
    write: CACHED_USAGE.writeTokens,
  };
}

interface StreamUsage {
  input?: number;
  output?: number;
  read?: number;
  write?: number;
}

/** The usage a client-dialect stream carries, in canonical terms. */
function clientStreamUsage(source: Provider, wire: string): StreamUsage {
  if (source === "openai") {
    let usage: any;
    for (const line of wire.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).replace(/^ /, "");
      if (data === "" || data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      if (chunk.usage) usage = chunk.usage;
    }
    return {
      input: usage?.prompt_tokens,
      output: usage?.completion_tokens,
      read: usage?.prompt_tokens_details?.cached_tokens,
      write: usage?.prompt_tokens_details?.cache_write_tokens,
    };
  }
  if (source === "anthropic") {
    let usage: any;
    for (const frame of wire.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      const evt = JSON.parse(data);
      if (evt.type === "message_delta") usage = evt.usage;
    }
    return {
      // Anthropic's input_tokens excludes cached tokens — add them
      // back so the caller can compare against canonical inputTokens.
      input:
        usage === undefined
          ? undefined
          : usage.input_tokens +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
      output: usage?.output_tokens,
      read: usage?.cache_read_input_tokens,
      write: usage?.cache_creation_input_tokens,
    };
  }
  if (source === "gemini") {
    let usage: any;
    for (const line of wire.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).replace(/^ /, "");
      if (data === "") continue;
      const evt = JSON.parse(data);
      if (evt.usageMetadata) usage = evt.usageMetadata;
    }
    return {
      input: usage?.promptTokenCount,
      output: usage?.candidatesTokenCount,
      read: usage?.cachedContentTokenCount,
    };
  }
  // ollama: the done:true line carries the totals; no cache fields.
  const lines = wire.split("\n").filter((l) => l !== "");
  const last = JSON.parse(lines.at(-1)!);
  return { input: last.prompt_eval_count, output: last.eval_count };
}

describe("cached usage survives every pair, streamed (spec §3.2, §4.2)", () => {
  it.each(ALL_PAIRS)(
    "%s → %s",
    async (source: Provider, target: Provider) => {
      setPair(source, target);
      cachedUsage[target] = true;

      const path =
        source === "gemini"
          ? "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse"
          : PROVIDER_PATHS[source].pathPrefix;
      const body = {
        ...(SOURCE_FIXTURES[source].requests.basic as Record<
          string,
          unknown
        >),
        ...(source !== "gemini" && { stream: true }),
        // An OpenAI client gets the usage chunk only when it asked.
        ...(source === "openai" && {
          stream_options: { include_usage: true },
        }),
      };

      const res = await postStream(path, body);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const wire = res.body as string;
      const usage = clientStreamUsage(source, wire);
      const expected = expectedCanonical(target);

      // All input tokens reach the client regardless of dialect;
      // the cache counts arrive only when the source wire can carry
      // them (Ollama: never; Gemini: reads only).
      expect(usage.input, `${source} input`).toBe(
        CACHED_USAGE.inputTokens,
      );
      expect(usage.output, `${source} output`).toBe(
        CACHED_USAGE.outputTokens,
      );
      if (source === "ollama") {
        expect(JSON.parse(wire.trimEnd().split("\n").at(-1)!)).not.toHaveProperty(
          "cache_read_input_tokens",
        );
      } else if (source === "gemini") {
        expect(usage.read).toBe(expected.read);
      } else {
        expect(usage.read, `${source} cache read`).toBe(expected.read);
        expect(usage.write, `${source} cache write`).toBe(expected.write);
      }
    },
  );
});
