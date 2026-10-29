import { describe, expect, it } from "vitest";
import {
  DSH_ID,
  DSH_PLUGIN,
  dshPluginState,
  ensureDshPlugin,
  removeDshPlugin,
  renderDshBlock,
  setDshPluginEnabled,
} from "../src/dsh-patch.js";
import { PROVIDERS } from "../src/selection.js";

const KIRO = renderDshBlock("kiro");
const GROK = renderDshBlock("grok");

describe("renderDshBlock", () => {
  it("writes a four-space insert item with the loader id and plugin name", () => {
    expect(KIRO).toBe(
      [
        "- insert:",
        "    - id: llm-kiro",
        "      name: 'ns-dsh-llm-kiro'",
        "      config:",
        "        provider: kiro",
      ].join("\n"),
    );
    for (const provider of PROVIDERS) {
      expect(DSH_PLUGIN[provider]).toBe(`ns-dsh-llm-${provider}`);
      expect(DSH_ID[provider]).toBe(`llm-${provider}`);
    }
  });
});

describe("ensureDshPlugin", () => {
  it("creates the file body with a header when empty or missing content", () => {
    const text = ensureDshPlugin("", "kiro");
    expect(text.startsWith("# ns-bridge provider routes.")).toBe(true);
    expect(text).toContain(KIRO);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("appends after an existing block, separated by a blank line", () => {
    const text = ensureDshPlugin(`${KIRO}\n`, "grok");
    expect(text).toBe(`${KIRO}\n\n${GROK}\n`);
  });

  it("takes the place of a profile template's empty array", () => {
    const template = "# Your patch layer for this dsh profile\n[]\n";
    const text = ensureDshPlugin(template, "kiro");
    expect(text).toBe(`${template.split("\n")[0]}\n${KIRO}\n`);
    expect(ensureDshPlugin(text, "grok")).toBe(`${template.split("\n")[0]}\n${KIRO}\n\n${GROK}\n`);
  });

  it("inserts only when the id is absent", () => {
    const once = ensureDshPlugin(`${KIRO}\n`, "kiro");
    expect(once).toBe(`${KIRO}\n`);
  });

  it("preserves a customized item and a disabled item", () => {
    const custom = [
      "- insert:",
      "    - id: llm-kiro",
      "      name: 'ns-dsh-llm-kiro'",
      "      config:",
      "        provider: kiro",
      "        profile: custom",
      "  disabled: true",
      "",
    ].join("\n");
    expect(ensureDshPlugin(custom, "kiro")).toBe(custom);
    expect(dshPluginState(custom, "kiro")).toBe("off");
  });

  it("does not reformat unrelated patch entries", () => {
    const raw = ["- insert:", "    - id: user-plugin", "      name: user-plugin", ""].join("\n");
    const text = ensureDshPlugin(raw, "arnict");
    expect(text.startsWith(raw)).toBe(true);
    expect(text).toContain("- id: llm-arnict");
  });
});

describe("dshPluginState", () => {
  it("finds the provider by its loader id", () => {
    const raw = [KIRO, "", GROK].join("\n");
    expect(dshPluginState(raw, "grok")).toBe("on");
    expect(dshPluginState(raw, "devin")).toBe("missing");
    expect(dshPluginState(raw, "qoder")).toBe("missing");
  });

  it("reads the disabled key from the enclosing insert item", () => {
    const raw = ["- insert:", "    - id: llm-kiro", "      name: 'ns-dsh-llm-kiro'", "  disabled: true"].join("\n");
    expect(dshPluginState(raw, "kiro")).toBe("off");
  });

  it("does not mistake an adjacent insert item for the entry's parent", () => {
    const raw = ["- insert:", "    - id: user-plugin", "", "- insert:", "    - id: llm-kiro", "      name: x"].join(
      "\n",
    );
    expect(dshPluginState(raw, "kiro")).toBe("on");
  });
});

describe("setDshPluginEnabled", () => {
  it("adds and removes the two-space disabled sibling key", () => {
    const raw = `${KIRO}\n`;
    const off = setDshPluginEnabled(raw, "kiro", false);
    expect(off).toBe(`${KIRO}\n  disabled: true\n`);
    expect(dshPluginState(off, "kiro")).toBe("off");
    expect(setDshPluginEnabled(off, "kiro", true)).toBe(raw);
  });

  it("only touches the block that owns the id", () => {
    const raw = [KIRO, "", GROK].join("\n");
    const off = setDshPluginEnabled(raw, "grok", false);
    expect(off).toContain(KIRO);
    expect(dshPluginState(off, "kiro")).toBe("on");
    expect(dshPluginState(off, "grok")).toBe("off");
  });

  it("is a no-op for a provider that is not in the file", () => {
    const raw = `${KIRO}\n`;
    expect(setDshPluginEnabled(raw, "devin", false)).toBe(raw);
  });
});

describe("removeDshPlugin", () => {
  it("removes the entry and the insert item when it was alone", () => {
    expect(removeDshPlugin(`# header\n\n${KIRO}\n`, "kiro")).toBe("# header\n[]\n");
  });

  it("keeps the insert item when other providers share it", () => {
    const raw = ["- insert:", "    - id: llm-kiro", "      name: k", "    - id: llm-grok", "      name: g", ""].join(
      "\n",
    );
    const text = removeDshPlugin(raw, "kiro");
    expect(text).toBe(["- insert:", "    - id: llm-grok", "      name: g", ""].join("\n"));
  });

  it("leaves unrelated insert items untouched", () => {
    const raw = ["- insert:", "    - id: user-plugin", "      name: user-plugin", "", KIRO, ""].join("\n");
    const text = removeDshPlugin(raw, "kiro");
    expect(text).toBe(["- insert:", "    - id: user-plugin", "      name: user-plugin", ""].join("\n"));
  });

  it("returns the input unchanged when the provider is absent", () => {
    const raw = `${KIRO}\n`;
    expect(removeDshPlugin(raw, "qoder")).toBe(raw);
  });

  it("keeps the patch layer a YAML array when it only held the removed block", () => {
    expect(removeDshPlugin(`${KIRO}\n`, "kiro")).toBe("[]\n");
  });
});
