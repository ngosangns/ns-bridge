/**
 * Catalog refresh loads the Pi provider only when the command applies.
 * `status`, `models list`, and install previews do not import it.
 */

import type { Vendor } from "./catalog.js";

export interface RefreshResult {
  count: number;
  detail?: string;
}

export interface ModelRefresh {
  kiro: () => Promise<RefreshResult>;
  devin: () => Promise<RefreshResult>;
  grok: () => Promise<RefreshResult>;
  arnict: () => Promise<RefreshResult>;
  qoder: () => Promise<RefreshResult>;
}

/**
 * A variable specifier so typecheck does not follow the esbuild bundle, which
 * pulls in the provider sources. The file exists only after `pnpm build`.
 */
export async function defaultModelRefresh(): Promise<ModelRefresh> {
  const specifier = "./refresh-entry.js";
  const loaded = (await import(specifier)) as { createBundledRefresh: () => ModelRefresh };
  return loaded.createBundledRefresh();
}

export function refreshLine(vendor: Vendor, result: RefreshResult): string {
  return `${vendor}: ${result.count} model(s)${result.detail ? ` ${result.detail}` : ""}`;
}
