import type {
  CanonicalRequest,
  CanonicalStreamEvent,
} from "../types/canonical.types";
import { systemText } from "../transformers/system-text";

/**
 * Local input-token estimate (spec §3.5): ceil(chars / 4) over the system
 * prompt, message text, tool-call arguments, tool-result content and
 * JSON.stringify(tools). A rough count — used for the locally answered
 * count_tokens endpoint and the Anthropic message_start estimate, never
 * billed against a real tokenizer.
 */
export function estimateInputTokens(req: CanonicalRequest): number {
  // Adapters keep the system text in BOTH systemPrompt and a system-role
  // message — count it once, via whichever field carries it.
  let chars = systemText(req.systemPrompt)?.length ?? 0;
  const systemInPrompt = req.systemPrompt !== undefined;

  for (const message of req.messages) {
    if (message.role === "system" && systemInPrompt) {
      // duplicates req.systemPrompt — already counted
    } else if (typeof message.content === "string") {
      chars += message.content.length;
    } else {
      for (const part of message.content) {
        if (part.type === "text" && part.text) chars += part.text.length;
      }
    }
    for (const call of message.toolCalls ?? []) {
      chars += call.function.arguments.length;
    }
  }

  if (req.tools) chars += JSON.stringify(req.tools).length;

  return Math.ceil(chars / 4);
}

/**
 * Output side of the local estimate (spec §3.6): chars/4 over the
 * stream's text and tool-call argument deltas — used to cost a
 * successful stream that ended without a usage event.
 */
export function estimateOutputTokens(
  events: CanonicalStreamEvent[],
): number {
  let chars = 0;
  for (const event of events) {
    if (event.type === "text_delta") {
      chars += event.text.length;
    } else if (event.type === "reasoning_delta") {
      // v1.4 §3.2: reasoning tokens are billed output
      chars += event.text.length;
    } else if (event.type === "tool_call_delta") {
      chars += event.argumentsDelta.length;
    }
  }
  return Math.ceil(chars / 4);
}
