import { describe, expect, it } from "vitest";
import { structuralDiff } from "./diff";

describe("structuralDiff", () => {
  it("added, removed, changed paths", () => {
    const a = {
      model: "m1",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "a" }] },
      ],
      max_tokens: 100,
      extra: { nested: true, also: 1 },
    };
    const b = {
      model: "m2",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "b" }, { type: "image", url: "u" }],
        },
      ],
      temperature: 0.5,
      extra: { nested: "yes" },
    };

    const diff = structuralDiff(a, b);

    expect(diff).toContainEqual({ path: "model", kind: "changed" });
    expect(diff).toContainEqual({
      path: "messages[1].content[0].text",
      kind: "changed",
    });
    expect(diff).toContainEqual({
      path: "messages[1].content[1]",
      kind: "added",
    });
    expect(diff).toContainEqual({ path: "max_tokens", kind: "removed" });
    expect(diff).toContainEqual({ path: "temperature", kind: "added" });
    expect(diff).toContainEqual({ path: "extra.nested", kind: "changed" });
    expect(diff).toContainEqual({ path: "extra.also", kind: "removed" });
    expect(diff).toHaveLength(7);
  });

  it("identical values produce no diff", () => {
    const a = { x: [1, { y: "z" }] };
    expect(structuralDiff(a, a)).toEqual([]);
    expect(structuralDiff(a, JSON.parse(JSON.stringify(a)))).toEqual([]);
  });

  it("array shrink marks removed indices, type switch marks changed", () => {
    expect(structuralDiff({ a: [1, 2, 3] }, { a: [1] })).toEqual([
      { path: "a[1]", kind: "removed" },
      { path: "a[2]", kind: "removed" },
    ]);
    expect(structuralDiff({ a: { b: 1 } }, { a: "x" })).toEqual([
      { path: "a", kind: "changed" },
    ]);
  });
});
