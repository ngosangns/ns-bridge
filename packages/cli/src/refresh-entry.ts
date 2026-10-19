/**
 * Built by esbuild into one file. The typecheck project excludes this module
 * so it does not compile the provider sources. `ns-bridge models refresh --apply`
 * is the only command that loads the result.
 */
import { refreshDevinModels } from "@ngosangns/ns-pi-provider/devin";
import { refreshGrokModels } from "@ngosangns/ns-pi-provider/grok";
import { refreshKiroModels } from "@ngosangns/ns-pi-provider/kiro";
import type { ModelRefresh } from "./refresh.js";

export function createBundledRefresh(): ModelRefresh {
  return {
    kiro: async () => {
      const refreshed = await refreshKiroModels({ force: true });
      return { count: refreshed.models.length, detail: `region=${refreshed.region}` };
    },
    devin: async () => {
      const refreshed = await refreshDevinModels({ force: true });
      return { count: refreshed.models.length };
    },
    grok: async () => {
      const refreshed = refreshGrokModels({ force: true });
      return { count: refreshed.models.length, detail: `source=${refreshed.source}` };
    },
  };
}
