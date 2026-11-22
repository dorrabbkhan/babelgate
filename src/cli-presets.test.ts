import { describe, it, expect, vi } from "vitest";
import { formatPresetList } from "./cli-presets";
import {
  PRESET_NAMES,
  PROVIDER_PRESETS,
} from "./config/provider-presets";
import { main, parseCliArgs } from "./cli";

describe("babelgate presets (v1.6 spec §3.3)", () => {
  it("presets command lists tier and docs date", async () => {
    const lines = formatPresetList(PROVIDER_PRESETS);
    expect(lines).toHaveLength(PRESET_NAMES.length);
    for (const name of PRESET_NAMES) {
      const preset = PROVIDER_PRESETS[name];
      const row = lines.find(
        (line) => line.trim().split(/\s+/)[0] === name,
      );
      expect(row, name).toBeDefined();
      expect(row, name).toContain(preset.tier);
      if (preset.api_key_env !== undefined) {
        expect(row, name).toContain(preset.api_key_env);
      }
      expect(row, name).toContain(
        `${preset.docs} (verified ${preset.verified})`,
      );
    }

    // `babelgate presets` prints the same list and exits 0.
    const printed: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((line?: unknown) => {
        printed.push(String(line));
      });
    try {
      await main(["presets"]);
    } finally {
      spy.mockRestore();
    }
    expect(printed).toEqual(lines);
  });

  it("presets is the only positional command", () => {
    expect(parseCliArgs(["presets"])).toEqual({ command: "presets" });
    expect(() => parseCliArgs(["bogus"])).toThrow(/bogus/);
    expect(() => parseCliArgs(["presets", "extra"])).toThrow(/extra/);
  });
});
