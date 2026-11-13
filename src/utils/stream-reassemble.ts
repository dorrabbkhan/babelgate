import type {
  CanonicalContentPart,
  CanonicalReasoningSignature,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalToolCall,
  CanonicalUsage,
} from "../types/canonical.types";
import { ProxyError, TransformError } from "./errors";

/**
 * Fold a canonical event stream back into a CanonicalResponse — the inverse
 * of streaming, used to compare streams against their non-streaming twins.
 * Throws TransformError when the events break the spec §3.1 stream rules;
 * an `error` event throws a ProxyError carrying that event's kind/status.
 */
export function reassembleStream(
  events: CanonicalStreamEvent[],
): CanonicalResponse {
  let started = false;
  let done = false;
  let id = "";
  let model = "";
  let text = "";
  let usage: CanonicalUsage | undefined;
  let finishReason: CanonicalResponse["finishReason"] | undefined;
  const calls = new Map<
    number,
    {
      id: string;
      name: string;
      args: string;
      ended: boolean;
      custom?: boolean;
      signature?: CanonicalReasoningSignature;
    }
  >();
  // Reasoning blocks keyed by their own index namespace — text and
  // signatures accumulate per index and reassemble into reasoning
  // content parts ahead of the reply text.
  const reasoning = new Map<
    number,
    { text: string; signature?: CanonicalReasoningSignature }
  >();
  let nextIndex = 0;

  function fail(why: string): never {
    throw new TransformError(`Invalid canonical stream: ${why}`);
  }

  for (const event of events) {
    if (done) fail(`event "${event.type}" after the stream ended`);
    if (!started && event.type !== "message_start") {
      fail(`event "${event.type}" before message_start`);
    }
    switch (event.type) {
      case "message_start":
        if (started) fail("duplicate message_start");
        started = true;
        id = event.id;
        model = event.model;
        break;
      case "text_delta":
        text += event.text;
        break;
      case "reasoning_delta": {
        const block = reasoning.get(event.index) ?? { text: "" };
        block.text += event.text;
        reasoning.set(event.index, block);
        break;
      }
      case "reasoning_signature": {
        const block = reasoning.get(event.index) ?? { text: "" };
        block.signature = event.signature;
        reasoning.set(event.index, block);
        break;
      }
      case "tool_call_start":
        if (event.index !== nextIndex) {
          fail(
            `tool_call_start index ${event.index}, expected ${nextIndex}`,
          );
        }
        calls.set(event.index, {
          id: event.id,
          name: event.name,
          args: "",
          ended: false,
          ...(event.custom !== undefined && { custom: event.custom }),
          ...(event.signature !== undefined && {
            signature: event.signature,
          }),
        });
        nextIndex++;
        break;
      case "tool_call_delta": {
        const call = calls.get(event.index);
        if (!call || call.ended) {
          fail(`tool_call_delta for index ${event.index} with no open call`);
        }
        call.args += event.argumentsDelta;
        break;
      }
      case "tool_call_end": {
        const call = calls.get(event.index);
        if (!call || call.ended) {
          fail(`tool_call_end for index ${event.index} with no open call`);
        }
        call.ended = true;
        break;
      }
      case "usage":
        if (usage) fail("duplicate usage event");
        usage = event.usage;
        break;
      case "message_end":
        finishReason = event.finishReason;
        done = true;
        break;
      case "error":
        done = true;
        throw new ProxyError(
          event.error.message,
          event.error.status,
          event.error.kind.toUpperCase(),
        );
    }
  }
  if (!done) fail("stream ended without message_end or error");

  const toolCalls: CanonicalToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.args },
      ...(c.custom !== undefined && { custom: c.custom }),
      ...(c.signature !== undefined && { signature: c.signature }),
    }));

  // Reasoning parts precede the reply text (thinking comes first on
  // every provider). A reasoning block's origin comes from its
  // signature; text-only reasoning (DeepSeek-style, no signature)
  // uses the out-of-attempt convention {provider: "", model}.
  const reasoningParts: CanonicalContentPart[] = [
    ...reasoning.entries(),
  ]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => ({
      type: "reasoning" as const,
      reasoning: {
        ...(block.text !== "" && { text: block.text }),
        origin: block.signature?.origin ?? { provider: "", model },
      },
      ...(block.signature !== undefined && {
        signature: block.signature,
      }),
    }));

  return {
    id,
    model,
    message: {
      role: "assistant",
      content:
        reasoningParts.length === 0
          ? text
          : [
              ...reasoningParts,
              ...(text !== ""
                ? [{ type: "text" as const, text }]
                : []),
            ],
      ...(toolCalls.length > 0 && { toolCalls }),
    },
    // done without throwing ⇒ a message_end set finishReason
    finishReason: finishReason!,
    ...(usage && { usage }),
  };
}
