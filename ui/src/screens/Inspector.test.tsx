/** @jsxImportSource preact */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "preact";
import { act } from "preact/test-utils";
import { Inspector } from "./Inspector";
import { getRequest } from "../api";
import type { RequestDetail, RequestRow } from "../api";

/** let pending fetch .then chains run before act flushes effects */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

vi.mock("../api", () => ({
  getRequest: vi.fn(),
}));

const getMock = vi.mocked(getRequest);

function makeRow(overrides: Partial<RequestRow>): RequestRow {
  return {
    id: "r1",
    startedAt: 1_730_000_000_000,
    client: "claude-code",
    userAgent: null,
    sourceApi: "openai",
    requestedModel: "gpt-4o",
    routeReason: "default",
    provider: "openai",
    model: "gpt-4o",
    stream: false,
    status: "ok",
    httpStatus: 200,
    errorType: null,
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 0.004,
    wouldCostUsd: null,
    costEstimated: false,
    priceSource: "bundled",
    ttfbMs: 120,
    totalMs: 640,
    finishReason: "stop",
    hops: [
      { provider: "openai", model: "gpt-4o", outcome: "ok", ms: 640 },
      { provider: "openai", model: "gpt-4o-mini", outcome: "ok", ms: 300 },
    ],
    notes: [
      {
        stage: "decode",
        adapter: "openai",
        code: "unsupported_param",
        path: "messages[0].content[1]",
      },
    ],
    diagnostics: [
      { toolCallId: "call_9", name: "get_weather", code: "fenced_json" },
    ],
    repairs: [{ toolCallId: "call_9", steps: ["strip_fence"] }],
    reasoningTokens: null,
    ...overrides,
  };
}

function makeDetail(): RequestDetail {
  return {
    row: makeRow({}),
    bodies: {
      source: {
        value: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      },
      canonical: {
        value: {
          model: "gpt-4o",
          messages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
          ],
        },
      },
      target: [
        { value: { model: "gpt-4o", input: "hop-one-sentinel" } },
        { value: { model: "gpt-4o-mini", input: "hop-two-sentinel" } },
      ],
      response: {
        wire: { value: { choices: [{ message: { content: "reply" } }] } },
      },
    },
  };
}

describe("Inspector screen", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("four stages and a tab per hop", async () => {
    getMock.mockResolvedValue(makeDetail());
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const stages = container.querySelectorAll(".stage");
    expect(stages).toHaveLength(4);
    const headings = [...stages].map(
      (s) => s.querySelector("h3")?.textContent ?? "",
    );
    expect(headings[0]).toContain("source");
    expect(headings[1]).toContain("canonical");
    expect(headings[2]).toContain("target");
    expect(headings[3]).toContain("response");

    // a tab per hop, first selected: hop 1 body shown, hop 2 hidden
    const tabs = container.querySelectorAll(".stage .tabs button");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain("gpt-4o");
    expect(container.textContent).toContain("hop-one-sentinel");
    expect(container.textContent).not.toContain("hop-two-sentinel");

    await act(async () => {
      tabs[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("hop-two-sentinel");
    expect(container.textContent).not.toContain("hop-one-sentinel");
  });

  it("not retained message", async () => {
    getMock.mockResolvedValue({
      row: makeRow({ notes: [], diagnostics: [], repairs: [] }),
      bodies: null,
      reason: "not_retained",
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    // spec §3.9, verbatim
    expect(container.textContent).toContain(
      "bodies not retained — the inspector keeps the last N requests in memory; " +
        "set LOG_BODIES=true to keep them on disk",
    );
    // metadata still renders
    expect(container.textContent).toContain("gpt-4o");
    expect(container.querySelectorAll(".stage")).toHaveLength(0);
  });

  it("notes and diagnostics at top", async () => {
    getMock.mockResolvedValue(makeDetail());
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const notes = container.querySelector(".inspector-notes");
    expect(notes).not.toBeNull();
    expect(notes!.textContent).toContain("unsupported_param");
    expect(notes!.textContent).toContain("fenced_json");
    expect(notes!.textContent).toContain("strip_fence");

    // they precede the stage columns in document order
    const stages = container.querySelector(".stages");
    expect(stages).not.toBeNull();
    expect(
      notes!.compareDocumentPosition(stages!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("signature bytes never rendered", async () => {
    const SIG = "SIGBYTES-SENTINEL-0123";
    const ENV = "bg1.ENVSENTINEL4567890";
    getMock.mockResolvedValue({
      row: makeRow({ notes: [], diagnostics: [], repairs: [] }),
      bodies: {
        source: {
          value: {
            model: "m",
            input: [
              {
                type: "reasoning",
                id: "rs_1",
                summary: [],
                encrypted_content: ENV,
              },
            ],
          },
        },
        canonical: {
          value: {
            model: "m",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "reasoning",
                    reasoning: {
                      text: "thought hard",
                      origin: { provider: "gemini", model: "gm" },
                    },
                    signature: {
                      origin: { provider: "gemini", model: "gm" },
                      data: SIG,
                    },
                  },
                ],
              },
            ],
          },
        },
        target: [{ value: { model: "gm" } }],
        response: { wire: { value: { output: [] } } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    // Expand every collapsed JsonTree node — even fully opened, the
    // sentinels must never reach the DOM.
    for (let round = 0; round < 6; round++) {
      const closed = [...container.querySelectorAll(".twisty")].filter(
        (t) => t.textContent?.includes("▸"),
      );
      if (closed.length === 0) break;
      await act(async () => {
        for (const t of closed) {
          t.parentElement!.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          );
        }
      });
    }

    // Opaque bytes never reach the DOM — only byte counts and origin.
    expect(container.textContent).not.toContain(SIG);
    expect(container.textContent).not.toContain(ENV);
    expect(container.textContent).toContain(
      `<signature: ${SIG.length} bytes, origin gemini/gm>`,
    );
    expect(container.textContent).toContain("<envelope:");
    // The reasoning part renders as a labelled, collapsible block.
    const keys = [...container.querySelectorAll(".key")].map(
      (k) => k.textContent,
    );
    expect(keys).toContain("reasoning");
    expect(container.textContent).toContain("thought hard");
  });

  it("signature bytes never rendered in a streamed response", async () => {
    const GEM = "GEMSIG-SENTINEL-1";
    const ANT = "ANTSIG-SENTINEL-2";
    const ENV = "bg1.ENVSENTINEL-3";
    const RED_TARGET = "REDACTED-SENTINEL-4";
    const RED_STREAM = "REDACTED-SENTINEL-5";
    const wire = [
      `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{}},"thoughtSignature":"${GEM}"}]}}]}`,
      "event: content_block_delta",
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"${ANT}"}}`,
      `data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"${ENV}"}}`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"${RED_STREAM}"}}`,
      "data: [DONE]",
      "",
    ].join("\n");
    getMock.mockResolvedValue({
      row: makeRow({
        stream: true,
        notes: [],
        diagnostics: [],
        repairs: [],
      }),
      bodies: {
        source: {
          value: { model: "m", input: [{ data: "keep-me" }] },
        },
        canonical: { value: { model: "m", messages: [] } },
        target: [
          {
            value: {
              model: "m",
              content: [{ type: "redacted_thinking", data: RED_TARGET }],
            },
          },
        ],
        response: { wire: { value: wire } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    for (let round = 0; round < 6; round++) {
      const closed = [...container.querySelectorAll(".twisty")].filter(
        (t) => t.textContent?.includes("▸"),
      );
      if (closed.length === 0) break;
      await act(async () => {
        for (const t of closed) {
          t.parentElement!.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          );
        }
      });
    }

    const text = container.textContent ?? "";
    // No signature or envelope bytes — streamed or nested — reach the DOM.
    for (const s of [GEM, ANT, ENV, RED_TARGET, RED_STREAM]) {
      expect(text).not.toContain(s);
    }
    expect(text).toContain(`<signature: ${GEM.length} bytes>`);
    expect(text).toContain(`<signature: ${ANT.length} bytes>`);
    expect(text).toContain(`<envelope: ${ENV.length} bytes>`);
    expect(text).toContain(`<signature: ${RED_TARGET.length} bytes>`);
    // SSE framing survives masking; NDJSON/SSE payloads re-serialize.
    expect(text).toContain("data: [DONE]");
    expect(text).toContain("content_block_delta");
    // An ordinary `data` key outside redacted_thinking stays visible.
    expect(text).toContain("keep-me");
  });

  it("truncated final stream line is not rendered", async () => {
    // A client abort or the wire cap can end the snapshot mid-line:
    // the partial JSON may carry the first bytes of a signature.
    const lastLine =
      `data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"bg1.TRUNCSENTINEL-6`;
    const wire = `data: {"type":"response.created"}\n\n${lastLine}`;
    getMock.mockResolvedValue({
      row: makeRow({
        stream: true,
        notes: [],
        diagnostics: [],
        repairs: [],
      }),
      bodies: {
        source: { value: { model: "m" } },
        canonical: { value: { model: "m", messages: [] } },
        target: [{ value: { model: "m" } }],
        response: { wire: { value: wire } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    expect(text).not.toContain("TRUNCSENTINEL-6");
    const n = new TextEncoder().encode(lastLine.slice(5)).length;
    expect(text).toContain(`data: <truncated: ${n} bytes>`);
    expect(text).toContain("response.created");
  });

  it("truncated final ndjson line is not rendered", async () => {
    const first = `{"message":{"role":"assistant","thinking":"t","content":"first-visible"}}`;
    const second = `{"message":{"role":"assistant","content":"done"},"done":true}`;
    const last = `{"message":{"thinking":"NDSENTINEL-7`;
    const wire = [first, second, last].join("\n");
    getMock.mockResolvedValue({
      row: makeRow({
        stream: true,
        notes: [],
        diagnostics: [],
        repairs: [],
      }),
      bodies: {
        source: { value: { model: "m" } },
        canonical: { value: { model: "m", messages: [] } },
        target: [{ value: { model: "m" } }],
        response: { wire: { value: wire } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    expect(text).not.toContain("NDSENTINEL-7");
    const n = new TextEncoder().encode(last).length;
    expect(text).toContain(`<truncated: ${n} bytes>`);
    expect(text).toContain("first-visible");
  });

  it("interior unparseable stream line still renders", async () => {
    const wire = [
      "data: not json",
      `data: {"type":"response.created"}`,
      "data: [DONE]",
    ].join("\n");
    getMock.mockResolvedValue({
      row: makeRow({
        stream: true,
        notes: [],
        diagnostics: [],
        repairs: [],
      }),
      bodies: {
        source: { value: { model: "m" } },
        canonical: { value: { model: "m", messages: [] } },
        target: [{ value: { model: "m" } }],
        response: { wire: { value: wire } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("not json");
    expect(text).toContain("data: [DONE]");
  });

  it("plain strings in bodies render unchanged", async () => {
    getMock.mockResolvedValue({
      row: makeRow({ notes: [], diagnostics: [], repairs: [] }),
      bodies: {
        source: { value: { model: "m" } },
        canonical: { value: { model: "m", messages: [] } },
        target: [
          {
            value: {
              model: "m",
              tools: [
                {
                  type: "function",
                  name: "get_weather",
                  parameters: { type: "object", required: ["city"] },
                },
              ],
              include: ["reasoning.encrypted_content"],
              stop: ["END"],
              input: "hello world",
            },
          },
        ],
        response: { wire: { value: { id: "resp_1" } } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    // Expand every collapsed JsonTree node so every nested and
    // array-element string is painted.
    for (let round = 0; round < 6; round++) {
      const closed = [...container.querySelectorAll(".twisty")].filter(
        (t) => t.textContent?.includes("▸"),
      );
      if (closed.length === 0) break;
      await act(async () => {
        for (const t of closed) {
          t.parentElement!.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          );
        }
      });
    }

    const text = container.textContent ?? "";
    for (const s of [
      "city",
      "reasoning.encrypted_content",
      "END",
      "hello world",
    ]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("<truncated:");
  });

  it("single-line non-stream string snapshot renders unchanged", async () => {
    getMock.mockResolvedValue({
      row: makeRow({ notes: [], diagnostics: [], repairs: [] }),
      bodies: {
        source: { value: { model: "m" } },
        canonical: { value: { model: "m", messages: [] } },
        target: [{ value: { model: "m" } }],
        response: { wire: { value: "Bad Gateway" } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Bad Gateway");
    expect(text).not.toContain("<truncated:");
  });

  it("url image shows host only", async () => {
    getMock.mockResolvedValue({
      row: makeRow({ notes: [], diagnostics: [], repairs: [] }),
      bodies: {
        source: {
          value: {
            model: "m",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: "https://cdn.example.com/pic/secret-path.png?token=abc123",
                    },
                  },
                ],
              },
            ],
          },
        },
        canonical: {
          value: {
            model: "m",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    image: {
                      url: "https://cdn.example.com/pic/secret-path.png?token=abc123",
                      mimeType: "image/png",
                    },
                  },
                ],
              },
            ],
          },
        },
        target: [{ value: { model: "m" } }],
        response: { wire: { value: { id: "r" } } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    for (let round = 0; round < 6; round++) {
      const closed = [...container.querySelectorAll(".twisty")].filter(
        (t) => t.textContent?.includes("▸"),
      );
      if (closed.length === 0) break;
      await act(async () => {
        for (const t of closed) {
          t.parentElement!.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          );
        }
      });
    }

    const text = container.textContent ?? "";
    expect(text).toContain("image (url: cdn.example.com/…)");
    // The path, query and the full URL are content-adjacent: only the
    // host renders (v1.5 §3.2.2 — type, size and URL, never content).
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain("token=abc123");
    expect(text).not.toContain(
      "https://cdn.example.com/pic/secret-path.png",
    );
  });

  it("pdf shows size not bytes", async () => {
    const PDF = "QUJD".repeat(512); // 2048 base64 chars → 1536 bytes → 2 KB
    getMock.mockResolvedValue({
      row: makeRow({ notes: [], diagnostics: [], repairs: [] }),
      bodies: {
        source: {
          value: {
            model: "m",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: "application/pdf",
                      data: PDF,
                    },
                  },
                ],
              },
            ],
          },
        },
        canonical: {
          value: {
            model: "m",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "document",
                    document: {
                      data: PDF,
                      mimeType: "application/pdf",
                      name: "report.pdf",
                    },
                  },
                ],
              },
            ],
          },
        },
        target: [{ value: { model: "m" } }],
        response: { wire: { value: { id: "r" } } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    for (let round = 0; round < 6; round++) {
      const closed = [...container.querySelectorAll(".twisty")].filter(
        (t) => t.textContent?.includes("▸"),
      );
      if (closed.length === 0) break;
      await act(async () => {
        for (const t of closed) {
          t.parentElement!.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          );
        }
      });
    }

    const text = container.textContent ?? "";
    expect(text).toContain("document (application/pdf, report.pdf, 2 KB)");
    expect(text).toContain("document (application/pdf, 2 KB)");
    expect(text).not.toContain("QUJD");
  });

  it("pass-through row shows preset", async () => {
    getMock.mockResolvedValue({
      row: makeRow({
        passthrough: true,
        preset: "ollama-anthropic",
        sourceApi: "anthropic",
        provider: "shim",
        notes: [],
        diagnostics: [],
        repairs: [],
      }),
      bodies: {
        source: { value: { model: "m" } },
        target: [{ value: { model: "upstream-m" } }],
        response: { wire: { value: { id: "r" } } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("pass-through");
    expect(text).toContain("ollama-anthropic");
  });

  it("gap notes listed", async () => {
    getMock.mockResolvedValue({
      row: makeRow({
        passthrough: true,
        notes: [
          {
            stage: "encode",
            adapter: "anthropic",
            code: "tool_choice_dropped",
            path: "tool_choice",
          },
          {
            stage: "encode",
            adapter: "anthropic",
            code: "cache_control_dropped",
            path: "system[0]",
          },
          {
            stage: "encode",
            adapter: "anthropic",
            code: "count_tokens_estimated",
          },
          {
            stage: "encode",
            adapter: "anthropic",
            code: "usage_estimated",
          },
        ],
        diagnostics: [],
        repairs: [],
      }),
      bodies: {
        source: { value: { model: "m" } },
        target: [{ value: { model: "m" } }],
        response: { wire: { value: { id: "r" } } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    const notes = container.querySelector(".inspector-notes");
    expect(notes).not.toBeNull();
    expect(notes!.textContent).toContain("tool_choice_dropped");
    expect(notes!.textContent).toContain("cache_control_dropped");
    expect(notes!.textContent).toContain("count_tokens_estimated");
    expect(notes!.textContent).toContain("usage_estimated");
  });

  it("pass-through badge", async () => {
    getMock.mockResolvedValue({
      row: makeRow({
        passthrough: true,
        sourceApi: "responses",
        notes: [],
        diagnostics: [],
        repairs: [],
      }),
      bodies: {
        source: { value: { model: "m", input: "raw" } },
        // §3.4: no canonical stage — nothing was canonicalized.
        target: [{ value: { model: "upstream-m", input: "raw" } }],
        response: { wire: { value: { id: "resp_1" } } },
      },
    });
    await act(async () => {
      render(<Inspector id="r1" />, container);
    });
    await act(async () => {
      await tick();
    });

    expect(container.textContent).toContain("pass-through");
    const stages = container.querySelectorAll(".stage");
    expect(stages).toHaveLength(3);
    const headings = [...stages].map(
      (s) => s.querySelector("h3")?.textContent ?? "",
    );
    expect(headings[0]).toContain("source");
    expect(headings[1]).toContain("target");
    expect(headings[2]).toContain("response");
  });
});
