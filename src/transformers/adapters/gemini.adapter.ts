import { randomUUID } from "crypto";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalContentPart,
  CanonicalToolCall,
  CanonicalError,
  CanonicalErrorKind,
  CanonicalFinishReason,
  ProviderAdapter,
  CanonicalModelList,
  CanonicalUsage,
  IdGenerator,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { ValidationError } from "../../utils/errors";
import { createIdGenerator } from "../../utils/ids";
import { systemText } from "../system-text";
import type {
  Content,
  GenerateContentRequest,
  GenerateContentResponse,
  Part,
  GeminiRole,
  GeminiToolConfig,
} from "../../types/gemini.types";
import {
  createStreamDecoder,
  createStreamEncoder,
} from "./gemini.stream";
import {
  appendFunctionResponsePart,
  functionCallPart,
  functionResponsePart,
  isFunctionCallPart,
  isFunctionResponsePart,
  recordCallId,
  toCanonicalToolCalls,
  toCanonicalToolChoice,
  toCanonicalToolMessages,
  toCanonicalTools,
  toGeminiToolConfig,
  toGeminiTools,
} from "./gemini.tools";
import type { PendingCallIds } from "./gemini.tools";

/**
 * Gemini FinishReason values — duplicated locally so the SDK stays a
 * type-only dependency. These are stable API constants (string enum
 * values), not implementation details.
 */
const FinishReason = {
  STOP: "STOP",
  MAX_TOKENS: "MAX_TOKENS",
  SAFETY: "SAFETY",
  RECITATION: "RECITATION",
  BLOCKLIST: "BLOCKLIST",
  PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
  SPII: "SPII",
  IMAGE_SAFETY: "IMAGE_SAFETY",
} as const;
type FinishReason = (typeof FinishReason)[keyof typeof FinishReason];

/** SDK candidate type — finishReason is a nominal enum, needs a cast site */
type GeminiCandidate = NonNullable<
  GenerateContentResponse["candidates"]
>[number];

/**
 * GenerateContentResponse on the wire carries `modelVersion` (every real
 * response and every streamed element does — see tests/fixtures); the
 * SDK type doesn't declare it, same gap as functionCall.id.
 */
type GeminiGenerateContentResponse = GenerateContentResponse & {
  modelVersion?: string;
};

export const geminiAdapter: ProviderAdapter<
  GenerateContentRequest,
  GenerateContentResponse
> = {
  toCanonicalRequest,
  fromCanonicalRequest,
  toCanonicalResponse,
  fromCanonicalResponse,
  toCanonicalModelList,
  fromCanonicalModelList,
  toCanonicalError,
  fromCanonicalError,
  createStreamDecoder,
  createStreamEncoder,
};

// ============ REQUEST: Gemini → Canonical ============

export function toCanonicalRequest(
  request: GenerateContentRequest,
): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  let systemPrompt: string | undefined;
  const ids = createIdGenerator();
  // pending call ids per function name, for matching functionResponses
  const pendingCalls: PendingCallIds = new Map();

  // Extract system instruction
  if (request.systemInstruction) {
    systemPrompt = extractTextFromInstruction(request.systemInstruction);
  }

  // Convert contents to messages
  for (const content of request.contents) {
    const parts = content.parts ?? [];
    const otherParts = parts.filter((p) => !isFunctionResponsePart(p));

    if (content.role === "model") {
      const toolCalls = toCanonicalToolCalls(otherParts, ids);
      for (const call of toolCalls) {
        recordCallId(pendingCalls, call.function.name, call.id);
      }
      messages.push({
        role: "assistant",
        content: extractContentParts({
          role: content.role,
          parts: otherParts.filter((p) => !isFunctionCallPart(p)),
        }),
        ...(toolCalls.length > 0 && { toolCalls }),
      });
    } else {
      messages.push(...toCanonicalToolMessages(parts, pendingCalls));
      if (otherParts.length > 0) {
        messages.push({
          role: "user",
          content: extractContentParts({
            role: content.role,
            parts: otherParts,
          }),
        });
      }
    }
  }

  const result: CanonicalRequest = {
    model: "gemini-pro",
    messages,
    ...(systemPrompt && { systemPrompt }),
  };

  // Convert tool definitions
  const tools = toCanonicalTools(request.tools);
  if (tools) {
    result.tools = tools;
  }

  // Convert tool config
  const toolChoice = toCanonicalToolChoice(
    request.toolConfig as GeminiToolConfig | undefined,
  );
  if (toolChoice !== undefined) {
    result.toolChoice = toolChoice;
  }

  // Convert generation config
  if (request.generationConfig) {
    const gc = request.generationConfig;
    result.config = {
      ...(gc.temperature !== undefined && { temperature: gc.temperature }),
      ...(gc.maxOutputTokens !== undefined && {
        maxTokens: gc.maxOutputTokens,
      }),
      ...(gc.topP !== undefined && { topP: gc.topP }),
      ...(gc.topK !== undefined && { topK: gc.topK }),
      ...(gc.stopSequences && { stopSequences: gc.stopSequences }),
      ...(gc.candidateCount !== undefined && {
        candidateCount: gc.candidateCount,
      }),
    };
  }

  return result;
}

function extractTextFromInstruction(
  instruction: GenerateContentRequest["systemInstruction"],
): string {
  if (!instruction) return "";
  if (typeof instruction === "string") return instruction;
  if ("text" in instruction && typeof instruction.text === "string") {
    return instruction.text;
  }
  if ("parts" in instruction) {
    return (instruction as Content).parts
      .filter((p): p is { text: string } => "text" in p)
      .map((p) => p.text)
      .join("");
  }
  return "";
}

function extractContentParts(
  content: Content,
): string | CanonicalContentPart[] {
  if (!content.parts || content.parts.length === 0) {
    return "";
  }

  // If all parts are text, join them
  const allText = content.parts.every((p) => "text" in p);
  if (allText) {
    return content.parts
      .filter((p): p is { text: string } => "text" in p)
      .map((p) => p.text)
      .join("");
  }

  // Mixed content
  return content.parts.map((part): CanonicalContentPart => {
    if ("text" in part) {
      return { type: "text", text: part.text };
    }
    if ("inlineData" in part && part.inlineData) {
      return {
        type: "image",
        image: {
          data: part.inlineData.data,
          mimeType: part.inlineData
            .mimeType as CanonicalContentPart["image"] extends {
            mimeType: infer T;
          }
            ? T
            : never,
        },
      };
    }
    return { type: "text", text: "" };
  });
}

// ============ REQUEST: Canonical → Gemini ============

export function fromCanonicalRequest(
  request: CanonicalRequest,
): GenerateContentRequest {
  // toolCallId → function name, resolved from earlier assistant messages
  const callNames = new Map<string, string>();
  const contents: Content[] = [];

  for (const m of request.messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      let parts = convertToParts(m.content);
      for (const call of calls) {
        callNames.set(call.id, call.function.name);
      }
      if (calls.length > 0) {
        parts = parts.filter(
          (p) => !("text" in p && p.text === ""),
        );
        // Gemini 3.x upstreams 400 unsigned history functionCall
        // parts ("Function call is missing a thought_signature").
        // Canonical can't carry real signatures yet (Task-3-window
        // follow-up), so every outgoing functionCall part gets the
        // documented placeholder — a part-level sibling, not a field
        // of functionCall.
        // https://ai.google.dev/gemini-api/docs/thought-signatures
        parts.push(
          ...calls.map((call) =>
            functionCallPart(call, {
              thoughtSignature: "skip_thought_signature_validator",
            }),
          ),
        );
      }
      contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const name = m.toolCallId
        ? callNames.get(m.toolCallId)
        : undefined;
      if (!name) {
        throw new ValidationError(
          `Tool result "${m.toolCallId ?? ""}" has no matching assistant tool call`,
        );
      }
      appendFunctionResponsePart(
        contents,
        functionResponsePart(name, m.content),
      );
    } else {
      contents.push({
        role: mapRoleToGemini(m.role),
        parts: convertToParts(m.content),
      });
    }
  }

  const result: GenerateContentRequest = {
    contents,
  };

  // Tool definitions; parameters filtered to Google's documented
  // schema subset (spec §3.4)
  const tools = toGeminiTools(request.tools);
  if (tools) {
    result.tools = tools;
  }

  // Tool choice → functionCallingConfig
  const toolConfig = toGeminiToolConfig(request.toolChoice);
  if (toolConfig) {
    result.toolConfig = toolConfig;
  }

  // Add system instruction — systemText flattens a parts prompt (§3.2)
  const systemMsg = request.messages.find((m) => m.role === "system");
  const systemContent = systemText(request.systemPrompt) ??
    (typeof systemMsg?.content === "string" ? systemMsg.content : "");
  if (systemContent) {
    result.systemInstruction = {
      role: "user" as GeminiRole,
      parts: [{ text: systemContent }],
    };
  }

  // Add generation config
  if (request.config) {
    const c = request.config;
    result.generationConfig = {
      ...(c.temperature !== undefined && { temperature: c.temperature }),
      ...(c.maxTokens !== undefined && { maxOutputTokens: c.maxTokens }),
      ...(c.topP !== undefined && { topP: c.topP }),
      ...(c.topK !== undefined && { topK: c.topK }),
      ...(c.stopSequences && { stopSequences: c.stopSequences }),
      ...(c.candidateCount !== undefined && {
        candidateCount: c.candidateCount,
      }),
    };
  }

  return result;
}

function mapRoleToGemini(role: CanonicalMessage["role"]): GeminiRole {
  return role === "assistant" ? "model" : "user";
}

function convertToParts(content: string | CanonicalContentPart[]): Part[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  return content.map((part): Part => {
    if (part.type === "text") {
      return { text: part.text || "" };
    }
    if (part.type === "image" && part.image) {
      return {
        inlineData: {
          mimeType: part.image.mimeType,
          data: part.image.data,
        },
      };
    }
    return { text: "" };
  });
}

// ============ RESPONSE: Gemini → Canonical ============

export function toCanonicalResponse(
  response: GenerateContentResponse,
  model: string,
  ids: IdGenerator = createIdGenerator(),
): CanonicalResponse {
  const candidate = response.candidates?.[0];
  const content = candidate?.content;
  const parts = content?.parts ?? [];

  const text = parts
    .filter((p): p is { text: string } => "text" in p)
    .map((p) => p.text)
    .join("");
  const toolCalls = toCanonicalToolCalls(parts, ids);

  return {
    id: `gemini-${randomUUID()}`,
    model,
    message: {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 && { toolCalls }),
    },
    finishReason:
      toolCalls.length > 0
        ? "tool_call"
        : mapFinishReason(candidate?.finishReason),
    usage: response.usageMetadata
      ? geminiUsageToCanonical(response.usageMetadata)
      : undefined,
  };
}

/**
 * usageMetadata → canonical (spec §3.2): `cachedContentTokenCount` maps to
 * cacheReadTokens; `promptTokenCount` already includes cached tokens.
 * Emitted only when non-zero (ai.google.dev/api/generate-content#UsageMetadata).
 */
export function geminiUsageToCanonical(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}): CanonicalUsage {
  const read = usage.cachedContentTokenCount ?? 0;
  const input = usage.promptTokenCount ?? 0;
  const output = usage.candidatesTokenCount ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.totalTokenCount ?? input + output,
    ...(read > 0 && { cacheReadTokens: read }),
  };
}

/** Canonical → usageMetadata; `cachedContentTokenCount` appears only when non-zero. */
export function geminiUsageFromCanonical(
  usage: NonNullable<CanonicalResponse["usage"]>,
): {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
} {
  return {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens,
    totalTokenCount: usage.totalTokens,
    ...(usage.cacheReadTokens !== undefined &&
      usage.cacheReadTokens > 0 && {
        cachedContentTokenCount: usage.cacheReadTokens,
      }),
  };
}

export function mapFinishReason(
  reason: FinishReason | string | undefined,
): CanonicalFinishReason {
  switch (reason) {
    case FinishReason.STOP:
    case "STOP":
      return "stop";
    case FinishReason.MAX_TOKENS:
    case "MAX_TOKENS":
      return "length";
    case FinishReason.SAFETY:
    case "SAFETY":
    case FinishReason.RECITATION:
    case "RECITATION":
    case FinishReason.BLOCKLIST:
    case "BLOCKLIST":
    case FinishReason.PROHIBITED_CONTENT:
    case "PROHIBITED_CONTENT":
    case FinishReason.SPII:
    case "SPII":
    case FinishReason.IMAGE_SAFETY:
    case "IMAGE_SAFETY":
      return "content_filter";
    default:
      return "stop";
  }
}

// ============ RESPONSE: Canonical → Gemini ============

export function fromCanonicalResponse(
  response: CanonicalResponse,
): GeminiGenerateContentResponse {
  const content =
    typeof response.message.content === "string"
      ? response.message.content
      : "";
  const toolCalls = response.message.toolCalls ?? [];
  const callPart = (call: CanonicalToolCall): Part =>
    functionCallPart(call, { includeId: true });
  const parts: Part[] =
    toolCalls.length > 0 && content === ""
      ? toolCalls.map(callPart)
      : [{ text: content }, ...toolCalls.map(callPart)];

  return {
    candidates: [
      {
        content: {
          role: "model",
          parts,
        },
        finishReason: mapToGeminiFinishReason(
          response.finishReason,
        ) as GeminiCandidate["finishReason"],
        index: 0,
      },
    ],
    // §3.3: replies carry the requested model name — on the wire that's
    // modelVersion, matching the stream encoder.
    modelVersion: response.model,
    usageMetadata: response.usage
      ? geminiUsageFromCanonical(response.usage)
      : undefined,
  };
}

// ============ MODEL LIST (/v1beta/models) ============

interface GeminiModelListResponse {
  models?: { name?: string; displayName?: string }[];
}

export function toCanonicalModelList(response: unknown): CanonicalModelList {
  const res = response as GeminiModelListResponse;
  return {
    models: (res.models ?? [])
      .filter((m): m is { name: string; displayName?: string } =>
        Boolean(m.name),
      )
      .map((m) => ({
        // "models/gemini-2.0-flash" → "gemini-2.0-flash"
        id: m.name.replace(/^models\//, ""),
        displayName: m.displayName,
      })),
  };
}

export function fromCanonicalModelList(
  list: CanonicalModelList,
): GeminiModelListResponse {
  return {
    models: list.models.map((m) => ({
      name: `models/${m.id}`,
      displayName: m.displayName,
    })),
  };
}

export function mapToGeminiFinishReason(
  reason: CanonicalFinishReason,
): FinishReason {
  switch (reason) {
    case "stop":
      return FinishReason.STOP;
    case "length":
      return FinishReason.MAX_TOKENS;
    case "content_filter":
      return FinishReason.SAFETY;
    default:
      return FinishReason.STOP;
  }
}

// ============ ERRORS ============

const GEMINI_ERROR_STATUS: Record<CanonicalErrorKind, string> = {
  invalid_request: "INVALID_ARGUMENT",
  authentication: "UNAUTHENTICATED",
  permission: "PERMISSION_DENIED",
  not_found: "NOT_FOUND",
  request_too_large: "RESOURCE_EXHAUSTED",
  rate_limit: "RESOURCE_EXHAUSTED",
  unsupported: "UNIMPLEMENTED",
  upstream: "INTERNAL",
  unavailable: "UNAVAILABLE",
  timeout: "DEADLINE_EXCEEDED",
  internal: "INTERNAL",
};

export function toCanonicalError(
  status: number,
  body: unknown,
): CanonicalError {
  const err = (
    body as { error?: { message?: unknown; details?: unknown } } | null
  )?.error;
  const message =
    typeof err?.message === "string" && err.message.length > 0
      ? err.message
      : `Upstream gemini returned ${status}`;
  const details = err?.details;
  const keyInvalid =
    Array.isArray(details) &&
    details.some(
      (d) =>
        typeof d === "object" &&
        d !== null &&
        (d as { reason?: unknown }).reason === "API_KEY_INVALID",
    );
  return makeCanonicalError(
    keyInvalid ? "authentication" : kindFromStatus(status),
    message,
  );
}

export function fromCanonicalError(err: CanonicalError): unknown {
  return {
    error: {
      code: err.status,
      message: err.message,
      status: GEMINI_ERROR_STATUS[err.kind],
    },
  };
}
