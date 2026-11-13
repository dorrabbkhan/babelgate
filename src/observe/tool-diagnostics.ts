import type {
  CanonicalTool,
  CanonicalToolCall,
} from "../types/canonical.types";
import type { ToolCallDiagnostic, ToolCallRepair } from "./trace";

/**
 * §3.7 tool-call diagnostics and the three opt-in argument repairs.
 * Diagnostics are computed on the ORIGINAL arguments and carry codes
 * and schema property names only — never argument text (privacy).
 * Repair applies the spec's three steps, in order, and only when the
 * result parses to an object; names and fields are never changed.
 */

type ArgumentCode = Extract<
  ToolCallDiagnostic["code"],
  "invalid_json" | "fenced_json" | "not_object"
>;

/** Inner text of one surrounding markdown fence; undefined when none. */
function stripFence(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith("```") || !t.endsWith("```") || t.length < 6) {
    return undefined;
  }
  const nl = t.indexOf("\n");
  if (nl === -1) return undefined;
  // The info string after ``` is a bare language tag, nothing else.
  if (/\s/.test(t.slice(3, nl).trim())) return undefined;
  const inner = t.slice(nl + 1, t.length - 3).trim();
  return inner === "" ? undefined : inner;
}

/**
 * The single balanced top-level `{…}` in `text`; undefined when there
 * is none or more than one. Braces inside "…" strings are ignored.
 */
function extractSingleObject(text: string): string | undefined {
  let start = -1;
  let end = -1;
  let depth = 0;
  let count = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        end = i;
        count++;
      }
    }
  }
  if (count !== 1 || depth !== 0) return undefined;
  return text.slice(start, end + 1);
}

/** Drop commas that sit directly before a } or ], outside strings. */
function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === "}" || text[j] === "]")) {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * The §3.7 argument-shape code for one call's arguments (undefined =
 * parses to an object; the empty string is the providers' "no args",
 * equivalent to {}). Fenced beats invalid only when the inner text is
 * real JSON — a fence around non-JSON is just invalid.
 */
export function diagnoseArguments(args: string): ArgumentCode | undefined {
  if (args.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return "not_object";
    }
    return undefined;
  } catch {
    const inner = stripFence(args);
    if (inner !== undefined) {
      try {
        JSON.parse(inner);
        return "fenced_json";
      } catch {
        // fenced, but not JSON inside — plain invalid
      }
    }
    return "invalid_json";
  }
}

/** `parameters.required` as a list of property names. */
function requiredProps(
  parameters: Record<string, unknown> | undefined,
): string[] {
  const required = parameters?.required;
  if (!Array.isArray(required)) return [];
  return required.filter((p): p is string => typeof p === "string");
}

/**
 * §3.7: diagnose every call's arguments and name against the
 * request's tools — argument-shape code first, then `unknown_tool`,
 * then one `missing_required` per absent required property (only when
 * the arguments parsed and the tool was declared).
 */
export function diagnoseToolCalls(
  calls: CanonicalToolCall[],
  tools: CanonicalTool[] | undefined,
): ToolCallDiagnostic[] {
  const byName = new Map(
    (tools ?? []).map(
      (t) => [t.type === "function" ? t.function.name : t.name, t] as const,
    ),
  );
  const out: ToolCallDiagnostic[] = [];
  for (const call of calls) {
    const { id, name } = { id: call.id, name: call.function.name };
    const argCode = diagnoseArguments(call.function.arguments);
    if (argCode !== undefined) {
      out.push({ toolCallId: id, name, code: argCode });
    }
    const tool = byName.get(name);
    if (tool === undefined) {
      out.push({ toolCallId: id, name, code: "unknown_tool" });
      continue;
    }
    if (argCode !== undefined || tool.type !== "function") continue;
    const parsed = JSON.parse(
      call.function.arguments.trim() === ""
        ? "{}"
        : call.function.arguments,
    ) as Record<string, unknown>;
    for (const prop of requiredProps(tool.function.parameters)) {
      if (!(prop in parsed)) {
        out.push({
          toolCallId: id,
          name,
          code: "missing_required",
          detail: prop,
        });
      }
    }
  }
  return out;
}

/**
 * §3.7 repair: apply the three steps in order — strip one surrounding
 * markdown fence, keep the single balanced top-level {…}, remove
 * trailing commas — and return the repaired string plus the steps
 * applied. Input that already parses is never touched (undefined);
 * a result that still isn't a JSON object is undefined too — partial
 * repairs are never shipped.
 */
export function repairArguments(
  args: string,
): { args: string; steps: ToolCallRepair["steps"] } | undefined {
  try {
    JSON.parse(args);
    return undefined;
  } catch {
    // repairs exist for text that does not parse
  }

  const steps: ToolCallRepair["steps"] = [];
  let text = args.trim();

  const unfenced = stripFence(text);
  if (unfenced !== undefined) {
    text = unfenced;
    steps.push("strip_fence");
  }

  const extracted = extractSingleObject(text);
  if (extracted !== undefined && extracted !== text) {
    text = extracted;
    steps.push("extract_object");
  }

  const decommaed = removeTrailingCommas(text);
  if (decommaed !== text) {
    text = decommaed;
    steps.push("trailing_comma");
  }

  if (steps.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return { args: text, steps };
    }
  } catch {
    // fall through
  }
  return undefined;
}
