package kiro

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
	_ "modernc.org/sqlite"
)

func withSessionHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("KIRO_PROCESS_STATE_PATH", "off")
	t.Setenv("KIRO_AUTH_SOURCE", "")
	t.Setenv("KIRO_OIDC_ENDPOINT", "http://127.0.0.1:1")
	t.Setenv("KIRO_DESKTOP_REFRESH_ENDPOINT", "http://127.0.0.1:1")
	return home
}

func cliDBPath(home string) string {
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(local, "Kiro-Cli", "data.sqlite3")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3")
	default:
		return filepath.Join(home, ".local", "share", "kiro-cli", "data.sqlite3")
	}
}

func seedCLI(t *testing.T, home string, rows map[string]string) {
	t.Helper()
	dbPath := cliDBPath(home)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatal(err)
	}
	for k, v := range rows {
		if _, err := db.Exec(`INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)`, k, v); err != nil {
			t.Fatal(err)
		}
	}
}

func readCLIValue(t *testing.T, home, key string) string {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(cliDBPath(home))+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var value string
	if err := db.QueryRow(`SELECT value FROM auth_kv WHERE key = ?`, key).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func idcRows(access, refresh, clientID, secret, region string, expires time.Time) map[string]string {
	tok, _ := json.Marshal(map[string]string{
		"access_token": access, "refresh_token": refresh,
		"expires_at": expires.UTC().Format(time.RFC3339Nano), "region": region,
	})
	dev, _ := json.Marshal(map[string]string{"client_id": clientID, "client_secret": secret})
	return map[string]string{
		"kirocli:odic:token":               string(tok),
		"kirocli:odic:device-registration": string(dev),
	}
}

func socialRows(access, refresh, region, arn string, expires time.Time) map[string]string {
	tok, _ := json.Marshal(map[string]string{
		"access_token": access, "refresh_token": refresh,
		"expires_at": expires.UTC().Format(time.RFC3339Nano), "region": region, "profile_arn": arn,
	})
	return map[string]string{"kirocli:social:token": string(tok)}
}

func writeIDE(t *testing.T, home, access, refresh, region, hash, clientID, secret string, expires time.Time) {
	t.Helper()
	dir := filepath.Join(home, ".aws", "sso", "cache")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	tok, _ := json.Marshal(map[string]string{
		"accessToken": access, "refreshToken": refresh,
		"expiresAt": expires.UTC().Format(time.RFC3339), "region": region, "clientIdHash": hash,
	})
	if err := os.WriteFile(filepath.Join(dir, "kiro-auth-token.json"), tok, 0o644); err != nil {
		t.Fatal(err)
	}
	if hash == "" {
		return
	}
	reg, _ := json.Marshal(map[string]string{"clientId": clientID, "clientSecret": secret})
	if err := os.WriteFile(filepath.Join(dir, hash+".json"), reg, 0o644); err != nil {
		t.Fatal(err)
	}
}

func sessionReq(credentials map[string]any) json.RawMessage {
	raw, err := json.Marshal(map[string]any{"credentials": credentials})
	if err != nil {
		panic(err)
	}
	return raw
}

func idcCred(refresh, access, clientID, secret, region string, expires float64) map[string]any {
	return map[string]any{
		"refresh": refresh, "access": access, "expires": expires,
		"clientId": clientID, "clientSecret": secret, "region": region, "authMethod": "idc",
	}
}

func asCreds(t *testing.T, v any) kiroCredentials {
	t.Helper()
	obj, ok := v.(*jsjson.Object)
	if !ok || obj == nil {
		t.Fatalf("result %#v", v)
	}
	var c kiroCredentials
	if err := json.Unmarshal([]byte(jsjson.Stringify(obj)), &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func sessionRefreshed(v any) bool {
	obj, _ := v.(*jsjson.Object)
	if obj == nil {
		return false
	}
	flag, ok := obj.Get("kiroSessionRefreshed")
	return ok && flag == true
}

func oidcServer(t *testing.T, statusFor func(refresh string) (int, string)) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			RefreshToken string `json:"refreshToken"`
		}
		_ = json.Unmarshal(body, &req)
		status, payload := statusFor(req.RefreshToken)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, payload)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("KIRO_OIDC_ENDPOINT", srv.URL)
}

func TestRefreshSessionNetworkAndSave(t *testing.T) {
	home := withSessionHome(t)
	past := time.Now().Add(-time.Hour)
	seedCLI(t, home, idcRows("old_at", "old_rt", "cid", "csec", "us-east-1", past))
	oidcServer(t, func(refresh string) (int, string) {
		if refresh != "old_rt" {
			t.Errorf("refresh %q", refresh)
		}
		return 200, `{"accessToken":"new_at","refreshToken":"new_rt","expiresIn":3600}`
	})

	got, err := refreshSession(context.Background(), sessionReq(idcCred("old_rt|cid|csec|idc", "old_at", "cid", "csec", "us-east-1", 0)))
	if err != nil {
		t.Fatal(err)
	}
	c := asCreds(t, got)
	if c.Access != "new_at" || c.Refresh != "new_rt|cid|csec|idc" || c.AuthMethod != "idc" {
		t.Fatalf("%+v", c)
	}
	if !strings.Contains(readCLIValue(t, home, "kirocli:odic:token"), `"access_token":"new_at"`) {
		t.Fatal("refreshed token was not written back")
	}
}

func TestRefreshSessionThrows(t *testing.T) {
	withSessionHome(t)
	oidcServer(t, func(string) (int, string) { return 401, `{}` })
	_, err := refreshSession(context.Background(), sessionReq(idcCred("rt|c|s|idc", "x", "", "", "us-east-1", 0)))
	if err == nil || !strings.Contains(err.Error(), "Token refresh failed: 401") {
		t.Fatal(err)
	}
}

func TestRefreshSessionAPIKeyUntouched(t *testing.T) {
	withSessionHome(t)
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
	t.Cleanup(srv.Close)
	t.Setenv("KIRO_OIDC_ENDPOINT", srv.URL)
	got, err := refreshSession(context.Background(), sessionReq(map[string]any{
		"access": "ksk_live", "refresh": "ksk_live", "expires": float64(0), "region": "us-east-1", "authMethod": "apikey",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if asCreds(t, got).Access != "ksk_live" || hits != 0 {
		t.Fatalf("access %q hits %d", asCreds(t, got).Access, hits)
	}
}

func TestRefreshSessionDesktop(t *testing.T) {
	withSessionHome(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"accessToken":"desk_at","refreshToken":"desk_rt","expiresIn":3600,"profileArn":"arn:social"}`)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("KIRO_DESKTOP_REFRESH_ENDPOINT", srv.URL)
	got, err := refreshSession(context.Background(), sessionReq(map[string]any{
		"refresh": "desk_rt|desktop", "access": "old", "expires": float64(0), "region": "us-east-1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	c := asCreds(t, got)
	if c.Access != "desk_at" || c.Refresh != "desk_rt|desktop" || c.AuthMethod != "desktop" {
		t.Fatalf("%+v", c)
	}
}

func TestRefreshSessionExternalIdP(t *testing.T) {
	withSessionHome(t)
	var gotRefresh string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		vals, _ := url.ParseQuery(string(body))
		gotRefresh = vals.Get("refresh_token")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"idp_at","refresh_token":"idp_rt2","expires_in":3600}`)
	}))
	t.Cleanup(srv.Close)
	endpoint := srv.URL + "/token"
	got, err := refreshSession(context.Background(), sessionReq(map[string]any{
		"refresh": "idp_rt|0oaEXAMPLE|" + endpoint + "|external-idp", "access": "old", "expires": float64(0), "region": "us-east-1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	c := asCreds(t, got)
	if gotRefresh != "idp_rt" || c.Access != "idp_at" || c.AuthMethod != "external-idp" {
		t.Fatalf("sent %q creds %+v", gotRefresh, c)
	}
	if c.Refresh != "idp_rt2|0oaEXAMPLE|"+endpoint+"|external-idp" {
		t.Fatal(c.Refresh)
	}
}

func TestRefreshSessionExternalIdPFailure(t *testing.T) {
	withSessionHome(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
	}))
	t.Cleanup(srv.Close)
	_, err := refreshSession(context.Background(), sessionReq(map[string]any{
		"refresh": "idp_rt|cid|" + srv.URL + "|external-idp", "access": "old", "expires": float64(0),
	}))
	if err == nil || !strings.Contains(err.Error(), "External IdP token refresh failed: 400") {
		t.Fatal(err)
	}
}

func TestRefreshSessionFallsBackToStaleCLI(t *testing.T) {
	home := withSessionHome(t)
	past := time.Now().Add(-time.Hour)
	seedCLI(t, home, idcRows("cli_at", "cli_rt", "cli_cid", "cli_csec", "us-east-1", past))
	oidcServer(t, func(refresh string) (int, string) {
		if refresh == "stale_rt" {
			return 401, `{}`
		}
		return 200, `{"accessToken":"new_at","refreshToken":"new_rt","expiresIn":3600}`
	})
	got, err := refreshSession(context.Background(), sessionReq(idcCred("stale_rt|cid|csec|idc", "stale_at", "", "", "us-east-1", 0)))
	if err != nil {
		t.Fatal(err)
	}
	if asCreds(t, got).Access != "new_at" {
		t.Fatal(asCreds(t, got).Access)
	}
	if !strings.Contains(readCLIValue(t, home, "kirocli:odic:token"), `"access_token":"new_at"`) {
		t.Fatal("fallback refresh was not saved")
	}
}

func TestRefreshSessionBufferWhenRefreshFails(t *testing.T) {
	home := withSessionHome(t)
	past := time.Now().Add(-time.Hour)
	seedCLI(t, home, idcRows("cli_at", "cli_rt", "cli_cid", "cli_csec", "us-east-1", past))
	oidcServer(t, func(string) (int, string) { return 401, `{}` })
	expires := float64(time.Now().Add(-time.Minute).UnixMilli())
	got, err := refreshSession(context.Background(), sessionReq(idcCred("old_rt|cid|csec|idc", "old_at", "cid", "csec", "us-east-1", expires)))
	if err != nil {
		t.Fatal(err)
	}
	c := asCreds(t, got)
	if c.Access != "old_at" || c.Expires <= float64(time.Now().UnixMilli()) {
		t.Fatalf("%+v", c)
	}
}

func TestRefreshSessionDoesNotReplaceDesktopWithIDE(t *testing.T) {
	home := withSessionHome(t)
	future := time.Now().Add(time.Hour)
	seedCLI(t, home, socialRows("social_at", "social_rt", "us-east-1", "arn:aws:codewhisperer:us-east-1:123456789012:profile/social", future))
	writeIDE(t, home, "ide_at", "ide_rt", "eu-central-1", "hash", "ide_cid", "ide_csec", future)
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
	t.Cleanup(srv.Close)
	t.Setenv("KIRO_DESKTOP_REFRESH_ENDPOINT", srv.URL)
	got, err := refreshSession(context.Background(), sessionReq(map[string]any{
		"refresh": "stored_rt|desktop", "access": "stored_at", "expires": float64(0),
		"clientId": "", "clientSecret": "", "region": "us-east-1", "authMethod": "desktop",
	}))
	if err != nil {
		t.Fatal(err)
	}
	c := asCreds(t, got)
	if c.Access != "social_at" || c.AuthMethod != "desktop" || c.Region != "us-east-1" || hits != 0 {
		t.Fatalf("%+v hits %d", c, hits)
	}
}

func TestRefreshSessionKeepsCLILogin(t *testing.T) {
	home := withSessionHome(t)
	future := time.Now().Add(time.Hour)
	seedCLI(t, home, idcRows("cli_at", "cli_rt", "cli_cid", "cli_csec", "us-east-1", future))
	writeIDE(t, home, "ide_at", "ide_rt", "us-east-1", "hash", "ide_cid", "ide_csec", future)
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
	t.Cleanup(srv.Close)
	t.Setenv("KIRO_OIDC_ENDPOINT", srv.URL)
	got, err := refreshSession(context.Background(), sessionReq(idcCred("cli_rt|cli_cid|cli_csec|idc", "cli_at", "cli_cid", "cli_csec", "us-east-1", float64(future.UnixMilli()))))
	if err != nil {
		t.Fatal(err)
	}
	c := asCreds(t, got)
	if c.Access != "cli_at" || !strings.Contains(c.Refresh, "cli_cid") || hits != 0 {
		t.Fatalf("%+v hits %d", c, hits)
	}
}

func TestRefreshSessionDoesNotSaveIDELogin(t *testing.T) {
	home := withSessionHome(t)
	past := time.Now().Add(-time.Hour)
	seedCLI(t, home, idcRows("other_at", "other_rt", "other_cid", "other_csec", "us-east-1", past))
	writeIDE(t, home, "ide_at", "ide_rt", "us-east-1", "hash", "ide_cid", "ide_csec", past)
	oidcServer(t, func(refresh string) (int, string) {
		if refresh != "ide_rt" {
			t.Errorf("refresh %q", refresh)
		}
		return 200, `{"accessToken":"ide_new_at","refreshToken":"ide_new_rt","expiresIn":3600}`
	})
	got, err := refreshSession(context.Background(), sessionReq(idcCred("ide_rt|ide_cid|ide_csec|idc", "ide_at", "ide_cid", "ide_csec", "us-east-1", float64(past.UnixMilli()))))
	if err != nil {
		t.Fatal(err)
	}
	if asCreds(t, got).Access != "ide_new_at" {
		t.Fatal(asCreds(t, got).Access)
	}
	if !strings.Contains(readCLIValue(t, home, "kirocli:odic:token"), `"access_token":"other_at"`) {
		t.Fatal("IDE login was written into the kiro-cli store")
	}
}

func TestResolveCredentialsPrefersAuthSource(t *testing.T) {
	home := withSessionHome(t)
	future := time.Now().Add(time.Hour)
	seedCLI(t, home, idcRows("cli_at", "cli_rt", "cli_cid", "cli_csec", "us-east-1", future))
	writeIDE(t, home, "ide_at", "ide_rt", "us-east-1", "hash", "ide_cid", "ide_csec", future)

	got, err := resolveCredentials(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if asCreds(t, got).Access != "cli_at" || sessionRefreshed(got) {
		t.Fatalf("%+v refreshed %v", asCreds(t, got), sessionRefreshed(got))
	}

	t.Setenv("KIRO_AUTH_SOURCE", "ide")
	got, err = resolveCredentials(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if asCreds(t, got).Access != "ide_at" {
		t.Fatal(asCreds(t, got).Access)
	}
}

func TestResolveCredentialsIgnoresUnknownAuthSource(t *testing.T) {
	home := withSessionHome(t)
	future := time.Now().Add(time.Hour)
	seedCLI(t, home, idcRows("cli_at", "cli_rt", "cli_cid", "cli_csec", "us-east-1", future))
	writeIDE(t, home, "ide_at", "ide_rt", "us-east-1", "hash", "ide_cid", "ide_csec", future)
	var buf bytes.Buffer
	logx.SetOutput(&buf)
	t.Cleanup(func() { logx.SetOutput(os.Stderr) })
	t.Setenv("KIRO_AUTH_SOURCE", "oidc")

	got, err := resolveCredentials(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if asCreds(t, got).Access != "cli_at" {
		t.Fatal(asCreds(t, got).Access)
	}
	if strings.Count(buf.String(), `Ignoring KIRO_AUTH_SOURCE=oidc`) != 1 {
		t.Fatal(buf.String())
	}
}

func TestResolveCredentialsRefreshesStaleCLIInsteadOfIDE(t *testing.T) {
	home := withSessionHome(t)
	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	seedCLI(t, home, idcRows("cli_at", "cli_rt", "cli_cid", "cli_csec", "us-east-1", past))
	writeIDE(t, home, "ide_at", "ide_rt", "us-east-1", "hash", "ide_cid", "ide_csec", future)
	oidcServer(t, func(string) (int, string) {
		return 200, `{"accessToken":"cli_new_at","refreshToken":"cli_new_rt","expiresIn":3600}`
	})

	got, err := resolveCredentials(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	c := asCreds(t, got)
	if c.Access != "cli_new_at" || !strings.Contains(c.Refresh, "cli_cid") || !sessionRefreshed(got) {
		t.Fatalf("%+v refreshed %v", c, sessionRefreshed(got))
	}
	if !strings.Contains(readCLIValue(t, home, "kirocli:odic:token"), `"access_token":"cli_new_at"`) {
		t.Fatal("refreshed cli session was not saved")
	}
}

func TestResolveCredentialsFallsBackToIDE(t *testing.T) {
	home := withSessionHome(t)
	writeIDE(t, home, "ide_at", "ide_rt", "us-east-1", "hash", "ide_cid", "ide_csec", time.Now().Add(time.Hour))
	got, err := resolveCredentials(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if asCreds(t, got).Access != "ide_at" || sessionRefreshed(got) {
		t.Fatalf("%+v", asCreds(t, got))
	}
}

func TestResolveCredentialsNone(t *testing.T) {
	withSessionHome(t)
	got, err := resolveCredentials(context.Background(), json.RawMessage(`{}`))
	if err != nil || got != nil {
		t.Fatalf("got %#v err %v", got, err)
	}
}
