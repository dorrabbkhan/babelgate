import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  afterAll,
} from "vitest";
import { setupServer } from "msw/node";
import request from "supertest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { app } from "../../src/app";
import { resetConfig } from "../../src/config/env-config";
import { PROVIDER_PATHS, type Provider } from "../../src/transformers";
import {
  upstreamHandlers,
  capturedRequests,
  resetCaptured,
  resetOverrides,
  resetReplyOptins,
  reasoningReply,
  MEDIA_URL,
  MEDIA_PNG_B64,
  MOCK_BASE_URLS,
} from "../mocks/upstreams";
import { recordMatrixCell } from "../matrix/matrix-report";
import { unpackEnvelope } from "../../src/transformers/reasoning-envelope";
import { fromGeminiSignature } from "../../src/transformers/adapters/gemini.signature";
import openaiFixtures from "../fixtures/openai.json";
import geminiFixtures from "../fixtures/gemini.json";
import ollamaFixtures from "../fixtures/ollama.json";
import anthropicFixtures from "../fixtures/anthropic.json";
import responsesFixtures from "../fixtures/responses.json";

/**
 * The v1.5 §3.4 matrix features beyond plain/stream/tools/
 * structured: reasoning, URL image, document, tool-result image and
 * same-format pass-through, per 5×5 pair. Each cell records the
 * status its request actually produced — "pass" (carried
 * faithfully), "note" (works with a documented caveat), "fail" (the
 * target refuses it), "na" (the source dialect cannot express it at
 * all — never a gateway failure) — into
 * tests/matrix/.out/matrix.json for `npm run matrix`.
 */

const server = setupServer(...upstreamHandlers);

const PROVIDERS: Provider[] = [
  "openai",
  "gemini",
  "ollama",
  "anthropic",
  "responses",
];
const ALL_PAIRS: [Provider, Provider][] = PROVIDERS.flatMap((source) =>
  PROVIDERS.map((target) => [source, target] as [Provider, Provider]),
);

const FIXTURES: Record<
  Provider,
  { requests: Record<string, unknown> }
> = {
  openai: openaiFixtures,
  gemini: geminiFixtures,
  ollama: ollamaFixtures,
  anthropic: anthropicFixtures,
  responses: responsesFixtures,
};

const PDF_B64 = Buffer.from("%PDF-1.4 fake").toString("base64");

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  for (const p of PROVIDERS) {
    process.env[`${p.toUpperCase()}_API_BASE_URL`] = MOCK_BASE_URLS[p];
    process.env[`${p.toUpperCase()}_API_KEY`] = "test-key";
  }
});

afterEach(() => {
  server.resetHandlers();
  resetCaptured();
  resetOverrides();
  resetReplyOptins();
  delete process.env.BABELGATE_CONFIG;
  rmSync(PT_CONFIG, { force: true });
});

afterAll(() => {
  server.close();
});

function setPair(source: Provider, target: Provider): void {
  process.env.SOURCE_API = source;
  process.env.TARGET_API = target;
  resetConfig();
}

/** A basic request in the source's dialect (Ollama opts out of streaming). */
function basicBody(source: Provider): Record<string, unknown> {
  const fixture = FIXTURES[source].requests["basic"];
  expect(fixture, `missing basic request fixture for ${source}`).toBeDefined();
  return source === "ollama"
    ? { ...(fixture as Record<string, unknown>), stream: false }
    : (fixture as Record<string, unknown>);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- reasoning (v1.5 spec §3.1) ----------

/**
 * The upstream's signed reasoning reply (reasoningReply mock) must
 * surface on the client in its dialect: the bg1. envelope on
 * Anthropic and Gemini, Responses `encrypted_content`, and —
 * text-only, no signature to send back — `reasoning_content` /
 * `thinking` on Chat and Ollama (conductor's call b; those cells are
 * `note`, not `pass`).
 */
describe("reasoning reply reaches every client (v1.5 spec §3.1)", () => {
  it.each(ALL_PAIRS)("%s → %s", async (source, target) => {
    setPair(source, target);
    reasoningReply[target] = true;

    const res = await request(app)
      .post(PROVIDER_PATHS[source].pathPrefix)
      .send(basicBody(source));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body as any;
    if (source === "openai") {
      expect(b.choices?.[0]?.message?.reasoning_content).toBe(
        "reasoning about turn 1",
      );
      recordMatrixCell(source, target, "reasoning", "note", "no_signature");
    } else if (source === "ollama") {
      expect(b.message?.thinking).toBe("reasoning about turn 1");
      recordMatrixCell(source, target, "reasoning", "note", "no_signature");
    } else if (source === "anthropic") {
      const block = (b.content ?? []).find(
        (x: any) => x.type === "thinking",
      );
      expect(block?.thinking).toBe("reasoning about turn 1");
      expect(block?.signature).toMatch(/^bg1\./);
      recordMatrixCell(source, target, "reasoning", "pass");
    } else if (source === "gemini") {
      const part = (b.candidates?.[0]?.content?.parts ?? []).find(
        (p: any) => p.thought === true,
      );
      expect(part?.text).toBe("reasoning about turn 1");
      // Task 14 live pass: the wire signature is standard base64 of
      // the bg1. envelope (a bytes field), never the raw bg1. string.
      expect(part?.thoughtSignature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(
        unpackEnvelope(fromGeminiSignature(part.thoughtSignature)),
      ).toMatchObject({ v: 1 });
      recordMatrixCell(source, target, "reasoning", "pass");
    } else {
      const item = (b.output ?? []).find(
        (x: any) => x.type === "reasoning",
      );
      expect(typeof item?.encrypted_content).toBe("string");
      expect(item.encrypted_content.length).toBeGreaterThan(0);
      recordMatrixCell(source, target, "reasoning", "pass");
    }
  });
});

// ---------- URL image (v1.5 spec §3.2.2) ----------

/**
 * A URL image part in each source's dialect. Ollama's `images` is
 * base64-only — no URL slot (docs.ollama.com/api/chat) — so its
 * row's cells are `n/a`, not fails: the request can never reach the
 * gateway.
 */
const URL_IMAGE_REQUESTS: Record<
  Provider,
  Record<string, unknown> | null
> = {
  openai: {
    model: "gpt-4",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: MEDIA_URL } },
        ],
      },
    ],
  },
  gemini: {
    contents: [
      {
        role: "user",
        parts: [
          { text: "what is this?" },
          { fileData: { fileUri: MEDIA_URL, mimeType: "image/png" } },
        ],
      },
    ],
  },
  ollama: null,
  anthropic: {
    model: "claude-3-opus-20240229",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "url", url: MEDIA_URL } },
        ],
      },
    ],
  },
  responses: {
    model: "gpt-5-codex",
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: MEDIA_URL },
        ],
      },
    ],
  },
};

describe("URL image reaches every target (v1.5 spec §3.2.2)", () => {
  it.each(ALL_PAIRS)("%s → %s", async (source, target) => {
    const body = URL_IMAGE_REQUESTS[source];
    if (body === null) {
      recordMatrixCell(source, target, "url_image", "na", "no url field");
      return;
    }
    setPair(source, target);

    const res = await request(app)
      .post(PROVIDER_PATHS[source].pathPrefix)
      .send(body);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests[target]).toHaveLength(1);
    const upstream = JSON.stringify(capturedRequests[target][0]);
    if (target === "ollama") {
      // Byte-only target: the URL was fetched through the mocked
      // media host and inlined as base64 (spec §3.2.2) — the cell is
      // a working `inlined` note, not a bare pass.
      expect(upstream).toContain(MEDIA_PNG_B64);
      recordMatrixCell(source, target, "url_image", "note", "inlined");
    } else {
      expect(upstream).toContain(MEDIA_URL);
      recordMatrixCell(source, target, "url_image", "pass");
    }
  });
});

// ---------- document (v1.5 spec §3.2.2) ----------

/**
 * A base64 PDF document in each source's dialect. Ollama has no
 * document field at all — its source cells are `n/a` — and it is
 * the only target that refuses documents (400 in the source's
 * dialect naming the field path — those cells stay fails).
 */
const DOCUMENT_REQUESTS: Record<
  Provider,
  Record<string, unknown> | null
> = {
  openai: {
    model: "gpt-4",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "read this" },
          {
            type: "file",
            file: {
              file_data: `data:application/pdf;base64,${PDF_B64}`,
              filename: "doc.pdf",
            },
          },
        ],
      },
    ],
  },
  gemini: {
    contents: [
      {
        role: "user",
        parts: [
          { text: "read this" },
          { inlineData: { mimeType: "application/pdf", data: PDF_B64 } },
        ],
      },
    ],
  },
  ollama: null,
  anthropic: {
    model: "claude-3-opus-20240229",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "read this" },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: PDF_B64,
            },
          },
        ],
      },
    ],
  },
  responses: {
    model: "gpt-5-codex",
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "read this" },
          {
            type: "input_file",
            file_data: `data:application/pdf;base64,${PDF_B64}`,
            filename: "doc.pdf",
          },
        ],
      },
    ],
  },
};

describe("document reaches capable targets (v1.5 spec §3.2.2)", () => {
  it.each(ALL_PAIRS)("%s → %s", async (source, target) => {
    const body = DOCUMENT_REQUESTS[source];
    if (body === null) {
      recordMatrixCell(
        source,
        target,
        "document",
        "na",
        "no document field",
      );
      return;
    }
    setPair(source, target);

    const res = await request(app)
      .post(PROVIDER_PATHS[source].pathPrefix)
      .send(body);

    if (target === "ollama") {
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        "documents are not supported",
      );
      recordMatrixCell(
        source,
        target,
        "document",
        "fail",
        "no document target",
      );
      return;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests[target]).toHaveLength(1);
    expect(JSON.stringify(capturedRequests[target][0])).toContain(PDF_B64);
    recordMatrixCell(source, target, "document", "pass");
  });
});

// ---------- image in a tool result (v1.5 spec §3.2.1) ----------

/**
 * An image inside a tool result: only Anthropic's `tool_result`
 * blocks, Responses' `function_call_output` arrays and a Chat tool
 * message's content parts can express it at all (Gemini's
 * `functionResponse` and Ollama's tool messages have no media slot —
 * those source cells are `n/a`); only Anthropic and Responses
 * targets accept it (MEDIA_SUPPORT.toolMessageImages — the refused
 * targets stay fails).
 */
const TOOL_IMAGE_REQUESTS: Record<
  Provider,
  Record<string, unknown> | null
> = {
  openai: {
    model: "gpt-4",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
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
        tool_call_id: "call_1",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${MEDIA_PNG_B64}`,
            },
          },
        ],
      },
    ],
  },
  gemini: null,
  ollama: null,
  anthropic: {
    model: "claude-3-opus-20240229",
    max_tokens: 128,
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: { type: "object", properties: {} },
      },
    ],
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
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
            tool_use_id: "toolu_1",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: MEDIA_PNG_B64,
                },
              },
            ],
          },
        ],
      },
    ],
  },
  responses: {
    model: "gpt-5-codex",
    store: false,
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: {} },
      },
    ],
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"location":"Paris"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${MEDIA_PNG_B64}`,
          },
        ],
      },
    ],
  },
};

const TOOL_IMAGE_TARGETS: Provider[] = ["anthropic", "responses"];

describe("image in a tool result reaches capable targets (v1.5 spec §3.2.1)", () => {
  it.each(ALL_PAIRS)("%s → %s", async (source, target) => {
    const body = TOOL_IMAGE_REQUESTS[source];
    if (body === null) {
      recordMatrixCell(
        source,
        target,
        "tool_image",
        "na",
        "no tool-image field",
      );
      return;
    }
    setPair(source, target);

    const res = await request(app)
      .post(PROVIDER_PATHS[source].pathPrefix)
      .send(body);

    if (!TOOL_IMAGE_TARGETS.includes(target)) {
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        "images in tool messages are not supported",
      );
      recordMatrixCell(
        source,
        target,
        "tool_image",
        "fail",
        "no tool-image target",
      );
      return;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests[target]).toHaveLength(1);
    expect(JSON.stringify(capturedRequests[target][0])).toContain(
      MEDIA_PNG_B64,
    );
    recordMatrixCell(source, target, "tool_image", "pass");
  });
});

// ---------- same-format pass-through (v1.5 spec §3.3) ----------

/**
 * Pass-through is same-format only: diagonal cells on an
 * `anthropic`/`openai` provider with `passthrough: true` and on a
 * `responses` provider unconditionally relay the client's bytes
 * (`x_matrix_pt` survives — canonical decode drops it). Gemini and
 * Ollama have no same-format shim (the schema rejects
 * `passthrough: true` there), and every cross-format pair is served
 * by the canonical path — a `canonical` note, not a pass-through
 * claim.
 */
const PT_CONFIG = join(__dirname, ".tmp-matrix-pt.yaml");
const PT_MARKER = "matrix-pt-probe";
const PASSTHROUGH_TYPES: Provider[] = ["anthropic", "openai", "responses"];

function ptYaml(type: Provider, passthrough: boolean): string {
  const flag = passthrough ? "    passthrough: true\n" : "";
  return `default: shim
providers:
  shim:
    type: ${type}
    base_url: ${MOCK_BASE_URLS[type]}
    api_key_env: ${type.toUpperCase()}_API_KEY
${flag}routes:
  - match: "*"
    to: shim/m
`;
}

describe("same-format pass-through (v1.5 spec §3.3)", () => {
  it.each(ALL_PAIRS)("%s → %s", async (source, target) => {
    if (source !== target) {
      // Pass-through never crosses formats; the pair is served by
      // the canonical path — the cross-format cells assert that
      // elsewhere in this file and in pairs.test.ts.
      recordMatrixCell(source, target, "passthrough", "note", "canonical");
      return;
    }
    const canPassThrough = PASSTHROUGH_TYPES.includes(source);
    writeFileSync(
      PT_CONFIG,
      ptYaml(source, source !== "responses" && canPassThrough),
    );
    process.env.BABELGATE_CONFIG = PT_CONFIG;
    resetConfig();

    const res = await request(app)
      .post(PROVIDER_PATHS[source].pathPrefix)
      .send({ ...basicBody(source), x_matrix_pt: PT_MARKER });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(capturedRequests[source]).toHaveLength(1);
    const upstream = JSON.stringify(capturedRequests[source][0]);
    if (canPassThrough) {
      // Byte relay: the marker survived to the upstream body.
      expect(upstream).toContain(PT_MARKER);
      recordMatrixCell(source, target, "passthrough", "pass");
    } else {
      // No same-format shim for this provider type: the request
      // still works, but through canonical translation — the marker
      // is dropped, which is the observable proof.
      expect(upstream).not.toContain(PT_MARKER);
      recordMatrixCell(source, target, "passthrough", "fail", "no passthrough");
    }
  });
});
