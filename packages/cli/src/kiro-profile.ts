/**
 * `ns-bridge kiro profile` — list the Kiro profiles a login can run on and pin one.
 *
 * The pin is `~/.ns-bridge/kiro-profile.json`. kiro-core reads it on every
 * profile resolution, so a running host switches on its next request.
 * `KIRO_PROFILE_ARN` still outranks it. Listing calls Kiro, so the operations
 * come from the refresh bundle and this module stays free of the core.
 */

export interface KiroProfileRow {
  arn: string;
  name?: string;
  region: string;
  /** Set when a well-formed ARN was passed that the listing did not show. */
  unlisted?: true;
}

/**
 * A Kiro profile ARN: `arn:<partition>:codewhisperer:<region>:<account>:profile/<id>`.
 * Listing only probes the login's region and the two canonical ones, so a
 * profile elsewhere is real but absent from the listing.
 */
const KIRO_PROFILE_ARN = /^arn:aws[a-z-]*:codewhisperer:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:profile\/[A-Za-z0-9]+$/;

export type KiroProfileSource = "env" | "ns-bridge" | "login";

export interface KiroProfileListing {
  profiles: KiroProfileRow[];
  /** The profile requests run on now, and what decided it. */
  active: { arn: string; source: KiroProfileSource };
  /**
   * The profile the login carries on its own, when it names one: kiro-cli's
   * pick for a kiro-cli login, the token's own profile for a social login.
   */
  loginArn?: string;
}

export interface KiroProfileOps {
  list: () => Promise<KiroProfileListing>;
  /** Pin a profile, or drop the pin with `undefined`. */
  select: (selection: { arn: string; name?: string } | undefined) => void;
  /** Whether the Kiro cache already holds this profile's catalog. Reads the file only. */
  hasCatalog: (arn: string) => boolean;
  /** Where the pin is written. */
  selectionPath: string;
}

/** The refresh bundle, loaded only when a profile command runs. See {@link defaultModelRefresh}. */
export async function defaultKiroProfiles(): Promise<KiroProfileOps> {
  const specifier = "./refresh-entry.js";
  const loaded = (await import(specifier)) as { createBundledKiroProfiles: () => KiroProfileOps };
  return loaded.createBundledKiroProfiles();
}

/**
 * Match by ARN, then by name, then by region when that region has one profile.
 * A well-formed ARN the listing lacks passes through, marked `unlisted`.
 */
export function findKiroProfile(
  profiles: readonly KiroProfileRow[],
  query: string,
): KiroProfileRow | { error: string } {
  const byArn = profiles.find((profile) => profile.arn === query);
  if (byArn) return byArn;
  const arnRegion = KIRO_PROFILE_ARN.exec(query)?.[1];
  if (arnRegion) return { arn: query, region: arnRegion, unlisted: true };
  const lowered = query.toLowerCase();
  const byName = profiles.filter((profile) => profile.name?.toLowerCase() === lowered);
  if (byName.length === 1 && byName[0]) return byName[0];
  const byRegion = profiles.filter((profile) => profile.region === query);
  if (byName.length === 0 && byRegion.length === 1 && byRegion[0]) return byRegion[0];
  const matches = byName.length > 0 ? byName : byRegion;
  if (matches.length > 1) return { error: `${query} matches ${matches.length} profiles; pass the ARN` };
  const known = profiles.map((profile) => profile.name ?? profile.arn).join(", ");
  return { error: `no Kiro profile named ${query} (this login has: ${known || "none"})` };
}

export function formatKiroProfiles(listing: KiroProfileListing): string[] {
  const nameWidth = Math.max(4, ...listing.profiles.map((profile) => (profile.name ?? "—").length));
  const regionWidth = Math.max(6, ...listing.profiles.map((profile) => profile.region.length));
  const lines = listing.profiles.map((profile) => {
    const mark = profile.arn === listing.active.arn ? "*" : " ";
    const tags = profile.arn === listing.loginArn ? "  (login)" : "";
    return `${mark} ${(profile.name ?? "—").padEnd(nameWidth)}  ${profile.region.padEnd(regionWidth)}  ${profile.arn}${tags}`;
  });
  if (!listing.profiles.some((profile) => profile.arn === listing.active.arn)) {
    lines.push(`! active profile ${listing.active.arn} is not one this login can use`);
  }
  lines.push(`# active from ${describeSource(listing.active.source)}`);
  return lines;
}

export function describeSource(source: KiroProfileSource): string {
  if (source === "env") return "KIRO_PROFILE_ARN";
  if (source === "ns-bridge") return "ns-bridge kiro profile use";
  return "the login (kiro-cli's pick, or the first profile Kiro lists)";
}
