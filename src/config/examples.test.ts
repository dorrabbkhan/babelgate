import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadYamlConfig } from "./yaml-config";

const EXAMPLES = join(__dirname, "..", "..", "examples");

/** A dummy value for every api_key_env the file names. */
function envFor(text: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const match of text.matchAll(/api_key_env:\s*([A-Za-z0-9_]+)/g)) {
    env[match[1]] = "test-key";
  }
  return env;
}

describe("examples/*.yaml", () => {
  it("every examples/*.yaml loads", () => {
    const files = readdirSync(EXAMPLES).filter((name) =>
      name.endsWith(".yaml"),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const path = join(EXAMPLES, name);
      const env = envFor(readFileSync(path, "utf8"));
      const config = loadYamlConfig(path, env);
      expect(
        config.registry.has(config.routing.defaultProvider),
        `${name}: default provider is not registered`,
      ).toBe(true);
    }
  });
});
