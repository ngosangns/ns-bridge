package kiro

import (
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Environment overrides for the regional endpoints (a proxy, or the local
// server the differential tests script). "{region}" is substituted.
const (
	EnvRuntimeEndpoint    = "KIRO_RUNTIME_ENDPOINT"
	EnvManagementEndpoint = "KIRO_MANAGEMENT_ENDPOINT"
)

func endpointFor(env, service, region string) string {
	if v := strings.TrimSpace(os.Getenv(env)); v != "" {
		u := strings.ReplaceAll(v, "{region}", region)
		if !strings.HasSuffix(u, "/") {
			u += "/"
		}
		return u
	}
	return "https://" + service + "." + region + ".kiro.dev/"
}

func managementBase(region string) string {
	return endpointFor(EnvManagementEndpoint, "management", region)
}
func runtimeBase(region string) string { return endpointFor(EnvRuntimeEndpoint, "runtime", region) }

// resolveURL is new URL(ref, base).toString().
func resolveURL(ref, base string) string {
	b, err := url.Parse(base)
	if err != nil {
		return base + ref
	}
	r, err := url.Parse(ref)
	if err != nil {
		return base + ref
	}
	return b.ResolveReference(r).String()
}

var regionPattern = regexp.MustCompile(`^[a-z]{2}(?:-[a-z]+)+-\d$`)

// regionFromProfileArn is getKiroRegionFromProfileArn.
func regionFromProfileArn(arn string) string {
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, ":")
	if len(parts) < 4 || !regionPattern.MatchString(parts[3]) {
		return ""
	}
	return parts[3]
}
