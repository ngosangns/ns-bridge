import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARNICT_PROVIDER_ID, registerArnictProvider } from "../src/arnict/register.js";
import { resetDefaultCatalogCache } from "../src/shared/catalog-cache.js";
import { resolveProviderSelection } from "../src/selection.js";

function mockPi() {
  const providers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  return {
    providers,
    commands,
    api: {
      registerProvider: vi.fn((id: string, config: unknown) => {
        providers.set(id, config);
      }),
      unregisterProvider: vi.fn(),
      registerCommand: vi.fn((name: string, def: unknown) => {
        commands.set(name, def);
      }),
      on: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
    },
  };
}

const envKeys = ["ARNICT_API_KEY", "NS_BRIDGE_ARNICT_CONFIG"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of envKeys) saved[key] = process.env[key];
  delete process.env.ARNICT_API_KEY;
  delete process.env.NS_BRIDGE_ARNICT_CONFIG;
  resetDefaultCatalogCache();
});

afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const KEY = "arnict-secret-key-value";

async function runCommand(commands: Map<string, unknown>, args: string): Promise<string> {
  const notify = vi.fn();
  const handler = (commands.get("arnict") as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
  await handler(args, { hasUI: true, ui: { notify } });
  return String(notify.mock.calls[0]?.[0] ?? "");
}

describe("arnict registration", () => {
  it("registers only the /arnict command when no key is present", async () => {
    process.env.NS_BRIDGE_ARNICT_CONFIG = join(mkdtempSync(join(tmpdir(), "ns-pi-arnict-nokey-")), "missing.json");
    const { api, providers, commands } = mockPi();
    await registerArnictProvider(api as never);
    expect(providers.has(ARNICT_PROVIDER_ID)).toBe(false);
    expect(commands.has("arnict")).toBe(true);

    const message = await runCommand(commands, "status");
    expect(message).toContain("no key");
    expect(message).toContain("ns-bridge arnict login");
  });

  it("registers the provider when a key is present, with a placeholder apiKey and masked status", async () => {
    process.env.ARNICT_API_KEY = KEY;
    const { api, providers, commands } = mockPi();
    await registerArnictProvider(api as never);
    expect(providers.has(ARNICT_PROVIDER_ID)).toBe(true);
    expect(commands.has("arnict")).toBe(true);

    const cfg = providers.get(ARNICT_PROVIDER_ID) as {
      name: string;
      baseUrl: string;
      apiKey: string;
      api: string;
      models: Array<{ id: string; cost: { cacheRead: number; cacheWrite: number } }>;
    };
    expect(cfg.name).toBe("Arnict");
    expect(cfg.baseUrl).toBe("https://api.arnict.com/v1");
    expect(cfg.apiKey).toBe("arnict");
    expect(cfg.apiKey).not.toContain(KEY);
    expect(cfg.api).toBe("arnict-chat");
    expect(cfg.models.length).toBeGreaterThan(0);
    for (const model of cfg.models) {
      expect(model.cost).toHaveProperty("cacheRead");
      expect(model.cost).toHaveProperty("cacheWrite");
    }

    const status = await runCommand(commands, "status");
    expect(status).toContain("key: yes (env)");
    expect(status).toContain("arni…alue");
    expect(status).not.toContain(KEY);
  });

  it("answers models and refresh actions", async () => {
    process.env.ARNICT_API_KEY = KEY;
    const { api, commands } = mockPi();
    await registerArnictProvider(api as never);

    const models = await runCommand(commands, "models");
    expect(models).toContain("zai/glm-5.3-flash-uncensored");
    const refresh = await runCommand(commands, "refresh");
    expect(refresh).toContain("ns-bridge models refresh arnict --apply");
    const unknown = await runCommand(commands, "bogus");
    expect(unknown).toContain("Unknown action");
  });
});

describe("arnict selection", () => {
  it("is on by default", () => {
    expect(resolveProviderSelection({}).arnict).toBe(true);
  });

  it("follows the providers file and env lists like the other keys", () => {
    const only = resolveProviderSelection({ NS_OMP_PROVIDERS: "arnict" });
    expect(only).toEqual({ kiro: false, devin: false, grok: false, arnict: true });

    const mixed = resolveProviderSelection({ NS_OMP_PROVIDERS: "grok, arnict" });
    expect(mixed.grok).toBe(true);
    expect(mixed.arnict).toBe(true);
    expect(mixed.kiro).toBe(false);

    const file = join(mkdtempSync(join(tmpdir(), "ns-pi-arnict-sel-")), "providers.json");
    writeFileSync(file, JSON.stringify({ arnict: false }));
    expect(resolveProviderSelection({ NS_BRIDGE_PROVIDERS: file }).arnict).toBe(false);
  });
});
