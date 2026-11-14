/**
 * Responses tool codec (v1.4 spec §3.1/§3.6): function, custom and
 * namespace tools and tool_choice to and from canonical. Custom tools
 * pass through natively; `{type:"namespace"}` rides canonical as a
 * `type: "custom"` carrier (`format.syntax === "namespace"`, nested
 * tools JSON in `format.definition`) — the services-side lowering in
 * custom-tools.ts flattens it for non-Responses targets. Built-in
 * tool types parse and drop with `builtin_tool_dropped`.
 * Extracted from responses.adapter.ts (rule 7).
 *
 * Wire-format sources:
 *  - Function tools and `tool_choice` (`auto`/`none`/`required`/
 *    `{type:"function", name}`): https://platform.openai.com/docs/api-reference/responses/create
 *    and `openai` npm 7.30.1 `resources/responses/responses.d.ts`
 *    (`Tool`, `ToolChoiceFunction`, `ToolChoiceOptions`).
 *  - Built-in tool type names in BUILTIN_TOOL_TYPES: the SDK `Tool`
 *    union (the create reference documents the same set under `tools`).
 *  - `namespace` tools: SDK `NamespaceTool`; Codex's `multi_agent_v1`
 *    usage is evidenced by `codex-rs/core/src/client.rs` at Codex
 *    0.169.0 and `tests/fixtures/codex/recording.jsonl` — the API
 *    reference does not document it.
 */
import type {
  CanonicalTool,
  CanonicalToolChoice,
} from "../../types/canonical.types";
import { ValidationError } from "../../utils/errors";
import { recordNote } from "../../observe/context";
import type {
  ResponsesRequest,
  ResponsesTool,
} from "../../types/responses.types";

function note(code: string, path: string, message: string): void {
  recordNote({ stage: "decode", adapter: "responses", code, path }, message);
}

/**
 * Built-in tool types the canonical format cannot honour — parsed,
 * noted and dropped; lowering them is Task 5's job (v1.4 spec §3.6).
 */
const BUILTIN_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "code_interpreter",
  "computer_use",
  "computer_use_preview",
  "image_generation",
  "tool_search",
  "mcp",
  "local_shell",
  "function_shell",
  "apply_patch",
  "programmatic_tool_calling",
]);

// ============ Tools: Responses → Canonical ============

export function toCanonicalTool(
  tool: ResponsesTool,
  index: number,
): CanonicalTool | undefined {
  const t = tool as { type?: string };
  if (t.type === "function") {
    const fn = tool as {
      name?: string;
      description?: string | null;
      parameters?: Record<string, unknown> | null;
      strict?: boolean | null;
    };
    if (fn.strict !== undefined && fn.strict !== null) {
      note(
        "tool_strict_dropped",
        `tools[${index}].strict`,
        'Dropping tool field "strict" (no canonical equivalent)',
      );
    }
    return {
      type: "function",
      function: {
        name: fn.name ?? "",
        ...(typeof fn.description === "string" && {
          description: fn.description,
        }),
        ...(fn.parameters !== undefined &&
          fn.parameters !== null && { parameters: fn.parameters }),
      },
    };
  }
  if (t.type === "custom") {
    // `tools[].type: "custom"` + `format` ({type:"text"} |
    // {type:"grammar", syntax, definition}): the Responses create
    // reference and the openai 7.30.1 SDK `CustomTool` typing.
    const c = tool as {
      name?: string;
      description?: string | null;
      format?: unknown;
    };
    const format = toCanonicalCustomFormat(c.format);
    return {
      type: "custom",
      name: c.name ?? "",
      ...(typeof c.description === "string" && {
        description: c.description,
      }),
      ...(format !== undefined && { format }),
    };
  }
  if (t.type === "namespace") {
    // `{type:"namespace", name, description, tools}` — SDK
    // `NamespaceTool`; Codex's `multi_agent_v1` usage is evidenced by
    // codex-rs/core/src/client.rs at 0.169.0 and the Task 1
    // recording. The carrier rides canonical as a custom tool whose
    // grammar syntax is the literal "namespace" and whose definition
    // is the nested tools array verbatim (Task 5 lowers it for
    // non-Responses targets; a Responses target keeps it native).
    const n = tool as {
      name?: string;
      description?: string | null;
      tools?: unknown;
    };
    return {
      type: "custom",
      name: n.name ?? "",
      ...(typeof n.description === "string" && {
        description: n.description,
      }),
      format: {
        type: "grammar",
        syntax: "namespace",
        definition: JSON.stringify(n.tools ?? []),
      },
    };
  }
  if (typeof t.type === "string" && BUILTIN_TOOL_TYPES.has(t.type)) {
    note(
      "builtin_tool_dropped",
      `tools[${index}]`,
      `Dropping built-in tool of type "${t.type}" (no canonical equivalent)`,
    );
    return undefined;
  }
  throw new ValidationError(
    `Unsupported tool type "${t.type ?? "unknown"}" in tools[]`,
  );
}

/** `format` on a custom tool: `{type:"text"}` or the grammar pair. */
function toCanonicalCustomFormat(
  format: unknown,
): CustomTool["format"] | undefined {
  if (format === undefined || format === null) return undefined;
  const f = format as { type?: unknown; syntax?: unknown; definition?: unknown };
  if (f.type === "text") return { type: "text" };
  if (
    f.type === "grammar" &&
    typeof f.syntax === "string" &&
    typeof f.definition === "string"
  ) {
    return { type: "grammar", syntax: f.syntax, definition: f.definition };
  }
  note(
    "field_dropped",
    "tools[].format",
    'Dropping custom tool "format" (unrecognised shape)',
  );
  return undefined;
}

type CustomTool = Extract<CanonicalTool, { type: "custom" }>;

export function toCanonicalToolChoice(choice: unknown): CanonicalToolChoice {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  const obj = choice as { type?: string; name?: string };
  if (obj?.type === "function" && typeof obj.name === "string") {
    return { type: "function", function: { name: obj.name } };
  }
  // `tool_choice: {type:"custom", name}` selects a custom tool —
  // canonical's named choice is provider-agnostic (the custom tool
  // lowers to a same-named function upstream).
  if (obj?.type === "custom" && typeof obj.name === "string") {
    return { type: "function", function: { name: obj.name } };
  }
  if (typeof choice === "object") {
    // A tool_choice naming a built-in/namespace/other tool — the
    // tool itself is dropped on decode, so the choice degrades to
    // "auto" with a note (spec §3.6).
    note(
      "field_dropped",
      "tool_choice",
      `Dropping tool_choice of type "${obj?.type ?? "unknown"}"; using "auto"`,
    );
    return "auto";
  }
  throw new ValidationError(`Unsupported tool_choice "${String(choice)}"`);
}


// ============ Tools: Canonical → Responses ============

export function toResponsesTool(tool: CanonicalTool): ResponsesTool {
  if (tool.type === "custom") {
    // The namespace carrier re-encodes natively
    // (`format.syntax === "namespace"`); every other custom tool
    // re-encodes as `type: "custom"`.
    if (
      tool.format?.type === "grammar" &&
      tool.format.syntax === "namespace"
    ) {
      let nested: unknown = [];
      try {
        nested = JSON.parse(tool.format.definition);
      } catch {
        // A carrier the decode side never produced — emit an empty
        // namespace rather than malformed JSON.
      }
      return {
        type: "namespace",
        name: tool.name,
        ...(tool.description !== undefined && {
          description: tool.description,
        }),
        tools: nested,
      } as unknown as ResponsesTool;
    }
    return {
      type: "custom",
      name: tool.name,
      ...(tool.description !== undefined && {
        description: tool.description,
      }),
      ...(tool.format !== undefined && { format: tool.format }),
    } as unknown as ResponsesTool;
  }
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: tool.function.parameters ?? null,
    strict: null,
  };
}

export function toResponsesToolChoice(
  choice: CanonicalToolChoice,
): ResponsesRequest["tool_choice"] {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  return { type: "function", name: choice.function.name };
}

