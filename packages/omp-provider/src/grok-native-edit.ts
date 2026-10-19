/**
 * Let Grok's already-applied file edits render as OMP edit cards.
 *
 * The provider emits an `edit` toolCall only after `stampResolved` marks it
 * with OMP's real `kCursorExecResolved`. The agent loop then skips execution,
 * so the file Grok already wrote is not edited again. `settle` emits
 * `tool_execution_end` through the streaming agent's own
 * `onDetachedToolUpdate` (that callback is `emitExternalEvent`), which is
 * what paints the card. Pi never installs this host, so it keeps the
 * Markdown line and never sees a toolCall.
 */

export const GROK_NATIVE_EDIT = Symbol.for("ns-bridge.grok.nativeEdit");

export interface GrokNativeEditHost {
  prepare(): Promise<boolean>;
  stampResolved(block: object): boolean;
  settle(edit: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    isError: boolean;
  }): void;
}

let cursorExecResolved: Promise<symbol | undefined> | undefined;

async function loadCursorExecResolved(): Promise<symbol | undefined> {
  try {
    // This specifier must stay a string literal. OMP's plugin loader rewrites
    // that exact import onto the copy bundled inside `omp`'s cli.js, which is
    // the same unique symbol the agent loop checks. A computed specifier, or a
    // `.js` suffix, resolves a second copy and the loop would run `edit` again.
    const mod = (await import("@oh-my-pi/pi-ai/utils/block-symbols")) as {
      kCursorExecResolved?: unknown;
    };
    return typeof mod.kCursorExecResolved === "symbol" ? mod.kCursorExecResolved : undefined;
  } catch {
    return undefined;
  }
}

export function createGrokNativeEditHost(deps: {
  emit?: (event: unknown) => void;
  loadSymbol?: () => Promise<symbol | undefined>;
} = {}): GrokNativeEditHost {
  let symbol: symbol | undefined;
  let ready: Promise<boolean> | undefined;
  const loadSymbol = deps.loadSymbol ?? (() => {
    cursorExecResolved ??= loadCursorExecResolved();
    return cursorExecResolved;
  });
  return {
    prepare() {
      ready ??= (async () => {
        if (typeof deps.emit !== "function") return false;
        const loaded = await loadSymbol();
        if (typeof loaded !== "symbol") return false;
        symbol = loaded;
        return true;
      })();
      return ready;
    },
    stampResolved(block: object) {
      if (!symbol) return false;
      (block as Record<symbol, true>)[symbol] = true;
      return true;
    },
    settle(edit) {
      deps.emit?.({
        type: "tool_execution_end",
        toolCallId: edit.toolCallId,
        toolName: edit.toolName,
        result: edit.result,
        isError: edit.isError,
      });
    },
  };
}

/** Copy stream options and attach the host. No-op fields on the original stay. */
export function attachGrokNativeEdit(options: unknown): Record<string | symbol, unknown> {
  const source = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
  const emit = source.onDetachedToolUpdate;
  const host = createGrokNativeEditHost({
    emit: typeof emit === "function" ? (event) => emit(event) : undefined,
  });
  return { ...source, [GROK_NATIVE_EDIT]: host };
}
