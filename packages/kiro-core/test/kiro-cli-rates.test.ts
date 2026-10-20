// ABOUTME: Covers reading per-model billing weights from kiro-cli.
// ABOUTME: In its own file because vi.mock replaces child_process for the whole module graph.

import { afterEach, describe, expect, it, vi } from "vitest";

type ExecCallback = (error: Error | null, stdout: string) => void;
const execFileMock = vi.hoisted(() => vi.fn());

/** Make the next `execFile` call finish with `stdout`. */
function answers(stdout: string): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    (args.at(-1) as ExecCallback)(null, stdout);
  });
}

/** Make the next `execFile` call fail the way a missing binary does. */
function fails(message: string): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    (args.at(-1) as ExecCallback)(new Error(message), "");
  });
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

const { getKiroCliModelRates } = await import("../src/kiro-cli.js");

afterEach(() => {
  execFileMock.mockReset();
});

/** Shape kiro-cli 2.21 emits for `chat --list-models --format json`. */
function listModelsOutput(models: unknown[]): string {
  return JSON.stringify({ models, default_model: "claude-opus-5" });
}

describe("getKiroCliModelRates", () => {
  it("reads the multiplier and unit for each model", async () => {
    answers(
      listModelsOutput([
        { model_id: "claude-opus-5", rate_multiplier: 2.2, rate_unit: "Credit" },
        { model_id: "qwen3-coder-next", rate_multiplier: 0.05, rate_unit: "Credit" },
      ]),
    );

    const rates = await getKiroCliModelRates();

    expect(rates?.get("claude-opus-5")).toEqual({ multiplier: 2.2, unit: "Credit" });
    expect(rates?.get("qwen3-coder-next")).toEqual({ multiplier: 0.05, unit: "Credit" });
  });

  it("asks kiro-cli for JSON rather than the human-readable listing", async () => {
    answers(listModelsOutput([{ model_id: "auto", rate_multiplier: 1 }]));

    await getKiroCliModelRates();

    expect(execFileMock).toHaveBeenCalledWith(
      "kiro-cli",
      ["chat", "--list-models", "--format", "json"],
      expect.objectContaining({ encoding: "utf-8" }),
      expect.any(Function),
    );
  });

  it("skips entries whose multiplier is missing, non-numeric or not positive", async () => {
    answers(
      listModelsOutput([
        { model_id: "good", rate_multiplier: 1.3, rate_unit: "Credit" },
        { model_id: "no-rate" },
        { model_id: "string-rate", rate_multiplier: "1.3" },
        { model_id: "zero", rate_multiplier: 0 },
        { model_id: "negative", rate_multiplier: -1 },
        { rate_multiplier: 1 },
      ]),
    );

    const rates = await getKiroCliModelRates();

    expect([...(rates?.keys() ?? [])]).toEqual(["good"]);
  });

  it("omits the unit when kiro-cli does not name one", async () => {
    answers(listModelsOutput([{ model_id: "auto", rate_multiplier: 1 }]));

    expect((await getKiroCliModelRates())?.get("auto")).toEqual({ multiplier: 1 });
  });

  // A catalog without rates is still a usable catalog, so every failure here has
  // to degrade to "no rates known" rather than break the refresh.
  it("returns undefined when kiro-cli is not installed", async () => {
    fails("spawn kiro-cli ENOENT");

    expect(await getKiroCliModelRates()).toBeUndefined();
  });

  it.each([
    ["invalid JSON", "not json at all"],
    ["a payload with no models array", JSON.stringify({ default_model: "auto" })],
    ["a listing where every entry is unusable", listModelsOutput([{ model_id: "x", rate_multiplier: 0 }])],
  ])("returns undefined for %s", async (_label, output) => {
    answers(output);

    expect(await getKiroCliModelRates()).toBeUndefined();
  });
});
