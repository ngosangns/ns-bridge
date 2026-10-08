/**
 * Loads the built dist/index.js (ns-pi-provider bundled + OMP shims) against a
 * fake OMP ExtensionAPI. Hermetic: temp HOME, no provider credentials, Grok
 * binary forced missing — so no network and no CLI spawns.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const dist = join(root, "dist/index.js");

class FakeOmpApi {
  providers = new Map<string, Record<string, unknown>>();
  events: string[] = [];
  commands: string[] = [];
  registerProvider(name: string, config: Record<string, unknown>) {
    this.providers.set(name, config);
  }
  on(event: string) {
    this.events.push(event);
  }
  registerCommand(name: string) {
    this.commands.push(name);
  }
}

let extension: (pi: object) => Promise<void>;

beforeAll(async () => {
  if (!existsSync(dist)) execFileSync(process.execPath, [join(root, "scripts/build.mjs")], { cwd: root, stdio: "inherit" });
  const home = mkdtempSync(join(tmpdir(), "ns-omp-bundle-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GROK_BIN = join(home, "no-such-grok");
  for (const key of [
    "XAI_API_KEY",
    "GROK_API_KEY",
    "KIRO_API_KEY",
    "KIRO_ACCESS_TOKEN",
    "AMAZON_Q_TOKEN",
    "DEVIN_API_KEY",
    "DEVIN_SESSION_TOKEN",
    "WINDSURF_API_KEY",
    "NS_OMP_PROVIDERS",
    "NS_OMP_PROVIDER_DISABLE",
    "NS_OMP_PROVIDER_ENABLE",
  ]) {
    delete process.env[key];
  }
  extension = (await import(dist)).default;
});

describe("dist/index.js on a fake OMP API", () => {
  it("registers devin, grok (+ grok-sdk alias) in OMP shape; kiro is opt-in", async () => {
    const pi = new FakeOmpApi();
    await extension(pi);

    expect([...pi.providers.keys()].sort()).toEqual(["devin", "grok", "grok-sdk"]);
    for (const [name, config] of pi.providers) {
      expect(config, name).not.toHaveProperty("refreshModels");
      expect(typeof config.fetchDynamicModels, name).toBe("function");
      expect(typeof config.streamSimple, name).toBe("function");
      expect(Array.isArray(config.models), name).toBe(true);
    }
    expect((pi.providers.get("devin")!.models as unknown[]).length).toBeGreaterThan(0);
    expect((pi.providers.get("grok")!.models as unknown[]).length).toBeGreaterThan(0);
    expect(pi.providers.get("grok")!.apiKey).toBe("grok-cli");

    expect(pi.events).not.toContain("session_info_changed");
    expect(pi.events).toEqual(expect.arrayContaining(["session_start", "session_switch", "session_branch", "session_shutdown"]));
    expect(pi.commands).toEqual(expect.arrayContaining(["ns-pi", "grok", "devin-status"]));
  });

  it("registers kiro in OMP shape when opted in with NS_OMP_PROVIDER_ENABLE", async () => {
    process.env.NS_OMP_PROVIDER_ENABLE = "kiro";
    try {
      const pi = new FakeOmpApi();
      await extension(pi);
      expect([...pi.providers.keys()].sort()).toEqual(["devin", "grok", "grok-sdk", "kiro"]);
      const kiro = pi.providers.get("kiro")!;
      expect(kiro).not.toHaveProperty("refreshModels");
      expect(typeof kiro.fetchDynamicModels).toBe("function");
      expect(typeof kiro.streamSimple).toBe("function");
      // No credential/saved catalog in the temp HOME → zero models (ns-pi-provider >= 0.2.0).
      expect(Array.isArray(kiro.models)).toBe(true);
      // `$KIRO_ACCESS_TOKEN` is unset → no bogus literal key; OMP falls back to /login.
      expect(kiro).not.toHaveProperty("apiKey");
    } finally {
      delete process.env.NS_OMP_PROVIDER_ENABLE;
    }
  });

  it("honours NS_OMP_PROVIDER_DISABLE", async () => {
    process.env.NS_OMP_PROVIDER_ENABLE = "kiro";
    process.env.NS_OMP_PROVIDER_DISABLE = "kiro,grok";
    try {
      const pi = new FakeOmpApi();
      await extension(pi);
      expect(pi.providers.has("kiro")).toBe(false);
      expect(pi.providers.has("grok")).toBe(false);
      expect(pi.providers.has("devin")).toBe(true);
    } finally {
      delete process.env.NS_OMP_PROVIDER_ENABLE;
      delete process.env.NS_OMP_PROVIDER_DISABLE;
    }
  });
});
