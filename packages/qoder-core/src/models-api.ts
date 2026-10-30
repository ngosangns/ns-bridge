// ABOUTME: The Qoder model list. The vendor has no open list endpoint, so read
// the model cache qodercli decrypted into `~/.qoder/.models/<uid>/catalog-v*`
// and take its display names, vision input, reasoning efforts and context tier.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { qoderConfigDir, type ResolvedQoderAuth } from "./auth.js";
import {
  type QoderModelSpec,
  qoderBootstrapModels,
  qoderModelInfosFromVendorCatalog,
  qoderModelsFromModelInfos,
} from "./catalog.js";
import { decryptQoderModelCache } from "./store.js";

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

export async function fetchQoderModels(
  _options: { auth?: ResolvedQoderAuth; signal?: AbortSignal } = {},
): Promise<QoderModelSpec[]> {
  try {
    const target = qoderVendorCatalogFile(qoderConfigDir());
    if (!target) return qoderBootstrapModels();
    const plain = decryptQoderModelCache(readFileSync(target.file, "utf8"), target.uid);
    return qoderModelsFromModelInfos(qoderModelInfosFromVendorCatalog(plain, target.scene));
  } catch {
    // No CLI cache, an undecryptable one, or a catalog shape we don't know:
    // hosts still get a usable picker from the bootstrap list.
    return qoderBootstrapModels();
  }
}
