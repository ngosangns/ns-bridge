import { describe, expect, it, vi } from "vitest";

import {
  ARNICT_PROVIDER_ID,
  adaptProviderConfig,
  SESSION_START_ALIASES,
  toFetchDynamicModels,
  toOmpApiKey,
  toPiContext,
  wrapExtensionApi,
} from "../src/adapter.js";

const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }];

const ompCompactThreshold = (window: number) => window - Math.max(Math.floor(window * 0.15), 16_384);

const firstModel = (config: Record<string, unknown>) => {
  const first = (config.models as Array<Record<string, unknown>>)[0];
  if (first === undefined) throw new Error("adapted config has no models");
  return first;
};

const windowOf = (row: Record<string, unknown>) => {
  if (typeof row.contextWindow !== "number") throw new Error("model row has no numeric contextWindow");
  return row.contextWindow;
};

/** The row ns-pi-provider registers for arnict's GLM standard window. */
const arnictGlmRow = {
  id: "zai/glm-5.3-flash-uncensored",
  name: "GLM 5.3 Flash Abliterated",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.125, output: 0.5, cacheRead: 0.05, cacheWrite: 0 },
  contextWindow: 400_000,
  maxTokens: 131_072,
  maxContextWindow: 1_048_576,
};

describe("toPiContext", () => {
  it("joins OMP systemPrompt[] and keeps tools", () => {
    const omp = {
      systemPrompt: ["You are OMP.", "", "  ", "Project rules."],
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools,
    };
    const pi = toPiContext(omp);
    expect(pi.systemPrompt).toBe("You are OMP.\n\nProject rules.");
    expect(pi.tools).toBe(tools);
    expect(pi.messages).toBe(omp.messages);
    expect(omp.systemPrompt).toEqual(["You are OMP.", "", "  ", "Project rules."]); // not mutated
  });

  it("removes an empty systemPrompt[] instead of passing an empty string", () => {
    const pi = toPiContext({ systemPrompt: [], messages: [] });
    expect("systemPrompt" in pi).toBe(false);
  });

  it("delivers OMP developer messages as user turns", () => {
    const omp = {
      messages: [
        { role: "user", content: "a" },
        { role: "developer", content: "reminder", synthetic: true },
        { role: "assistant", content: [] },
      ],
    };
    const pi = toPiContext(omp);
    expect(pi.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(pi.messages[1]).toMatchObject({ content: "reminder", synthetic: true });
    expect(omp.messages[1]?.role).toBe("developer");
  });

  it("passes Pi-shaped contexts through untouched", () => {
    const pi = {
      systemPrompt: "already a string",
      messages: [
        { role: "system", content: "p", toolsAdded: tools },
        { role: "user", content: "hi" },
      ],
    };
    expect(toPiContext(pi)).toBe(pi);
  });
});

describe("toOmpApiKey", () => {
  it("maps $ENV refs to OMP env names only when set", () => {
    expect(toOmpApiKey("$XAI_API_KEY", { XAI_API_KEY: "k" })).toBe("XAI_API_KEY");
    expect(toOmpApiKey("$XAI_API_KEY", {})).toBeUndefined();
  });

  it("unescapes Pi $$ literals and keeps plain literals / commands", () => {
    expect(toOmpApiKey("ab$$cd$$", {})).toBe("ab$cd$");
    expect(toOmpApiKey("plain-literal", {})).toBe("plain-literal");
    expect(toOmpApiKey("!security find-generic-password -w", {})).toBe("!security find-generic-password -w");
    expect(toOmpApiKey("", {})).toBeUndefined();
    expect(toOmpApiKey(undefined, {})).toBeUndefined();
  });
});

describe("adaptProviderConfig", () => {
  it("turns refreshModels into fetchDynamicModels and wraps streamSimple", async () => {
    const refreshModels = vi.fn(async () => [{ id: "m1" }]);
    const streamSimple = vi.fn((_model: unknown, context: unknown, _options?: unknown) => context);
    const adapted = adaptProviderConfig(
      { name: "X", api: "x-api", apiKey: "$MISSING_KEY", models: [], refreshModels, streamSimple },
      {},
    );

    expect("refreshModels" in adapted).toBe(false);
    expect("apiKey" in adapted).toBe(false);

    const fetchDynamicModels = adapted.fetchDynamicModels as (key?: string) => Promise<unknown[]>;
    await expect(fetchDynamicModels("tok")).resolves.toEqual([{ id: "m1" }]);
    expect(refreshModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ credential: { type: "api_key", key: "tok", access: "tok" }, allowNetwork: false }),
    );
    await fetchDynamicModels(undefined);
    expect(refreshModels).toHaveBeenLastCalledWith(expect.objectContaining({ credential: undefined }));

    const wrapped = adapted.streamSimple as (m: unknown, c: unknown, o?: unknown) => unknown;
    const options = { apiKey: "k" };
    const seen = wrapped({ id: "m1" }, { systemPrompt: ["a", "b"], messages: [], tools }, options) as {
      systemPrompt: string;
    };
    expect(seen.systemPrompt).toBe("a\n\nb");
    expect(streamSimple).toHaveBeenCalledWith({ id: "m1" }, expect.anything(), options);
    expect(streamSimple.mock.calls.at(-1)?.[2]).toBe(options);
  });

  it("returns [] from fetchDynamicModels when refresh yields nothing", async () => {
    await expect(toFetchDynamicModels(() => undefined)(undefined)).resolves.toEqual([]);
  });

  it("passes a null catalog through so OMP does not cache it as authoritative", async () => {
    await expect(toFetchDynamicModels(() => null)(undefined)).resolves.toBeNull();
  });

  it("keeps an explicit fetchDynamicModels", () => {
    const own = async () => [];
    const adapted = adaptProviderConfig({ fetchDynamicModels: own, refreshModels: async () => [] }, {});
    expect(adapted.fetchDynamicModels).toBe(own);
  });
});

describe("arnict model rows", () => {
  it("registers zai/glm-5.3-flash-uncensored at the smallest window whose OMP threshold reaches Pi's 383,616", () => {
    const adapted = adaptProviderConfig(
      { name: "Arnict", api: "arnict-chat", models: [{ ...arnictGlmRow }] },
      {},
      ARNICT_PROVIDER_ID,
    );
    const row = firstModel(adapted);
    const window = windowOf(row);
    expect(ompCompactThreshold(window)).toBe(383_616);
    expect(ompCompactThreshold(window - 1)).toBeLessThan(383_616); // smallest such window
    expect(window).toBeLessThanOrEqual(1_048_576);
    expect(row.maxContextWindow).toBe(1_048_576);
    expect(row.id).toBe("zai/glm-5.3-flash-uncensored");
    expect(row.maxTokens).toBe(131_072);
  });

  it("uses an explicit compaction thresholdTokens instead of the Pi reserve", () => {
    const adapted = adaptProviderConfig(
      { models: [{ ...arnictGlmRow, compaction: { thresholdTokens: 383_616 } }] },
      {},
      "arnict",
    );
    expect(ompCompactThreshold(windowOf(firstModel(adapted)))).toBe(383_616);
  });

  it("caps the mapped window at maxContextWindow, or at the row's own window when it has none", () => {
    const capped = adaptProviderConfig({ models: [{ ...arnictGlmRow, maxContextWindow: 420_000 }] }, {}, "arnict");
    expect(windowOf(firstModel(capped))).toBe(420_000);
    const bare: Record<string, unknown> = { ...arnictGlmRow };
    delete bare.maxContextWindow;
    const own = adaptProviderConfig({ models: [bare] }, {}, "arnict");
    expect(windowOf(firstModel(own))).toBe(400_000);
  });

  it("lands a smaller standard window on its own Pi threshold when a native window rides along", () => {
    const standard = adaptProviderConfig({ models: [{ ...arnictGlmRow, contextWindow: 200_000 }] }, {}, "arnict");
    const window = windowOf(firstModel(standard));
    expect(ompCompactThreshold(window)).toBe(200_000 - 16_384);
    expect(window).toBeLessThanOrEqual(1_048_576);
  });

  it("maps fetchDynamicModels results but passes a null catalog through", async () => {
    const adapted = adaptProviderConfig(
      { models: [], fetchDynamicModels: async () => [{ ...arnictGlmRow }] },
      {},
      "arnict",
    );
    const fetcher = adapted.fetchDynamicModels as (key?: string) => Promise<Array<Record<string, unknown>>>;
    const dynamic = (await fetcher(undefined))[0];
    if (dynamic === undefined) throw new Error("expected at least one dynamic model");
    expect(ompCompactThreshold(windowOf(dynamic))).toBe(383_616);

    const nullable = adaptProviderConfig({ models: [], fetchDynamicModels: async () => null }, {}, "arnict");
    await expect((nullable.fetchDynamicModels as (key?: string) => Promise<unknown>)(undefined)).resolves.toBeNull();
  });

  it("maps refreshModels results when building fetchDynamicModels for arnict", async () => {
    const adapted = adaptProviderConfig({ models: [], refreshModels: async () => [{ ...arnictGlmRow }] }, {}, "arnict");
    const fetcher = adapted.fetchDynamicModels as (key?: string) => Promise<Array<Record<string, unknown>>>;
    const dynamic = (await fetcher(undefined))[0];
    if (dynamic === undefined) throw new Error("expected at least one dynamic model");
    expect(ompCompactThreshold(windowOf(dynamic))).toBe(383_616);
  });

  it("leaves kiro rows untouched", () => {
    const kiroRow = { id: "kiro-claude", contextWindow: 176_470, maxContextWindow: 200_000 };
    const models = [kiroRow];
    const adapted = adaptProviderConfig({ models, refreshModels: async () => models }, {}, "kiro");
    expect(adapted.models).toBe(models);
    expect((adapted.models as unknown[])[0]).toBe(kiroRow);
  });
});

describe("wrapExtensionApi", () => {
  class FakeApi {
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
      this.commands.push(name); // relies on `this` binding
    }
  }

  it("adapts providers, drops unsupported events, aliases session_start", () => {
    const real = new FakeApi();
    const pi = wrapExtensionApi(real, { env: {} });
    pi.registerProvider("p", { apiKey: "$NOPE", refreshModels: async () => [] });
    pi.on("session_info_changed");
    pi.on("session_start");
    pi.on("session_shutdown");
    pi.registerCommand("cmd");

    expect(real.providers.get("p")).toEqual({ fetchDynamicModels: expect.any(Function) });
    expect(real.events).toEqual(["session_start", ...SESSION_START_ALIASES, "session_shutdown"]);
    expect(real.commands).toEqual(["cmd"]);
  });

  it("remaps arnict rows by provider id and leaves kiro rows alone", async () => {
    const real = new FakeApi();
    const pi = wrapExtensionApi(real, { env: {} });
    const arnictRow = { ...arnictGlmRow };
    const kiroRow = { id: "kiro-claude", contextWindow: 176_470 };
    pi.registerProvider("arnict", { models: [arnictRow], fetchDynamicModels: async () => [arnictRow] });
    pi.registerProvider("kiro", { models: [kiroRow] });

    const arnict = real.providers.get("arnict");
    if (arnict === undefined) throw new Error("arnict provider was not registered");
    const staticRow = (arnict.models as Array<Record<string, unknown>>)[0];
    if (staticRow === undefined) throw new Error("arnict has no static models");
    expect(ompCompactThreshold(windowOf(staticRow))).toBe(383_616);
    const dynamic = await (arnict.fetchDynamicModels as (key?: string) => Promise<Array<Record<string, unknown>>>)(
      undefined,
    );
    const dynamicRow = dynamic[0];
    if (dynamicRow === undefined) throw new Error("arnict returned no dynamic models");
    expect(ompCompactThreshold(windowOf(dynamicRow))).toBe(383_616);

    const kiro = real.providers.get("kiro");
    if (kiro === undefined) throw new Error("kiro provider was not registered");
    expect((kiro.models as unknown[])[0]).toBe(kiroRow);
  });
});
