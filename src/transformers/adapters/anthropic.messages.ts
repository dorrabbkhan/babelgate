import type {
  CanonicalMessage,
  CanonicalContentPart,
  CanonicalImage,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalToolChoice,
} from "../../types/canonical.types";
import { parseToolArguments } from "../../utils/tool-args";
import { ValidationError } from "../../utils/errors";
import { logger } from "../../utils/logger";
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
 */
export function toCanonicalMessage(m: MessageParam): CanonicalMessage[] {
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

  if (m.role === "user" && toolResults.length > 0) {
    const out: CanonicalMessage[] = toolResults.map((r) => ({
      role: "tool",
      toolCallId: r.tool_use_id,
      content: toolResultContentToString(r.content),
      ...(r.is_error === true && { isError: true }),
    }));
    if (rest.length > 0) {
      out.push({ role: "user", content: extractContent(rest) });
    }
    return out;
  }

  const msg: CanonicalMessage = {
    role: m.role as CanonicalMessage["role"],
    content: extractContent(rest),
  };
  if (toolUses.length > 0) {
    msg.toolCalls = toolUses.map(toolUseToCanonical);
  }
  return [msg];
}

/**
 * tool_result.content is a string or an array of blocks (spec §3.4). Text
 * blocks join with "\n"; canonical tool results carry no images, so any
 * other block type is a 400 naming it — never a silent drop.
 */
function toolResultContentToString(
  content: ToolResultBlockParam["content"],
): string {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
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
  const fn: CanonicalTool["function"] = { name: tool.name };
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
    logger.debug(
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
 * §3.5: `thinking`/`redacted_thinking` blocks are dropped safely (debug
 * log names the type only); any other unrecognised block type is a 400
 * naming it — Claude Code blocks we can't honour must fail loudly, not
 * silently turn into empty text.
 */
function extractContent(
  content: MessageParam["content"],
): string | CanonicalContentPart[] {
  if (typeof content === "string") {
    return content;
  }

  const parts: CanonicalContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({
        type: "text",
        text: block.text,
        ...(block.cache_control && { cache: toCacheHint(block.cache_control) }),
      });
      continue;
    }
    if (block.type === "image" && "source" in block) {
      const source = block.source as {
        type: string;
        media_type?: string;
        data?: string;
      };
      if (source.type === "base64" && source.data) {
        parts.push({
          type: "image",
          image: {
            data: source.data,
            mimeType: (source.media_type ||
              "image/png") as CanonicalImage["mimeType"],
          },
          ...(block.cache_control && {
            cache: toCacheHint(block.cache_control),
          }),
        });
      } else {
        // image without a usable base64 source keeps the old placeholder
        parts.push({ type: "text", text: "" });
      }
      continue;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      logger.debug(
        `Dropping content block "${block.type}" (no canonical equivalent)`,
      );
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
    content: [...blocks, ...m.toolCalls.map(toToolUseBlock)],
  };
}

export function toToolResultBlock(m: CanonicalMessage): ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: m.toolCallId ?? "",
    content: convertToAnthropicContent(m.content),
    // is_error is sent only when true; Anthropic defaults it to false.
    ...(m.isError === true && { is_error: true }),
  };
}

export function toToolUseBlock(tc: CanonicalToolCall): ToolUseBlockParam {
  const parsed = parseToolArguments(tc.function.arguments);
  if (!parsed.valid) {
    logger.warn(
      "Tool call arguments are not valid JSON; sending _invalid_arguments wrapper",
    );
  }
  return {
    type: "tool_use",
    id: tc.id,
    name: tc.function.name,
    input: parsed.args,
  };
}

export function toAnthropicTool(tool: CanonicalTool): Tool {
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
      source: { type: "base64"; media_type: ImageMediaType; data: string };
      cache_control?: CacheControlEphemeral;
    };

function convertToAnthropicContent(
  content: string | CanonicalContentPart[],
): string | AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content;
  }

  const blocks: AnthropicContentBlock[] = content.map((part) => {
    const cacheControl = toCacheControl(part.cache);
    if (part.type === "text") {
      return {
        type: "text",
        text: part.text || "",
        ...(cacheControl && { cache_control: cacheControl }),
      };
    }
    if (part.type === "image" && part.image) {
      return {
        type: "image",
        source: {
          type: "base64" as const,
          media_type: validateMediaType(part.image.mimeType),
          data: part.image.data,
        },
        ...(cacheControl && { cache_control: cacheControl }),
      };
    }
    return { type: "text", text: "" };
  });

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
