/**
 * Catalog refresh loads the Pi provider only when `--apply` runs.
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
}

interface KiroRefreshModule {
  refreshKiroModels: (options: { force?: boolean }) => Promise<{ models: { id: string }[]; region: string }>;
}

interface DevinRefreshModule {
  refreshDevinModels: (options: { force?: boolean }) => Promise<{ models: { id: string }[] }>;
}

interface GrokRefreshModule {
  refreshGrokModels: (options: { force?: boolean }) => { models: { id: string }[]; source: string };
}

/**
 * The specifier is a plain string so this package's typecheck does not compile
 * the provider sources. The import still runs only when a refresh is applied.
 */
async function loadModule<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

export async function defaultModelRefresh(): Promise<ModelRefresh> {
  const [kiro, devin, grok] = await Promise.all([
    loadModule<KiroRefreshModule>("@ngosangns/ns-pi-provider/kiro"),
    loadModule<DevinRefreshModule>("@ngosangns/ns-pi-provider/devin"),
    loadModule<GrokRefreshModule>("@ngosangns/ns-pi-provider/grok"),
  ]);
  return {
    kiro: async () => {
      const refreshed = await kiro.refreshKiroModels({ force: true });
      return { count: refreshed.models.length, detail: `region=${refreshed.region}` };
    },
    devin: async () => {
      const refreshed = await devin.refreshDevinModels({ force: true });
      return { count: refreshed.models.length };
    },
    grok: async () => {
      const refreshed = grok.refreshGrokModels({ force: true });
      return { count: refreshed.models.length, detail: `source=${refreshed.source}` };
    },
  };
}

export function refreshLine(vendor: Vendor, result: RefreshResult): string {
  return `${vendor}: ${result.count} model(s)${result.detail ? ` ${result.detail}` : ""}`;
}
