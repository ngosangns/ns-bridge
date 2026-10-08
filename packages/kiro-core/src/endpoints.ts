// ABOUTME: Resolves Kiro API regions and constructs current-service endpoints.
// ABOUTME: Keeps management and runtime host selection independent from request URLs.

const API_REGION_MAP: Record<string, string> = {
  "sa-east-1": "us-east-1",
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-northeast-2": "us-east-1",
  "ap-south-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
};

export interface KiroEndpoints {
  region: string;
  management: string;
  runtime: string;
}

export function resolveApiRegion(ssoRegion: string | undefined): string {
  if (!ssoRegion) return "us-east-1";
  return API_REGION_MAP[ssoRegion] ?? ssoRegion;
}

/** Overrides the runtime base URL; `{region}` is replaced with the region. */
export const KIRO_RUNTIME_ENDPOINT_ENV = "KIRO_RUNTIME_ENDPOINT";
/** Overrides the management base URL; `{region}` is replaced with the region. */
export const KIRO_MANAGEMENT_ENDPOINT_ENV = "KIRO_MANAGEMENT_ENDPOINT";

function endpointOverride(name: string, region: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const url = value.replaceAll("{region}", region);
  return url.endsWith("/") ? url : `${url}/`;
}

export function getKiroEndpoints(region: string): KiroEndpoints {
  return {
    region,
    management: endpointOverride(KIRO_MANAGEMENT_ENDPOINT_ENV, region) ?? `https://management.${region}.kiro.dev/`,
    runtime: endpointOverride(KIRO_RUNTIME_ENDPOINT_ENV, region) ?? `https://runtime.${region}.kiro.dev/`,
  };
}

/**
 * A Kiro profile is owned by one region and its ARN carries that region. The
 * runtime API rejects a profile ARN issued in another region with a generic
 * `Improperly formed request.`, so runtime host selection has to follow the
 * profile rather than the SSO-derived region: an Identity Center instance in
 * us-east-1 can own a profile in eu-central-1.
 */
export function getKiroRegionFromProfileArn(profileArn: string | undefined): string | undefined {
  if (!profileArn) return undefined;
  const region = profileArn.split(":")[3];
  return region && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) ? region : undefined;
}

export function getKiroRegionFromEndpoint(endpoint: string): string | undefined {
  try {
    const [service, region, ...suffix] = new URL(endpoint).hostname.split(".");
    const domain = suffix.join(".");
    if ((service === "management" || service === "runtime") && domain === "kiro.dev") return region;
    return undefined;
  } catch {
    return undefined;
  }
}
