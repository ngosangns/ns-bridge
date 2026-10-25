/**
 * Loads the built dist/index.js (ns-pi-provider's Kiro and Arnict registrations
 * bundled + OMP shims) against a fake OMP ExtensionAPI. Hermetic: temp HOME, no
 * provider credentials — so no network and no CLI spawns. OMP ships devin and
 * xai itself, so kiro and arnict are the only providers it may ever register;
 * without an Arnict key, arnict only adds the /arnict command.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  if (!existsSync(dist))
    execFileSync(process.execPath, [join(root, "scripts/build.mjs")], { cwd: root, stdio: "inherit" });
  const home = mkdtempSync(join(tmpdir(), "ns-omp-bundle-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.NS_BRIDGE_PROVIDERS = join(home, "providers.json");
  process.env.OMP_PROFILE = "";
  process.env.PI_PROFILE = "";
  for (const key of [
    "ARNICT_API_KEY",
    "NS_BRIDGE_ARNICT_CONFIG",
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
  it("registers only kiro, in OMP shape, with the arnict command but no provider", async () => {
    const pi = new FakeOmpApi();
    await extension(pi);

    expect([...pi.providers.keys()]).toEqual(["kiro"]);
    const kiro = pi.providers.get("kiro");
    if (kiro === undefined) throw new Error("kiro provider was not registered");
    expect(kiro).not.toHaveProperty("refreshModels");
    expect(typeof kiro.fetchDynamicModels).toBe("function");
    expect(typeof kiro.streamSimple).toBe("function");
    // No credential/saved catalog in the temp HOME → zero models (ns-pi-provider >= 0.2.0).
    expect(Array.isArray(kiro.models)).toBe(true);
    // `$KIRO_ACCESS_TOKEN` is unset → no bogus literal key; OMP falls back to /login.
    expect(kiro).not.toHaveProperty("apiKey");

    expect(pi.events).not.toContain("session_info_changed");
    expect(pi.events).toEqual(expect.arrayContaining(["session_start", "session_switch", "session_branch"]));
    // No Arnict key → registration stops at the signpost command.
    expect(pi.commands).toContain("arnict");
    expect(pi.commands).not.toContain("grok");
    expect(pi.commands).not.toContain("devin-status");
  });

  it("registers arnict too when an Arnict key is present, with the native window as maxContextWindow", async () => {
    process.env.ARNICT_API_KEY = "arnict-bundle-test-key";
    try {
      const pi = new FakeOmpApi();
      await extension(pi);

      expect([...pi.providers.keys()]).toEqual(expect.arrayContaining(["kiro", "arnict"]));
      const arnict = pi.providers.get("arnict");
      if (arnict === undefined) throw new Error("arnict provider was not registered");
      expect(arnict.api).toBe("arnict-chat");
      expect(arnict).not.toHaveProperty("refreshModels");
      expect(typeof arnict.fetchDynamicModels).toBe("function");
      expect(typeof arnict.streamSimple).toBe("function");
      // OMP compacts at a share of contextWindow, so the GLM row is registered
      // at the smallest window whose OMP threshold reaches Pi's 383,616 (where
      // Pi compacts the 400K standard window); the 1M native window Arnict
      // serves rides along for OMP's extended context.
      const models = arnict.models as Array<Record<string, unknown>>;
      const flash = models.find((m) => m.id === "zai/glm-5.3-flash-uncensored");
      const window = flash?.contextWindow as number;
      expect(window - Math.max(Math.floor(window * 0.15), 16_384)).toBe(383_616);
      expect(flash?.maxContextWindow).toBe(1_048_576);
    } finally {
      delete process.env.ARNICT_API_KEY;
    }
  });

  it("registers arnict and not kiro when the dedicated ns-omp-provider-kiro plugin is installed", async () => {
    const previous: Record<string, string | undefined> = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      ARNICT_API_KEY: process.env.ARNICT_API_KEY,
    };
    // A temp HOME carrying the dedicated plugin makes dedicatedKiroInstalled() true,
    // so the kiro id belongs to ns-omp-provider-kiro; arnict still registers on a key.
    const dedicatedHome = mkdtempSync(join(tmpdir(), "ns-omp-dedicated-"));
    mkdirSync(join(dedicatedHome, ".omp", "plugins", "node_modules", "ns-omp-provider-kiro"), { recursive: true });
    process.env.HOME = dedicatedHome;
    process.env.USERPROFILE = dedicatedHome;
    process.env.ARNICT_API_KEY = "arnict-bundle-test-key";
    try {
      const pi = new FakeOmpApi();
      await extension(pi);

      expect([...pi.providers.keys()]).toEqual(["arnict"]);
      const arnict = pi.providers.get("arnict");
      if (arnict === undefined) throw new Error("arnict provider was not registered");
      expect(arnict.api).toBe("arnict-chat");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dedicatedHome, { recursive: true, force: true });
    }
  });

  it("never registers devin or grok, even when an env list or the file asks for them", async () => {
    const providersFile = process.env.NS_BRIDGE_PROVIDERS;
    if (providersFile === undefined) throw new Error("NS_BRIDGE_PROVIDERS must be set by beforeAll");
    process.env.NS_OMP_PROVIDERS = "kiro,devin,grok";
    process.env.NS_OMP_PROVIDER_ENABLE = "devin,grok";
    writeFileSync(providersFile, JSON.stringify({ kiro: true, devin: true, grok: true }));
    try {
      const pi = new FakeOmpApi();
      await extension(pi);
      expect([...pi.providers.keys()]).toEqual(["kiro"]);
    } finally {
      delete process.env.NS_OMP_PROVIDERS;
      delete process.env.NS_OMP_PROVIDER_ENABLE;
      rmSync(providersFile, { force: true });
    }
  });

  it("registers nothing when devin or grok is the whole allow-list", async () => {
    process.env.NS_OMP_PROVIDERS = "devin,grok";
    try {
      const pi = new FakeOmpApi();
      await extension(pi);
      expect(pi.providers.size).toBe(0);
    } finally {
      delete process.env.NS_OMP_PROVIDERS;
    }
  });

  it("honours NS_OMP_PROVIDER_DISABLE=kiro and ignores devin or grok in it", async () => {
    process.env.NS_OMP_PROVIDER_DISABLE = "devin,grok";
    try {
      const pi = new FakeOmpApi();
      await extension(pi);
      expect([...pi.providers.keys()]).toEqual(["kiro"]);
    } finally {
      delete process.env.NS_OMP_PROVIDER_DISABLE;
    }
    process.env.NS_OMP_PROVIDER_DISABLE = "kiro";
    try {
      const pi = new FakeOmpApi();
      await extension(pi);
      expect(pi.providers.size).toBe(0);
    } finally {
      delete process.env.NS_OMP_PROVIDER_DISABLE;
    }
  });

  it("keeps devin and grok code out of the bundle, and the arnict registration in it", () => {
    const bundle = readFileSync(dist, "utf8");
    expect(bundle).not.toMatch(/registerDevinProvider|registerGrokProvider|cli-chat-proxy\.grok\.com/);
    expect(bundle).toContain("Arnict provider:");
    expect(bundle).toContain("ns-bridge arnict login");
  });
});
