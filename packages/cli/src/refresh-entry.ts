/**
 * Built by esbuild into one file. The typecheck project excludes this module
 * so it does not compile the provider sources. `ns-bridge models refresh --apply`
 * and `ns-bridge kiro profile` are the only commands that load the result.
 */
import { refreshDevinModels } from "@ngosangns/ns-pi-provider/devin";
import { refreshGrokModels } from "@ngosangns/ns-pi-provider/grok";
import { refreshKiroModels } from "@ngosangns/ns-pi-provider/kiro";
import {
  getKiroProfileOverride,
  hasCachedKiroProfileCatalog,
  KIRO_PROFILE_SELECTION_PATH,
  listKiroProfiles,
  resolveKiroProfileArn,
  resolveKiroRequestCredentials,
  writeKiroProfileSelection,
} from "ns-kiro-core";
import type { KiroProfileOps } from "./kiro-profile.js";
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
      const refreshed = await refreshGrokModels({ force: true });
      return { count: refreshed.models.length, detail: `source=${refreshed.source}` };
    },
  };
}

export function createBundledKiroProfiles(): KiroProfileOps {
  return {
    list: async () => {
      const credentials = await resolveKiroRequestCredentials(process.env.KIRO_API_KEY?.trim() || undefined);
      const auth = { accessToken: credentials.accessToken, region: credentials.region };
      const profiles = await listKiroProfiles(auth);
      const override = getKiroProfileOverride();
      const arn = await resolveKiroProfileArn(auth, credentials.profileArn);
      return {
        profiles,
        active: { arn, source: override?.source ?? "login" },
        ...(credentials.profileArn ? { loginArn: credentials.profileArn } : {}),
      };
    },
    select: writeKiroProfileSelection,
    hasCatalog: hasCachedKiroProfileCatalog,
    selectionPath: KIRO_PROFILE_SELECTION_PATH,
  };
}
