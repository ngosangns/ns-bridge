package kiro

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/kirocli"
	"github.com/ngosangns/ns-bridge/go/internal/redact"
)

const (
	apiKeyRegion     = "us-east-1"
	getProfileTarget = "AmazonCodeWhispererService.GetProfile"
)

type managementAuth struct {
	accessToken string
	region      string
}

func isAPIKey(token string) bool { return strings.HasPrefix(token, "ksk_") }

// authHeaders is kiroAuthHeaders, plus kiroTokenTypeHeaders when withType.
func authHeaders(h http.Header, token string, withType bool) {
	h.Set("Authorization", "Bearer "+token)
	if isAPIKey(token) {
		h.Set("tokentype", "API_KEY")
	}
	if withType && isExternalIdpAccessToken(token) {
		h.Set("tokentype", "EXTERNAL_IDP")
	}
}

func userAgentHeaders(h http.Header, service, sdkVersion string) {
	h.Set("User-Agent", "aws-sdk-js/3.714.0 os/macos/24.3.0 lang/js md/nodejs/22.14.0 api/"+service+"/3.714.0 exec-env/kiro-cli/2.7.0 m/E")
	h.Set("amz-sdk-invocation-id", "00000000-0000-0000-0000-000000000000")
	h.Set("amz-sdk-request", "attempt=1; max="+sdkVersion)
}

// isExternalIdpAccessToken is token-type.ts.
func isExternalIdpAccessToken(token string) bool {
	if token == "" {
		return false
	}
	segs := strings.Split(token, ".")
	if len(segs) == 3 && segs[1] != "" {
		p := strings.NewReplacer("-", "+", "_", "/").Replace(segs[1])
		p = strings.TrimRight(p, "=")
		if raw, err := base64.RawStdEncoding.DecodeString(p); err == nil {
			var payload struct {
				Aud json.RawMessage `json:"aud"`
			}
			if json.Unmarshal(raw, &payload) == nil && payload.Aud != nil {
				var one string
				var many []any
				if json.Unmarshal(payload.Aud, &one) == nil && one == "api://kiro" {
					return true
				}
				if json.Unmarshal(payload.Aud, &many) == nil {
					for _, a := range many {
						if a == "api://kiro" {
							return true
						}
					}
				}
			}
		}
	}
	if c := kirocli.GetExternalIdpCredentials(); c != nil && c.Access == token {
		return true
	}
	return false
}

// profileCache is the facade-seeded stand-in for management.ts's in-memory
// profileArnCache; changes go back to the facade on the done event.
type profileCache struct {
	entries map[string]string
	changes map[string]*string
}

func newProfileCache(seed map[string]string) *profileCache {
	c := &profileCache{entries: map[string]string{}, changes: map[string]*string{}}
	for k, v := range seed {
		c.entries[k] = v
	}
	return c
}

func profileCacheKey(a managementAuth) string {
	sum := sha256.Sum256([]byte(a.accessToken))
	return a.region + ":" + base64.RawURLEncoding.EncodeToString(sum[:])
}

func (c *profileCache) set(a managementAuth, arn string) {
	k := profileCacheKey(a)
	c.entries[k] = arn
	v := arn
	c.changes[k] = &v
}

func (c *profileCache) invalidate(a managementAuth) {
	k := profileCacheKey(a)
	delete(c.entries, k)
	c.changes[k] = nil
}

func managementStatusError(op, region string, resp *http.Response) error {
	text := ""
	if st := statusText(resp); st != "" {
		text = " " + redact.Kiro(st)
	}
	return &ManagementHTTPError{Message: fmt.Sprintf("Kiro management %s failed in %s: %d%s", op, region, resp.StatusCode, text), Status: resp.StatusCode}
}

func statusText(resp *http.Response) string {
	_, text, _ := strings.Cut(resp.Status, " ")
	return text
}

func parseManagementResponse(resp *http.Response, op, region string, out any) error {
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return managementStatusError(op, region, resp)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil || json.Unmarshal(raw, out) != nil {
		return fmt.Errorf("Kiro management %s returned invalid JSON in %s", op, region)
	}
	return nil
}

func (s *session) requestManagement(ctx context.Context, a managementAuth, op, path, method string, query map[string]string, out any) error {
	u := resolveURL(path, managementBase(a.region))
	var body io.Reader
	if method == http.MethodGet {
		if parsed, err := url.Parse(u); err == nil {
			q := parsed.Query()
			for k, v := range query {
				q.Set(k, v)
			}
			parsed.RawQuery = q.Encode()
			u = parsed.String()
		}
	} else {
		body = bytes.NewReader([]byte("{}"))
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	authHeaders(req.Header, a.accessToken, true)
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("Kiro management %s request failed in %s", op, a.region)
	}
	return parseManagementResponse(resp, op, a.region, out)
}

func (s *session) apiKeyProfileArn(ctx context.Context, token string) (string, error) {
	const op = "GetProfile"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, managementBase(apiKeyRegion), strings.NewReader("{}"))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	req.Header.Set("X-Amz-Target", getProfileTarget)
	authHeaders(req.Header, token, false)
	userAgentHeaders(req.Header, "codewhispererruntime", "F,C")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("Kiro management %s request failed in %s", op, apiKeyRegion)
	}
	var parsed struct {
		Profile *struct {
			Arn string `json:"arn"`
		} `json:"profile"`
	}
	if err := parseManagementResponse(resp, op, apiKeyRegion, &parsed); err != nil {
		return "", err
	}
	if parsed.Profile == nil || parsed.Profile.Arn == "" {
		return "", fmt.Errorf("Kiro management %s returned no profile in %s", op, apiKeyRegion)
	}
	return parsed.Profile.Arn, nil
}

func candidateRegions(primary string) []string {
	out := []string{primary}
	for _, r := range []string{"us-east-1", "eu-central-1"} {
		if r != primary {
			out = append(out, r)
		}
	}
	return out
}

// resolveProfileArn is resolveKiroProfileArn.
func (s *session) resolveProfileArn(ctx context.Context, a managementAuth) (string, error) {
	if env := strings.TrimSpace(os.Getenv("KIRO_PROFILE_ARN")); env != "" {
		debugLog("profile.resolve", map[string]any{"source": "env", "arn": env})
		return env, nil
	}
	if arn, ok := s.profiles.entries[profileCacheKey(a)]; ok && arn != "" {
		return arn, nil
	}
	if isAPIKey(a.accessToken) {
		arn, err := s.apiKeyProfileArn(ctx, a.accessToken)
		if err != nil {
			return "", err
		}
		s.profiles.set(a, arn)
		debugLog("profile.resolve", map[string]any{"source": "api-key", "region": apiKeyRegion, "arn": arn})
		return arn, nil
	}
	var lastHTTP *ManagementHTTPError
	for _, region := range candidateRegions(a.region) {
		var resp struct {
			Profiles []struct {
				Arn string `json:"arn"`
			} `json:"profiles"`
		}
		err := s.requestManagement(ctx, managementAuth{a.accessToken, region}, "ListAvailableProfiles", "List-Available-Profiles", http.MethodPost, nil, &resp)
		if err != nil {
			if m, ok := err.(*ManagementHTTPError); ok && m.Status == 403 {
				lastHTTP = m
				continue
			}
			return "", err
		}
		for _, p := range resp.Profiles {
			if p.Arn != "" {
				s.profiles.set(a, p.Arn)
				debugLog("profile.resolve", map[string]any{"source": "network", "region": region, "arn": p.Arn})
				return p.Arn, nil
			}
		}
	}
	if lastHTTP != nil {
		return "", lastHTTP
	}
	return "", fmt.Errorf("Kiro management ListAvailableProfiles returned no profile in %s "+
		"(SSO-derived region: %s). If kiro-cli works, verify your profile region with `kiro-cli whoami`; "+
		"the management API is regional to the profile, not to your login region.", strings.Join(candidateRegions(a.region), ", "), a.region)
}
