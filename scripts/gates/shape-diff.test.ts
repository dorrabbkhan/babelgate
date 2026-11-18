import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./shape-diff";

/**
 * shape-diff.ts (v1.5 spec §3.4 replay): compares a fresh client
 * recording against the committed fixture — added request keys, tool
 * types, input item types or SSE event types exit 1; removals are
 * reported but never fail (a leaner release is not a break).
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function line(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    method: "POST",
    path: "/v1/messages",
    queryKeys: ["beta"],
    headerNames: ["content-type", "authorization"],
    bodyShape: {
      model: "<string:20>",
      messages: [
        { role: "<string:4>", content: [{ type: "text", text: "<string:9>" }] },
      ],
      tools: [
        {
          name: "Bash",
          description: "<string:40>",
          input_schema: { type: "object", properties: {} },
        },
      ],
      stream: "<bool>",
    },
    status: 200,
    contentType: "text/event-stream",
    sseEvents: { message_start: 1, content_block_delta: 3, message_stop: 1 },
    ...overrides,
  });
}

function files(
  fixtureLines: string[],
  newLines: string[],
): { fixture: string; fresh: string } {
  const dir = mkdtempSync(join(tmpdir(), "shape-diff-"));
  tmpDirs.push(dir);
  const fixture = join(dir, "fixture.jsonl");
  const fresh = join(dir, "new.jsonl");
  writeFileSync(fixture, fixtureLines.join("\n") + "\n");
  writeFileSync(fresh, newLines.join("\n") + "\n");
  return { fixture, fresh };
}

describe("shape-diff.ts (v1.5 spec §3.4)", () => {
  it("identical shapes exit 0", () => {
    const { fixture, fresh } = files([line({})], [line({})]);
    const out: string[] = [];
    expect(run([fresh, fixture], (l) => out.push(l))).toBe(0);
    expect(
      out.filter((l) => l.startsWith("added") || l.startsWith("removed")),
    ).toEqual([]);
    expect(out).toContain("SHAPE DIFF: 0 added, 0 removed");
  });

  it("new request key reported, exit 1", () => {
    const body = JSON.parse(line({})) as { bodyShape: object };
    const withExtra = JSON.parse(line({})) as {
      bodyShape: Record<string, unknown>;
    };
    withExtra.bodyShape = {
      ...withExtra.bodyShape,
      output_config: { format: { type: "json_schema" } },
    };
    const { fixture, fresh } = files(
      [JSON.stringify(body)],
      [JSON.stringify(withExtra)],
    );
    const out: string[] = [];
    expect(run([fresh, fixture], (l) => out.push(l))).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("added request key");
    expect(text).toContain("output_config");
  });

  it("new SSE event type reported", () => {
    const { fixture, fresh } = files(
      [line({})],
      [
        line({
          sseEvents: {
            message_start: 1,
            content_block_delta: 3,
            message_stop: 1,
            ping: 2,
          },
        }),
      ],
    );
    const out: string[] = [];
    expect(run([fresh, fixture], (l) => out.push(l))).toBe(1);
    expect(out.join("\n")).toContain("added SSE event type: ping");
  });

  it("removed field reported, exit 0", () => {
    const withoutTools = JSON.parse(line({})) as {
      bodyShape: Record<string, unknown>;
    };
    delete withoutTools.bodyShape.tools;
    const { fixture, fresh } = files(
      [line({})],
      [JSON.stringify(withoutTools)],
    );
    const out: string[] = [];
    expect(run([fresh, fixture], (l) => out.push(l))).toBe(0);
    expect(out.join("\n")).toContain("removed request key");
    expect(out.join("\n")).toContain("tools");
  });
});
