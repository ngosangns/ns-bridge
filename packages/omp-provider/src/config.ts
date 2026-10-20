/** Which wrapped providers to register. Re-exported so both hosts share the Pi reader. */

export {
  PROVIDER_KEYS,
  type ProviderKey,
  type ProviderSelection,
  readProviderFile,
  resolveProviderSelection,
} from "@ngosangns/ns-pi-provider/selection";
