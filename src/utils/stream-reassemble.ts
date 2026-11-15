import type {
  CanonicalContentPart,
  CanonicalReasoningOrigin,
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
  // Text accumulates as a list of parts (Task 7a, #99): a text_delta
  // appends to the current part, or opens a new one when the current
  // is already signed — a non-empty part following a signed one is new
  // text, so a signature never moves to other text. A text_signature
  // signs the current part; with none open it opens an empty one
  // (Gemini can sign an empty final text part, as max_tokens.sse does).
  const textParts: {
    text: string;
    signature?: CanonicalReasoningSignature;
  }[] = [];
  let usage: CanonicalUsage | undefined;
  let finishReason: CanonicalResponse["finishReason"] | undefined;
  const calls = new Map<
    number,
    {
      id: string;
      name: string;
      namespace?: string;
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
    {
      text: string;
      origin: CanonicalReasoningOrigin;
      redacted: boolean;
      signature?: CanonicalReasoningSignature;
    }
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
      case "text_delta": {
        const last = textParts[textParts.length - 1];
        if (last !== undefined && last.signature === undefined) {
          last.text += event.text;
        } else {
          textParts.push({ text: event.text });
        }
        break;
      }
      case "text_signature": {
        const last = textParts[textParts.length - 1];
        if (last !== undefined && last.signature === undefined) {
          last.signature = event.signature;
        } else {
          textParts.push({ text: "", signature: event.signature });
        }
        break;
      }
      case "reasoning_start":
        if (reasoning.has(event.index)) {
          fail(`duplicate reasoning_start for index ${event.index}`);
        }
        reasoning.set(event.index, {
          text: "",
          origin: event.origin,
          redacted: event.redacted === true,
        });
        break;
      case "reasoning_delta": {
        const block = reasoning.get(event.index);
        if (!block) {
          fail(
            `reasoning_delta for index ${event.index} with no reasoning_start`,
          );
        }
        block.text += event.text;
        break;
      }
      case "reasoning_signature": {
        const block = reasoning.get(event.index);
        if (!block) {
          fail(
            `reasoning_signature for index ${event.index} with no reasoning_start`,
          );
        }
        block.signature = event.signature;
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
          ...(event.namespace !== undefined && {
            namespace: event.namespace,
          }),
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
      function: {
        name: c.name,
        arguments: c.args,
        ...(c.namespace !== undefined && { namespace: c.namespace }),
      },
      ...(c.custom !== undefined && { custom: c.custom }),
      ...(c.signature !== undefined && { signature: c.signature }),
    }));

  // Reasoning parts precede the reply text (thinking comes first on
  // every provider). A block's origin — and whether it is redacted —
  // comes from its reasoning_start, never from a signature, so
  // unsigned stream reasoning (DeepSeek-style) keeps its provider.
  const reasoningParts: CanonicalContentPart[] = [
    ...reasoning.entries(),
  ]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => ({
      type: "reasoning" as const,
      reasoning: {
        ...(block.text !== "" && { text: block.text }),
        ...(block.redacted && { redacted: true as const }),
        origin: block.origin,
      },
      ...(block.signature !== undefined && {
        signature: block.signature,
      }),
    }));

  // A signed text part makes content a parts array (the same rule as
  // reasoning parts); without one it stays the joined string, so
  // unsigned traffic is unchanged.
  const hasSignedText = textParts.some((p) => p.signature !== undefined);
  const text = textParts.map((p) => p.text).join("");
  const content =
    reasoningParts.length === 0 && !hasSignedText
      ? text
      : [
          ...reasoningParts,
          ...(hasSignedText
            ? textParts.map(
                (p): CanonicalContentPart => ({
                  type: "text" as const,
                  text: p.text,
                  ...(p.signature !== undefined && {
                    signature: p.signature,
                  }),
                }),
              )
            : text !== ""
              ? [{ type: "text" as const, text }]
              : []),
        ];

  return {
    id,
    model,
    message: {
      role: "assistant",
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
    },
    // done without throwing ⇒ a message_end set finishReason
    finishReason: finishReason!,
    ...(usage && { usage }),
  };
}
