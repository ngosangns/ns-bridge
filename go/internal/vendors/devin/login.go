package devin

// Interactive login (`ns-bridge login --vendor devin`): the PKCE flow
// `devin auth login` runs — a callback listener on 127.0.0.1:59653, the
// consent URL handed to the host, then the code exchange for a session token.
// Port of ns-devin-core's loginDevinWithPkce.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

// Endpoints the flow talks to; package vars so tests can redirect them.
var (
	loginWebappURL     = "https://app.devin.ai"
	loginManagementURL = "https://api.devin.ai"
	loginListenAddr    = "127.0.0.1:59653"
)

const (
	loginCallbackPath       = "/callback"
	loginTokenPath          = "/auth/cli/token"
	loginDefaultTimeoutMs   = 5 * 60 * 1000
	loginFallbackExpiresMs  = 365 * 24 * 60 * 60 * 1000
	loginExpirySafetyMargin = 5 * 60 * 1000
)

// LoginRequest is the `login` command's request for the devin vendor.
type LoginRequest struct {
	// TimeoutMs is how long to wait for the browser round trip.
	TimeoutMs *float64 `json:"timeoutMs"`
}

// Login implements sidecar.Loginer. The result is a DevinCredentials
// ({access, refresh, expires, authMethod:"oauth"}), ready to persist.
func (Vendor) Login(ctx context.Context, raw json.RawMessage, host bridge.Host) (any, error) {
	var req LoginRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, bridge.Errorf(bridge.KindInvalidRequest, "devin login request: %v", err)
	}
	timeoutMs := float64(loginDefaultTimeoutMs)
	if req.TimeoutMs != nil {
		timeoutMs = *req.TimeoutMs
	}

	verifier := base64URL(randBytes(32))
	challengeSum := sha256.Sum256([]byte(verifier))
	challenge := base64URL(challengeSum[:])
	state := newUUID()

	code, err := awaitLoginCallback(ctx, challenge, state, timeoutMs, host)
	if err != nil {
		return nil, err
	}

	_ = host.Progress("Exchanging authorization code...")
	token, err := exchangeCLIToken(ctx, code, verifier)
	if err != nil {
		return nil, err
	}

	out := jsjson.NewObject()
	out.Set("access", token)
	out.Set("refresh", token)
	out.Set("expires", tokenExpiryMs(token))
	out.Set("authMethod", "oauth")
	return out, nil
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func base64URL(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// awaitLoginCallback runs the local callback server, hands the consent URL to
// the host, and returns the authorization code the browser delivers.
func awaitLoginCallback(ctx context.Context, challenge, state string, timeoutMs float64, host bridge.Host) (string, error) {
	listener, err := net.Listen("tcp", loginListenAddr)
	if err != nil {
		return "", bridge.Errorf(bridge.KindInternal, "devin login: listen on %s: %v", loginListenAddr, err)
	}
	defer listener.Close()

	type outcome struct {
		code string
		err  error
	}
	got := make(chan outcome, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != loginCallbackPath {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		q := r.URL.Query()
		returnedState, authCode, authErr := q.Get("state"), q.Get("code"), q.Get("error")
		w.Header().Set("content-type", "text/html")
		if authErr != "" || authCode == "" || returnedState != state {
			_, _ = io.WriteString(w, "<html><body>Devin login failed. You can close this tab.</body></html>")
			reason := authErr
			if reason == "" {
				reason = "missing or mismatched state/code"
			}
			got <- outcome{err: bridge.Errorf(bridge.KindAuth, "Devin login failed: %s", reason)}
			return
		}
		_, _ = io.WriteString(w, "<html><body>Devin login complete. You can close this tab.</body></html>")
		got <- outcome{code: authCode}
	})
	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	redirectURI := "http://" + loginListenAddr + loginCallbackPath
	params := url.Values{
		"redirect_uri":          {redirectURI},
		"state":                 {state},
		"prompt":                {"select_account"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	if err := host.AuthURL(
		loginWebappURL+"/auth/cli/continue?"+params.Encode(),
		"Sign in to Devin in your browser.",
	); err != nil {
		return "", err
	}

	timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timer.Stop()
	select {
	case o := <-got:
		return o.code, o.err
	case <-timer.C:
		return "", bridge.Errorf(bridge.KindTimeout, "Timed out waiting for the Devin login callback.")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// exchangeCLIToken trades the authorization code for a session token, the
// same POST exchangeDevinCliToken makes.
func exchangeCLIToken(ctx context.Context, code, verifier string) (string, error) {
	body, err := json.Marshal(map[string]string{"code": code, "code_verifier": verifier})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, loginManagementURL+loginTokenPath, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := defaultHTTPClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("Devin CLI token exchange failed: %v", err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("Devin CLI token exchange failed: %v", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", &APIError{Operation: "CLI token exchange", Status: resp.StatusCode,
			Message: fmt.Sprintf("Devin CLI token exchange failed: %d %s", resp.StatusCode, string(payload)), Header: resp.Header}
	}
	var data struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(payload, &data); err != nil || data.Token == "" {
		return "", fmt.Errorf("Devin CLI token exchange returned an empty token.")
	}
	return data.Token, nil
}

// tokenExpiryMs reads a JWT's exp claim (minus a 5-minute margin); long-lived
// when the token is not a JWT or carries no exp.
func tokenExpiryMs(token string) float64 {
	fallback := float64(time.Now().UnixMilli()) + loginFallbackExpiresMs
	parts := splitToken(token)
	if len(parts) < 2 || parts[1] == "" {
		return fallback
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		if payload, err = base64.URLEncoding.DecodeString(parts[1]); err != nil {
			return fallback
		}
	}
	var claims struct {
		Exp *float64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp == nil {
		return fallback
	}
	return *claims.Exp*1000 - loginExpirySafetyMargin
}

func splitToken(token string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(token); i++ {
		if i == len(token) || token[i] == '.' {
			out = append(out, token[start:i])
			start = i + 1
		}
	}
	return out
}
