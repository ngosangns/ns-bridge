// Typed facade for the bundled @ngosangns/ns-pi-provider entry (its sources are
// Pi-typed TypeScript; tsconfig `paths` points here so tsc does not
// type-check them against Pi packages that are not installed).
export interface NsPiProviderOptions {
  kiro?: boolean;
  devin?: boolean;
  grok?: boolean;
}

export function registerAllProviders(pi: unknown, options?: NsPiProviderOptions): Promise<void>;
export const KIRO_PROVIDER_ID: string;
export const DEVIN_PROVIDER_ID: string;
export const GROK_PROVIDER_ID: string;
