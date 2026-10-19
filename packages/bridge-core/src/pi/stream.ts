// ABOUTME: Drives a vendor core's neutral event stream into a Pi-family AssistantMessageEventStream.
// ABOUTME: Owns message assembly for Pi and OMP; the vendor core owns the wire protocol and every retry.

import { formatErrorMessage } from "../errors.js";
import type { BridgeStreamEvent, BridgeUsage } from "../types.js";

type PiContentBlock =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "thinking"; thinking: string; thinkingSignature?: string; [key: string]: unknown }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; [key: string]: unknown };

/** The assistant message Pi and OMP both render from (`partial`) and store (`message`). */
export interface PiAssistantMessageLike {
  role: "assistant";
  content: PiContentBlock[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    [key: string]: unknown;
  };
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
  [key: string]: unknown;
}

/** The two methods of Pi's / OMP's AssistantMessageEventStream a provider calls. */
export interface PiEventStreamLike {
  push(event: unknown): void;
  end(result?: never): void;
}

export interface PiModelLike {
  id: string;
  api: string;
  provider: string;
}

export interface PiStreamOptions<TStream extends PiEventStreamLike> {
  model: PiModelLike;
  /** The host's stream constructor (`createAssistantMessageEventStream` or `new AssistantMessageEventStream()`). */
  createStream: () => TStream;
  /**
   * Start the vendor call. Runs inside the bridge's error handling, so a
   * credential or network failure becomes a Pi `error` event, not a rejection.
   */
  events: () => AsyncIterable<BridgeStreamEvent> | Promise<AsyncIterable<BridgeStreamEvent>>;
  signal?: AbortSignal;
  /** Error text for the transcript; defaults to {@link formatErrorMessage}. */
  formatError?: (error: unknown) => string;
  /**
   * Whether Pi-family `partial` can drop blocks already shown (it can: the
   * renderer reads the array). When true a core `reset` truncates the message.
   */
  discardOnReset?: boolean;
}

export function zeroPiUsage(): PiAssistantMessageLike["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Copy neutral usage onto Pi's: required numbers stay numbers, extras ride along. */
export function applyBridgeUsage(target: PiAssistantMessageLike["usage"], usage: BridgeUsage): void {
  target.input = usage.input;
  target.output = usage.output;
  target.totalTokens = usage.totalTokens;
  // Pi's usage fields are required numbers, so an unreported cache count
  // collapses to 0 here — the distinction the core preserves cannot be
  // expressed on this side.
  target.cacheRead = usage.cacheRead ?? 0;
  target.cacheWrite = usage.cacheWrite ?? 0;
  target.cost = { ...usage.cost };
  // pi-ai's Usage has no credit/estimate fields; carry them through so a
  // consumer that knows to look still sees the metering frame.
  if (usage.contextPercent !== undefined) target.contextPercent = usage.contextPercent;
  if (usage.credits !== undefined) target.credits = usage.credits;
  if (usage.creditUnit !== undefined) target.creditUnit = usage.creditUnit;
  if (usage.cacheEstimated !== undefined) target.cacheEstimated = usage.cacheEstimated;
}

/**
 * Shortest gap between host updates. Pi and OMP rebuild the assistant markdown,
 * and re-run highlight.js on every open code fence, on every update.
 */
const HOST_DELTA_FLUSH_MS = 32;

/**
 * Longest gap. Past this a huge fence still has to move or the reply looks stuck.
 * highlight.js on Pi 1.3 is about 2.5ms per KB of fence; the idle pad leaves a
 * slice of the event loop for the keyboard between those runs.
 */
const HOST_DELTA_FLUSH_MAX_MS = 1_000;
const HIGHLIGHT_MS_PER_KB = 2.5;
const HIGHLIGHT_IDLE_MS = 48;

/** Bytes of fenced code in `text`, including a fence the model has not closed yet. */
function fencedCodeChars(text: string): number {
  let total = 0;
  let search = 0;
  while (search < text.length) {
    const open = text.indexOf("```", search);
    if (open < 0) break;
    const lineEnd = text.indexOf("\n", open + 3);
    if (lineEnd < 0) {
      total += text.length - (open + 3);
      break;
    }
    const close = text.indexOf("```", lineEnd + 1);
    if (close < 0) {
      total += text.length - (lineEnd + 1);
      break;
    }
    total += close - (lineEnd + 1);
    search = close + 3;
  }
  return total;
}

function flushDelayMs(codeChars: number): number {
  if (codeChars <= 0) return HOST_DELTA_FLUSH_MS;
  const workMs = Math.ceil((codeChars / 1024) * HIGHLIGHT_MS_PER_KB);
  return Math.min(HOST_DELTA_FLUSH_MAX_MS, Math.max(HOST_DELTA_FLUSH_MS, workMs + HIGHLIGHT_IDLE_MS));
}

/**
 * Sync work to do between yields. Decoding a buffered burst (Smithy frames,
 * protobuf) now shares the event loop with the TUI; past this, paint and input
 * get a turn before the next frame.
 */
export const HOST_TURN_BUDGET_MS = 8;

type HeldDelta = {
  type: "text_delta" | "thinking_delta" | "toolcall_delta";
  contentIndex: number;
  delta: string;
};

/**
 * Assemble a Pi-family assistant message from neutral core events, pushing
 * Pi's own events as it goes. Returns the host stream immediately; the vendor
 * call runs in the background.
 */
export function streamToPi<TStream extends PiEventStreamLike>(options: PiStreamOptions<TStream>): TStream {
  const stream = options.createStream();
  const formatError = options.formatError ?? formatErrorMessage;
  const discardOnReset = options.discardOnReset ?? true;
  const output: PiAssistantMessageLike = {
    role: "assistant",
    content: [],
    api: options.model.api,
    provider: options.model.provider,
    model: options.model.id,
    usage: zeroPiUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };

  (async () => {
    let held: HeldDelta | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const disarm = (): void => {
      if (flushTimer === undefined) return;
      clearTimeout(flushTimer);
      flushTimer = undefined;
    };
    const flushHeld = (): void => {
      disarm();
      const current = held;
      held = undefined;
      if (!current) return;
      if (current.type === "text_delta") {
        (output.content[current.contentIndex] as { text: string }).text += current.delta;
      } else if (current.type === "thinking_delta") {
        (output.content[current.contentIndex] as { thinking: string }).thinking += current.delta;
      }
      stream.push({
        type: current.type,
        contentIndex: current.contentIndex,
        delta: current.delta,
        partial: output,
      });
    };
    // Code the next flush will ask the host to highlight: fences already on the
    // message, plus the delta still held, including a fence that spans both.
    const pendingCodeChars = (): number => {
      const tail = held && (held.type === "text_delta" || held.type === "thinking_delta") ? held : undefined;
      let total = 0;
      for (let index = 0; index < output.content.length; index++) {
        const block = output.content[index];
        const extra = tail?.contentIndex === index ? tail.delta : "";
        if (block.type === "text") total += fencedCodeChars(extra ? block.text + extra : block.text);
        else if (block.type === "thinking") total += fencedCodeChars(extra ? block.thinking + extra : block.thinking);
      }
      return total;
    };
    const holdDelta = (next: HeldDelta, live: boolean): void => {
      if (next.delta.length === 0) return;
      if (held && held.type === next.type && held.contentIndex === next.contentIndex) {
        held.delta += next.delta;
      } else {
        flushHeld();
        held = next;
      }
      // Tool-argument deltas do not change the markdown Pi highlights, and the
      // partial arguments stay empty until the call ends. A timer here would
      // re-highlight the whole reply for a widget that does not move.
      if (!live || flushTimer !== undefined) return;
      flushTimer = setTimeout(flushHeld, flushDelayMs(pendingCodeChars()));
    };

    try {
      // Core block indexes are monotonic across the whole response, including
      // across an internal retry; Pi's are positions in `output.content`, which
      // a retry rewinds. Keep the translation rather than assuming they agree.
      let indexes = new Map<number, number>();
      const open = (coreIndex: number, block: PiContentBlock): number => {
        const contentIndex = output.content.length;
        output.content.push(block);
        indexes.set(coreIndex, contentIndex);
        return contentIndex;
      };
      const at = (coreIndex: number): number | undefined => indexes.get(coreIndex);
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        stream.push({ type: "start", partial: output });
      };
      let burstAt = performance.now();

      for await (const event of await options.events()) {
        switch (event.type) {
          case "start":
            start();
            break;
          case "reset":
            if (discardOnReset) {
              // The retry discarded this text. Drop it unpushed so the host
              // never paints a frame that the next attempt immediately rewinds.
              disarm();
              held = undefined;
              output.content = [];
              indexes = new Map();
            } else {
              flushHeld();
            }
            break;
          case "text_start": {
            flushHeld();
            start();
            const contentIndex = open(event.index, { type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex, partial: output });
            break;
          }
          case "text_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            holdDelta({ type: "text_delta", contentIndex, delta: event.delta }, true);
            break;
          }
          case "text_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            flushHeld();
            // A core may rewrite a block's text after the fact (tool calls lifted
            // out of prose, echo noise stripped), so the terminal event — not the
            // accumulated deltas — is the authority on final content.
            (output.content[contentIndex] as { text: string }).text = event.text;
            stream.push({ type: "text_end", contentIndex, content: event.text, partial: output });
            break;
          }
          case "thinking_start": {
            flushHeld();
            start();
            const contentIndex = open(event.index, { type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex, partial: output });
            break;
          }
          case "thinking_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            holdDelta({ type: "thinking_delta", contentIndex, delta: event.delta }, true);
            break;
          }
          case "thinking_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            flushHeld();
            const block = output.content[contentIndex] as { thinking: string; thinkingSignature?: string };
            block.thinking = event.thinking;
            if (event.signature) block.thinkingSignature = event.signature;
            stream.push({ type: "thinking_end", contentIndex, content: event.thinking, partial: output });
            break;
          }
          case "tool_call_start": {
            flushHeld();
            start();
            const contentIndex = open(event.index, { type: "toolCall", id: event.id, name: event.name, arguments: {} });
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
            break;
          }
          case "tool_call_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            holdDelta({ type: "toolcall_delta", contentIndex, delta: event.argumentsDelta }, false);
            break;
          }
          case "tool_call_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            flushHeld();
            const toolCall = output.content[contentIndex] as { name: string; arguments: Record<string, unknown> };
            toolCall.name = event.name;
            toolCall.arguments = event.arguments;
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
            break;
          }
          case "usage":
            applyBridgeUsage(output.usage, event.usage);
            break;
          case "done":
            flushHeld();
            start();
            output.stopReason = event.stopReason;
            if (event.responseId) output.responseId = event.responseId;
            if (event.upstreamModel && event.upstreamModel !== output.model) output.responseModel = event.upstreamModel;
            // A terminal diagnostic for a turn that finished but produced less
            // than the model sent — kept so the host surfaces a silent turn.
            if (event.errorMessage) output.errorMessage = event.errorMessage;
            stream.push({ type: "done", reason: event.stopReason, message: output });
            break;
        }
        if (performance.now() - burstAt >= HOST_TURN_BUDGET_MS) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          burstAt = performance.now();
        }
      }
      flushHeld();
      stream.end();
    } catch (error) {
      // Apply a delta still in the hold so the transcript keeps the text
      // received before the failure, then surface the error.
      flushHeld();
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      disarm();
    }
  })().catch(() => {
    // Safety net: a rejection escaping the inner try/catch (an AbortError
    // during signal teardown, say) must not become an unhandled rejection
    // that crashes the host.
    try {
      stream.end();
    } catch {}
  });

  return stream;
}
