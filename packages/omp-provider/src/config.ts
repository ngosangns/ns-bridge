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
 * - `NS_OMP_PROVIDERS=devin,grok` — allow-list (only these are registered).
 * - `NS_OMP_PROVIDER_DISABLE=kiro` — deny-list, applied after the allow-list.
 * Default: all three.
 */
export function resolveProviderSelection(env: NodeJS.ProcessEnv = process.env): ProviderSelection {
  const allow = parseList(env.NS_OMP_PROVIDERS);
  const deny = parseList(env.NS_OMP_PROVIDER_DISABLE) ?? new Set<string>();
  const selection = {} as ProviderSelection;
  for (const key of PROVIDER_KEYS) {
    selection[key] = (allow ? allow.has(key) : true) && !deny.has(key);
  }
  return selection;
}
