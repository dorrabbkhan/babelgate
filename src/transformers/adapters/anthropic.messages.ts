import type {
  CanonicalCacheHint,
  CanonicalFunction,
  CanonicalMessage,
  CanonicalContentPart,
  CanonicalImageMimeType,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalToolChoice,
} from "../../types/canonical.types";
import { parseToolArguments } from "../../utils/tool-args";
import { ValidationError } from "../../utils/errors";
import { recordNote } from "../../observe/context";
import { logger } from "../../utils/logger";
import {
  originMatchesCurrent,
  signatureMatchesCurrent,
} from "../reasoning-origin";
import {
  unpackEnvelope,
  type EnvelopePayload,
} from "../reasoning-envelope";
import { toCacheControl, toCacheHint } from "./anthropic.cache";
import type {
  CacheControlEphemeral,
  MessageParam,
  ContentBlockParam,
  Tool,
  ToolChoice,
  ToolResultBlockParam,
  ToolUnion,
  ToolUseBlockParam,
} from "../../types/anthropic.types";

/**
 * Anthropic request-message layer (spec §3.4): message, content-block,
 * tool_result/tool_use, tools[] and tool_choice conversion. Kept out of
 * anthropic.adapter.ts to keep that file under ~400 lines; imports only
 * src/types and src/utils, same as the adapter itself.
 */

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

// ============ Anthropic → Canonical ============

/**
 * One Anthropic message → one or more canonical messages (spec §3.4):
 * a user message's tool_result blocks become one canonical tool message
 * each (in order), followed by a user message for any remaining
 * text/image blocks. Assistant tool_use blocks become toolCalls.
 * `messageIndex` is the wire index, for note paths (§3.5).
 */
export function toCanonicalMessage(
  m: MessageParam,
  messageIndex = 0,
): CanonicalMessage[] {
  if (typeof m.content === "string" || !Array.isArray(m.content)) {
    return [
      {
        role: m.role as CanonicalMessage["role"],
        content: typeof m.content === "string" ? m.content : "",
      },
    ];
  }

  const blocks = m.content;
  const toolResults = blocks.filter(
    (b): b is ToolResultBlockParam => b.type === "tool_result",
  );
  const toolUses = blocks.filter(
    (b): b is ToolUseBlockParam => b.type === "tool_use",
  );
  const rest = blocks.filter(
    (b) => b.type !== "tool_result" && b.type !== "tool_use",
  );
  // Envelope signatures decoded off thinking blocks — resolved onto
  // the message once its parts and toolCalls exist.
  const envelopeSigs: EnvelopePayload["signatures"] = [];

  if (m.role === "user" && toolResults.length > 0) {
    const out: CanonicalMessage[] = toolResults.map((r) => {
      const cache = toolResultHint(r);
      return {
        role: "tool",
        toolCallId: r.tool_use_id,
        content: toolResultContent(r.content),
        ...(r.is_error === true && { isError: true }),
        ...(cache && { cache }),
      };
    });
    if (rest.length > 0) {
      const msg: CanonicalMessage = {
        role: "user",
        content: extractContent(rest, messageIndex, envelopeSigs),
      };
      resolveEnvelopeSignatures(msg, envelopeSigs, messageIndex);
      out.push(msg);
    }
    return out;
  }

  const msg: CanonicalMessage = {
    role: m.role as CanonicalMessage["role"],
    content: extractContent(rest, messageIndex, envelopeSigs),
  };
  if (toolUses.length > 0) {
    msg.toolCalls = toolUses.map(toolUseToCanonical);
  }
  resolveEnvelopeSignatures(msg, envelopeSigs, messageIndex);
  return [msg];
}

/**
 * v1.5 spec §3.1 (Task 4): `bg1.` envelopes decoded off thinking
 * blocks yield signature entries keyed by `toolCallId` or `textIndex`
 * (the nth text part of the message) — resolve them onto the decoded
 * message; an entry with no matching part drops with a
 * `reasoning_dropped` note.
 */
function resolveEnvelopeSignatures(
  msg: CanonicalMessage,
  signatures: EnvelopePayload["signatures"],
  messageIndex: number,
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
        adapter: "anthropic",
        code: "reasoning_dropped",
        path: `messages[${messageIndex}].signatures[${i}]`,
      },
      "Dropping an envelope signature (no matching part in the message)",
    );
  }
}

/**
 * The cache hint a tool_result carries (Task 17a): its own
 * cache_control — the block-level breakpoint ends the whole result —
 * or, when absent, the last hinted nested text block (Claude Code's
 * moving breakpoint sits on the last block of the last tool_result).
 * Extra hints beyond the carried one still fire
 * `cache_control_dropped` (hasUncarriedCacheControl).
 */
function toolResultHint(
  r: ToolResultBlockParam,
): CanonicalCacheHint | undefined {
  const own = toCacheHint(r.cache_control);
  if (own !== undefined) return own;
  if (!Array.isArray(r.content)) return undefined;
  const hinted = r.content.filter(
    (b) => b.type === "text" && b.cache_control,
  );
  return toCacheHint(
    hinted[hinted.length - 1]?.cache_control,
  );
}

/**
 * tool_result.content is a string or an array of blocks (spec §3.4).
 * Text-only content joins with "\n" as before; v1.5 spec §3.2.1 keeps
 * image blocks as canonical tool image parts — the result is then a
 * parts array in wire order (Claude Code's media run sends
 * text+image mixes, E14). Any other block type is a 400 naming it —
 * never a silent drop.
 */
function toolResultContent(
  content: ToolResultBlockParam["content"],
): string | CanonicalContentPart[] {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!content.some((b) => b.type === "image")) {
    return content
      .map((block) => {
        if (block.type === "text") {
          return block.text;
        }
        throw new ValidationError(
          `Unsupported content block type "${block.type}" in tool_result`,
        );
      })
      .join("\n");
  }
  const parts: CanonicalContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      parts.push(imageSourceToPart(block.source));
      continue;
    }
    // document/search_result/tool_reference/… blocks — no canonical
    // slot on a tool message (tool messages carry text and image
    // parts only, §3.2.1) — a loud 400 naming the type.
    throw new ValidationError(
      `Unsupported content block type "${block.type}" in tool_result`,
    );
  }
  return parts;
}

/** An Anthropic `image` block's source → canonical image part. */
function imageSourceToPart(source: {
  type?: string;
  media_type?: string;
  data?: string;
  url?: string;
}): CanonicalContentPart {
  if (source.type === "base64" && source.data) {
    return {
      type: "image",
      image: {
        data: source.data,
        mimeType: (source.media_type ||
          "image/png") as CanonicalImageMimeType,
      },
    };
  }
  if (source.type === "url" && typeof source.url === "string") {
    // v1.5 spec §3.2.2: a URL image source keeps its URL —
    // media-inline fetches or passes it through per target.
    return { type: "image", image: { url: source.url } };
  }
  // file / unrecognised image sources — a loud 400, never an
  // empty text part pretending to carry the image.
  throw new ValidationError(
    `Unsupported image source type "${source.type}"`,
  );
}

/**
 * Anthropic `document` block → canonical document part (v1.5 spec
 * §3.2.2). Source variants per
 * https://platform.claude.com/docs/en/build-with-claude/pdf-support:
 * base64 (PDF bytes), text (plain-text source carried as utf-8 →
 * base64), url (PDFs only on the wire). `content` (a nested block
 * array) and `file` (stored-file references) have no canonical
 * equivalent — a 400 naming the source type, never a silent drop.
 */
function toCanonicalDocumentPart(
  block: {
    source: unknown;
    title?: string | null;
    cache_control?: unknown;
  },
  path: string,
): CanonicalContentPart {
  const source = (block.source ?? {}) as {
    type?: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
  const name =
    typeof block.title === "string" && block.title !== ""
      ? { name: block.title }
      : {};
  const cache =
    block.cache_control !== undefined && block.cache_control !== null
      ? {
          cache: toCacheHint(
            block.cache_control as Parameters<typeof toCacheHint>[0],
          ),
        }
      : {};
  switch (source.type) {
    case "base64":
      if (source.media_type !== "application/pdf" || !source.data) {
        throw new ValidationError(
          `Unsupported document source media_type "${source.media_type ?? "none"}" at ${path}`,
        );
      }
      return {
        type: "document",
        document: {
          data: source.data,
          mimeType: "application/pdf",
          ...name,
        },
        ...cache,
      };
    case "text":
      if (typeof source.data !== "string") {
        throw new ValidationError(
          `Unsupported document text source at ${path}`,
        );
      }
      return {
        type: "document",
        document: {
          data: Buffer.from(source.data, "utf8").toString("base64"),
          mimeType: "text/plain",
          ...name,
        },
        ...cache,
      };
    case "url":
      if (typeof source.url !== "string" || source.url === "") {
        throw new ValidationError(
          `Unsupported document url source at ${path}`,
        );
      }
      return {
        type: "document",
        document: { url: source.url, mimeType: "application/pdf", ...name },
        ...cache,
      };
    default:
      throw new ValidationError(
        `Unsupported document source type "${source.type ?? "none"}" at ${path}`,
      );
  }
}

function toolUseToCanonical(block: ToolUseBlockParam): CanonicalToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    },
  };
}

export function toCanonicalTool(tool: ToolUnion): CanonicalTool {
  if (!("name" in tool)) {
    // Server-side toolsets have no canonical equivalent — 400 naming
    // the type rather than silently dropping the declaration.
    throw new ValidationError(
      `Unsupported tool type "${tool.type}" in tools[]`,
    );
  }
  const fn: CanonicalFunction = { name: tool.name };
  if ("description" in tool && typeof tool.description === "string") {
    fn.description = tool.description;
  }
  if ("input_schema" in tool && tool.input_schema) {
    fn.parameters = tool.input_schema as Record<string, unknown>;
  }
  const cache =
    "cache_control" in tool ? toCacheHint(tool.cache_control) : undefined;
  return {
    type: "function",
    function: fn,
    ...(cache && { cache }),
  };
}

// auto→auto, any→required, tool{name}→function choice, none→none (§3.4).
export function toCanonicalToolChoice(choice: ToolChoice): CanonicalToolChoice {
  if (
    "disable_parallel_tool_use" in choice &&
    choice.disable_parallel_tool_use !== undefined
  ) {
    recordNote(
      {
        stage: "decode",
        adapter: "anthropic",
        code: "disable_parallel_tool_use_dropped",
        path: "tool_choice.disable_parallel_tool_use",
      },
      'Dropping tool_choice field "disable_parallel_tool_use" (no canonical equivalent)',
    );
  }
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}

/**
 * §3.5 + v1.5 §3.1 (Task 4): a `thinking`/`redacted_thinking` block's
 * `signature`/`data` field carries a `bg1.` envelope that unpacks to
 * canonical reasoning parts and signatures in place (the parts keep
 * the block's position; the signatures collect into `envelopeSigs`
 * for `resolveEnvelopeSignatures`). Anything else on those fields —
 * a raw upstream signature, or nothing — drops the block with a
 * `reasoning_dropped` note naming the path (conductor's call (c));
 * any other unrecognised block type is a 400 naming it — Claude Code
 * blocks we can't honour must fail loudly, not silently turn into
 * empty text. Block shapes:
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 * (`thinking.signature`, `redacted_thinking.data`;
 * https://platform.claude.com/docs/en/build-with-claude/thinking).
 */
function extractContent(
  content: MessageParam["content"],
  messageIndex = 0,
  envelopeSigs: EnvelopePayload["signatures"] = [],
): string | CanonicalContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  const parts: CanonicalContentPart[] = [];
  for (const [blockIndex, block] of content.entries()) {
    if (block.type === "text") {
      parts.push({
        type: "text",
        text: block.text,
        ...(block.cache_control && { cache: toCacheHint(block.cache_control) }),
      });
      continue;
    }
    if (block.type === "image" && "source" in block) {
      // https://platform.claude.com/docs/en/build-with-claude/vision
      const part = imageSourceToPart(
        block.source as {
          type?: string;
          media_type?: string;
          data?: string;
          url?: string;
        },
      );
      parts.push(
        block.cache_control
          ? { ...part, cache: toCacheHint(block.cache_control) }
          : part,
      );
      continue;
    }
    if (block.type === "document" && "source" in block) {
      parts.push(
        toCanonicalDocumentPart(
          block as {
            source: unknown;
            title?: string | null;
            cache_control?: unknown;
          },
          `messages[${messageIndex}].content[${blockIndex}]`,
        ),
      );
      continue;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      const carrier =
        block.type === "thinking"
          ? (block as { signature?: unknown }).signature
          : (block as { data?: unknown }).data;
      const payload =
        typeof carrier === "string"
          ? unpackEnvelope(carrier)
          : undefined;
      if (payload !== undefined) {
        parts.push(...payload.reasoning);
        envelopeSigs.push(...payload.signatures);
      } else {
        recordNote(
          {
            stage: "decode",
            adapter: "anthropic",
            code: "reasoning_dropped",
            path: `messages[${messageIndex}].content[${blockIndex}]`,
          },
          `Dropping content block "${block.type}" (its ${block.type === "thinking" ? "signature" : "data"} is not a bg1. envelope)`,
        );
      }
      continue;
    }
    throw new ValidationError(
      `Unsupported content block type "${block.type}"`,
    );
  }

  return parts.length > 0 ? parts : "";
}

// ============ Canonical → Anthropic ============

export function toMessageParam(m: CanonicalMessage): MessageParam {
  const content = convertToAnthropicContent(m.content);

  if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) {
    return { role: m.role === "assistant" ? "assistant" : "user", content };
  }

  // Assistant message: text (and other content blocks) first, then the
  // tool_use blocks (spec §3.4).
  const blocks: ContentBlockParam[] =
    typeof content === "string"
      ? content
        ? [{ type: "text", text: content }]
        : []
      : content;
  return {
    role: "assistant",
    content: [
      ...blocks,
      ...m.toolCalls.map((tc) => toToolUseBlock(tc)),
    ],
  };
}

/**
 * Task 7 (v1.4 spec §3.3): a canonical signature on anything Anthropic
 * can't carry it on — a text part or a tool call (the wire has no
 * signature slot on either) — is dropped with a `reasoning_dropped`
 * note when its origin is foreign, or when Anthropic has no field for
 * it at all.
 */
export function noteOrphanedSignature(path: string): void {
  recordNote(
    {
      stage: "encode",
      adapter: "anthropic",
      code: "reasoning_dropped",
      path,
    },
    `Dropping signature at ${path} (no Anthropic field carries it)`,
  );
}

export function toToolResultBlock(m: CanonicalMessage): ToolResultBlockParam {
  const cacheControl = toCacheControl(m.cache);
  // A tool_result carries no thinking blocks — reasoning parts in a
  // tool message's content are dropped before conversion.
  const content = Array.isArray(m.content)
    ? m.content.filter((p) => p.type !== "reasoning")
    : m.content;
  return {
    type: "tool_result",
    tool_use_id: m.toolCallId ?? "",
    // Reasoning parts were filtered above, so no thinking blocks can
    // be emitted — the tool_result content union can't carry them.
    content: convertToAnthropicContent(
      content,
    ) as ToolResultBlockParam["content"],
    // is_error is sent only when true; Anthropic defaults it to false.
    ...(m.isError === true && { is_error: true }),
    ...(cacheControl && { cache_control: cacheControl }),
  };
}

export function toToolUseBlock(
  tc: CanonicalToolCall,
  opts: { noteSignature?: boolean } = {},
): ToolUseBlockParam {
  const parsed = parseToolArguments(tc.function.arguments);
  if (!parsed.valid) {
    logger.warn(
      "Tool call arguments are not valid JSON; sending _invalid_arguments wrapper",
    );
  }
  if (tc.signature !== undefined && opts.noteSignature !== false) {
    noteOrphanedSignature(`toolCalls[${tc.id}].signature`);
  }
  return {
    type: "tool_use",
    id: tc.id,
    name: tc.function.name,
    input: parsed.args,
  };
}

export function toAnthropicTool(tool: CanonicalTool): Tool {
  if (tool.type !== "function") {
    // Custom tools are lowered to function tools by canonicalForTarget
    // before encode (v1.4 spec §3.6) — one reaching here is a bug.
    throw new ValidationError(
      `Unsupported tool type "${tool.type}" in tools[]`,
    );
  }
  const cacheControl = toCacheControl(tool.cache);
  return {
    name: tool.function.name,
    ...(tool.function.description && {
      description: tool.function.description,
    }),
    input_schema: {
      type: "object",
      ...(tool.function.parameters ?? {}),
    } as Tool["input_schema"],
    ...(cacheControl && { cache_control: cacheControl }),
  };
}

// auto→auto, required→any, none→none, function choice→tool{name} (§3.4).
export function toAnthropicToolChoice(choice: CanonicalToolChoice): ToolChoice {
  if (typeof choice === "object") {
    return { type: "tool", name: choice.function.name };
  }
  switch (choice) {
    case "auto":
      return { type: "auto" };
    case "required":
      return { type: "any" };
    case "none":
      return { type: "none" };
  }
}

type AnthropicContentBlock =
  | {
      type: "text";
      text: string;
      cache_control?: CacheControlEphemeral;
    }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: ImageMediaType; data: string }
        | { type: "url"; url: string };
      cache_control?: CacheControlEphemeral;
    }
  | {
      type: "document";
      source:
        | { type: "base64"; media_type: "application/pdf"; data: string }
        | { type: "url"; url: string };
      title?: string;
      cache_control?: CacheControlEphemeral;
    }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

function convertToAnthropicContent(
  content: string | CanonicalContentPart[],
): string | AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content;
  }

  // Task 7 (v1.4 spec §3.3): reasoning parts keep their canonical
  // position — a thinking block that preceded a text/tool_use block is
  // reinserted at its original index. They are emitted only when their
  // signature's origin matches the current attempt; anything else is
  // dropped with a `reasoning_dropped` note.
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    const cacheControl = toCacheControl(part.cache);
    if (part.type === "text") {
      if (part.signature !== undefined) {
        noteOrphanedSignature(`content.signature`);
      }
      blocks.push({
        type: "text",
        text: part.text || "",
        ...(cacheControl && { cache_control: cacheControl }),
      });
      continue;
    }
    if (part.type === "image" && part.image) {
      // v1.5 §3.2.2: image source takes a URL on the wire —
      // https://platform.claude.com/docs/en/build-with-claude/vision
      const source =
        part.image.data === undefined
          ? { type: "url" as const, url: part.image.url! }
          : {
              type: "base64" as const,
              media_type: validateMediaType(part.image.mimeType),
              data: part.image.data,
            };
      blocks.push({
        type: "image",
        source,
        ...(cacheControl && { cache_control: cacheControl }),
      });
      continue;
    }
    if (part.type === "document" && part.document) {
      blocks.push(toDocumentBlock(part.document, cacheControl));
      continue;
    }
    if (part.type === "reasoning" && part.reasoning) {
      if (
        originMatchesCurrent(part.reasoning.origin) &&
        signatureMatchesCurrent(part.signature)
      ) {
        if (part.reasoning.redacted === true) {
          blocks.push({
            type: "redacted_thinking",
            data: part.signature.data,
          });
        } else {
          blocks.push({
            type: "thinking",
            thinking: part.reasoning.text ?? "",
            signature: part.signature.data,
          });
        }
      } else {
        recordNote(
          {
            stage: "encode",
            adapter: "anthropic",
            code: "reasoning_dropped",
            path: "reasoning",
          },
          "Dropping reasoning part (no matching-origin signature)",
        );
      }
      continue;
    }
    blocks.push({ type: "text", text: "" });
  }

  // If only one text block, return as string — unless it carries a
  // cache hint, which only a block can express.
  if (
    blocks.length === 1 &&
    blocks[0].type === "text" &&
    blocks[0].cache_control === undefined
  ) {
    return blocks[0].text;
  }

  return blocks;
}

/**
 * Canonical document → Anthropic `document` block (v1.5 §3.2.2):
 * PDF bytes → base64 source; a URL → url source (the wire supports
 * PDFs by URL); `name` rides as `title`. A text/plain document —
 * converted to a text part by media-inline — defensively encodes
 * as a text block when its data reaches the encoder; a text/plain
 * URL can only arrive un-fetched, which nothing can encode.
 * https://platform.claude.com/docs/en/build-with-claude/pdf-support
 */
function toDocumentBlock(
  document: {
    data?: string;
    url?: string;
    mimeType: string;
    name?: string;
  },
  cacheControl: CacheControlEphemeral | undefined,
): AnthropicContentBlock {
  const title =
    document.name !== undefined ? { title: document.name } : {};
  if (document.mimeType === "text/plain") {
    if (document.data === undefined) {
      throw new ValidationError(
        'Unsupported "document" content: "url" without "data"',
      );
    }
    return {
      type: "text",
      text: Buffer.from(document.data, "base64").toString("utf8"),
      ...(cacheControl && { cache_control: cacheControl }),
    };
  }
  const source =
    document.url !== undefined
      ? { type: "url" as const, url: document.url }
      : document.data !== undefined
        ? {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: document.data,
          }
        : (() => {
            throw new ValidationError(
              'Unsupported "document" content: neither "url" nor "data"',
            );
          })();
  return {
    type: "document",
    source,
    ...title,
    ...(cacheControl && { cache_control: cacheControl }),
  };
}

function validateMediaType(type: string): ImageMediaType {
  const validTypes: ImageMediaType[] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ];
  return validTypes.includes(type as ImageMediaType)
    ? (type as ImageMediaType)
    : "image/png";
}
