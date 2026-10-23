// Typed facade for the bundled @ngosangns/ns-pi-provider/kiro entry (its sources
// are Pi-typed TypeScript; tsconfig `paths` points here so tsc does not
// type-check them against Pi packages that are not installed).
export const KIRO_PROVIDER_ID: string;
export function registerKiroProvider(pi: unknown): Promise<void>;
