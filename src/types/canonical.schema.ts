import { z } from "zod";

/**
 * Zod schemas mirroring canonical.types.ts.
 * Used for runtime contract validation of adapter outputs.
 */

const roleSchema = z.enum(["system", "user", "assistant", "tool"]);

const mimeTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const imageSchema = z.object({
  data: z.string(),
  mimeType: mimeTypeSchema,
});

const cacheHintSchema = z.object({
  ttl: z.enum(["5m", "1h"]).optional(),
});

const contentPartSchema = z
  .object({
    type: z.enum(["text", "image"]),
    text: z.string().optional(),
    image: imageSchema.optional(),
    cache: cacheHintSchema.optional(),
  })
  .refine((p) => (p.type === "text" ? p.text !== undefined : true), {
    message: "content part of type 'text' must have text",
  });

// systemPrompt parts are text-only (spec §3.2)
const systemPromptSchema = z.union([
  z.string(),
  z
    .array(contentPartSchema)
    .refine((parts) => parts.every((p) => p.type === "text"), {
      message: "system prompt parts must be text",
    }),
]);

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const canonicalMessageSchema = z.object({
  role: roleSchema,
  content: z.union([z.string(), z.array(contentPartSchema)]),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  cache: cacheHintSchema.optional(),
  name: z.string().optional(),
});

export const canonicalConfigSchema = z.object({
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().optional(),
  topK: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).optional(),
  candidateCount: z.number().int().positive().optional(),
  seed: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  contextWindow: z.number().int().positive().optional(),
});

const functionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const canonicalToolSchema = z.object({
  type: z.literal("function"),
  function: functionSchema,
  cache: cacheHintSchema.optional(),
});

export const canonicalToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() }),
  }),
]);

export const canonicalRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(canonicalMessageSchema).min(1),
  systemPrompt: systemPromptSchema.optional(),
  config: canonicalConfigSchema.optional(),
  tools: z.array(canonicalToolSchema).optional(),
  toolChoice: canonicalToolChoiceSchema.optional(),
  stream: z.boolean().optional(),
});

export const finishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_call",
  "content_filter",
  "error",
  "unknown",
]);

export const canonicalUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});

export const canonicalResponseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  message: canonicalMessageSchema,
  finishReason: finishReasonSchema,
  usage: canonicalUsageSchema.optional(),
  created: z.number().optional(),
});

// ============ ERRORS ============

export const canonicalErrorKindSchema = z.enum([
  "invalid_request",
  "authentication",
  "permission",
  "not_found",
  "request_too_large",
  "rate_limit",
  "unsupported",
  "upstream",
  "unavailable",
  "timeout",
  "internal",
]);

export const canonicalErrorSchema = z.object({
  kind: canonicalErrorKindSchema,
  status: z.number().int(),
  message: z.string(),
  retryAfterSeconds: z.number().optional(),
});

// ============ MODEL LIST ============

export const canonicalModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  created: z.number().optional(),
  ownedBy: z.string().optional(),
});

export const canonicalModelListSchema = z.object({
  models: z.array(canonicalModelSchema),
});

// ============ STREAMING ============

const streamIndexSchema = z.number().int().nonnegative();

export const canonicalStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_start"),
    id: z.string(),
    model: z.string(),
  }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({
    type: z.literal("tool_call_start"),
    index: streamIndexSchema,
    id: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_delta"),
    index: streamIndexSchema,
    argumentsDelta: z.string(),
  }),
  z.object({ type: z.literal("tool_call_end"), index: streamIndexSchema }),
  z.object({ type: z.literal("usage"), usage: canonicalUsageSchema }),
  z.object({
    type: z.literal("message_end"),
    finishReason: finishReasonSchema,
  }),
  z.object({ type: z.literal("error"), error: canonicalErrorSchema }),
]);
