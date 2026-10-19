/**
 * Harness adapter over the local `grok` CLI.
 *
 * `listModels` and `resolveModel` read the Pi catalog file and do not spawn.
 * `stream` spawns `grok` with `--max-turns 1` and without `--always-approve`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AttachmentStore, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import {
  type ContentBlock,
  type GenerateOptions,
  LlmAdapter,
  LlmError,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  offloadedImageText,
  ReasoningEffortId,
  type StreamChunk,
  textOnlyImageText,
} from "@deepseek-ai/dsh-llm";
import { type GrokListedModel, readGrokCatalog } from "./catalog.js";
import { buildGrokCliArgs, resolveGrokBinary } from "./cli.js";
import { createMessagesParseState, finishMessagesParse, parseGrokMessagesLine } from "./messages.js";
import { buildGrokAcpContent, type GrokAcpBlock, grokAcpDocument } from "./prompt.js";
import { createToolChunkTranslator } from "./tools.js";

export interface GrokAdapterOptions {
  provider: string;
  displayName: string;
  /** Optional durable attachment service, resolved at request time. */
  attachments?: () => AttachmentStore | undefined;
}

/** Every listed Grok model accepts images. The catalog file stays text-only. */
const INPUT_MODALITIES = ["text", "image"] as const;

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
    let promptFile: { dir: string; file: string };
    try {
      promptFile = await this.writePromptFile(options);
    } catch (error) {
      if (options.signal?.aborted) {
        yield abortedFinish();
        return;
      }
      yield errorFinish(error instanceof Error ? error.message : String(error));
      return;
    }
    const child = spawn(
      binary,
      buildGrokCliArgs({
        promptFile: promptFile.file,
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
    const tools = createToolChunkTranslator(options.tools);
    try {
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout });
        for await (const line of lines) {
          if (options.signal?.aborted) break;
          for (const chunk of parseGrokMessagesLine(line, state)) yield* tools.push(chunk);
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
      for (const chunk of finishMessagesParse(state)) yield* tools.push(chunk);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await rm(promptFile.dir, { recursive: true, force: true });
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
      inputModalities: [...INPUT_MODALITIES],
    };
  }

  private async writePromptFile(options: GenerateOptions): Promise<{ dir: string; file: string }> {
    const content = await this.acpContent(options);
    const dir = await mkdtemp(join(tmpdir(), "ns-dsh-grok-"));
    const file = join(dir, "prompt.json");
    try {
      await writeFile(file, grokAcpDocument(content), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { dir, file };
  }

  private async acpContent(options: GenerateOptions): Promise<GrokAcpBlock[]> {
    const store = this.options.attachments?.();
    const messages = [];
    for (const message of options.messages) {
      const content = [];
      for (const block of message.content) {
        if (block.type === "text" || block.type === "reasoning" || block.type === "tool-call") {
          content.push(block);
        } else if (block.type === "image") {
          content.push(await this.imageBlock(block, store, options.signal));
        }
      }
      messages.push({ role: message.role, content });
    }
    return buildGrokAcpContent({ system: options.system, messages });
  }

  private async imageBlock(
    block: Extract<ContentBlock, { type: "image" }>,
    store: AttachmentStore | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ type: "image"; data?: string; mimeType?: string; placeholder: string }> {
    if (block.offloaded === true) {
      return { type: "image", placeholder: this.omittedImageText(block.attachment, store, true) };
    }
    if (!store) return { type: "image", placeholder: textOnlyImageText(block.attachment) };
    try {
      const stored = await store.readImage(block.attachment, signal);
      return {
        type: "image",
        data: Buffer.from(stored.data).toString("base64"),
        mimeType: block.attachment.mediaType,
        placeholder: textOnlyImageText(block.attachment),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { type: "image", placeholder: textOnlyImageText(block.attachment) };
    }
  }

  private omittedImageText(ref: ImageAttachmentRef, store: AttachmentStore | undefined, offloaded: boolean): string {
    if (!offloaded) return textOnlyImageText(ref);
    let hostPath: string | undefined;
    try {
      hostPath = store?.imageHostPath(ref);
    } catch {
      hostPath = undefined;
    }
    return offloadedImageText(ref, hostPath ? { readonlyPath: hostPath } : undefined);
  }
}
