/**
 * Harness adapter over the local `grok` CLI.
 *
 * `listModels` and `resolveModel` read the Pi catalog file and do not spawn.
 * `stream` spawns `grok` with `--max-turns 1` and without `--always-approve`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  type GenerateOptions,
  LlmAdapter,
  LlmError,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  ReasoningEffortId,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { type GrokListedModel, readGrokCatalog } from "./catalog.js";
import { buildGrokCliArgs, resolveGrokBinary } from "./cli.js";
import { createMessagesParseState, finishMessagesParse, parseGrokMessagesLine } from "./messages.js";
import { buildGrokPrompt } from "./prompt.js";

export interface GrokAdapterOptions {
  provider: string;
  displayName: string;
}

const EFFORTS = [
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"],
] as const;

function errorFinish(message: string): StreamChunk {
  return { type: "finish", reason: { kind: "error", failure: { message, code: "GROK_CLI" } } };
}

function abortedFinish(): StreamChunk {
  return { type: "finish", reason: { kind: "aborted", failure: { message: "Grok CLI aborted", code: "ABORTED" } } };
}

function waitClose(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once("close", (code) => resolve(code));
  });
}

export class GrokAdapter extends LlmAdapter {
  constructor(private readonly options: GrokAdapterOptions) {
    super();
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog().map((model) => this.describe(provider, model));
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const known = this.catalog().find((candidate) => candidate.id === model);
    if (!known) throw new LlmError(`Unknown Grok model: ${model}`, "UNKNOWN_MODEL");
    return {
      ...this.describe(provider, known),
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: known.maxTokens,
      ...(known.reasoning
        ? { reasoning: { efforts: EFFORTS.map(([id, name]) => ({ id: ReasoningEffortId(id), name })) } }
        : {}),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      yield abortedFinish();
      return;
    }
    let binary: string;
    try {
      binary = resolveGrokBinary();
    } catch (error) {
      yield errorFinish(error instanceof Error ? error.message : String(error));
      return;
    }
    const child = spawn(
      binary,
      buildGrokCliArgs({
        prompt: buildGrokPrompt(options),
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }),
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let stderr = "";
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const state = createMessagesParseState();
    try {
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout });
        for await (const line of lines) {
          if (options.signal?.aborted) break;
          yield* parseGrokMessagesLine(line, state);
        }
      }
      const code = await waitClose(child);
      if (options.signal?.aborted) {
        if (!state.finished) yield abortedFinish();
        return;
      }
      if ((spawnError || code !== 0) && !state.finished) {
        yield errorFinish(stderr.trim() || spawnError?.message || `grok exited ${code ?? "null"}`);
        return;
      }
      yield* finishMessagesParse(state);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  }

  private catalog(): GrokListedModel[] {
    return readGrokCatalog();
  }

  private describe(provider: string, model: GrokListedModel): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.input,
    };
  }
}
