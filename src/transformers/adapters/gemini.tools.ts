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
  CanonicalContentPart,
  CanonicalImageMimeType,
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
  GeminiFunctionResponseMediaPart,
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

/**
 * Gemini functionCall parts → canonical toolCalls (wire id or
 * generated). Task 7 (v1.4 spec §3.3): a part-level `thoughtSignature`
 * sibling becomes the call's canonical signature when `origin` is
 * given — callers pass the decode origin (`decodeOrigin(model)`).
 */
export function toCanonicalToolCalls(
  parts: Part[],
  ids: IdGenerator,
  origin?: { provider: string; model: string },
): CanonicalToolCall[] {
  return parts.filter(isFunctionCallPart).map(
    (part): CanonicalToolCall => {
      const call = part.functionCall as GeminiFunctionCall;
      const thoughtSignature = (
        part as { thoughtSignature?: string }
      ).thoughtSignature;
      return {
        id: call.id ?? ids(),
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        },
        ...(origin !== undefined &&
          typeof thoughtSignature === "string" &&
          thoughtSignature !== "" && {
            signature: { origin, data: thoughtSignature },
          }),
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

/**
 * Gemini functionResponse → canonical tool-message content (v1.5
 * spec §3.2.1). `response` decodes to the text it always did —
 * `{"$ref": displayName}` subobjects point at media in `parts[]`,
 * so the pointers are stripped rather than left as text.
 * `functionResponse.parts[]` — multimodal function-response media
 * per https://ai.google.dev/api/generate-content#FunctionResponse
 * (documented for Gemini 3 series models,
 * https://ai.google.dev/gemini-api/docs/function-calling#multimodal)
 * — decode to image parts appended after the text; whether a Gemini
 * target can take them is MEDIA_SUPPORT's call, not the decoder's.
 */
export function functionResponseContent(
  res: GeminiFunctionResponse,
): string | CanonicalContentPart[] {
  const media = (res.parts ?? []).map((part, i) =>
    functionResponseMediaPart(part, res.name, i),
  );
  const text = functionResponseText(res.response);
  if (media.length === 0) return text;
  return [
    ...(text !== "" ? [{ type: "text" as const, text }] : []),
    ...media,
  ];
}

/** `functionResponse.response` → text, with `{"$ref": name}` media
 *  pointers stripped. */
function functionResponseText(response: unknown): string {
  if (
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) {
    return JSON.stringify(response ?? {});
  }
  const stripped = JSON.stringify(response, (_key, value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof (value as { $ref?: unknown }).$ref === "string"
    ) {
      return undefined;
    }
    return value;
  });
  const parsed = JSON.parse(stripped ?? "{}") as Record<
    string,
    unknown
  >;
  const keys = Object.keys(parsed);
  // Unwrap the { "content": "<string>" } wrapper this adapter emits
  if (keys.length === 1 && typeof parsed.content === "string") {
    return parsed.content;
  }
  return keys.length === 0 ? "" : JSON.stringify(parsed);
}

/**
 * One `functionResponse.parts[]` entry → a canonical image part.
 * `inlineData` carries bytes, `fileData.fileUri` a URL — anything
 * that isn't an image has no canonical slot on a tool message: a
 * loud 400 naming the mime, never a silent drop.
 */
function functionResponseMediaPart(
  part: GeminiFunctionResponseMediaPart,
  name: string,
  index: number,
): CanonicalContentPart {
  const inline = part.inlineData;
  if (inline?.data !== undefined) {
    const mimeType = inline.mimeType ?? "";
    if (!mimeType.startsWith("image/")) {
      throw new ValidationError(
        `Unsupported functionResponse.parts[${index}] mime type "${mimeType}" on "${name}"`,
      );
    }
    return {
      type: "image",
      image: {
        data: inline.data,
        mimeType: mimeType as CanonicalImageMimeType,
      },
    };
  }
  const file = part.fileData;
  if (file?.fileUri !== undefined) {
    const mimeType = file.mimeType ?? "";
    if (!mimeType.startsWith("image/")) {
      throw new ValidationError(
        `Unsupported functionResponse.parts[${index}] mime type "${mimeType}" on "${name}"`,
      );
    }
    return {
      type: "image",
      image: {
        url: file.fileUri,
        ...(file.mimeType !== undefined && {
          mimeType: file.mimeType as CanonicalImageMimeType,
        }),
      },
    };
  }
  throw new ValidationError(
    `Unsupported functionResponse.parts[${index}] on "${name}" (no inlineData or fileData)`,
  );
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
  const media =
    typeof content === "string"
      ? undefined
      : content.find(
          (p) => p.type === "image" || p.type === "document",
        );
  if (media !== undefined) {
    // Media in a tool result has no encoding into standard
    // functionResponse — media-inline refuses it for this target
    // first; an encode reaching here is a loud 400, never a drop.
    throw new ValidationError(
      `Unsupported "${media.type}" content part in a tool message`,
    );
  }
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
      functionDeclarations: tools.map((tool) => {
        if (tool.type !== "function") {
          // Custom tools are lowered to function tools by
          // canonicalForTarget before encode (v1.4 spec §3.6).
          throw new ValidationError(
            `Unsupported tool type "${tool.type}" in tools[]`,
          );
        }
        return {
          name: tool.function.name,
          ...(tool.function.description !== undefined && {
            description: tool.function.description,
          }),
          ...(tool.function.parameters !== undefined && {
            parameters: toGeminiSchema(
              tool.function.parameters,
            ) as unknown as FunctionDeclaration["parameters"],
          }),
        };
      }),
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
