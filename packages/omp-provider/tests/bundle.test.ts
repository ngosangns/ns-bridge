/**
 * Loads the built dist/index.js (ns-pi-provider's Kiro registration bundled +
 * OMP shims) against a fake OMP ExtensionAPI. Hermetic: temp HOME, no provider
 * credentials — so no network and no CLI spawns. OMP ships devin and xai
 * itself, so only kiro may ever be registered.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("registers only kiro, in OMP shape", async () => {
    const pi = new FakeOmpApi();
    await extension(pi);

    expect([...pi.providers.keys()]).toEqual(["kiro"]);
    const kiro = pi.providers.get("kiro")!;
    expect(kiro).not.toHaveProperty("refreshModels");
    expect(typeof kiro.fetchDynamicModels).toBe("function");
    expect(typeof kiro.streamSimple).toBe("function");
    // No credential/saved catalog in the temp HOME → zero models (ns-pi-provider >= 0.2.0).
    expect(Array.isArray(kiro.models)).toBe(true);
    // `$KIRO_ACCESS_TOKEN` is unset → no bogus literal key; OMP falls back to /login.
    expect(kiro).not.toHaveProperty("apiKey");

    expect(pi.events).not.toContain("session_info_changed");
    expect(pi.events).toEqual(expect.arrayContaining(["session_start", "session_switch", "session_branch"]));
    expect(pi.commands).not.toContain("grok");
    expect(pi.commands).not.toContain("devin-status");
  });

  it("never registers devin or grok, even when an env list or the file asks for them", async () => {
    process.env.NS_OMP_PROVIDERS = "kiro,devin,grok";
    process.env.NS_OMP_PROVIDER_ENABLE = "devin,grok";
    writeFileSync(process.env.NS_BRIDGE_PROVIDERS!, JSON.stringify({ kiro: true, devin: true, grok: true }));
    try {
      const pi = new FakeOmpApi();
      await extension(pi);
      expect([...pi.providers.keys()]).toEqual(["kiro"]);
    } finally {
      delete process.env.NS_OMP_PROVIDERS;
      delete process.env.NS_OMP_PROVIDER_ENABLE;
      rmSync(process.env.NS_BRIDGE_PROVIDERS!, { force: true });
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

  it("keeps devin and grok code out of the bundle", () => {
    const bundle = readFileSync(dist, "utf8");
    expect(bundle).not.toMatch(/registerDevinProvider|registerGrokProvider|cli-chat-proxy\.grok\.com/);
  });
});
