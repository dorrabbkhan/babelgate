/**
 * Ollama tool mapping (spec §3.4), used only by ollama.adapter.ts:
 * `tools[]` ↔ canonical tools, `message.tool_calls` ↔ canonical
 * toolCalls, and `tool_name` ↔ canonical toolCallId.
 *
 * Wire tool calls may carry `id` and `function.index` (recorded
 * Ollama 0.40.11 responses do) which the SDK type omits — hence
 * OllamaWireToolCall. Tool results carry only `tool_name` on the
 * wire (docs.ollama.com api.md "Chat request (With history, with
 * tools)"): on decode each is paired with the earliest unconsumed
 * earlier call of that name (a FIFO queue per name, because
 * parallel calls to the same function are legal); on encode the
 * name is looked up by canonical `toolCallId`, resolving only
 * against assistant calls that precede the tool message.
 */
import type {
  CanonicalTool,
  CanonicalToolCall,
  IdGenerator,
} from "../../types/canonical.types";
import type { OllamaChatRequest } from "../../types/ollama.types";
import { ValidationError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { parseToolArguments } from "../../utils/tool-args";

/** Ollama wire tool call: the SDK type omits `id`/`function.index`,
 * which recorded Ollama 0.40.11 responses carry. */
export interface OllamaWireToolCall {
  id?: string;
  function?: {
    index?: number;
    name?: string;
    arguments?: unknown;
  };
}

// ============ DECODE: Ollama → Canonical ============

export function toCanonicalToolCalls(
  toolCalls: OllamaWireToolCall[],
  ids: IdGenerator,
): CanonicalToolCall[] {
  return toolCalls.map((tc) => {
    const args = tc?.function?.arguments;
    return {
      id: typeof tc?.id === "string" ? tc.id : ids(),
      type: "function" as const,
      function: {
        name: tc?.function?.name ?? "",
        // `arguments` is normally an object (JSON.stringify it); a
        // string is already the JSON encoding and passes through
        // verbatim — same rule as the stream decoder.
        arguments:
          typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    };
  });
}

/** Ollama `tools[]` → canonical tools; any non-`function` type →
 * ValidationError naming it rather than a silent drop. */
export function toCanonicalTools(
  tools: NonNullable<OllamaChatRequest["tools"]>,
): CanonicalTool[] {
  return tools.map((t) => {
    if (t.type !== "function") {
      throw new ValidationError(
        `Unsupported Ollama tool type "${String(t.type)}"`,
      );
    }
    return {
      type: "function" as const,
      function: {
        name: t.function?.name ?? "",
        ...(t.function?.description !== undefined && {
          description: t.function.description,
        }),
        ...(t.function?.parameters !== undefined && {
          parameters: t.function.parameters as Record<string, unknown>,
        }),
      },
    };
  });
}

/**
 * Function name → pending call ids, in order of appearance. A queue
 * per name is required because parallel calls to the same function
 * are legal and each result must get its own call's id.
 */
export type PendingCallIds = Map<string, string[]>;

export function recordCallId(
  pending: PendingCallIds,
  name: string,
  id: string,
): void {
  const queue = pending.get(name);
  if (queue) {
    queue.push(id);
  } else {
    pending.set(name, [id]);
  }
}

/** Consume the oldest pending call id for `tool_name`. */
export function resolveCallId(
  pending: PendingCallIds,
  name: string,
): string | undefined {
  return pending.get(name)?.shift();
}

// ============ ENCODE: Canonical → Ollama ============

export function toOllamaToolCalls(
  toolCalls: CanonicalToolCall[],
): OllamaWireToolCall[] {
  return toolCalls.map((tc, index) => {
    const parsed = parseToolArguments(tc.function.arguments);
    if (!parsed.valid) {
      logger.warn(
        "Tool call arguments are not valid JSON; sending _invalid_arguments wrapper",
      );
    }
    return {
      id: tc.id,
      function: {
        index,
        name: tc.function.name,
        arguments: parsed.args,
      },
    };
  });
}

/** Canonical tools → Ollama `tools[]` (definitions pass through). */
export function toOllamaTools(
  tools: CanonicalTool[] | undefined,
): OllamaChatRequest["tools"] {
  if (!tools?.length) return undefined;
  return tools.map((t) => {
    if (t.type !== "function") {
      // Custom tools are lowered to function tools by
      // canonicalForTarget before encode (v1.4 spec §3.6).
      throw new ValidationError(
        `Unsupported tool type "${t.type}" in tools[]`,
      );
    }
    return {
      type: "function",
      function: {
        name: t.function.name,
        ...(t.function.description !== undefined && {
          description: t.function.description,
        }),
        ...(t.function.parameters !== undefined && {
          parameters: t.function.parameters as NonNullable<
            OllamaChatRequest["tools"]
          >[number]["function"]["parameters"],
        }),
      },
    };
  });
}

/** Canonical call id → Ollama tool name, built by the adapter while
 * it walks the messages in order — a tool message resolves only
 * against assistant calls that precede it. */
export type CallNameById = Map<string, string>;

/** The `tool_name` for a canonical tool message: the name of the
 * matching earlier assistant call, else a ValidationError naming
 * the id only (Ollama carries names, not call ids). */
export function resolveToolName(
  callNameById: CallNameById,
  toolCallId: string | undefined,
): string {
  const name =
    toolCallId !== undefined ? callNameById.get(toolCallId) : undefined;
  if (name === undefined) {
    throw new ValidationError(
      `Ollama tool message has no matching tool call for tool_call_id "${
        toolCallId ?? ""
      }"`,
    );
  }
  return name;
}
