// ABOUTME: The Qoder model list. Asks the model server with the signed
// `models.list` call qodercli makes; falls back to the cache qodercli decrypts
// into `~/.qoder/.models/<uid>/catalog-v*`, then to the bootstrap list.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { qoderConfigDir } from "./auth.js";
import {
  type QoderModelSpec,
  qoderBootstrapModels,
  qoderModelInfosFromVendorCatalog,
  qoderModelsFromModelInfos,
} from "./catalog.js";
import { QODER_LOGIN_MESSAGE, QoderApiError, QoderAuthError } from "./errors.js";
import { decryptQoderModelCache, readQoderSigningIdentity, signQoderRequest } from "./store.js";
import { QODER_WIRE_VERSION, qoderWireUrl } from "./stream.js";

const QODER_MODEL_LIST_PATH = "/algo/api/v2/model/list?Encode=1";

export interface QoderVendorCatalogTarget {
  file: string;
  uid: string;
  scene?: string;
}

function newestCatalogDirectory(root: string): { dir: string; file: string } | undefined {
  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .flatMap((dir) => {
        try {
          return [{ dir, mtime: statSync(dir).mtimeMs }];
        } catch {
          return [];
        }
      });
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const { dir } of dirs) {
      const file = newestCatalog(dir);
      if (file) return { dir, file };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function newestCatalog(dir: string): string | undefined {
  try {
    const files = readdirSync(dir)
      .flatMap((name) => {
        const match = /^catalog-v(\d+)$/.exec(name);
        return match ? [{ file: join(dir, name), version: Number(match[1]) }] : [];
      })
      .sort((a, b) => b.version - a.version);
    return files[0]?.file;
  } catch {
    return undefined;
  }
}

/**
 * Locate the cache qodercli keeps for the logged-in user. `default` names the
 * uid and scene; without it, take the user dir touched most recently.
 */
export function qoderVendorCatalogFile(configDir: string): QoderVendorCatalogTarget | undefined {
  const root = join(configDir, ".models");
  let uid: string | undefined;
  let scene: string | undefined;
  try {
    const pointer = JSON.parse(readFileSync(join(root, "default"), "utf8")) as Record<string, unknown>;
    if (typeof pointer.uid === "string" && pointer.uid) uid = pointer.uid;
    if (typeof pointer.scene === "string" && pointer.scene) scene = pointer.scene;
  } catch {
    // Older CLIs wrote no pointer; the directory scan below still finds the cache.
  }
  let dir = uid ? join(root, uid) : undefined;
  let file = dir ? newestCatalog(dir) : undefined;
  if (!file) {
    // A stale pointer (user logged out, cache cleared) must not hide the cache
    // that is actually on disk.
    const found = newestCatalogDirectory(root);
    dir = found?.dir;
    file = found?.file;
  }
  if (!dir || !file) return undefined;
  return { file, uid: dir.slice(root.length + 1), ...(scene ? { scene } : {}) };
}

export type QoderModelSource = "server" | "catalog" | "bootstrap";

export interface QoderModelList {
  models: QoderModelSpec[];
  /** `server` is the only source that reflects the account's current models. */
  source: QoderModelSource;
  /** Why the server list was not used. Absent when `source` is `server`. */
  error?: string;
}

const MODEL_LIST_TIMEOUT_MS = 10_000;

async function fetchServerModels(signal: AbortSignal | undefined): Promise<QoderModelSpec[]> {
  const identity = readQoderSigningIdentity(qoderConfigDir());
  if (!identity) throw new QoderAuthError();
  const signed = signQoderRequest(
    qoderWireUrl(process.env.QODER_MODEL_SERVER_HOST),
    QODER_MODEL_LIST_PATH,
    "GET",
    "auth",
    undefined,
    identity,
    QODER_WIRE_VERSION,
  );
  const timeout = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
  const response = await fetch(signed.url, {
    method: "GET",
    headers: signed.headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new QoderAuthError(`${QODER_LOGIN_MESSAGE} (HTTP ${response.status}: ${text.slice(0, 200)})`);
  }
  if (!response.ok) throw new QoderApiError(`models.list failed: HTTP ${response.status}: ${text.slice(0, 200)}`);
  const infos = qoderModelInfosFromVendorCatalog(text);
  if (infos.length === 0) throw new QoderApiError("models.list returned no models for the assistant scene");
  return qoderModelsFromModelInfos(infos);
}

function readLocalCatalog(): QoderModelSpec[] | undefined {
  const target = qoderVendorCatalogFile(qoderConfigDir());
  if (!target) return undefined;
  const plain = decryptQoderModelCache(readFileSync(target.file, "utf8"), target.uid);
  return qoderModelsFromModelInfos(qoderModelInfosFromVendorCatalog(plain, target.scene));
}

/**
 * The account's models. Asks the model server first, the same signed
 * `models.list` call qodercli makes. If that fails, falls back to the
 * catalog qodercli last cached, then to the bootstrap list. `source` says
 * which one answered, so callers never present a stale snapshot as current.
 */
export async function fetchQoderModels(options: { signal?: AbortSignal } = {}): Promise<QoderModelList> {
  let error: string;
  try {
    return { models: await fetchServerModels(options.signal), source: "server" };
  } catch (err) {
    if (options.signal?.aborted) throw err;
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    const models = readLocalCatalog();
    if (models) return { models, source: "catalog", error };
  } catch {
    // An undecryptable cache or an unknown shape: the bootstrap list still serves.
  }
  return { models: qoderBootstrapModels(), source: "bootstrap", error };
}
