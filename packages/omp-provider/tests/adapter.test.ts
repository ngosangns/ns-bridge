import { describe, expect, it, vi } from "vitest";

import {
  adaptProviderConfig,
  SESSION_START_ALIASES,
  toFetchDynamicModels,
  toOmpApiKey,
  toPiContext,
  wrapExtensionApi,
} from "../src/adapter.js";
import { createGrokNativeEditHost, GROK_NATIVE_EDIT } from "../src/grok-native-edit.js";

const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }];

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
    expect(toOmpApiKey("grok-cli", {})).toBe("grok-cli");
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

  it("copies grok stream options and attaches the native-edit host", () => {
    const streamSimple = vi.fn();
    const emit = () => undefined;
    const options = { apiKey: "k", onDetachedToolUpdate: emit };
    for (const api of ["grok-cli", "grok-sdk"]) {
      const adapted = adaptProviderConfig({ api, streamSimple }, {});
      const wrapped = adapted.streamSimple as (m: unknown, c: unknown, o?: unknown) => unknown;
      wrapped({ id: "grok" }, { messages: [] }, options);
      const passed = streamSimple.mock.calls.at(-1)?.[2] as Record<PropertyKey, unknown>;
      expect(passed).not.toBe(options);
      expect(passed.apiKey).toBe("k");
      expect(passed.onDetachedToolUpdate).toBe(emit);
      expect(passed[GROK_NATIVE_EDIT]).toEqual(
        expect.objectContaining({
          prepare: expect.any(Function),
          stampResolved: expect.any(Function),
          settle: expect.any(Function),
        }),
      );
    }
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

describe("createGrokNativeEditHost", () => {
  it("stamps the loaded symbol and emits only tool_execution_end", async () => {
    const symbol = Symbol("kCursorExecResolved");
    const events: unknown[] = [];
    const host = createGrokNativeEditHost({
      emit: (event) => events.push(event),
      loadSymbol: async () => symbol,
    });
    expect(await host.prepare()).toBe(true);
    const block: Record<symbol, boolean> = {};
    expect(host.stampResolved(block)).toBe(true);
    expect(block[symbol]).toBe(true);
    const result = { content: [{ type: "text", text: "Edited a.txt" }], details: { diff: "-1|a\n+1|b", path: "a.txt" } };
    host.settle({ toolCallId: "e1", toolName: "edit", args: { path: "a.txt", op: "update" }, result, isError: false });
    expect(events).toEqual([
      { type: "tool_execution_end", toolCallId: "e1", toolName: "edit", result, isError: false },
    ]);
  });

  it("stays off when the sink or the symbol is missing", async () => {
    const noSink = createGrokNativeEditHost({ loadSymbol: async () => Symbol("x") });
    expect(await noSink.prepare()).toBe(false);
    expect(noSink.stampResolved({})).toBe(false);

    const noSymbol = createGrokNativeEditHost({
      emit: () => undefined,
      loadSymbol: async () => undefined,
    });
    expect(await noSymbol.prepare()).toBe(false);
    expect(noSymbol.stampResolved({})).toBe(false);
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
});
