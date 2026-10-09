package kiro

// Interactive login (`ns-bridge login --vendor kiro`): validating a `ksk_`
// API key against GetProfile, which both proves the key works and resolves
// the profile ARN it bills against. Port of ns-kiro-core's
// loginKiroWithApiKey; every other Kiro login method already lands a session
// in the kiro-cli store or the IDE token file, which the TypeScript facade
// reads before calling this.
//
// The request carries {apiKey}; a host prompts for it on its own side, so the
// binary never needs to ask.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

// LoginRequest is the `login` command's request for the kiro vendor.
type LoginRequest struct {
	APIKey string `json:"apiKey"`
}

var invalidTokenPattern = regexp.MustCompile(`(?i)invalid token`)

// Login implements sidecar.Loginer. The result is a KiroCredentials with
// authMethod "apikey".
func (Vendor) Login(ctx context.Context, raw json.RawMessage, host bridge.Host) (any, error) {
	var req LoginRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, bridge.Errorf(bridge.KindInvalidRequest, "kiro login request: %v", err)
	}
	if !strings.HasPrefix(req.APIKey, "ksk_") {
		return nil, bridge.Errorf(bridge.KindInvalidRequest, "Invalid API key format. Kiro API keys start with 'ksk_'.")
	}

	_ = host.Progress("Validating API key...")

	const op = "GetProfile"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, managementBase(apiKeyRegion), strings.NewReader("{}"))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/x-amz-json-1.0")
	httpReq.Header.Set("X-Amz-Target", getProfileTarget)
	authHeaders(httpReq.Header, req.APIKey, false)
	userAgentHeaders(httpReq.Header, "codewhispererruntime", "F,C")
	resp, err := httpClient().Do(httpReq)
	if err != nil {
		return nil, &bridge.Error{Kind: bridge.KindNetwork,
			Message: "Kiro management " + op + " request failed in " + apiKeyRegion}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		detail, _ := io.ReadAll(resp.Body)
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden ||
			invalidTokenPattern.Match(detail) {
			return nil, bridge.Errorf(bridge.KindAuth,
				"API key was rejected by Kiro. Check that the key is valid and not expired.")
		}
		return nil, &ManagementHTTPError{
			Message: strings.TrimSpace("Kiro " + op + " failed: " + resp.Status + " " + string(detail)),
			Status:  resp.StatusCode,
		}
	}
	var parsed struct {
		Profile *struct {
			Arn string `json:"arn"`
		} `json:"profile"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, &bridge.Error{Kind: bridge.KindProtocol,
			Message: "Kiro management " + op + " returned invalid JSON in " + apiKeyRegion}
	}

	out := jsjson.NewObject()
	out.Set("access", req.APIKey)
	out.Set("refresh", req.APIKey+"|apikey")
	out.Set("expires", nowMs()+365*24*60*60*1000)
	out.Set("clientId", "")
	out.Set("clientSecret", "")
	out.Set("region", apiKeyRegion)
	out.Set("authMethod", "apikey")
	if parsed.Profile != nil && parsed.Profile.Arn != "" {
		out.Set("profileArn", parsed.Profile.Arn)
	}
	return out, nil
}
