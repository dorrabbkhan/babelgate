/**
 * Custom-tool and namespace-tool lowering/raising (v1.4 spec §3.6,
 * owner decision A). Lives in the services, not the adapters: the
 * four existing providers see only function tools.
 *
 * - A `type: "custom"` tool lowers to a one-string function tool
 *   (`input` parameter; the grammar rides the description) and its
 *   calls unwrap `{input: <raw>}` back to a `custom: true` call.
 * - A `{type:"namespace"}` Responses tool rides canonical as a
 *   `type: "custom"` carrier (`format.syntax === "namespace"`, the
 *   nested function tools JSON in `format.definition`). Its leaves
 *   flatten to `ns__leaf` function tools — a separator/charset every
 *   provider's name rule accepts (OpenAI `^[a-zA-Z0-9_-]{1,64}$`,
 *   Gemini the same, Anthropic `^[a-zA-Z0-9_-]{1,128}$`, Ollama
 *   unrestricted) — and calls flatten back the same way. On the way
 *   out, only names THIS request's lowering produced are raised back
 *   to `{name: leaf, namespace: ns}` — never guessed from a name
 *   string (owner decision).
 * - Names over 64 chars (the shortest limit) shorten to
 *   `<prefix>-<hash>` deterministically; a flattened name colliding
 *   with an existing top-level tool gets a `__N` suffix and a
 *   `tool_name_collision` note.
 *
 * Wire-format sources: Responses `tools[].type: "custom"` + `format`,
 * `custom_tool_call`, `custom_tool_call{namespace}` and the
 * `namespace` tool —
 * https://platform.openai.com/docs/api-reference/responses/create and
 * `codex-rs/core/src/client.rs` + `tools/router.rs` at Codex 0.169.0
 * (tests/fixtures/codex/recording.jsonl).
 */
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalTool,
  CanonicalToolCall,
} from "../types/canonical.types";
import type { Provider } from "./adapters";
import { recordNote } from "../observe/context";

const NS_SEP = "__";
/** Shortest provider tool-name limit (OpenAI/Gemini); charset is theirs. */
const MAX_TOOL_NAME = 64;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export type CustomTool = Extract<CanonicalTool, { type: "custom" }>;

function note(code: string, adapter: Provider, path: string, message: string): void {
  recordNote({ stage: "encode", adapter, code, path }, message);
}

export function isNamespaceCarrier(
  tool: CanonicalTool,
): tool is CustomTool & {
  format: { type: "grammar"; syntax: "namespace"; definition: string };
} {
  return (
    tool.type === "custom" &&
    tool.format?.type === "grammar" &&
    tool.format.syntax === "namespace" &&
    typeof tool.format.definition === "string"
  );
}

interface NamespaceLeaf {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** The nested function tools a namespace carrier's definition holds
 *  (exported for tool-call diagnostics' name/schema lookup). */
export function namespaceLeafTools(
  tool: CustomTool,
): NamespaceLeaf[] | undefined {
  if (tool.format?.type !== "grammar") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tool.format.definition);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const leaves: NamespaceLeaf[] = [];
  for (const leaf of parsed) {
    const l = leaf as { name?: unknown };
    if (typeof l?.name !== "string") return undefined;
    leaves.push({
      name: l.name,
      ...(typeof (leaf as { description?: unknown }).description ===
        "string" && {
        description: (leaf as { description: string }).description,
      }),
      ...((leaf as { parameters?: unknown }).parameters !==
        undefined &&
        (leaf as { parameters?: unknown }).parameters !== null && {
          parameters: (leaf as { parameters: Record<string, unknown> })
            .parameters,
        }),
    });
  }
  return leaves;
}

/** 8-hex-char FNV-1a — deterministic, stable across runs. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * `ns__leaf` as a provider-safe name: sanitized to
 * `[a-zA-Z0-9_-]`, and `prefix-<8 hex hash>` when over 64 chars —
 * deterministic (same inputs, same name) and still injective enough:
 * the hash covers the whole name.
 */
export function flatToolName(ns: string, leaf: string): string {
  const raw = `${ns}${NS_SEP}${leaf}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe.length <= MAX_TOOL_NAME) return safe;
  const hash = shortHash(safe);
  return `${safe.slice(0, MAX_TOOL_NAME - hash.length - 1)}-${hash}`;
}

/** Produced flat name → the (ns, leaf) pair lowering made it from. */
export type FlatMap = Map<string, { ns: string; leaf: string }>;
/** (ns, leaf) → produced flat name — for lowering call history. */
export type ForwardMap = Map<string, string>;

const forwardKey = (ns: string, leaf: string): string => `${ns}${leaf}`;

/**
 * The names every lowered tool will take on output: all top-level
 * function names and every custom tool's name (custom tools lower to
 * same-named functions). Namespace flats are chosen against this set,
 * so replaying the flatten in the same order reproduces the names.
 */
function reservedNames(tools: CanonicalTool[] | undefined): Set<string> {
  const reserved = new Set<string>();
  for (const t of tools ?? []) {
    reserved.add(t.type === "function" ? t.function.name : t.name);
  }
  return reserved;
}

/**
 * One namespace carrier → its flattened function tools and the
 * flat-name map. `reserved` is the running set of taken output names;
 * collisions get a `__N` suffix (recorded by the caller via `notes`).
 */
function flattenCarrier(
  carrier: CustomTool,
  reserved: Set<string>,
  adapter: Provider,
  path: string,
  silent = false,
): { tools: CanonicalTool[]; entries: [string, { ns: string; leaf: string }][] } {
  const leaves = namespaceLeafTools(carrier);
  if (leaves === undefined) return { tools: [], entries: [] };
  const suffix = `Namespace: ${carrier.name}${
    carrier.description !== undefined ? ` — ${carrier.description}` : ""
  }`;
  const tools: CanonicalTool[] = [];
  const entries: [string, { ns: string; leaf: string }][] = [];
  for (const leaf of leaves) {
    let flat = flatToolName(carrier.name, leaf.name);
    if (reserved.has(flat)) {
      const base = flat;
      for (let n = 1; reserved.has(flat); n++) {
        flat = `${base}${NS_SEP}${n}`;
        if (flat.length > MAX_TOOL_NAME) {
          flat = `${base.slice(0, MAX_TOOL_NAME - String(n).length - 2)}${NS_SEP}${n}`;
        }
      }
      if (!silent) {
        note(
          "tool_name_collision",
          adapter,
          path,
          `Flattened tool name "${base}" collides with an existing tool; renamed "${flat}"`,
        );
      }
    }
    reserved.add(flat);
    entries.push([flat, { ns: carrier.name, leaf: leaf.name }]);
    tools.push({
      type: "function",
      function: {
        name: flat,
        description:
          leaf.description !== undefined
            ? `${leaf.description}\n\n${suffix}`
            : suffix,
        ...(leaf.parameters !== undefined && {
          parameters: leaf.parameters,
        }),
      },
    });
  }
  return { tools, entries };
}

/** Lowered name maps for a request's tools — shared by raise paths. */
function buildMaps(tools: CanonicalTool[] | undefined): {
  customNames: Set<string>;
  flatMap: FlatMap;
  forwardMap: ForwardMap;
} {
  const customNames = new Set<string>();
  const flatMap: FlatMap = new Map();
  const forwardMap: ForwardMap = new Map();
  const reserved = reservedNames(tools);
  for (const t of tools ?? []) {
    if (t.type !== "custom") continue;
    if (!isNamespaceCarrier(t)) {
      customNames.add(t.name);
      continue;
    }
    // Replay flattening silently — the notes were emitted by
    // lowerCustomTools; names are deterministic, so the maps match.
    for (const [flat, pair] of flattenCarrier(t, reserved, "responses", "tools", true).entries) {
      flatMap.set(flat, pair);
      forwardMap.set(forwardKey(pair.ns, pair.leaf), flat);
    }
  }
  return { customNames, flatMap, forwardMap };
}

/** `type: "custom"` (non-namespace) → one-string-parameter function. */
function lowerCustomTool(tool: CustomTool): CanonicalTool {
  const grammar =
    tool.format?.type === "grammar"
      ? `Input format (${tool.format.syntax}):\n\`\`\`\n${tool.format.definition}\n\`\`\``
      : undefined;
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined || grammar !== undefined
        ? {
            description: [tool.description, grammar]
              .filter((d): d is string => d !== undefined)
              .join("\n\n"),
          }
        : {}),
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    },
    ...(tool.cache !== undefined && { cache: tool.cache }),
  };
}

/**
 * §3.6 lowering for non-Responses targets (called by
 * canonicalForTarget on a copy — the decoded request is never
 * mutated): custom tools → one-string functions, namespace carriers
 * → `ns__leaf` functions, custom-call history → `{input}` arguments,
 * namespaced call history → the produced flat name.
 */
export function lowerCustomTools(
  request: CanonicalRequest,
  adapter: Provider = "responses",
): CanonicalRequest {
  const tools = request.tools ?? [];
  const hasWork =
    tools.some((t) => t.type === "custom") ||
    request.messages.some((m) =>
      m.toolCalls?.some((c) => c.custom === true || c.function.namespace !== undefined),
    );
  if (!hasWork) return request;

  const reserved = reservedNames(tools);
  const forwardMap: ForwardMap = new Map();
  const loweredTools: CanonicalTool[] = [];
  for (const [i, t] of tools.entries()) {
    if (t.type !== "custom") {
      loweredTools.push(t);
      continue;
    }
    if (!isNamespaceCarrier(t)) {
      loweredTools.push(lowerCustomTool(t));
      continue;
    }
    const flat = flattenCarrier(t, reserved, adapter, `tools[${i}]`);
    if (flat.tools.length === 0) {
      // A carrier with an unparsable definition lowers like an
      // ordinary custom tool — still callable, never silently lost.
      loweredTools.push(lowerCustomTool(t));
      continue;
    }
    for (const [name, pair] of flat.entries) {
      forwardMap.set(forwardKey(pair.ns, pair.leaf), name);
    }
    loweredTools.push(...flat.tools);
  }

  const messages = request.messages.map((m) => {
    if (!m.toolCalls?.some((c) => c.custom === true || c.function.namespace !== undefined)) {
      return m;
    }
    return {
      ...m,
      toolCalls: m.toolCalls.map(lowerCallHistory(forwardMap)),
    };
  });

  return { ...request, messages, tools: loweredTools };
}

const lowerCallHistory =
  (forwardMap: ForwardMap) =>
  (call: CanonicalToolCall): CanonicalToolCall => {
    if (call.custom === true) {
      const { custom: _custom, ...rest } = call;
      return {
        ...rest,
        function: {
          name: call.function.name,
          arguments: JSON.stringify({ input: call.function.arguments }),
        },
      };
    }
    if (call.function.namespace !== undefined) {
      const flat =
        forwardMap.get(
          forwardKey(call.function.namespace, call.function.name),
        ) ?? flatToolName(call.function.namespace, call.function.name);
      return {
        ...call,
        function: {
          name: flat,
          arguments: call.function.arguments,
        },
      };
    }
    return call;
  };

/**
 * Raise one lowered call back to the client-facing form, using only
 * the maps THIS request's tools produce: `ns__leaf` →
 * `{name: leaf, namespace: ns}`; a custom tool's name →
 * `custom: true` with `arguments` unwrapped from `{input}` (kept raw
 * with a `custom_input_unparsed` note when it isn't that shape — raw
 * input is never mangled).
 */
export function raiseCall(
  call: CanonicalToolCall,
  customNames: Set<string>,
  flatMap: FlatMap,
  adapter: Provider,
  path: string,
): CanonicalToolCall {
  if (call.custom === true || call.function.namespace !== undefined) {
    return call;
  }
  const pair = flatMap.get(call.function.name);
  if (pair !== undefined) {
    return {
      ...call,
      function: {
        name: pair.leaf,
        namespace: pair.ns,
        arguments: call.function.arguments,
      },
    };
  }
  if (!customNames.has(call.function.name)) return call;

  let input: string | undefined;
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { input?: unknown }).input === "string"
    ) {
      input = (parsed as { input: string }).input;
    }
  } catch {
    // raw, unparsed — kept as-is below
  }
  if (input === undefined) {
    note(
      "custom_input_unparsed",
      adapter,
      path,
      `Custom call "${call.function.name}" returned arguments that were not a {"input": string} object; passing them through raw`,
    );
  }
  return {
    ...call,
    custom: true,
    function: {
      name: call.function.name,
      arguments: input ?? call.function.arguments,
    },
  };
}

/**
 * §3.6: the unary half of raising — applied to the decoded upstream
 * response before the source encode. Calls the target never lowered
 * (names absent from the maps) pass through untouched.
 */
export function raiseCustomCalls(
  response: CanonicalResponse,
  source: CanonicalRequest,
  adapter: Provider = "responses",
): CanonicalResponse {
  const calls = response.message.toolCalls;
  if (calls === undefined || calls.length === 0) return response;
  const { customNames, flatMap } = buildMaps(source.tools);
  if (customNames.size === 0 && flatMap.size === 0) return response;
  return {
    ...response,
    message: {
      ...response.message,
      toolCalls: calls.map((call, i) =>
        raiseCall(
          call,
          customNames,
          flatMap,
          adapter,
          `message.toolCalls[${i}]`,
        ),
      ),
    },
  };
}

/**
 * §3.6: the streaming half — sits between the target decoder and the
 * generic repair transform (a custom call's raw input must never be
 * parsed as JSON). A call whose name the lowering produced comes
 * back raised on its `tool_call_start`; a custom call's `{input}`
 * wrapper is buffered and replaced by one delta of the raw input at
 * `tool_call_end` — released unrepaired when the stream ends
 * mid-call, before the terminal event.
 */
export function createCustomCallTransform(
  source: CanonicalRequest,
  adapter: Provider = "responses",
): (event: CanonicalStreamEvent) => CanonicalStreamEvent[] {
  const { customNames, flatMap } = buildMaps(source.tools);
  const held = new Map<number, string[]>();

  function flushHeld(out: CanonicalStreamEvent[]): void {
    for (const index of [...held.keys()].sort((a, b) => a - b)) {
      for (const d of held.get(index) ?? []) {
        out.push({ type: "tool_call_delta", index, argumentsDelta: d });
      }
      out.push({ type: "tool_call_end", index });
    }
    held.clear();
  }

  return (event) => {
    switch (event.type) {
      case "tool_call_start": {
        const pair = flatMap.get(event.name);
        if (pair !== undefined) {
          return [
            { ...event, name: pair.leaf, namespace: pair.ns },
          ];
        }
        if (customNames.has(event.name)) {
          held.set(event.index, []);
          return [{ ...event, custom: true }];
        }
        return [event];
      }
      case "tool_call_delta": {
        const deltas = held.get(event.index);
        if (deltas === undefined) return [event];
        deltas.push(event.argumentsDelta);
        return [];
      }
      case "tool_call_end": {
        const deltas = held.get(event.index);
        if (deltas === undefined) return [event];
        held.delete(event.index);
        const joined = deltas.join("");
        let input: string | undefined;
        try {
          const parsed: unknown = JSON.parse(joined);
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            typeof (parsed as { input?: unknown }).input === "string"
          ) {
            input = (parsed as { input: string }).input;
          }
        } catch {
          // kept raw below
        }
        if (input === undefined) {
          note(
            "custom_input_unparsed",
            adapter,
            `tool_call[${event.index}]`,
            'A custom call\'s arguments were not a {"input": string} object; passing them through raw',
          );
          return [
            ...deltas.map(
              (d): CanonicalStreamEvent => ({
                type: "tool_call_delta",
                index: event.index,
                argumentsDelta: d,
              }),
            ),
            event,
          ];
        }
        return [
          {
            type: "tool_call_delta",
            index: event.index,
            argumentsDelta: input,
          },
          event,
        ];
      }
      case "message_end":
      case "error": {
        if (held.size === 0) return [event];
        const out: CanonicalStreamEvent[] = [];
        flushHeld(out);
        out.push(event);
        return out;
      }
      default:
        return [event];
    }
  };
}
