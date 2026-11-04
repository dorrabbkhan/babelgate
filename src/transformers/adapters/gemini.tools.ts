/**
 * Gemini tool mapping (spec §3.4), used only by gemini.adapter.ts:
 * `functionDeclarations` ↔ canonical tools, `functionCallingConfig` ↔
 * canonical toolChoice, `functionCall` parts ↔ canonical toolCalls and
 * `functionResponse` parts ↔ canonical tool messages.
 *
 * `functionCall.id` / `functionResponse.id` are optional on the wire.
 * When a response carries no id it is matched to a pending call by
 * name, oldest first (a FIFO queue per name, because parallel calls to
 * the same function are legal); a wire `functionResponse.id` wins when
 * present.
 */
import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalToolChoice,
  IdGenerator,
} from "../../types/canonical.types";
import type {
  Content,
  FunctionCallPart,
  FunctionDeclaration,
  FunctionResponsePart,
  GenerateContentRequest,
  GeminiFunctionCall,
  GeminiFunctionCallPart,
  GeminiFunctionResponse,
  GeminiToolConfig,
  Part,
  ToolConfig,
} from "../../types/gemini.types";
import { ValidationError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { parseToolArguments } from "../../utils/tool-args";
import { toGeminiSchema } from "./gemini.schema";

export function isFunctionCallPart(part: Part): part is FunctionCallPart {
  return "functionCall" in part && part.functionCall != null;
}

export function isFunctionResponsePart(
  part: Part,
): part is FunctionResponsePart {
  return "functionResponse" in part && part.functionResponse != null;
}

// ============ DECODE: Gemini → Canonical ============

/**
 * Function name → pending call ids, in order of appearance. A queue per
 * name is required because parallel calls to the same function are legal
 * and each response must get its own call's id.
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

/**
 * Resolve the call id for a functionResponse: a wire `id` wins (and is
 * consumed so it cannot match twice); otherwise the oldest pending call
 * id for that name.
 */
export function resolveCallId(
  pending: PendingCallIds,
  res: GeminiFunctionResponse,
): string | undefined {
  const queue = pending.get(res.name) ?? [];
  if (res.id !== undefined) {
    const i = queue.indexOf(res.id);
    if (i !== -1) queue.splice(i, 1);
    return res.id;
  }
  return queue.shift();
}

/** Gemini functionCall parts → canonical toolCalls (wire id or generated). */
export function toCanonicalToolCalls(
  parts: Part[],
  ids: IdGenerator,
): CanonicalToolCall[] {
  return parts.filter(isFunctionCallPart).map(
    (part): CanonicalToolCall => {
      const call = part.functionCall as GeminiFunctionCall;
      return {
        id: call.id ?? ids(),
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        },
      };
    },
  );
}

/** Gemini functionResponse parts → canonical tool messages. */
export function toCanonicalToolMessages(
  parts: Part[],
  pending: PendingCallIds,
): CanonicalMessage[] {
  return parts.filter(isFunctionResponsePart).map(
    (part): CanonicalMessage => {
      const res = part.functionResponse as GeminiFunctionResponse;
      const toolCallId = resolveCallId(pending, res);
      if (!toolCallId) {
        throw new ValidationError(
          `Function response "${res.name}" has no matching function call in this request`,
        );
      }
      return {
        role: "tool",
        toolCallId,
        content: functionResponseContent(res),
      };
    },
  );
}

/**
 * Gemini `tools[]` → canonical tools. Only `functionDeclarations`
 * entries have a canonical equivalent; any other tool type
 * (`codeExecution`, `googleSearch`, `googleSearchRetrieval`, …) →
 * ValidationError naming the key.
 */
export function toCanonicalTools(
  tools: GenerateContentRequest["tools"],
): CanonicalTool[] | undefined {
  const declarations: FunctionDeclaration[] = [];
  for (const tool of tools ?? []) {
    for (const key of Object.keys(tool)) {
      if (key !== "functionDeclarations") {
        throw new ValidationError(
          `Gemini tool type "${key}" is not supported`,
        );
      }
    }
    if ("functionDeclarations" in tool) {
      declarations.push(...(tool.functionDeclarations ?? []));
    }
  }
  if (declarations.length === 0) return undefined;
  return declarations.map((decl) => {
    // Gemini CLI sends parametersJsonSchema (full JSON Schema) rather
    // than parameters (the documented subset) — evidence E11. The
    // documented field wins when both are present, matching what the
    // encoder writes back.
    const parameters = (decl.parameters ??
      (decl as { parametersJsonSchema?: unknown })
        .parametersJsonSchema) as Record<string, unknown> | undefined;
    return {
      type: "function" as const,
      function: {
        name: decl.name,
        ...(decl.description !== undefined && {
          description: decl.description,
        }),
        ...(parameters !== undefined && { parameters }),
      },
    };
  });
}

/** Gemini `toolConfig.functionCallingConfig` → canonical toolChoice. */
export function toCanonicalToolChoice(
  toolConfig: GeminiToolConfig | undefined,
): CanonicalToolChoice | undefined {
  const fcc = toolConfig?.functionCallingConfig;
  if (fcc?.mode === undefined) return undefined;
  switch (fcc.mode) {
    case "AUTO":
    case "MODE_UNSPECIFIED":
      return "auto";
    case "NONE":
      return "none";
    case "ANY": {
      const names = fcc.allowedFunctionNames ?? [];
      if (names.length === 0) {
        return "required";
      }
      if (names.length === 1) {
        return {
          type: "function",
          function: { name: names[0] },
        };
      }
      throw new ValidationError(
        "Gemini functionCallingConfig with multiple allowedFunctionNames has no canonical equivalent",
      );
    }
    default:
      throw new ValidationError(
        `Gemini functionCallingConfig mode "${fcc.mode}" is not supported`,
      );
  }
}

/** Gemini functionResponse → canonical tool-message content string. */
export function functionResponseContent(
  res: GeminiFunctionResponse,
): string {
  const response = res.response;
  if (
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response)
  ) {
    const keys = Object.keys(response);
    // Unwrap the { "content": "<string>" } wrapper this adapter emits
    if (
      keys.length === 1 &&
      typeof response.content === "string"
    ) {
      return response.content;
    }
    return JSON.stringify(response);
  }
  return JSON.stringify(response ?? {});
}

// ============ ENCODE: Canonical → Gemini ============

/**
 * Canonical tool call → Gemini functionCall part. `functionCall.id`
 * is a documented optional field: the request encoder drops it
 * (default — requests stay byte-identical), while the response
 * encoder passes `includeId` so the client can echo
 * `functionResponse.id` back, matching the stream encoder's shape.
 * `thoughtSignature` sets the part-level sibling — only the request
 * encoder passes it (the `skip_thought_signature_validator`
 * placeholder; responses and streams keep the wire signatures out).
 */
export function functionCallPart(
  call: CanonicalToolCall,
  opts: { includeId?: boolean; thoughtSignature?: string } = {},
): GeminiFunctionCallPart {
  const parsed = parseToolArguments(call.function.arguments);
  if (!parsed.valid) {
    logger.warn(
      "Tool call arguments are not valid JSON; sending _invalid_arguments wrapper",
    );
  }
  return {
    functionCall: {
      ...(opts.includeId === true && { id: call.id }),
      name: call.function.name,
      args: parsed.args,
    },
    ...(opts.thoughtSignature !== undefined && {
      thoughtSignature: opts.thoughtSignature,
    }),
  };
}

/** Canonical tool message → Gemini functionResponse part. */
export function functionResponsePart(
  name: string,
  content: CanonicalMessage["content"],
): FunctionResponsePart {
  return {
    functionResponse: {
      name,
      response: toolResultResponse(content),
    },
  };
}

/**
 * Append a functionResponse part to `contents`, sharing the previous
 * user turn when it consists solely of functionResponses.
 */
export function appendFunctionResponsePart(
  contents: Content[],
  part: FunctionResponsePart,
): void {
  const last = contents[contents.length - 1];
  if (
    last?.role === "user" &&
    last.parts.every(isFunctionResponsePart)
  ) {
    last.parts.push(part);
  } else {
    contents.push({ role: "user", parts: [part] });
  }
}

/** Canonical tool-result content → Gemini functionResponse.response object. */
export function toolResultResponse(
  content: CanonicalMessage["content"],
): Record<string, unknown> {
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
  const parsed = parseToolArguments(text);
  if (parsed.valid && text.trim() !== "") {
    return parsed.args;
  }
  return { content: text };
}

/**
 * Canonical tools → a single Gemini `functionDeclarations` entry;
 * parameters filtered to Google's documented schema subset (spec §3.4).
 */
export function toGeminiTools(
  tools: CanonicalTool[] | undefined,
): GenerateContentRequest["tools"] {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        ...(tool.function.description !== undefined && {
          description: tool.function.description,
        }),
        ...(tool.function.parameters !== undefined && {
          parameters: toGeminiSchema(
            tool.function.parameters,
          ) as unknown as FunctionDeclaration["parameters"],
        }),
      })),
    },
  ];
}

/** Canonical toolChoice → Gemini toolConfig.functionCallingConfig. */
export function toGeminiToolConfig(
  choice: CanonicalToolChoice | undefined,
): GenerateContentRequest["toolConfig"] {
  if (choice === undefined) return undefined;
  return {
    functionCallingConfig: toFunctionCallingConfig(
      choice,
    ) as ToolConfig["functionCallingConfig"],
  };
}

function toFunctionCallingConfig(
  choice: CanonicalToolChoice,
): GeminiToolConfig["functionCallingConfig"] {
  if (choice === "auto") return { mode: "AUTO" };
  if (choice === "none") return { mode: "NONE" };
  if (choice === "required") return { mode: "ANY" };
  return {
    mode: "ANY",
    allowedFunctionNames: [choice.function.name],
  };
}
