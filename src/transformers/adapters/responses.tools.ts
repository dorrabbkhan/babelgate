/**
 * Responses tool codec (v1.4 spec §3.1/§3.6): function tools and
 * tool_choice to and from canonical. Built-in and namespace tool
 * types parse and drop with notes — lowering them arrives in Task 5.
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
  if (t.type === "namespace" || t.type === "custom") {
    // Owner decision A: the Codex fallback shape is accepted and
    // parsed — lowering namespaced/custom tools is Task 5's job.
    note(
      "field_dropped",
      `tools[${index}]`,
      `Dropping tool of type "${t.type}" (lowering arrives in Task 5)`,
    );
    return undefined;
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

export function toCanonicalToolChoice(choice: unknown): CanonicalToolChoice {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  const obj = choice as { type?: string; name?: string };
  if (obj?.type === "function" && typeof obj.name === "string") {
    return { type: "function", function: { name: obj.name } };
  }
  if (typeof choice === "object") {
    // A tool_choice naming a built-in/other tool — Task 5 refines.
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
  if (tool.type !== "function") {
    // Custom tools arrive in Task 5.
    throw new ValidationError(`Unsupported tool type "${tool.type}"`);
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

