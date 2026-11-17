import { randomUUID } from "crypto";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalContentPart,
  CanonicalImageMimeType,
  CanonicalToolCall,
  CanonicalError,
  CanonicalErrorKind,
  CanonicalFinishReason,
  ProviderAdapter,
  CanonicalModelList,
  CanonicalResponseFormat,
  CanonicalUsage,
  IdGenerator,
} from "../../types/canonical.types";
import {
  kindFromStatus,
  makeCanonicalError,
} from "../../utils/canonical-error";
import { ValidationError } from "../../utils/errors";
import { createIdGenerator } from "../../utils/ids";
import { recordNote } from "../../observe/context";
import {
  decodeOrigin,
  originMatchesCurrent,
  signatureMatchesCurrent,
} from "../reasoning-origin";
import {
  packEnvelope,
  unpackEnvelope,
  type EnvelopePayload,
} from "../reasoning-envelope";
import {
  EFFORT_LADDER,
  budgetFor,
  effortForBudget,
  nearestSupported,
  type Effort,
} from "../reasoning-effort";
import {
  DEFAULT_RESPONSE_FORMAT_NAME,
  isSchemaObject,
  noteDroppedFormatExtras,
} from "../response-format";
import { systemText } from "../system-text";
import type {
  Content,
  GenerateContentRequest,
  GenerateContentResponse,
  GeminiGenerationConfig,
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

type CanonicalReasoning = NonNullable<
  NonNullable<CanonicalRequest["config"]>["reasoning"]
>;

/**
 * `generationConfig.thinkingConfig` → `config.reasoning` (v1.5 spec
 * §3.1). Field names per
 * https://ai.google.dev/api/generate-content#ThinkingConfig:
 * `thinkingLevel` is a level name (the canonical ladder — anything
 * else keeps a `field_dropped` note), `thinkingBudget` a token
 * budget (effort = the level whose starting budget fits, the budget
 * kept; a level wins when both are sent), `includeThoughts` →
 * `summary`. A non-object `thinkingConfig` keeps `field_dropped`.
 */
function toCanonicalReasoning(
  gc: GeminiGenerationConfig | undefined,
): CanonicalReasoning | undefined {
  const note = (path: string, message: string): void =>
    recordNote(
      { stage: "decode", adapter: "gemini", code: "field_dropped", path },
      message,
    );
  const tc = (gc as { thinkingConfig?: unknown } | undefined)
    ?.thinkingConfig;
  if (tc === undefined || tc === null) return undefined;
  if (typeof tc !== "object" || Array.isArray(tc)) {
    note(
      "generationConfig.thinkingConfig",
      'Dropping "thinkingConfig" (not an object)',
    );
    return undefined;
  }
  const fields = tc as {
    thinkingLevel?: unknown;
    thinkingBudget?: unknown;
    includeThoughts?: unknown;
  };
  const reasoning: CanonicalReasoning = {};
  if (fields.thinkingLevel !== undefined) {
    if (
      typeof fields.thinkingLevel === "string" &&
      (EFFORT_LADDER as readonly string[]).includes(fields.thinkingLevel)
    ) {
      reasoning.effort = fields.thinkingLevel as Effort;
    } else {
      note(
        "generationConfig.thinkingConfig.thinkingLevel",
        'Dropping "thinkingLevel" (not a level string)',
      );
    }
  }
  if (fields.thinkingBudget !== undefined) {
    if (
      typeof fields.thinkingBudget === "number" &&
      Number.isFinite(fields.thinkingBudget)
    ) {
      reasoning.effort ??= effortForBudget(fields.thinkingBudget);
      reasoning.budgetTokens = fields.thinkingBudget;
    } else {
      note(
        "generationConfig.thinkingConfig.thinkingBudget",
        'Dropping "thinkingBudget" (not a number)',
      );
    }
  }
  if (fields.includeThoughts !== undefined) {
    if (typeof fields.includeThoughts === "boolean") {
      reasoning.summary = fields.includeThoughts;
    } else {
      note(
        "generationConfig.thinkingConfig.includeThoughts",
        'Dropping "includeThoughts" (not a boolean)',
      );
    }
  }
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

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
  for (const [contentIndex, content] of request.contents.entries()) {
    const parts = content.parts ?? [];
    const otherParts = parts.filter((p) => !isFunctionResponsePart(p));

    if (content.role === "model") {
      const toolCalls = toCanonicalToolCalls(otherParts, ids);
      for (const call of toolCalls) {
        recordCallId(pendingCalls, call.function.name, call.id);
      }
      const envelopeSigs: EnvelopePayload["signatures"] = [];
      // v1.5 §3.1 (Task 4): an envelope on a functionCall part
      // splices its reasoning parts at the position the call
      // occupies among the turn's non-call parts (a raw signature
      // drops with a note, conductor's call (c)). thoughtSignature
      // is a part-level field:
      // https://ai.google.dev/gemini-api/docs/thought-signatures.
      const fcEnvelopes: { pos: number; payload: EnvelopePayload }[] =
        [];
      {
        let pos = 0;
        for (const [j, p] of parts.entries()) {
          if (isFunctionResponsePart(p)) continue;
          if (!isFunctionCallPart(p)) {
            pos++;
            continue;
          }
          const carrier = (
            p as { thoughtSignature?: unknown }
          ).thoughtSignature;
          if (typeof carrier === "string" && carrier !== "") {
            const payload = unpackEnvelope(carrier);
            if (payload === undefined) {
              recordNote(
                {
                  stage: "decode",
                  adapter: "gemini",
                  code: "reasoning_dropped",
                  path: `contents[${contentIndex}].parts[${j}].thoughtSignature`,
                },
                "Dropping a thoughtSignature (not a bg1. envelope)",
              );
            } else {
              fcEnvelopes.push({ pos, payload });
            }
          }
        }
      }
      let msgContent = extractContentParts(
        { role: content.role, parts },
        contentIndex,
        envelopeSigs,
      );
      if (fcEnvelopes.length > 0) {
        const contentParts: CanonicalContentPart[] =
          typeof msgContent === "string"
            ? msgContent === ""
              ? []
              : [{ type: "text", text: msgContent }]
            : [...msgContent];
        for (const { pos, payload } of fcEnvelopes) {
          contentParts.splice(
            Math.min(pos, contentParts.length),
            0,
            ...payload.reasoning,
          );
          envelopeSigs.push(...payload.signatures);
        }
        msgContent = contentParts.length > 0 ? contentParts : "";
      }
      const msg: CanonicalMessage = {
        role: "assistant",
        content: msgContent,
        ...(toolCalls.length > 0 && { toolCalls }),
      };
      resolveEnvelopeSignatures(msg, envelopeSigs, contentIndex);
      messages.push(msg);
    } else {
      messages.push(...toCanonicalToolMessages(parts, pendingCalls));
      if (otherParts.length > 0) {
        const envelopeSigs: EnvelopePayload["signatures"] = [];
        const msg: CanonicalMessage = {
          role: "user",
          content: extractContentParts(
            { role: content.role, parts },
            contentIndex,
            envelopeSigs,
          ),
        };
        resolveEnvelopeSignatures(msg, envelopeSigs, contentIndex);
        messages.push(msg);
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
    const reasoning = toCanonicalReasoning(gc);
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
      ...(reasoning !== undefined && { reasoning }),
    };
  }

  // v1.4 spec §3.5: `generationConfig.responseJsonSchema` (JSON
  // Schema) and the OpenAPI-subset `responseSchema` both decode to
  // the same canonical schema, unchanged;
  // `responseMimeType: "application/json"` alone is `json_object`.
  // Field names per
  // https://ai.google.dev/api/generate-content#GenerationConfig.
  // Neither wire field carries a name → the canonical side gets the
  // fixed default name. The schema passes through by reference.
  const wireGc = request.generationConfig as
    | GeminiGenerationConfig
    | undefined;
  const responseFormat = toCanonicalResponseFormat(wireGc);
  if (responseFormat !== undefined) {
    result.responseFormat = responseFormat;
  }

  return result;
}

function toCanonicalResponseFormat(
  gc: GeminiGenerationConfig | undefined,
): CanonicalResponseFormat | undefined {
  if (gc === undefined || gc === null) return undefined;

  let format: CanonicalResponseFormat | undefined;
  const note = (path: string, message: string): void =>
    recordNote(
      { stage: "decode", adapter: "gemini", code: "field_dropped", path },
      message,
    );

  const jsonSchema = gc.responseJsonSchema;
  if (jsonSchema !== undefined) {
    if (isSchemaObject(jsonSchema)) {
      format = {
        type: "json_schema",
        name: DEFAULT_RESPONSE_FORMAT_NAME,
        schema: jsonSchema,
      };
      if (gc.responseSchema !== undefined) {
        note(
          "generationConfig.responseSchema",
          'Dropping "responseSchema" (superseded by responseJsonSchema)',
        );
      }
    } else {
      note(
        "generationConfig.responseJsonSchema",
        'Dropping "responseJsonSchema" (not a schema object)',
      );
    }
  } else if (gc.responseSchema !== undefined) {
    if (isSchemaObject(gc.responseSchema)) {
      format = {
        type: "json_schema",
        name: DEFAULT_RESPONSE_FORMAT_NAME,
        schema: gc.responseSchema as Record<string, unknown>,
      };
    } else {
      note(
        "generationConfig.responseSchema",
        'Dropping "responseSchema" (not a schema object)',
      );
    }
  }

  const mime = gc.responseMimeType;
  if (mime === "application/json") {
    // A schema wins; mime alone is the schemaless JSON mode.
    format ??= { type: "json_object" };
  } else if (mime !== undefined && mime !== "text/plain") {
    // "text/plain" is the documented default — absent meaning.
    note(
      "generationConfig.responseMimeType",
      'Dropping an unsupported "responseMimeType" value',
    );
  }

  return format;
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

/**
 * v1.5 spec §3.1 (Task 4): a part-level `thoughtSignature` carries a
 * `bg1.` envelope that unpacks to canonical reasoning parts and
 * signatures in place — collected into `envelopeSigs` for resolution
 * against the decoded message. A `thought: true` part without an
 * envelope (or with a raw signature) drops with `reasoning_dropped`,
 * as does a raw `thoughtSignature` on any other part (conductor's
 * call (c)). Wire fields:
 * https://ai.google.dev/gemini-api/docs/thinking,
 * https://ai.google.dev/gemini-api/docs/thought-signatures
 * (`thought`/`thoughtSignature` on Part per
 * https://ai.google.dev/api/generate-content#Part).
 */
function extractContentParts(
  content: Content,
  contentIndex: number,
  envelopeSigs: EnvelopePayload["signatures"],
): string | CanonicalContentPart[] {
  const parts = content.parts ?? [];
  if (parts.length === 0) {
    return "";
  }

  const out: CanonicalContentPart[] = [];
  let enveloped = false;
  for (const [j, part] of parts.entries()) {
    if (isFunctionCallPart(part) || isFunctionResponsePart(part)) {
      continue;
    }
    const p = part as {
      text?: string;
      thought?: boolean;
      thoughtSignature?: unknown;
      inlineData?: { data: string; mimeType: string };
    };
    const carrier =
      typeof p.thoughtSignature === "string" &&
      p.thoughtSignature !== ""
        ? p.thoughtSignature
        : undefined;
    const payload =
      carrier !== undefined ? unpackEnvelope(carrier) : undefined;
    const sigPath = `contents[${contentIndex}].parts[${j}].thoughtSignature`;
    if (p.thought === true) {
      if (payload !== undefined) {
        enveloped = true;
        out.push(...payload.reasoning);
        envelopeSigs.push(...payload.signatures);
      } else {
        recordNote(
          {
            stage: "decode",
            adapter: "gemini",
            code: "reasoning_dropped",
            path: sigPath,
          },
          "Dropping a thought part (thoughtSignature is not a bg1. envelope)",
        );
      }
      continue;
    }
    if (carrier !== undefined) {
      if (payload !== undefined) {
        enveloped = true;
        out.push(...payload.reasoning);
        envelopeSigs.push(...payload.signatures);
      } else {
        recordNote(
          {
            stage: "decode",
            adapter: "gemini",
            code: "reasoning_dropped",
            path: sigPath,
          },
          "Dropping a thoughtSignature (not a bg1. envelope)",
        );
      }
    }
    if ("text" in part) {
      out.push({ type: "text", text: p.text ?? "" });
      continue;
    }
    if (p.inlineData != null) {
      out.push({
        type: "image",
        image: {
          data: p.inlineData.data,
          mimeType: p.inlineData
            .mimeType as CanonicalContentPart["image"] extends {
            mimeType: infer T;
          }
            ? T
            : never,
        },
      });
      continue;
    }
    out.push({ type: "text", text: "" });
  }

  if (out.length === 0) return "";
  if (!enveloped && out.every((p) => p.type === "text")) {
    return out.map((p) => (p.type === "text" ? p.text : "")).join("");
  }
  return out;
}

/**
 * Resolve `bg1.` envelope signature entries onto the decoded message:
 * `toolCallId` targets its toolCalls, `textIndex` the nth text part
 * of its content. An entry with no matching part drops with a
 * `reasoning_dropped` note.
 */
function resolveEnvelopeSignatures(
  msg: CanonicalMessage,
  signatures: EnvelopePayload["signatures"],
  contentIndex: number,
): void {
  if (signatures.length === 0) return;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const textParts = content.filter((p) => p.type === "text");
  for (const [i, entry] of signatures.entries()) {
    if (entry.toolCallId !== undefined) {
      const call = msg.toolCalls?.find(
        (c) => c.id === entry.toolCallId,
      );
      if (call !== undefined) {
        call.signature = entry.signature;
        continue;
      }
    } else if (entry.textIndex !== undefined) {
      const target = textParts[entry.textIndex];
      if (target !== undefined) {
        target.signature = entry.signature;
        continue;
      }
    }
    recordNote(
      {
        stage: "decode",
        adapter: "gemini",
        code: "reasoning_dropped",
        path: `contents[${contentIndex}].signatures[${i}]`,
      },
      "Dropping an envelope signature (no matching part in the message)",
    );
  }
}

// ============ REQUEST: Canonical → Gemini ============

/**
 * Models whose generateContent takes
 * `generationConfig.thinkingConfig.thinkingLevel` — the API
 * reference marks the field "Recommended for Gemini 3 or later
 * models. Use with earlier models results in an error"
 * (https://ai.google.dev/api/generate-content#ThinkingConfig), so
 * unlisted models get `thinkingBudget` instead (v1.4 spec §3.3).
 * `levels` is the model's supported set from the thinking docs
 * (https://ai.google.dev/gemini-api/docs/thinking#thinking-levels);
 * `xhigh` exists only on `gemini-4-hydrogen`. Prefix-matched, more
 * specific prefixes first.
 */
const THINKING_LEVEL_MODELS: { prefix: string; levels: Effort[] }[] =
  [
    { prefix: "gemini-4-hydrogen", levels: ["low", "medium", "high", "xhigh"] },
    { prefix: "gemini-4-carbon", levels: ["low", "medium", "high"] },
    { prefix: "gemini-4-argon", levels: ["low", "medium", "high"] },
    { prefix: "gemini-3.8-flash", levels: ["low", "medium", "high"] },
    { prefix: "gemini-3.6-flash", levels: ["minimal", "low", "medium", "high"] },
    { prefix: "gemini-3.5-flash-lite", levels: ["minimal", "low", "medium", "high"] },
    { prefix: "gemini-3.1-pro-preview", levels: ["low", "medium", "high"] },
    { prefix: "gemini-3.1-flash-lite-image", levels: ["minimal", "high"] },
    { prefix: "gemini-3.1-flash-lite", levels: ["minimal", "low", "medium", "high"] },
    { prefix: "gemini-3-pro-preview", levels: ["low", "high"] },
    { prefix: "gemini-3-flash-preview", levels: ["minimal", "low", "medium", "high"] },
    { prefix: "gemini-robotics-er-2-preview", levels: ["minimal", "low", "medium", "high"] },
  ];

function thinkingLevelsFor(model: string): Effort[] | undefined {
  return THINKING_LEVEL_MODELS.find((entry) =>
    model.startsWith(entry.prefix),
  )?.levels;
}

/**
 * `thinkingBudget` ranges and off-switches per model — the
 * per-model budget table on
 * https://ai.google.dev/gemini-api/docs/thinking ("Thinking
 * budgets", generateContent variant). `canDisable` marks the rows
 * the table gives a `thinkingBudget = 0` off switch; 2.5 Pro has
 * none ("Cannot disable thinking"), so an off request must leave
 * the budget unset rather than send `0`. Unlisted models keep the
 * raw encoding. Prefix-matched, more specific prefixes first.
 */
const THINKING_BUDGET_MODELS: {
  prefix: string;
  min: number;
  max: number;
  canDisable: boolean;
}[] = [
  { prefix: "gemini-robotics-er-1.6", min: 0, max: 24576, canDisable: true },
  { prefix: "gemini-2.5-flash-lite", min: 512, max: 24576, canDisable: true },
  { prefix: "gemini-2.5-flash", min: 0, max: 24576, canDisable: true },
  { prefix: "gemini-2.5-pro", min: 128, max: 32768, canDisable: false },
];

function thinkingBudgetFor(
  model: string,
): (typeof THINKING_BUDGET_MODELS)[number] | undefined {
  return THINKING_BUDGET_MODELS.find((entry) =>
    model.startsWith(entry.prefix),
  );
}

/**
 * Canonical `config.reasoning` → `generationConfig.thinkingConfig`
 * (v1.4 spec §3.3). Level-capable models emit `thinkingLevel`
 * (unsupported efforts lower to the nearest level the model takes;
 * efforts below the model's floor clamp to that floor — there is no
 * wire "off" for level models). Other models emit `thinkingBudget`
 * — `0` disables thinking and `-1` asks for dynamic budgeting per
 * https://ai.google.dev/api/generate-content#ThinkingConfig.
 * `includeThoughts` (same reference) carries `summary`.
 */
function toThinkingConfig(
  request: CanonicalRequest,
): Record<string, unknown> | undefined {
  const reasoning = request.config?.reasoning;
  if (reasoning === undefined) return undefined;

  const levels = thinkingLevelsFor(request.model);
  if (levels !== undefined) {
    if (reasoning.budgetTokens !== undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "gemini",
          code: "reasoning_budget_dropped",
          path: "reasoning.budget_tokens",
        },
        "Dropping reasoning.budget_tokens (this model takes thinkingLevel, not a budget)",
      );
    }
    const thinkingConfig: Record<string, unknown> = {};
    if (reasoning.effort !== undefined) {
      const resolved = nearestSupported(reasoning.effort, levels);
      let level: Effort;
      if (resolved === "none") {
        // Requested below (or at) the model's floor — the wire has
        // no off, so clamp to the lowest level it accepts.
        level = levels[0];
        recordNote(
          {
            stage: "encode",
            adapter: "gemini",
            code: "reasoning_effort_clamped",
            path: "reasoning.effort",
          },
          `Clamping reasoning effort "${reasoning.effort}" to "${level}" (${request.model} has no lower level)`,
        );
      } else {
        level = resolved;
        if (level !== reasoning.effort) {
          recordNote(
            {
              stage: "encode",
              adapter: "gemini",
              code: "reasoning_effort_lowered",
              path: "reasoning.effort",
            },
            `Lowering reasoning effort "${reasoning.effort}" to "${level}" (${request.model} supports ${levels.join("/")})`,
          );
        }
      }
      thinkingConfig.thinkingLevel = level;
    }
    // https://ai.google.dev/api/generate-content#ThinkingConfig —
    // `includeThoughts` asks for thought summaries in the response.
    if (reasoning.summary === true) {
      thinkingConfig.includeThoughts = true;
    }
    return Object.keys(thinkingConfig).length > 0
      ? thinkingConfig
      : undefined;
  }

  // `thinkingBudget` path — token budget per
  // https://ai.google.dev/gemini-api/docs/thinking (budget models
  // take 0 = off, -1 = dynamic). No effort and no budget → thinking
  // stays off (no `thinkingBudget`); an explicit budget alone
  // still enables it. Listed models clamp to their documented
  // range; a model that cannot disable thinking (2.5 Pro) gets no
  // budget at all for `none` — `0` is not a legal value there.
  const thinkingConfig: Record<string, unknown> = {};
  const ranged = thinkingBudgetFor(request.model);
  if (
    reasoning.effort === "none" &&
    ranged !== undefined &&
    !ranged.canDisable
  ) {
    recordNote(
      {
        stage: "encode",
        adapter: "gemini",
        code: "reasoning_effort_raised",
        path: "reasoning.effort",
      },
      `Raising reasoning effort "none" to the model default (${request.model} cannot turn thinking off)`,
    );
    if (reasoning.budgetTokens !== undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "gemini",
          code: "reasoning_budget_dropped",
          path: "reasoning.budget_tokens",
        },
        "Dropping reasoning.budget_tokens (overridden by effort \"none\")",
      );
    }
  } else if (
    reasoning.effort !== undefined ||
    reasoning.budgetTokens !== undefined
  ) {
    let budget = reasoning.budgetTokens ?? budgetFor(reasoning.effort!);
    if (
      ranged !== undefined &&
      budget !== -1 &&
      !(budget === 0 && ranged.canDisable)
    ) {
      const path =
        reasoning.budgetTokens !== undefined
          ? "reasoning.budget_tokens"
          : "reasoning.effort";
      if (budget > ranged.max) {
        recordNote(
          {
            stage: "encode",
            adapter: "gemini",
            code: "reasoning_budget_clamped",
            path,
          },
          `Clamping thinking budget ${budget} to ${ranged.max} (${request.model} maximum)`,
        );
        budget = ranged.max;
      } else if (budget < ranged.min) {
        recordNote(
          {
            stage: "encode",
            adapter: "gemini",
            code: "reasoning_budget_clamped",
            path,
          },
          `Raising thinking budget ${budget} to ${ranged.min} (${request.model} minimum)`,
        );
        budget = ranged.min;
      }
    }
    thinkingConfig.thinkingBudget = budget;
  }
  if (reasoning.summary === true) {
    thinkingConfig.includeThoughts = true;
  }
  return Object.keys(thinkingConfig).length > 0
    ? thinkingConfig
    : undefined;
}

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
        // v1.4 spec §3.3 (Task 7): a call carrying a signature of the
        // current attempt's origin sends it verbatim as the part-level
        // `thoughtSignature`; one with a foreign signature drops it
        // with a `reasoning_dropped` note (signatures never cross
        // provider or model, spec §3.2). A call with no matching
        // signature keeps the v1.3 placeholder — Gemini 3.x upstreams
        // 400 unsigned history functionCall parts ("Function call is
        // missing a thought_signature"). A part-level sibling, not a
        // field of functionCall.
        // https://ai.google.dev/gemini-api/docs/thought-signatures
        parts.push(
          ...calls.map((call) => {
            let thoughtSignature = "skip_thought_signature_validator";
            if (call.signature !== undefined) {
              if (signatureMatchesCurrent(call.signature)) {
                thoughtSignature = call.signature.data;
              } else {
                noteReasoningDropped("signature");
              }
            }
            return functionCallPart(call, { thoughtSignature });
          }),
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

  // v1.4 spec §3.6: Gemini has no parallel-tool-calls field — noted
  // as dropped (only `false` is meaningful; `true` is the default).
  if (request.parallelToolCalls !== undefined) {
    recordNote(
      {
        stage: "encode",
        adapter: "gemini",
        code: "field_dropped",
        path: "parallel_tool_calls",
      },
      'Dropping request field "parallel_tool_calls" (no Gemini equivalent)',
    );
  }

  // Add system instruction — systemText flattens a parts prompt (§3.2)
  const systemMsg = request.messages.find((m) => m.role === "system");
  const systemContent =
    systemText(request.systemPrompt) ??
    systemText(systemMsg?.content) ??
    "";
  if (systemContent) {
    result.systemInstruction = {
      role: "user" as GeminiRole,
      parts: [{ text: systemContent }],
    };
  }

  // Add generation config
  const rf = request.responseFormat;
  if (request.config || rf !== undefined) {
    const c = request.config;
    const thinkingConfig = toThinkingConfig(request);
    const gc: Record<string, unknown> = {
      ...(c?.temperature !== undefined && { temperature: c.temperature }),
      ...(c?.maxTokens !== undefined && { maxOutputTokens: c.maxTokens }),
      ...(c?.topP !== undefined && { topP: c.topP }),
      ...(c?.topK !== undefined && { topK: c.topK }),
      ...(c?.stopSequences && { stopSequences: c.stopSequences }),
      ...(c?.candidateCount !== undefined && {
        candidateCount: c.candidateCount,
      }),
      ...(thinkingConfig !== undefined && { thinkingConfig }),
    };
    if (rf !== undefined) {
      // v1.4 spec §3.5: `responseJsonSchema` is the JSON-Schema field
      // (never the v1.2 tool-parameter sanitiser `toGeminiSchema` —
      // the schema passes through by reference, unchanged);
      // `responseMimeType: "application/json"` is required alongside
      // it and alone encodes `json_object`. Field names per
      // https://ai.google.dev/api/generate-content#GenerationConfig.
      // `name`/`strict`/`description` have no wire slot — extras are
      // noted, `name` never sent.
      noteDroppedFormatExtras("gemini", rf);
      gc.responseMimeType = "application/json";
      if (rf.type === "json_schema") {
        gc.responseJsonSchema = rf.schema;
      }
    }
    result.generationConfig =
      gc as GenerateContentRequest["generationConfig"];
  }

  return result;
}

function mapRoleToGemini(role: CanonicalMessage["role"]): GeminiRole {
  return role === "assistant" ? "model" : "user";
}

function noteReasoningDropped(path: "reasoning" | "signature"): void {
  recordNote(
    {
      stage: "encode",
      adapter: "gemini",
      code: "reasoning_dropped",
      path,
    },
    `Dropping ${path} (origin does not match the current attempt)`,
  );
}

function convertToParts(content: string | CanonicalContentPart[]): Part[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  // Task 7 (v1.4 spec §3.3): a signed part of the current attempt's
  // origin carries `thoughtSignature` on the same wire part it
  // arrived on — signed text on the text part, reasoning as a
  // `thought: true` part, in canonical order. Foreign or missing
  // signatures are dropped with a `reasoning_dropped` note.
  const parts: Part[] = [];
  for (const part of content) {
    if (part.type === "text") {
      let thoughtSignature: string | undefined;
      if (part.signature !== undefined) {
        if (signatureMatchesCurrent(part.signature)) {
          thoughtSignature = part.signature.data;
        } else {
          noteReasoningDropped("signature");
        }
      }
      parts.push({
        text: part.text || "",
        ...(thoughtSignature !== undefined && { thoughtSignature }),
      } as Part);
      continue;
    }
    if (part.type === "image" && part.image) {
      if (part.image.data === undefined) {
        // URL images resolve to bytes in the services (v1.5 Task 6).
        throw new ValidationError(
          'Unsupported "image" content: "url" without "data"',
        );
      }
      parts.push({
        inlineData: {
          mimeType: part.image.mimeType,
          data: part.image.data,
        },
      });
      continue;
    }
    if (part.type === "reasoning" && part.reasoning) {
      if (
        originMatchesCurrent(part.reasoning.origin) &&
        signatureMatchesCurrent(part.signature)
      ) {
        parts.push({
          text: part.reasoning.text ?? "",
          thought: true,
          thoughtSignature: part.signature.data,
        } as Part);
      } else {
        noteReasoningDropped("reasoning");
      }
      continue;
    }
    parts.push({ text: "" });
  }
  return parts;
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

  // v1.4 spec §3.3 (Tasks 7/7a, #99): `thought: true` marks a
  // reasoning part — it decodes with the attempt origin and keeps its
  // `thoughtSignature` sibling as the part's signature. A
  // `thoughtSignature` on a text part becomes that part's signature
  // (Task 7a: the stream twin carries it as `text_signature`).
  // Signatures on functionCall parts ride through
  // toCanonicalToolCalls; on any other part kind there is no
  // signature-carrying canonical part, so the drop is still noted.
  const origin = decodeOrigin(model);
  const out: CanonicalContentPart[] = [];
  let hasReasoning = false;
  let hasSignedText = false;
  for (const part of parts) {
    const p = part as {
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
    };
    if (isFunctionCallPart(part) || isFunctionResponsePart(part)) {
      continue;
    }
    const sig =
      typeof p.thoughtSignature === "string" && p.thoughtSignature !== ""
        ? { origin, data: p.thoughtSignature }
        : undefined;
    if (p.thought === true) {
      hasReasoning = true;
      out.push({
        type: "reasoning",
        reasoning: { text: p.text ?? "", origin },
        ...(sig !== undefined && { signature: sig }),
      });
      continue;
    }
    if (typeof p.text === "string") {
      if (sig !== undefined) hasSignedText = true;
      out.push({
        type: "text",
        text: p.text,
        ...(sig !== undefined && { signature: sig }),
      });
      continue;
    }
    if ("inlineData" in part && part.inlineData) {
      if (sig !== undefined) {
        recordNote(
          {
            stage: "decode",
            adapter: "gemini",
            code: "reasoning_dropped",
            path: "signature",
          },
          "Dropping thoughtSignature on a non-text part (no canonical signature for it)",
        );
      }
      out.push({
        type: "image",
        image: {
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType as CanonicalImageMimeType,
        },
      });
      continue;
    }
    if (sig !== undefined) {
      // A signed part with no text — Gemini can sign an empty final
      // part (max_tokens.nonstreaming.json records the shape).
      hasSignedText = true;
      out.push({ type: "text", text: "", signature: sig });
    }
  }

  const text = out
    .filter((p): p is { type: "text"; text?: string } => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
  const toolCalls = toCanonicalToolCalls(parts, ids, origin);

  return {
    id: `gemini-${randomUUID()}`,
    model,
    message: {
      role: "assistant",
      content: hasReasoning || hasSignedText ? out : text,
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
 * v1.4 §3.2/E9: `thoughtsTokenCount` (thinking models) is billed output —
 * it joins outputTokens and is reported as reasoningTokens.
 */
export function geminiUsageToCanonical(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}): CanonicalUsage {
  const read = usage.cachedContentTokenCount ?? 0;
  const input = usage.promptTokenCount ?? 0;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  const output = (usage.candidatesTokenCount ?? 0) + thoughts;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.totalTokenCount ?? input + output,
    ...(read > 0 && { cacheReadTokens: read }),
    ...(thoughts > 0 && { reasoningTokens: thoughts }),
  };
}

/** Canonical → usageMetadata; `cachedContentTokenCount` and
 *  `thoughtsTokenCount` appear only when non-zero. outputTokens
 *  includes reasoning, so candidatesTokenCount subtracts it back. */
export function geminiUsageFromCanonical(
  usage: NonNullable<CanonicalResponse["usage"]>,
): {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
} {
  const thoughts = usage.reasoningTokens ?? 0;
  return {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens - thoughts,
    totalTokenCount: usage.totalTokens,
    ...(usage.cacheReadTokens !== undefined &&
      usage.cacheReadTokens > 0 && {
        cachedContentTokenCount: usage.cacheReadTokens,
      }),
    ...(thoughts > 0 && { thoughtsTokenCount: thoughts }),
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
  const message = response.message;
  const toolCalls = message.toolCalls ?? [];

  // v1.5 spec §3.1 (Task 4) + conductor's call (a): reasoning reaches
  // the Gemini client inside the `bg1.` envelope — reasoning parts
  // become `{text, thought: true}` parts and the turn's envelope
  // (all reasoning parts and signatures) rides the first thought
  // part's `thoughtSignature`, or the first functionCall part's when
  // there is no thought part. `thought: true`/`thoughtSignature`:
  // https://ai.google.dev/gemini-api/docs/thinking and
  // https://ai.google.dev/gemini-api/docs/thought-signatures
  // (part fields per https://ai.google.dev/api/generate-content#Part).
  const parts_: CanonicalContentPart[] =
    typeof message.content === "string"
      ? message.content === ""
        ? []
        : [{ type: "text", text: message.content }]
      : (message.content ?? []);
  const envelopeSigs: EnvelopePayload["signatures"] = [];
  let textIndex = 0;
  const hasReasoning = parts_.some((p) => p.type === "reasoning");
  for (const part of parts_) {
    if (part.type === "text") {
      if (part.signature !== undefined) {
        envelopeSigs.push({ textIndex, signature: part.signature });
      }
      textIndex++;
    } else if (
      part.type !== "reasoning" &&
      part.signature !== undefined
    ) {
      recordNote(
        {
          stage: "encode",
          adapter: "gemini",
          code: "reasoning_dropped",
          path: "signature",
        },
        "Dropping a signature on a non-text part (no Gemini field carries it)",
      );
    }
  }
  for (const call of toolCalls) {
    if (call.signature !== undefined) {
      envelopeSigs.push({
        toolCallId: call.id,
        signature: call.signature,
      });
    }
  }

  let parts: Part[];
  if (!hasReasoning && envelopeSigs.length === 0) {
    const content = parts_
      .filter((p) => p.type === "text")
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    const callPart = (call: CanonicalToolCall): Part =>
      functionCallPart(call, { includeId: true });
    parts =
      toolCalls.length > 0 && content === ""
        ? toolCalls.map(callPart)
        : [{ text: content }, ...toolCalls.map(callPart)];
  } else {
    const reasoningParts = parts_.filter(
      (p) => p.type === "reasoning",
    );
    const envelope = packEnvelope({
      v: 1,
      reasoning: reasoningParts,
      signatures: envelopeSigs,
    });
    if (envelope === undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "gemini",
          code: "reasoning_dropped",
          path: "reasoning",
        },
        "Dropping a thoughtSignature envelope (over the 1 MiB cap)",
      );
    }
    parts = [];
    let attached = false;
    for (const part of parts_) {
      if (part.type === "reasoning" && part.reasoning) {
        const thoughtPart: Part = {
          text: part.reasoning.text ?? "",
          thought: true,
          ...(!attached && envelope !== undefined
            ? { thoughtSignature: envelope }
            : {}),
        } as Part;
        if (!attached && envelope !== undefined) attached = true;
        parts.push(thoughtPart);
        continue;
      }
      if (part.type === "text") {
        parts.push({ text: part.text ?? "" } as Part);
        continue;
      }
    }
    for (const [i, call] of toolCalls.entries()) {
      const onFirst =
        !attached && envelope !== undefined && i === 0
          ? { thoughtSignature: envelope }
          : {};
      if (Object.keys(onFirst).length > 0) attached = true;
      parts.push(
        functionCallPart(call, { includeId: true, ...onFirst }),
      );
    }
    if (!attached && envelope !== undefined) {
      recordNote(
        {
          stage: "encode",
          adapter: "gemini",
          code: "reasoning_dropped",
          path: "reasoning",
        },
        "Dropping a thoughtSignature envelope (no thought or functionCall part to carry it)",
      );
    }
  }

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
