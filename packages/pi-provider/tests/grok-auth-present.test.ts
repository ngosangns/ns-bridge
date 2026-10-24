import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokAuthPresent } from "../src/grok/register.js";

describe("grokAuthPresent", () => {
  it("ignores a console API key and requires a session access token", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-auth-present-"));
    const env = { XAI_API_KEY: "console-key", GROK_API_KEY: "other-key" } as NodeJS.ProcessEnv;
    expect(grokAuthPresent(env, home)).toBe(false);

    const dir = join(home, ".grok");
    mkdirSync(dir);
    const path = join(dir, "auth.json");
    writeFileSync(path, JSON.stringify({ "https://auth.x.ai::client": { email: "person@example.com" } }));
    expect(grokAuthPresent(env, home)).toBe(false);

    writeFileSync(path, JSON.stringify({ "https://auth.x.ai::client": { key: "access-token" } }));
    expect(grokAuthPresent(env, home)).toBe(true);
  });
});
