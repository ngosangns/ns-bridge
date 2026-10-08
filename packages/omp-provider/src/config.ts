/** Which wrapped providers to register, from the environment. */

export const PROVIDER_KEYS = ["kiro", "devin", "grok"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export type ProviderSelection = Record<ProviderKey, boolean>;

function parseList(value: string | undefined): Set<string> | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return new Set(
    value
      .split(/[\s,]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Providers that stay off unless explicitly requested. `kiro` is opt-in because
 * the dedicated `ns-omp-provider-kiro` plugin is the recommended Kiro path in
 * OMP; registering a second `kiro` here would shadow it.
 */
export const OPT_IN_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["kiro"]);

/**
 * - `NS_OMP_PROVIDERS=devin,grok,kiro` — allow-list (only these are registered;
 *   listing `kiro` here opts it in).
 * - `NS_OMP_PROVIDER_ENABLE=kiro` — opt in to opt-in providers on top of the
 *   default set (or the allow-list).
 * - `NS_OMP_PROVIDER_DISABLE=grok` — deny-list, applied last.
 * Default: `devin` and `grok`; `kiro` is opt-in.
 */
export function resolveProviderSelection(env: NodeJS.ProcessEnv = process.env): ProviderSelection {
  const allow = parseList(env.NS_OMP_PROVIDERS);
  const enable = parseList(env.NS_OMP_PROVIDER_ENABLE) ?? new Set<string>();
  const deny = parseList(env.NS_OMP_PROVIDER_DISABLE) ?? new Set<string>();
  const selection = {} as ProviderSelection;
  for (const key of PROVIDER_KEYS) {
    const base = allow ? allow.has(key) : !OPT_IN_PROVIDERS.has(key);
    selection[key] = (base || enable.has(key)) && !deny.has(key);
  }
  return selection;
}
