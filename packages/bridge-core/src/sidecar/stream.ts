// ABOUTME: Runs one vendor call in the ns-bridge Go binary and yields its events as BridgeStreamEvents.
// ABOUTME: Wire format: docs/SIDECAR-PROTOCOL.md — envelope on stdin, NDJSON on stdout, terminal error line.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { BridgeStreamEvent } from "../types.js";
import { DEFAULT_SIDECAR_COMMAND, findPackagedSidecarBinary, resolveSidecarBinary } from "./binary.js";
import { SidecarError, type SidecarErrorPayload } from "./errors.js";

/** The sidecar protocol version this client speaks. */
export const SIDECAR_PROTOCOL_VERSION = 1;

const DEFAULT_KILL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 8 * 1024;

const EVENT_TYPES: ReadonlySet<string> = new Set<BridgeStreamEvent["type"]>([
  "start",
  "text_start",
  "text_delta",
  "text_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "tool_call_start",
  "tool_call_delta",
  "tool_call_end",
  "reset",
  "usage",
  "done",
]);

/** A `{"jsonrpc":"2.0",…}` line the binary wrote: `id` means the host must answer it on stdin. */
export interface SidecarHostCall {
  method: string;
  params?: unknown;
  id?: number;
}

export interface SidecarStreamOptions {
  /** Cancels the call: stdin is closed, then SIGTERM, then SIGKILL, each after `killGraceMs`. */
  signal?: AbortSignal;
  /** Binary to run when `NS_BRIDGE_BIN` is unset; defaults to `ns-bridge` on PATH. */
  binary?: string;
  /** Environment for the binary (and for `NS_BRIDGE_BIN` lookup); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Grace period between cancellation steps. */
  killGraceMs?: number;
  /**
   * Where the binary's diagnostics (stderr) go besides the crash tail: the
   * host's stderr by default, as the in-process cores' console output did;
   * `false` keeps them private.
   */
  stderr?: NodeJS.WritableStream | false;
  /**
   * Dispatch a host call (`{"jsonrpc":"2.0",…}` lines — `host/authUrl`,
   * `host/progress`, `host/prompt`). Notifications resolve to nothing; a call
   * carrying `id` gets its return value written back on stdin. Lines with no
   * handler are ignored.
   */
  hostCall?: (call: SidecarHostCall) => unknown | Promise<unknown>;
}

/**
 * Start `ns-bridge stream --vendor <vendor>`, send `request`, and yield the
 * events it streams back. Resolves normally after the `done` event once the
 * process has exited cleanly; otherwise throws a {@link SidecarError} (or the
 * signal's abort reason when cancelled).
 *
 * Breaking out of the loop early cancels the call the same way an abort does.
 */
export async function* sidecarStream(
  vendor: string,
  request: unknown,
  options: SidecarStreamOptions = {},
): AsyncGenerator<BridgeStreamEvent, void, undefined> {
  let sawDone = false;
  for await (const message of sidecarLines(vendor, ["stream", "--vendor", vendor], request, options, "done")) {
    if (!EVENT_TYPES.has(message.type)) continue; // newer binary, older client: skip what we cannot read
    if (sawDone) continue;
    if (message.type === "done") sawDone = true;
    yield message as unknown as BridgeStreamEvent;
  }
}

/**
 * Run `ns-bridge call --vendor <vendor> --op <op>` — a one-shot operation
 * (model catalog, usage, token refresh) — and resolve with its result.
 * Fails like {@link sidecarStream}: a {@link SidecarError}, or the abort reason.
 */
export async function sidecarCall<TResult = unknown>(
  vendor: string,
  op: string,
  request: unknown,
  options: SidecarStreamOptions = {},
): Promise<TResult> {
  let result: unknown;
  for await (const message of sidecarLines(
    vendor,
    ["call", "--vendor", vendor, "--op", op],
    request,
    options,
    "result",
  )) {
    if (message.type === "result") result = (message as { result?: unknown }).result;
  }
  return result as TResult;
}

/** The host callbacks an interactive login (`ns-bridge login`) drives. */
export interface SidecarLoginCallbacks {
  /** `host/authUrl`: open (or print) the URL the user must visit. */
  onAuthUrl?: (url: string, instructions?: string) => void;
  /** `host/progress`: a human-readable progress note. */
  onProgress?: (message: string) => void;
  /** `host/prompt`: answer a prompt the binary asks for. */
  onPrompt?: (prompt: {
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
    secret?: boolean;
  }) => Promise<string>;
}

/**
 * Run `ns-bridge login --vendor <vendor>` — an interactive login (Devin's
 * PKCE browser round trip, a Kiro API-key check) — and resolve with the
 * credentials it returns. `{"jsonrpc":"2.0",…}` host calls it writes are
 * routed to `callbacks`; an unhandled `host/prompt` is answered with an
 * error, which the vendor usually turns into its own failure.
 */
export async function sidecarLogin<TResult = unknown>(
  vendor: string,
  request: unknown,
  callbacks: SidecarLoginCallbacks,
  options: SidecarStreamOptions = {},
): Promise<TResult> {
  const hostCall = async (call: SidecarHostCall): Promise<unknown> => {
    const params = (call.params ?? {}) as Record<string, unknown>;
    switch (call.method) {
      case "host/authUrl":
        callbacks.onAuthUrl?.(
          typeof params.url === "string" ? params.url : "",
          typeof params.instructions === "string" ? params.instructions : undefined,
        );
        return undefined;
      case "host/progress":
        callbacks.onProgress?.(typeof params.message === "string" ? params.message : "");
        return undefined;
      case "host/prompt":
        if (!callbacks.onPrompt) {
          throw new SidecarError("protocol", `ns-bridge (${vendor}) asked for a prompt this host cannot answer`, {
            vendor,
          });
        }
        return callbacks.onPrompt(params as { message: string });
      default:
        if (call.id !== undefined) throw new Error(`unknown host method ${call.method}`);
        return undefined; // unknown notification: ignore, like an unknown event type
    }
  };
  let result: unknown;
  for await (const message of sidecarLines(
    vendor,
    ["login", "--vendor", vendor],
    request,
    { ...options, hostCall },
    "result",
  )) {
    if (message.type === "result") result = (message as { result?: unknown }).result;
  }
  return result as TResult;
}

/**
 * Spawn the binary with `args`, send the envelope, and yield every line it
 * writes until it exits. An error line throws; a run that never wrote a
 * `terminal`-typed line, or exited non-zero, throws too.
 */
async function* sidecarLines(
  vendor: string,
  args: string[],
  request: unknown,
  options: SidecarStreamOptions,
  terminal: string,
): AsyncGenerator<SidecarLine, void, undefined> {
  const { signal } = options;
  signal?.throwIfAborted();

  const env = options.env ?? process.env;
  const binary = resolveSidecarBinary(options.binary, env);
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(binary, args, { env, stdio: "pipe", windowsHide: true });
  } catch (cause) {
    throw unavailable(binary, vendor, cause);
  }

  // Everything the process reports lands in this state; the generator below
  // waits on `wake` whenever it has nothing to hand out.
  const lines: string[] = [];
  let partial = "";
  let stderr = "";
  let spawnError: unknown;
  let exited = false;
  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let aborted = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop() ?? "";
    for (const part of parts) if (part.trim()) lines.push(part);
    notify();
  });
  child.stderr.setEncoding("utf8");
  const stderrSink = options.stderr === undefined ? process.stderr : options.stderr;
  child.stderr.on("data", (chunk: string) => {
    if (stderrSink) stderrSink.write(chunk);
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  // A binary that exits before reading stdin makes the write fail with EPIPE;
  // its exit status is the real story, so the pipe error is not.
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    spawnError = error;
    notify();
  });
  child.on("exit", (code, sig) => {
    exited = true;
    exitCode = code;
    exitSignal = sig;
  });
  child.on("close", (code, sig) => {
    exited = true;
    closed = true;
    exitCode ??= code;
    exitSignal ??= sig;
    if (partial.trim()) lines.push(partial);
    partial = "";
    notify();
  });

  const timers: NodeJS.Timeout[] = [];
  /** Close stdin (the protocol's cancel), then escalate to SIGTERM and SIGKILL. */
  const cancel = () => {
    if (!child.stdin.destroyed) child.stdin.end();
    if (exited) return;
    const escalate = (delay: number, sig: NodeJS.Signals) => {
      const timer = setTimeout(() => {
        if (!exited) child.kill(sig);
      }, delay);
      timer.unref();
      timers.push(timer);
    };
    escalate(graceMs, "SIGTERM");
    escalate(graceMs * 2, "SIGKILL");
  };
  const onAbort = () => {
    aborted = true;
    cancel();
    notify();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // stdin stays open for the call's lifetime: closing it is how we cancel.
  child.stdin.write(`${JSON.stringify({ protocol: SIDECAR_PROTOCOL_VERSION, request })}\n`);

  const details = () => ({ vendor, exitCode, exitSignal, stderr: stderr.trim() || undefined });
  let sawTerminal = false;
  let finished = false;
  try {
    while (true) {
      if (aborted) throw abortReason(signal);
      if (spawnError !== undefined) throw unavailable(binary, vendor, spawnError);

      const line = lines.shift();
      if (line !== undefined) {
        const message = parseLine(line, details);
        if (message.jsonrpc !== undefined) {
          await dispatchHostCall(message, options.hostCall, child);
          continue;
        }
        if (message.type === "error") {
          throw SidecarError.fromPayload(
            message.error ?? { kind: "protocol", message: "ns-bridge wrote an error line without a payload" },
            details(),
          );
        }
        if (message.type === terminal) sawTerminal = true;
        yield message;
        continue;
      }

      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    if (exitCode !== 0) {
      const how = exitSignal ? `was killed by ${exitSignal}` : `exited with code ${exitCode}`;
      throw new SidecarError("crashed", `ns-bridge (${vendor}) ${how} without reporting an error`, details());
    }
    if (!sawTerminal) {
      throw new SidecarError(
        "protocol",
        `ns-bridge (${vendor}) exited without a ${terminal} ${terminal === "done" ? "event" : "line"}`,
        details(),
      );
    }
    finished = true;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (finished) {
      for (const timer of timers) clearTimeout(timer);
    } else {
      cancel();
    }
  }
}

interface SidecarLine {
  type: string;
  error?: SidecarErrorPayload;
  /** Present on host calls: `{"jsonrpc":"2.0","method":…,"id"?:"…"}` instead of `type`. */
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
}

function parseLine(line: string, details: () => object): SidecarLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new SidecarError("protocol", `ns-bridge wrote a line that is not JSON: ${line.slice(0, 200)}`, {
      ...details(),
      cause,
    });
  }
  if (!value || typeof value !== "object") {
    throw new SidecarError(
      "protocol",
      `ns-bridge wrote a line that is not an object: ${line.slice(0, 200)}`,
      details(),
    );
  }
  const record = value as SidecarLine;
  if (typeof record.jsonrpc === "string") return record; // host call, no `type`
  if (typeof record.type !== "string") {
    throw new SidecarError("protocol", `ns-bridge wrote a line without a type: ${line.slice(0, 200)}`, details());
  }
  return record;
}

/**
 * Hand one `{"jsonrpc":"2.0",…}` line to the host-call handler. A line with an
 * `id` is a request: the handler's return value goes back on stdin as the
 * JSON-RPC result (an error object when it threw).
 */
async function dispatchHostCall(
  message: SidecarLine,
  hostCall: SidecarStreamOptions["hostCall"],
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const id = typeof message.id === "number" ? message.id : undefined;
  const respond = (payload: Record<string, unknown>) => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  if (id === undefined) {
    await hostCall?.({ method: message.method ?? "", params: message.params });
    return;
  }
  try {
    const result = hostCall
      ? await hostCall({ method: message.method ?? "", params: message.params, id })
      : (() => {
          throw new Error("this client answers no host calls");
        })();
    respond({ jsonrpc: "2.0", id, result: result ?? null });
  } catch (error) {
    respond({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function unavailable(binary: string, vendor: string, cause: unknown): SidecarError {
  const code = (cause as { code?: unknown } | undefined)?.code;
  const reason = code === "ENOENT" ? "not found" : code === "EACCES" ? "not executable" : String(cause);
  // Falling back to PATH means the packaged binary was not usable; say why,
  // since that is the install the user is expected to have.
  const packaged = binary === DEFAULT_SIDECAR_COMMAND ? findPackagedSidecarBinary() : undefined;
  const why = packaged && "error" in packaged ? ` ${packaged.error}.` : "";
  return new SidecarError(
    "unavailable",
    `Cannot start the ns-bridge binary "${binary}" (${reason}).${why} Install ns-bridge-bin or point NS_BRIDGE_BIN at a binary.`,
    { vendor, cause },
  );
}

function abortReason(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "This operation was aborted", "AbortError");
}
