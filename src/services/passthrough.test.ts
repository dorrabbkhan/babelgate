import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import type { ProviderEntry } from "../routing/registry";
import type { RouteTarget } from "../routing/plan-route";
import type { CanonicalRequest } from "../types/canonical.types";
import { UnsupportedParameterError } from "../utils/errors";
import {
  assertBridgeableBody,
  isPassthrough,
  passthroughTargetBody,
} from "./passthrough";
import type { PassthroughObservation } from "./passthrough-relay";
import {
  relayAnthropicStream,
  relayChatStream,
  relayResponsesStream,
} from "./passthrough-dialects";

/**
 * The pass-through relay (v1.4 spec §3.4): Responses source →
 * `type: responses` entry. Request: only `model` rewritten and
 * `max_output_tokens` clamped. Reply: byte for byte except
 * `response.model` inside the five lifecycle events.
 *
 * The relay tests drive `relayResponsesStream` directly so each
 * realistic upstream shape is exercised: no `event:` lines (the
 * OpenRouter shape), `data: [DONE]`, CRLF endings, gzip content
 * encoding, several events per network chunk, and a lifecycle event
 * split across chunks.
 */

const ENTRY: ProviderEntry = {
  name: "or",
  type: "responses",
  baseUrl: "http://responses.mock",
};

const TARGET: RouteTarget = { provider: "or", model: "upstream-model" };

const CANONICAL: CanonicalRequest = {
  model: "client-model",
  messages: [{ role: "user", content: "hi" }],
};

function observation(): PassthroughObservation {
  return {};
}

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) {
        c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      }
      c.close();
    },
  });
}

async function collect(
  gen: AsyncGenerator<string>,
): Promise<string> {
  let out = "";
  for await (const s of gen) out += s;
  return out;
}

function relay(
  chunks: Array<string | Uint8Array>,
  opts?: {
    headers?: Record<string, string>;
    observation?: PassthroughObservation;
    signal?: AbortSignal;
  },
): Promise<string> {
  return collect(
    relayResponsesStream({
      upstream: streamOf(chunks),
      upstreamHeaders: opts?.headers,
      requestedModel: "client-model",
      idleMs: 60_000,
      signal: opts?.signal ?? new AbortController().signal,
      observation: opts?.observation ?? observation(),
    }),
  );
}

// Event field names per
// https://platform.openai.com/docs/api-reference/responses-streaming.
const lifecycleEvent = (type: string, model = "upstream-model") =>
  JSON.stringify({
    type,
    sequence_number: 0,
    response: {
      id: "resp_1",
      object: "response",
      created_at: 1,
      status:
        type === "response.completed"
          ? "completed"
          : type === "response.incomplete"
            ? "incomplete"
            : type === "response.failed"
              ? "failed"
              : "in_progress",
      model,
      output: [],
      usage:
        type === "response.completed"
          ? {
              input_tokens: 12,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 2,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 14,
            }
          : null,
    },
  });

const DELTA =
  'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}\n\n';

const ANT_ENTRY: ProviderEntry = {
  name: "ant",
  type: "anthropic",
  baseUrl: "http://anthropic.mock",
};

const CHAT_ENTRY: ProviderEntry = {
  name: "chat",
  type: "openai",
  baseUrl: "http://openai.mock",
};

describe("isPassthrough", () => {
  it("is true only for a responses source on a responses entry", () => {
    expect(isPassthrough("responses", ENTRY)).toBe(true);
    expect(
      isPassthrough("responses", { ...ENTRY, type: "openai" }),
    ).toBe(false);
    expect(isPassthrough("openai", ENTRY)).toBe(false);
    expect(
      isPassthrough("openai", { ...ENTRY, type: "openai" }),
    ).toBe(false);
    expect(
      isPassthrough("gemini", { ...ENTRY, type: "anthropic" }),
    ).toBe(false);
  });

  // v1.5 spec §3.3 (D6): same-format anthropic/openai entries relay
  // only when `passthrough: true` opts them in — no flag keeps the
  // canonical path.
  it("anthropic and openai entries need passthrough: true", () => {
    expect(
      isPassthrough("anthropic", { ...ANT_ENTRY, passthrough: true }),
    ).toBe(true);
    expect(
      isPassthrough("openai", { ...CHAT_ENTRY, passthrough: true }),
    ).toBe(true);
    expect(isPassthrough("anthropic", ANT_ENTRY)).toBe(false);
    expect(isPassthrough("openai", CHAT_ENTRY)).toBe(false);
  });

  it("the flag never crosses provider formats", () => {
    expect(
      isPassthrough("anthropic", { ...CHAT_ENTRY, passthrough: true }),
    ).toBe(false);
    expect(
      isPassthrough("openai", { ...ANT_ENTRY, passthrough: true }),
    ).toBe(false);
    expect(
      isPassthrough("gemini", { ...ANT_ENTRY, passthrough: true }),
    ).toBe(false);
    expect(
      isPassthrough("responses", { ...ANT_ENTRY, passthrough: true }),
    ).toBe(false);
  });
});

describe("passthroughTargetBody", () => {
  it("only model is rewritten in the forwarded body", () => {
    const source = {
      model: "client-model",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium" },
      tools: [{ type: "web_search", external_web_access: true }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", encrypted_content: "bg1.sig" },
      ],
      metadata: { caller: "codex" },
      max_output_tokens: 512,
    };
    const forwarded = passthroughTargetBody(
      source,
      TARGET,
      CANONICAL,
      ENTRY,
    );
    // Byte compare after replacing model (plan Step 1): the only
    // field that differs is `model`.
    expect(JSON.stringify(forwarded)).toBe(
      JSON.stringify({ ...source, model: "upstream-model" }),
    );
    expect(forwarded.model).toBe("upstream-model");
  });

  it("clamps max_output_tokens like the bridged path", () => {
    const capped = { ...ENTRY, maxOutputTokens: 100 };
    const canonical = {
      ...CANONICAL,
      config: { maxTokens: 512 },
    };
    const forwarded = passthroughTargetBody(
      { model: "client-model", max_output_tokens: 512 },
      TARGET,
      canonical,
      capped,
    );
    expect(forwarded.max_output_tokens).toBe(100);
  });

  it("an unset max_output_tokens is filled with the cap", () => {
    const capped = { ...ENTRY, maxOutputTokens: 100 };
    const forwarded = passthroughTargetBody(
      { model: "client-model" },
      TARGET,
      CANONICAL,
      capped,
    );
    expect(forwarded.max_output_tokens).toBe(100);
  });

  it("no cap leaves max_output_tokens untouched", () => {
    const forwarded = passthroughTargetBody(
      { model: "client-model", max_output_tokens: 50 },
      TARGET,
      { ...CANONICAL, config: { maxTokens: 50 } },
      ENTRY,
    );
    expect(forwarded.max_output_tokens).toBe(50);
    expect(
      passthroughTargetBody(
        { model: "client-model" },
        TARGET,
        CANONICAL,
        ENTRY,
      ),
    ).not.toHaveProperty("max_output_tokens");
  });

  // v1.5 spec §3.3: the clamp lands on the entry's own max-tokens
  // field — the one its encoder writes on the bridged path.
  it("clamps max_tokens on an anthropic entry", () => {
    const forwarded = passthroughTargetBody(
      { model: "client-model", max_tokens: 512, stream: true },
      TARGET,
      { ...CANONICAL, config: { maxTokens: 512 } },
      { ...ANT_ENTRY, maxOutputTokens: 100 },
    );
    expect(forwarded.max_tokens).toBe(100);
    expect(forwarded).not.toHaveProperty("max_output_tokens");
    expect(forwarded.stream).toBe(true);
  });

  it("clamps max_completion_tokens when the chat client sent it", () => {
    const forwarded = passthroughTargetBody(
      { model: "client-model", max_completion_tokens: 512 },
      TARGET,
      { ...CANONICAL, config: { maxTokens: 512 } },
      { ...CHAT_ENTRY, maxOutputTokens: 100 },
    );
    expect(forwarded.max_completion_tokens).toBe(100);
    expect(forwarded).not.toHaveProperty("max_tokens");
  });

  it("clamps max_tokens on a chat entry without max_completion_tokens", () => {
    const forwarded = passthroughTargetBody(
      { model: "client-model", max_tokens: 512 },
      TARGET,
      { ...CANONICAL, config: { maxTokens: 512 } },
      { ...CHAT_ENTRY, maxOutputTokens: 100 },
    );
    expect(forwarded.max_tokens).toBe(100);
  });
});

describe("assertBridgeableBody", () => {
  // The responses-lite markers (owner decision, Task 3): relayed on
  // pass-through, a 400 on the bridge.
  const LITE_MARKERS: Array<[string, Record<string, unknown>]> = [
    [
      "additional_tools",
      { input: [{ type: "additional_tools", tools: [] }] },
    ],
    [
      "phase",
      {
        input: [{ type: "message", role: "user", phase: "commentary" }],
      },
    ],
    [
      "custom_tool_call",
      {
        input: [
          { type: "custom_tool_call", namespace: "multi_agent_v1" },
        ],
      },
    ],
    ["reasoning.context", { reasoning: { context: "…" } }],
  ];

  for (const [param, body] of LITE_MARKERS) {
    it(`${param} is a 400 unsupported_parameter on the bridge`, () => {
      try {
        assertBridgeableBody(body);
        expect.unreachable(`${param} did not throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedParameterError);
        expect((err as UnsupportedParameterError).toCanonical()).toMatchObject(
          { code: "unsupported_parameter", param },
        );
      }
    });
  }

  it("plain bodies pass", () => {
    assertBridgeableBody({ model: "m", input: [{ type: "message" }] });
    assertBridgeableBody({});
    assertBridgeableBody(null);
  });
});

describe("relayResponsesStream", () => {
  it("lifecycle events get response.model restored; every other byte is identical", async () => {
    const upstream =
      'data: {"type":"response.created","sequence_number":0,"response":{"id":"r1","object":"response","status":"in_progress","model":"upstream-model","output":[]}}\n\n' +
      DELTA +
      'data: {"type":"response.completed","sequence_number":9,"response":{"id":"r1","object":"response","status":"completed","model":"upstream-model","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n';
    const out = await relay([upstream]);
    const blocks = out.split("\n\n").filter((b) => b !== "");
    expect(blocks[1]).toBe(DELTA.trimEnd());
    const created = JSON.parse(blocks[0].slice(5)) as {
      type: string;
      response: { model: string };
    };
    expect(created.type).toBe("response.created");
    expect(created.response.model).toBe("client-model");
    const completed = JSON.parse(blocks[2].slice(5)) as {
      response: { model: string };
    };
    expect(completed.response.model).toBe("client-model");
  });

  it("event: lines are preserved with the model restored", async () => {
    const upstream =
      `event: response.in_progress\n` +
      `data: ${lifecycleEvent("response.in_progress")}\n\n` +
      DELTA +
      `data: ${lifecycleEvent("response.completed")}\n\n`;
    const out = await relay([upstream]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("event: response.in_progress");
    const parsed = JSON.parse(lines[1].slice(5)) as {
      type: string;
      response: { model: string };
    };
    expect(parsed.response.model).toBe("client-model");
    // The delta block — trailing blank line included — is verbatim.
    expect(out).toContain(DELTA);
  });

  it("data: [DONE] is relayed untouched", async () => {
    const upstream =
      `data: ${lifecycleEvent("response.completed")}\n\n` +
      "data: [DONE]\n\n";
    const out = await relay([upstream]);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("CRLF line endings round-trip", async () => {
    const upstream =
      "event: response.created\r\n" +
      `data: ${lifecycleEvent("response.created")}\r\n\r\n` +
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\r\n\r\n";
    const out = await relay([upstream]);
    const blocks = out.split("\r\n\r\n");
    expect(blocks[0].startsWith("event: response.created\r\n")).toBe(true);
    expect(blocks[1]).toBe(
      'data: {"type":"response.output_text.delta","delta":"x"}',
    );
  });

  it("a lifecycle event split across two chunks is restored whole", async () => {
    const event = `data: ${lifecycleEvent("response.completed")}\n\n`;
    const mid = event.indexOf('"model"');
    const obs = observation();
    const out = await collect(
      relayResponsesStream({
        upstream: streamOf([event.slice(0, mid), event.slice(mid)]),
        requestedModel: "client-model",
        idleMs: 60_000,
        signal: new AbortController().signal,
        observation: obs,
      }),
    );
    const parsed = JSON.parse(
      out.split("\n\n")[0].slice(5),
    ) as { response: { model: string } };
    expect(parsed.response.model).toBe("client-model");
    expect(obs.terminal?.type).toBe("response.completed");
  });

  it("several events in one chunk are relayed in order", async () => {
    const upstream =
      `data: ${lifecycleEvent("response.created")}\n\n` +
      DELTA +
      DELTA +
      `data: ${lifecycleEvent("response.completed")}\n\n`;
    const out = await relay([upstream]);
    expect(out.split("\n\n").filter((b) => b !== "")).toHaveLength(4);
  });

  it("a complete delta reaches the client before the next upstream chunk", async () => {
    const enc = new TextEncoder();
    let push!: (s: string) => void;
    let end!: () => void;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => c.enqueue(enc.encode(s));
        end = () => c.close();
      },
    });
    const iter = relayResponsesStream({
      upstream,
      requestedModel: "client-model",
      idleMs: 60_000,
      signal: new AbortController().signal,
      observation: observation(),
    })[Symbol.asyncIterator]();
    push(DELTA);
    // Resolves without a second chunk — the relay holds nothing back.
    const first = await iter.next();
    expect(first.value).toBe(DELTA);
    end();
  });

  it("a gzip upstream body is decompressed, then relayed", async () => {
    const sse =
      `data: ${lifecycleEvent("response.created")}\n\n` + DELTA;
    const gz = gzipSync(sse);
    const obs = observation();
    const out = await collect(
      relayResponsesStream({
        upstream: streamOf([gz]),
        upstreamHeaders: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
        },
        requestedModel: "client-model",
        idleMs: 60_000,
        signal: new AbortController().signal,
        observation: obs,
      }),
    );
    expect(out).toContain('"model":"client-model"');
    expect(out).toContain(DELTA.trimEnd());
  });

  it("upstream close without a terminal event ends in a synthesized response.failed", async () => {
    const obs = observation();
    const out = await collect(
      relayResponsesStream({
        upstream: streamOf([DELTA]),
        requestedModel: "client-model",
        idleMs: 60_000,
        signal: new AbortController().signal,
        observation: obs,
      }),
    );
    expect(out).toContain("response.failed");
    expect(obs.errorKind).toBeDefined();
  });

  it("a mid-stream read error ends in a synthesized response.failed", async () => {
    // The delta is delivered on the first read; the second read is the
    // socket reset — a synchronous enqueue+error in start() would drop
    // the queued chunk, which is not the shape being tested.
    let sent = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(new TextEncoder().encode(DELTA));
          return;
        }
        throw new Error("socket reset");
      },
    });
    const obs = observation();
    const out = await collect(
      relayResponsesStream({
        upstream,
        requestedModel: "client-model",
        idleMs: 60_000,
        signal: new AbortController().signal,
        observation: obs,
      }),
    );
    expect(out.startsWith(DELTA)).toBe(true);
    expect(out).toContain("response.failed");
    expect(obs.errorKind).toBeDefined();
  });

  it("an idle upstream times out into response.failed", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(DELTA));
        // never produces another chunk
      },
    });
    const obs = observation();
    const out = await collect(
      relayResponsesStream({
        upstream,
        requestedModel: "client-model",
        idleMs: 10,
        signal: new AbortController().signal,
        observation: obs,
      }),
    );
    expect(out).toContain("response.failed");
    expect(obs.errorKind).toBe("timeout");
  });

  it("client abort ends the relay quietly", async () => {
    const ac = new AbortController();
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(DELTA));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gen = relayResponsesStream({
      upstream,
      requestedModel: "client-model",
      idleMs: 60_000,
      signal: ac.signal,
      observation: observation(),
    });
    const iter = gen[Symbol.asyncIterator]();
    await iter.next(); // the delta
    ac.abort();
    const rest = await collect({
      [Symbol.asyncIterator]: () => iter,
    } as AsyncGenerator<string>);
    expect(rest).toBe("");
    expect(cancelled).toBe(true);
  });
});

// Anthropic SSE event names per
// https://docs.anthropic.com/en/api/messages-streaming.
const ANT_STREAM = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"upstream-model","content":[],"usage":{"input_tokens":25,"output_tokens":1}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

function relayAnthropic(
  chunks: Array<string | Uint8Array>,
  opts?: {
    headers?: Record<string, string>;
    observation?: PassthroughObservation;
    signal?: AbortSignal;
    idleMs?: number;
  },
): Promise<string> {
  return collect(
    relayAnthropicStream({
      upstream: streamOf(chunks),
      upstreamHeaders: opts?.headers,
      requestedModel: "client-model",
      idleMs: opts?.idleMs ?? 60_000,
      signal: opts?.signal ?? new AbortController().signal,
      observation: opts?.observation ?? observation(),
    }),
  );
}

describe("relayAnthropicStream", () => {
  it("message_start model is restored; every other byte is identical", async () => {
    const obs = observation();
    const out = await relayAnthropic([ANT_STREAM], { observation: obs });
    const blocks = out.split("\n\n").filter((b) => b !== "");
    const start = JSON.parse(
      blocks[0].split("\n")[1].slice(5),
    ) as { message: { model: string } };
    expect(start.message.model).toBe("client-model");
    // Non-lifecycle blocks relay verbatim — the content_block_delta
    // block reaches the client exactly as the upstream sent it.
    expect(blocks[2]).toBe(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    );
    expect(blocks.at(-1)).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}',
    );
    expect(obs.terminal?.type).toBe("message_stop");
  });

  it("usage from message_start and message_delta lands in observation.events", async () => {
    const obs = observation();
    await relayAnthropic([ANT_STREAM], { observation: obs });
    const usage = obs.events?.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    expect(usage).toMatchObject({
      type: "usage",
      usage: { inputTokens: 25, outputTokens: 15 },
    });
    expect(
      obs.events?.find((e) => e.type === "message_end"),
    ).toMatchObject({ finishReason: "stop" });
  });

  it("an upstream error event relays verbatim and marks the observation", async () => {
    const errBlock =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n';
    const obs = observation();
    const out = await relayAnthropic([ANT_STREAM + errBlock], {
      observation: obs,
    });
    expect(out.endsWith(errBlock)).toBe(true);
    expect(obs.errorKind).toBe("upstream");
  });

  it("upstream close without message_stop ends in a synthesized error event", async () => {
    const deltaOnly =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';
    const obs = observation();
    const out = await relayAnthropic([deltaOnly], { observation: obs });
    expect(out).toContain("event: error\n");
    expect(out).toContain('"api_error"');
    expect(obs.errorKind).toBeDefined();
  });

  it("client abort ends the relay quietly", async () => {
    const ac = new AbortController();
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(ANT_STREAM));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gen = relayAnthropicStream({
      upstream,
      requestedModel: "client-model",
      idleMs: 60_000,
      signal: ac.signal,
      observation: observation(),
    });
    const iter = gen[Symbol.asyncIterator]();
    await iter.next();
    ac.abort();
    const rest = await collect({
      [Symbol.asyncIterator]: () => iter,
    } as AsyncGenerator<string>);
    expect(rest).toBe("");
    expect(cancelled).toBe(true);
  });
});

// Chat Completions chunk shape per
// https://platform.openai.com/docs/api-reference/chat/streaming —
// every chunk carries `model`, `data: [DONE]` ends the stream, and a
// `choices: []` chunk carries `usage` when the client asked for it via
// `stream_options.include_usage`.
const CHAT_CHUNK =
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"upstream-model","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';

function relayChat(
  chunks: Array<string | Uint8Array>,
  opts?: {
    headers?: Record<string, string>;
    observation?: PassthroughObservation;
    signal?: AbortSignal;
    idleMs?: number;
  },
): Promise<string> {
  return collect(
    relayChatStream({
      upstream: streamOf(chunks),
      upstreamHeaders: opts?.headers,
      requestedModel: "client-model",
      idleMs: opts?.idleMs ?? 60_000,
      signal: opts?.signal ?? new AbortController().signal,
      observation: opts?.observation ?? observation(),
    }),
  );
}

describe("relayChatStream", () => {
  it("every chunk's model is restored; data: [DONE] is verbatim and terminal", async () => {
    const obs = observation();
    const out = await relayChat([CHAT_CHUNK + "data: [DONE]\n\n"], {
      observation: obs,
    });
    expect(out).toContain('"model":"client-model"');
    expect(out).not.toContain("upstream-model");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(obs.terminal?.type).toBe("[DONE]");
  });

  it("a usage chunk lands in observation.events", async () => {
    const stream =
      CHAT_CHUNK +
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"upstream-model","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
      "data: [DONE]\n\n";
    const obs = observation();
    await relayChat([stream], { observation: obs });
    const usage = obs.events?.find((e) => e.type === "usage");
    expect(usage).toMatchObject({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("an in-stream error chunk relays verbatim and marks the observation", async () => {
    const errBlock =
      'data: {"error":{"message":"overloaded","type":"server_error","param":null,"code":"overloaded"}}\n\n';
    const obs = observation();
    const out = await relayChat([CHAT_CHUNK + errBlock], {
      observation: obs,
    });
    expect(out).toContain(errBlock.trimEnd());
    expect(obs.errorKind).toBe("upstream");
  });

  it("upstream close without [DONE] ends in a synthesized error chunk then [DONE]", async () => {
    const obs = observation();
    const out = await relayChat([CHAT_CHUNK], { observation: obs });
    expect(out).toContain('"error"');
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(obs.errorKind).toBeDefined();
  });

  it("client abort ends the relay quietly", async () => {
    const ac = new AbortController();
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(CHAT_CHUNK));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gen = relayChatStream({
      upstream,
      requestedModel: "client-model",
      idleMs: 60_000,
      signal: ac.signal,
      observation: observation(),
    });
    const iter = gen[Symbol.asyncIterator]();
    await iter.next();
    ac.abort();
    const rest = await collect({
      [Symbol.asyncIterator]: () => iter,
    } as AsyncGenerator<string>);
    expect(rest).toBe("");
    expect(cancelled).toBe(true);
  });
});
