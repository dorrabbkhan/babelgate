import type { CanonicalStreamEvent } from "../types/canonical.types";
import { currentTrace } from "./context";
import { diagnoseArguments, repairArguments } from "./tool-diagnostics";

/**
 * §3.7 streaming repair (per provider `repair_tool_calls`, inserted by
 * chat-stream.service between the target decoder and the source
 * encoder): a call's argument deltas are held per index and released
 * as ONE delta — repaired when possible — before that call's
 * tool_call_end. Text and every other event stream as before.
 * A stream that ends mid-call releases what it held unrepaired with a
 * diagnostic before the error/message_end event — held arguments are
 * never lost. Repairs and diagnostics land on the ambient trace the
 * same way recordNote/snapshot do.
 */
export function createRepairTransform(): (
  event: CanonicalStreamEvent,
) => CanonicalStreamEvent[] {
  const held = new Map<number, { id: string; name: string; args: string }>();

  return (event) => {
    switch (event.type) {
      case "tool_call_start":
        held.set(event.index, { id: event.id, name: event.name, args: "" });
        return [event];

      case "tool_call_delta": {
        const call = held.get(event.index);
        // No open call at that index: pass through rather than invent.
        if (call === undefined) return [event];
        call.args += event.argumentsDelta;
        return [];
      }

      case "tool_call_end": {
        const call = held.get(event.index);
        if (call === undefined) return [event];
        held.delete(event.index);
        let args = call.args;
        const repair = repairArguments(args);
        if (repair !== undefined) {
          args = repair.args;
          currentTrace()?.repairs.push({
            toolCallId: call.id,
            steps: repair.steps,
          });
        }
        return [delta(event.index, args), event];
      }

      case "message_end":
      case "error": {
        if (held.size === 0) return [event];
        const out: CanonicalStreamEvent[] = [];
        for (const [index, call] of [...held].sort(([a], [b]) => a - b)) {
          const code = diagnoseArguments(call.args);
          if (code !== undefined) {
            currentTrace()?.diagnostics.push({
              toolCallId: call.id,
              name: call.name,
              code,
            });
          }
          out.push(delta(index, call.args));
        }
        held.clear();
        out.push(event);
        return out;
      }

      default:
        return [event];
    }
  };
}

function delta(index: number, argumentsDelta: string): CanonicalStreamEvent {
  return { type: "tool_call_delta", index, argumentsDelta };
}
