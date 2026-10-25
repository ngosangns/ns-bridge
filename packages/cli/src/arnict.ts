/**
 * `ns-bridge arnict login|logout|status` — store, drop, and probe the Arnict API key.
 *
 * The key lives in `~/.ns-bridge/arnict.json` as `{"apiKey": …}`, a 0600 file
 * in a 0700 directory, and `ARNICT_API_KEY` outranks the file. The published
 * CLI cannot import the private arnict-core (nothing bundles it here), so this
 * module keeps to node: built-ins and mirrors arnict-core's key-file logic.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emitKeypressEvents } from "node:readline";

const ARNICT_API_KEY_ENV = "ARNICT_API_KEY";
const ARNICT_CONFIG_PATH_ENV = "NS_BRIDGE_ARNICT_CONFIG";
const ARNICT_BASE_URL_ENV = "ARNICT_BASE_URL";
const ARNICT_DEFAULT_BASE_URL = "https://api.arnict.com/v1";
const MODELS_TIMEOUT_MS = 15_000;
const ARNICT_PROMPT = "Arnict API key: ";

export type ArnictAction = "login" | "logout" | "status";

/** Everything the Arnict commands touch. Tests inject every field. */
export interface ArnictIo {
  /** Lookup for ARNICT_API_KEY, NS_BRIDGE_ARNICT_CONFIG, and ARNICT_BASE_URL. */
  env: NodeJS.ProcessEnv;
  /** Home directory the default config path hangs off. */
  home: string;
  /** Whether stdin is a terminal; a piped stdin reads the key from stdin. */
  stdinIsTTY: boolean;
  /** The full stdin text. Only called when the key is read from stdin. */
  readStdinText: () => Promise<string>;
  /** HTTP client for the /v1/models probe. */
  fetch: typeof fetch;
  /** Hidden TTY prompt. Rejects when the user aborts with Ctrl-C. */
  prompt: (question: string) => Promise<string>;
}

export function defaultArnictIo(): ArnictIo {
  return {
    env: process.env,
    home: homedir(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdinText: readPipedStdin,
    fetch,
    prompt: hiddenPrompt,
  };
}

export async function runArnict(
  action: ArnictAction,
  flags: { stdin: boolean; json: boolean },
  overrides: Partial<ArnictIo> | undefined,
  log: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const defaults = defaultArnictIo();
  const io: ArnictIo = {
    env: overrides?.env ?? defaults.env,
    home: overrides?.home ?? defaults.home,
    stdinIsTTY: overrides?.stdinIsTTY ?? defaults.stdinIsTTY,
    readStdinText: overrides?.readStdinText ?? defaults.readStdinText,
    fetch: overrides?.fetch ?? defaults.fetch,
    prompt: overrides?.prompt ?? defaults.prompt,
  };
  if (action === "login") return runLogin(io, flags.stdin, log, err);
  if (action === "logout") return runLogout(io, log, err);
  return runStatus(io, flags.json, log, err);
}

async function runLogin(
  io: ArnictIo,
  stdin: boolean,
  log: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  let apiKey: string;
  if (stdin || !io.stdinIsTTY) {
    const text = await io.readStdinText();
    apiKey = (text.split("\n", 1)[0] ?? "").trim();
  } else {
    try {
      apiKey = (await io.prompt(ARNICT_PROMPT)).trim();
    } catch {
      err("cancelled");
      return 1;
    }
  }
  if (!apiKey) {
    err("no key given: pipe one in or run ns-bridge arnict login from a terminal");
    return 1;
  }
  const path = arnictConfigPath(io.home, io.env);
  try {
    await saveKey(path, apiKey);
  } catch (error) {
    err(`could not save ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  log(`Saved Arnict API key ${maskArnictKey(apiKey)} to ${path}`);
  return 0;
}

async function runLogout(io: ArnictIo, log: (line: string) => void, err: (line: string) => void): Promise<number> {
  const path = arnictConfigPath(io.home, io.env);
  let removed = false;
  try {
    await rm(path);
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      err(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  log(removed ? `Removed ${path}` : `No saved key at ${path}`);
  if (io.env[ARNICT_API_KEY_ENV]?.trim()) err("# ARNICT_API_KEY is set and still applies");
  return 0;
}

async function runStatus(
  io: ArnictIo,
  json: boolean,
  log: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const path = arnictConfigPath(io.home, io.env);
  const key = await resolveKey(io);
  if (!key) {
    if (json) log(JSON.stringify({ source: "none", key: null, path, models: null }));
    else {
      log("key: none");
      log(`path: ${path}`);
    }
    err("no key: run ns-bridge arnict login");
    return 1;
  }
  const probe = await probeModels(io, key.apiKey);
  if (json) {
    log(JSON.stringify({ source: key.source, key: maskArnictKey(key.apiKey), path, models: probe }));
  } else {
    log(`key: ${maskArnictKey(key.apiKey)} (${key.source})`);
    log(`path: ${path}`);
    if (probe.ok) {
      const ids = probe.ids && probe.ids.length > 0 ? ` ${probe.ids.join(", ")}` : "";
      log(`models: ok (${probe.count})${ids}`);
    } else {
      const status = probe.status !== undefined ? ` ${probe.status}` : "";
      err(`models: error${status} ${probe.error}`);
    }
  }
  return probe.ok ? 0 : 1;
}

export function arnictConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const override = env[ARNICT_CONFIG_PATH_ENV]?.trim();
  if (override) return override;
  return join(home, ".ns-bridge", "arnict.json");
}

interface ArnictKey {
  apiKey: string;
  source: "env" | "config";
}

async function resolveKey(io: ArnictIo): Promise<ArnictKey | undefined> {
  const fromEnv = io.env[ARNICT_API_KEY_ENV]?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  let raw: string;
  try {
    raw = await readFile(arnictConfigPath(io.home, io.env), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    const key = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    if (key) return { apiKey: key, source: "config" };
  } catch {
    // A corrupt file is no key, never a thrown error.
  }
  return undefined;
}

async function saveKey(path: string, apiKey: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ apiKey }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A key safe to print: `abcd…wxyz`, or `****` when that shape would reveal it all. */
function maskArnictKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/** Masks `Bearer <token>` and every occurrence of the raw key so nothing secret reaches output. */
function redactSecrets(text: string, apiKey: string): string {
  let out = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  if (apiKey.length >= 8) out = out.split(apiKey).join("[redacted]");
  return out;
}

interface ModelsProbe {
  ok: boolean;
  count?: number;
  ids?: string[];
  status?: number;
  error?: string;
}

async function probeModels(io: ArnictIo, apiKey: string): Promise<ModelsProbe> {
  const base = (io.env[ARNICT_BASE_URL_ENV]?.trim() || ARNICT_DEFAULT_BASE_URL).replace(/\/$/, "");
  let response: Response;
  try {
    response = await io.fetch(`${base}/models`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error), apiKey) };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: await responseError(response, apiKey) };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, status: response.status, error: "the models response was not JSON" };
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return { ok: false, status: response.status, error: "the models response was not JSON" };
  }
  const ids: string[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return { ok: true, count: ids.length, ids };
}

/** The body-derived message of a failed models response, redacted and capped. */
async function responseError(response: Response, apiKey: string): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let message = "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error && typeof parsed.error === "object") message = parsed.error.message ?? "";
    else if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    message = "";
  }
  const body = message || text.replace(/\s+/g, " ").trim() || "no response body";
  return redactSecrets(body, apiKey).slice(0, 300);
}

async function readPipedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface KeypressKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** Reads one line without echoing it: raw mode, backspace works, Ctrl-C aborts. */
function hiddenPrompt(question: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      resolve("");
      return;
    }
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    emitKeypressEvents(input);
    output.write(question);
    let value = "";
    const finish = (result: () => void) => {
      input.removeListener("keypress", keypress);
      input.setRawMode(wasRaw);
      output.write("\n");
      result();
    };
    function keypress(chunk: string, key?: KeypressKey): void {
      if (key?.ctrl && key.name === "c") {
        finish(() => reject(new Error("cancelled")));
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        finish(() => resolve(value));
        return;
      }
      if (key?.name === "backspace") {
        if (value.length > 0) value = value.slice(0, -1);
        return;
      }
      if (chunk && !key?.ctrl && !key?.meta) value += chunk;
    }
    input.on("keypress", keypress);
  });
}
