import { describe, it, expect } from "vitest";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalTool,
} from "../types/canonical.types";
import { runWithTrace } from "../observe/context";
import { newTrace, type RequestTrace } from "../observe/trace";
import {
  lowerCustomTools,
  raiseCustomCalls,
  createCustomCallTransform,
} from "./custom-tools";

/**
 * v1.4 spec §3.6 + owner decision A: custom tools lower to one-string
 * function tools on non-Responses targets; `{type:"namespace"}` tools
 * ride canonical as a custom tool whose `format.syntax` is
 * "namespace" and flatten to `ns__leaf` function tools.
 */

function traced<T>(fn: () => T): { result: T; trace: RequestTrace } {
  const trace = newTrace({
    requestId: "r1",
    startedAt: 0,
    client: "other",
    sourceApi: "responses",
  });
  const result = runWithTrace(trace, fn);
  return { result, trace };
}

const APPLY_PATCH: CanonicalTool = {
  type: "custom",
  name: "apply_patch",
  description: "Apply a patch",
  format: {
    type: "grammar",
    syntax: "lark",
    definition: "start: patch",
  },
};

/** The canonical carrier a Responses `{type:"namespace"}` tool decodes to. */
const NAMESPACE: CanonicalTool = {
  type: "custom",
  name: "multi_agent_v1",
  description: "Tools for spawning and managing sub-agents.",
  format: {
    type: "grammar",
    syntax: "namespace",
    definition: JSON.stringify([
      {
        type: "function",
        name: "spawn_agent",
        description: "Spawn an agent",
        parameters: { type: "object" },
        strict: false,
      },
      {
        type: "function",
        name: "wait_agent",
        parameters: { type: "object" },
      },
    ]),
  },
};

function req(tools: CanonicalTool[], extra: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools,
    ...extra,
  };
}

describe("lowerCustomTools (spec §3.6)", () => {
  it("custom tool becomes a one-string function", () => {
    const out = lowerCustomTools(req([APPLY_PATCH]));

    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "apply_patch",
          description:
            'Apply a patch\n\nInput format (lark):\n```\nstart: patch\n```',
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          },
        },
      },
    ]);
  });

  it("text format and absent format add no description suffix", () => {
    const out = lowerCustomTools(
      req([
        {
          type: "custom",
          name: "free_text",
          description: "Free text tool",
          format: { type: "text" },
        },
        { type: "custom", name: "bare" },
      ]),
    );

    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "free_text",
          description: "Free text tool",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "bare",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          },
        },
      },
    ]);
  });

  it("custom call history lowers to {input}", () => {
    const out = lowerCustomTools(
      req([APPLY_PATCH], {
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                custom: true,
                function: {
                  name: "apply_patch",
                  arguments: "*** Begin Patch\n@@",
                },
              },
            ],
          },
        ],
      }),
    );

    expect(out.messages[0].toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "apply_patch",
          arguments: JSON.stringify({ input: "*** Begin Patch\n@@" }),
        },
      },
    ]);
  });

  it("function tools pass through untouched", () => {
    const out = lowerCustomTools(
      req([
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ]),
    );
    expect(out.tools).toEqual([
      {
        type: "function",
        function: { name: "get_weather", parameters: { type: "object" } },
      },
    ]);
  });
});

describe("raiseCustomCalls (spec §3.6)", () => {
  function resp(calls: CanonicalResponse["message"]["toolCalls"]): CanonicalResponse {
    return {
      id: "r1",
      model: "m",
      message: {
        role: "assistant",
        content: "",
        toolCalls: calls,
      },
      finishReason: "tool_call",
    };
  }

  it("function call for a custom tool raises to custom", () => {
    const out = raiseCustomCalls(
      resp([
        {
          id: "call_1",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ input: "*** Begin Patch\n@@" }),
          },
        },
      ]),
      req([APPLY_PATCH]),
    );

    expect(out.message.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        custom: true,
        function: {
          name: "apply_patch",
          arguments: "*** Begin Patch\n@@",
        },
      },
    ]);
  });

  it("unparsed custom input kept raw with a note", () => {
    const { result, trace } = traced(() =>
      raiseCustomCalls(
        resp([
          {
            id: "call_1",
            type: "function",
            function: { name: "apply_patch", arguments: '{"n":1}' },
          },
        ]),
        req([APPLY_PATCH]),
      ),
    );

    expect(result.message.toolCalls?.[0]).toMatchObject({
      custom: true,
      function: { arguments: '{"n":1}' },
    });
    expect(
      trace.notes.some((n) => n.code === "custom_input_unparsed"),
    ).toBe(true);
  });

  it("calls for other tools are untouched", () => {
    const out = raiseCustomCalls(
      resp([
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"x"}' },
        },
      ]),
      req([APPLY_PATCH]),
    );
    expect(out.message.toolCalls?.[0].custom).toBeUndefined();
  });
});

describe("createCustomCallTransform (spec §3.6)", () => {
  const start = (index: number, id: string, name: string) =>
    ({
      type: "tool_call_start",
      index,
      id,
      name,
    }) as const;
  const delta = (index: number, argumentsDelta: string) =>
    ({ type: "tool_call_delta", index, argumentsDelta }) as const;
  const end = (index: number) =>
    ({ type: "tool_call_end", index }) as const;

  function feedAll(
    transform: (e: CanonicalStreamEvent) => CanonicalStreamEvent[],
    events: CanonicalStreamEvent[],
  ): CanonicalStreamEvent[] {
    return events.flatMap(transform);
  }

  it("stream transform raises a split {input} across deltas", () => {
    const transform = createCustomCallTransform(req([APPLY_PATCH]));

    const out = feedAll(transform, [
      { type: "message_start", id: "m", model: "m" },
      start(0, "call_1", "apply_patch"),
      delta(0, '{"in'),
      delta(0, 'put":"*** Begin'),
      delta(0, ' Patch"}'),
      end(0),
      { type: "message_end", finishReason: "tool_call" },
    ]);

    expect(out).toEqual([
      { type: "message_start", id: "m", model: "m" },
      {
        type: "tool_call_start",
        index: 0,
        id: "call_1",
        name: "apply_patch",
        custom: true,
      },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: "*** Begin Patch",
      },
      { type: "tool_call_end", index: 0 },
      { type: "message_end", finishReason: "tool_call" },
    ]);
  });

  it("held custom calls are released before a terminal event", () => {
    const transform = createCustomCallTransform(req([APPLY_PATCH]));

    const out = feedAll(transform, [
      start(0, "call_1", "apply_patch"),
      delta(0, '{"input":"raw'),
      {
        type: "error",
        error: { kind: "upstream", status: 502, message: "boom" },
      },
    ]);

    expect(out).toEqual([
      {
        type: "tool_call_start",
        index: 0,
        id: "call_1",
        name: "apply_patch",
        custom: true,
      },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"input":"raw' },
      { type: "tool_call_end", index: 0 },
      {
        type: "error",
        error: { kind: "upstream", status: 502, message: "boom" },
      },
    ]);
  });
});

describe("namespace flattening (owner decision A)", () => {
  it("namespace tools flatten to ns__leaf function tools", () => {
    const out = lowerCustomTools(req([NAMESPACE]));

    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "multi_agent_v1__spawn_agent",
          description:
            "Spawn an agent\n\nNamespace: multi_agent_v1 — Tools for spawning and managing sub-agents.",
          parameters: { type: "object" },
        },
      },
      {
        type: "function",
        function: {
          name: "multi_agent_v1__wait_agent",
          description:
            "Namespace: multi_agent_v1 — Tools for spawning and managing sub-agents.",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  it("flattened name over 64 chars shortens deterministically", () => {
    const long: CanonicalTool = {
      type: "custom",
      name: "a_very_long_namespace_name_that_goes_on",
      format: {
        type: "grammar",
        syntax: "namespace",
        definition: JSON.stringify([
          {
            type: "function",
            name: "an_extremely_long_tool_name_here",
            parameters: { type: "object" },
          },
        ]),
      },
    };

    const out = lowerCustomTools(req([long]));
    const tool = out.tools?.[0];
    expect(tool?.type).toBe("function");
    if (tool?.type !== "function") return;
    expect(tool.function.name.length).toBeLessThanOrEqual(64);
    expect(tool.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // deterministic — lowering the same request twice gives the same name
    const again = lowerCustomTools(req([long]));
    expect(again.tools?.[0]).toEqual(tool);
  });

  it("a flattened name colliding with a top-level function is renamed with a note", () => {
    const collision: CanonicalTool = {
      type: "custom",
      name: "a",
      format: {
        type: "grammar",
        syntax: "namespace",
        definition: JSON.stringify([
          { type: "function", name: "b", parameters: { type: "object" } },
        ]),
      },
    };
    const topLevel: CanonicalTool = {
      type: "function",
      function: { name: "a__b", parameters: { type: "object" } },
    };

    const { result, trace } = traced(() =>
      lowerCustomTools(req([collision, topLevel])),
    );

    const names = result.tools?.map((t) =>
      t.type === "function" ? t.function.name : t.name,
    );
    // the real top-level tool keeps its name; the flattened one is mangled
    expect(names).toContain("a__b");
    const mangled = names?.find(
      (n) => n !== "a__b" && n?.startsWith("a__b"),
    );
    expect(mangled).toBeDefined();
    expect(
      trace.notes.some((n) => n.code === "tool_name_collision"),
    ).toBe(true);
  });
});
