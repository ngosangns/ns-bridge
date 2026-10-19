import { describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const wrap = (name: keyof typeof child) => {
    child[name].mockImplementation((...args: unknown[]) => (actual[name] as (...inner: unknown[]) => unknown)(...args));
  };
  wrap("execFile");
  wrap("execFileSync");
  wrap("execSync");
  wrap("spawn");
  wrap("spawnSync");
  return { ...actual, ...child };
});

import { apply } from "../src/index.js";

describe("Kiro harness registration", () => {
  it("does not call the network from apply", () => {
    const fetchSpy = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      apply(
        {
          inject(_names: string[], fn: (scope: { attachments: undefined; effect: () => void }) => void) {
            fn({ attachments: undefined, effect() {} });
          },
          llm: { registerAdapter() {} },
        } as never,
        { provider: "kiro", displayName: "Kiro" },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(child.execFile).not.toHaveBeenCalled();
      expect(child.execFileSync).not.toHaveBeenCalled();
      expect(child.execSync).not.toHaveBeenCalled();
      expect(child.spawn).not.toHaveBeenCalled();
      expect(child.spawnSync).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
