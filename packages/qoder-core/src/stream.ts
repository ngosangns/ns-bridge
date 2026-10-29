// ABOUTME: One Qoder agent-sdk query per host turn. The host owns the tool loop.

import {
  type Options,
  ProcessTransport,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@qoder-ai/qoder-agent-sdk";
import { recordUsage } from "ns-core-utils";
import { type ResolvedQoderAuth, requireQoderAuth } from "./auth.js";
import { QODER_DEFAULT_CONTEXT_WINDOW, qoderBootstrapModels } from "./catalog.js";
import { QoderApiError } from "./errors.js";
import { buildQoderPrompt, collectQoderImages, qoderImageData } from "./prompt.js";
import { createSdkReduceState, finishSdkReduce, reduceSdkMessage } from "./sdk-reduce.js";
import { qoderSessionId } from "./session.js";
import { createHostToolMcpServer, hostToolName } from "./tools.js";
import type { QoderEffort, QoderMessage, QoderStreamEvent, QoderTool } from "./types.js";

export type QueryFactory = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface StreamQoderOptions {
  model: string;
  messages: readonly QoderMessage[];
  systemPrompt?: string;
  tools?: readonly QoderTool[];
  effort?: QoderEffort;
  sessionId?: string;
  signal?: AbortSignal;
  cwd?: string;
  auth?: ResolvedQoderAuth;
  queryFactory?: QueryFactory;
}

const BRIDGE_NOTE =
  "You are bridged through ns-bridge into Pi/OMP/DSH. Built-in qodercli tools are disabled. Call only the host tools listed for this turn. Do not run them yourself. Stop after the tool call. The host executes it and sends the result on the next turn.";

const BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "LS",
  "WebSearch",
  "WebFetch",
  "Task",
  "Skill",
  "NotebookEdit",
  "TodoWrite",
  "TodoRead",
];

function aborted(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** OMP runs its extensions on Bun. */
function runsOnBun(): boolean {
  return (process.versions as Record<string, string | undefined>).bun !== undefined;
}

function sdkEffort(effort: QoderEffort): string {
  if (effort === "minimal") return "low";
  if (effort === "xhigh") return "max";
  return effort;
}

function promptFor(options: StreamQoderOptions): string | AsyncIterable<SDKUserMessage> {
  const text = buildQoderPrompt(options.messages, options.systemPrompt);
  const images = collectQoderImages(options.messages);
  if (images.length === 0) return text;
  async function* once(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text },
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mimeType,
              data: qoderImageData(image.data),
            },
          })),
        ],
      },
    };
  }
  return once();
}

function renameToolEvent(event: QoderStreamEvent, known: ReadonlySet<string>): QoderStreamEvent {
  if (event.type === "tool_call_start" || event.type === "tool_call_end") {
    return { ...event, name: hostToolName(event.name, known) };
  }
  return event;
}

async function* streamQoderResponse(options: StreamQoderOptions): AsyncGenerator<QoderStreamEvent> {
  if (options.signal?.aborted) throw aborted();
  const auth = options.auth ?? requireQoderAuth();
  const prompt = promptFor(options);
  const text = typeof prompt === "string" ? prompt : buildQoderPrompt(options.messages, options.systemPrompt);
  if (!text.trim()) throw new QoderApiError("Qoder prompt is empty");

  const known = new Set((options.tools ?? []).map((entry) => entry.name));
  const mcp = createHostToolMcpServer(options.tools);
  const pending: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const sessionId = qoderSessionId(options.sessionId);
  // The SDK's own transport errors name the exit but not why; the tail keeps
  // the worker's last words so the failure reaches the host instead of a bare
  // "exited with code".
  let stderrTail = "";
  const sdkOptions: Options = {
    auth: auth.options,
    model: options.model,
    maxTurns: 1,
    permissionMode: "default",
    tools: [],
    skills: [],
    disallowedTools: BUILTIN_TOOLS,
    includePartialMessages: true,
    persistSession: false,
    cwd: options.cwd ?? process.cwd(),
    stderr: (data) => {
      stderrTail = `${stderrTail}${data}`.slice(-2_000);
    },
    systemPrompt: { type: "preset", preset: "qodercli", append: BRIDGE_NOTE },
    canUseTool: async (toolName, input, permission) => {
      const name = hostToolName(toolName, known);
      if (known.has(name)) pending.push({ id: permission.toolUseID, name, input });
      return {
        behavior: "deny",
        interrupt: true,
        toolUseID: permission.toolUseID,
        message: known.has(name)
          ? "The host executes this tool. Stop."
          : "Built-in tools are disabled. Use a host tool.",
      };
    },
    ...(options.effort
      ? {
          resolveModel: () => ({
            model: options.model,
            parameters: { reasoningEffort: sdkEffort(options.effort as QoderEffort) },
          }),
        }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(mcp ? { mcpServers: { "ns-bridge-host": mcp } } : {}),
    ...(options.signal ? { abortController: createAbortBridge(options.signal) } : {}),
    // Bun's worker_threads ignores the stdout/stderr channel options this SDK's
    // default WorkerTransport relies on, so the worker's messages never arrive.
    // OMP runs on Bun; there the query drives qodercli over the process
    // transport instead.
    ...(runsOnBun() ? { transport: ProcessTransport.default } : {}),
  };

  const runQuery = options.queryFactory ?? query;
  const q = runQuery({ prompt, options: sdkOptions });
  const state = createSdkReduceState();
  let sawSuccessResult = false;
  const emitted = new Set<string>();

  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      if (options.signal?.aborted) throw aborted();
      let sawTool = false;
      for (const event of reduceSdkMessage(state, message)) {
        const renamed = renameToolEvent(event, known);
        if (renamed.type === "tool_call_end") {
          emitted.add(renamed.id);
          sawTool = true;
        }
        yield renamed;
      }
      if (message.type === "result") {
        if (message.subtype === "success") sawSuccessResult = true;
        else if (message.subtype !== "error_max_turns") {
          const detail = message.subtype === "error_during_execution" ? message.errors?.join("; ") : message.subtype;
          throw new QoderApiError(detail || "Qoder query failed", message.subtype);
        }
      }
      if (sawTool || pending.length > 0) break;
    }
    for (const call of pending) {
      if (emitted.has(call.id)) continue;
      state.sawTool = true;
      const index = state.nextIndex;
      state.nextIndex += 1;
      emitted.add(call.id);
      yield { type: "tool_call_start", index, id: call.id, name: call.name };
      yield {
        type: "tool_call_end",
        index,
        id: call.id,
        name: call.name,
        arguments: call.input,
        argumentsJson: JSON.stringify(call.input),
      };
    }
    for (const event of finishSdkReduce(state)) yield event;
  } catch (error) {
    const detail = stderrTail.trim();
    if (detail && error instanceof Error && !error.message.includes(detail)) {
      throw new QoderApiError(`${error.message}: ${detail}`);
    }
    throw error;
  } finally {
    // After a successful result the SDK has already torn down the transport.
    // A host tool handoff must still interrupt so qodercli does not run the tool.
    if (!sawSuccessResult && typeof q.interrupt === "function") {
      try {
        await q.interrupt();
      } catch {
        // ignore
      }
    }
  }
}

function createAbortBridge(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

export function streamQoder(options: StreamQoderOptions): AsyncGenerator<QoderStreamEvent> {
  const contextWindow =
    qoderBootstrapModels().find((model) => model.id === options.model)?.contextWindow ?? QODER_DEFAULT_CONTEXT_WINDOW;
  return recordUsage(streamQoderResponse(options), {
    vendor: "qoder",
    model: options.model,
    contextWindow,
    effort: options.effort,
    sessionId: options.sessionId,
  });
}
