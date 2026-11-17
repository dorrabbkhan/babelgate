import { describe, it, expect } from "vitest";
import { runWithTrace } from "../observe/context";
import { newTrace, type RequestTrace } from "../observe/trace";
import type { ProviderEntry } from "../routing/registry";
import { adapters, type Provider } from "../transformers";
import type { CanonicalRequest } from "../types/canonical.types";
import { applyReasoningPolicy } from "./reasoning-policy";

/** Run `fn` inside a trace scope and return the filled trace (§3.5). */
function traced<T>(fn: () => T): RequestTrace {
  const trace = newTrace({
    requestId: "r1",
    startedAt: 0,
    client: "other",
    sourceApi: "playground",
  });
  runWithTrace(trace, fn);
  return trace;
}

function entry(type: Provider, reasoning?: boolean): ProviderEntry {
  return {
    name: `p-${type}`,
    type,
    baseUrl: "http://upstream",
    ...(reasoning !== undefined && { reasoning }),
  };
}

const TARGETS: Provider[] = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "responses",
];

/**
 * The canonical v1.4 produced for the same client request: every
 * non-Responses reasoning request field was dropped at decode, so
 * `config.reasoning` never existed.
 */
function v14Canonical(canonical: CanonicalRequest): CanonicalRequest {
  if (canonical.config === undefined) return canonical;
  const { reasoning: _dropped, ...rest } = canonical.config;
  return { ...canonical, config: rest };
}

describe("applyReasoningPolicy (v1.5 spec §3.1)", () => {
  it("reasoning:false reproduces v1.4 note and body", () => {
    // Each source's reasoning request field, the canonical the
    // decoder maps it to, and the note v1.4 recorded for the drop.
    const sources: {
      source: Provider;
      body: unknown;
      v14Note?: {
        stage: string;
        adapter: string;
        code: string;
        path: string;
      };
    }[] = [
      {
        source: "anthropic",
        body: {
          model: "claude-3-opus-20240229",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 1024,
          thinking: { type: "enabled", budget_tokens: 8192 },
        },
        v14Note: {
          stage: "decode",
          adapter: "anthropic",
          code: "thinking_dropped",
          path: "thinking",
        },
      },
      {
        source: "openai",
        body: {
          model: "m",
          reasoning_effort: "high",
          messages: [{ role: "user", content: "hi" }],
        },
      },
      {
        source: "gemini",
        body: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            thinkingConfig: { thinkingBudget: 1024 },
          },
        },
      },
      {
        source: "ollama",
        body: {
          model: "m",
          think: true,
          messages: [{ role: "user", content: "hi" }],
        },
      },
    ];

    for (const { source, body, v14Note } of sources) {
      for (const target of TARGETS) {
        const targetEntry = entry(target, false);
        let canonical: CanonicalRequest | undefined;
        let stripped: CanonicalRequest | undefined;
        const trace = traced(() => {
          canonical = adapters[source].toCanonicalRequest(body);
          stripped = applyReasoningPolicy(
            canonical,
            targetEntry,
            source,
            body,
          );
        });

        // The mapped reasoning is gone — and only that.
        expect(canonical?.config?.reasoning).not.toBeUndefined();
        expect(stripped?.config?.reasoning).toBeUndefined();
        expect(stripped).toEqual(v14Canonical(canonical!));
        // The decoded request is never mutated.
        expect(canonical?.config?.reasoning).not.toBeUndefined();

        // Exactly the v1.4 note(s) for this source — Anthropic
        // recorded thinking_dropped; the other decoders ignored
        // their reasoning fields silently.
        const dropNotes = trace.notes.filter(
          (n) =>
            n.code === "thinking_dropped" ||
            n.code === "reasoning_dropped" ||
            n.code === "field_dropped",
        );
        expect(dropNotes).toEqual(v14Note === undefined ? [] : [v14Note]);

        // Byte-identical upstream body: what v1.4 encoded for the
        // same request.
        expect(
          adapters[target].fromCanonicalRequest(stripped!),
        ).toEqual(
          adapters[target].fromCanonicalRequest(
            v14Canonical(canonical!),
          ),
        );
      }
    }
  });

  it("reasoning:false keeps decode-time level notes (owner-accepted exception)", () => {
    // Decoders record level-normalisation notes at decode, before the
    // per-attempt policy runs — the trace cannot retract them, so a
    // "max" level still records reasoning_effort_lowered under
    // reasoning:false (decisions.md v1.5 Task 3, owner-accepted
    // 2026-11-17, option 1 on #118).
    const body = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "max",
    };
    let stripped: CanonicalRequest | undefined;
    const trace = traced(() => {
      const canonical = adapters.openai.toCanonicalRequest(body);
      stripped = applyReasoningPolicy(
        canonical,
        entry("anthropic", false),
        "openai",
        body,
      );
    });

    expect(stripped?.config?.reasoning).toBeUndefined();
    // Exactly the decode-time level note — nothing more, nothing
    // retracted.
    expect(trace.notes).toEqual([
      {
        stage: "decode",
        adapter: "openai",
        code: "reasoning_effort_lowered",
        path: "reasoning_effort",
      },
    ]);
    // Byte-identical upstream body: what v1.4 encoded for the same
    // request without reasoning_effort.
    expect(adapters.anthropic.fromCanonicalRequest(stripped!)).toEqual({
      model: "m",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("responses source unaffected by reasoning:false", () => {
    const body = {
      model: "m",
      reasoning: { effort: "high" },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    };
    const canonical = adapters.responses.toCanonicalRequest(body);
    expect(canonical.config?.reasoning).toEqual({ effort: "high" });

    const out = applyReasoningPolicy(
      canonical,
      entry("anthropic", false),
      "responses",
      body,
    );
    expect(out.config?.reasoning).toEqual({ effort: "high" });
  });

  it("reasoning unset or true keeps the mapped config", () => {
    const body = {
      model: "m",
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hi" }],
    };
    const canonical = adapters.openai.toCanonicalRequest(body);

    for (const e of [entry("gemini"), entry("gemini", true)]) {
      const out = applyReasoningPolicy(canonical, e, "openai", body);
      expect(out.config?.reasoning).toEqual({ effort: "low" });
    }
  });
});
