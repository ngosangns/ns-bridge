// Package kirocli reads (and, for a refresh, writes back) the credentials
// kiro-cli keeps in its SQLite store, and runs kiro-cli's own token refresh:
// the Go port of ns-kiro-core's kiro-cli.ts. The store is opened with a pure-Go
// SQLite, so the sidecar stays CGO-free and needs no sqlite3 on PATH.
package kirocli

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
	"github.com/ngosangns/ns-bridge/go/internal/redact"
	_ "modernc.org/sqlite"
)

// ExternalIdpTokenKey is the auth_kv row an external-IdP login lives in.
const ExternalIdpTokenKey = "kirocli:external-idp:token"

// Credentials mirrors ns-kiro-core's KiroCredentials. Expires is epoch ms
// (NaN when kiro-cli stored an unreadable date, as in JavaScript).
type Credentials struct {
	Access       string  `json:"access"`
	Refresh      string  `json:"refresh"`
	Expires      float64 `json:"expires"`
	ClientID     string  `json:"clientId"`
	ClientSecret string  `json:"clientSecret"`
	Region       string  `json:"region"`
	AuthMethod   string  `json:"authMethod"`
	ProfileArn   string  `json:"profileArn,omitempty"`
}

// Now is swappable for tests.
var Now = func() time.Time { return time.Now() }

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return ""
}

// DBPath is kiro-cli's data.sqlite3 when it exists.
func DBPath() string {
	home := homeDir()
	var candidates []string
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		roaming := os.Getenv("APPDATA")
		if roaming == "" {
			roaming = filepath.Join(home, "AppData", "Roaming")
		}
		candidates = []string{filepath.Join(local, "Kiro-Cli", "data.sqlite3"), filepath.Join(roaming, "kiro-cli", "data.sqlite3")}
	case "darwin":
		candidates = []string{filepath.Join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3")}
	default:
		candidates = []string{filepath.Join(home, ".local", "share", "kiro-cli", "data.sqlite3")}
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func open(dbPath string, readOnly bool) (*sql.DB, error) {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	if readOnly {
		q.Set("mode", "ro")
	}
	return sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?"+q.Encode())
}

// readValue is the auth_kv value for key ("" when absent or unreadable).
func readValue(dbPath, key string) string {
	db, err := open(dbPath, true)
	if err != nil {
		return ""
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var value sql.NullString
	if err := db.QueryRowContext(ctx, "SELECT value FROM auth_kv WHERE key = ?", key).Scan(&value); err != nil {
		return ""
	}
	return value.String
}

func writeValue(dbPath, key, value string) bool {
	db, err := open(dbPath, false)
	if err != nil {
		return false
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = db.ExecContext(ctx, "UPDATE auth_kv SET value = ? WHERE key = ?", value, key)
	return err == nil
}

func str(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := m[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0 && !math.IsNaN(t)
	default:
		return true
	}
}

// ParseJSDate is new Date(v).getTime() for the shapes kiro-cli writes.
func ParseJSDate(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		s := strings.TrimSpace(t)
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02"} {
			if ts, err := time.Parse(layout, s); err == nil {
				return float64(ts.UnixMilli())
			}
		}
	}
	return math.NaN()
}

// TryToken reads one token row the way tryKiroCliToken does.
func TryToken(dbPath, tokenKey, authMethod string, allowExpired bool) *Credentials {
	raw := readValue(dbPath, tokenKey)
	if raw == "" {
		return nil
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil
	}
	if !truthy(data["access_token"]) || !truthy(data["refresh_token"]) {
		return nil
	}
	access, _ := data["access_token"].(string)
	refresh, _ := data["refresh_token"].(string)
	now := float64(Now().UnixMilli())
	expiresAt := now + 3600000
	if truthy(data["expires_at"]) {
		expiresAt = ParseJSDate(data["expires_at"])
	}
	if !allowExpired && now >= expiresAt-2*60*1000 {
		return nil
	}
	region := str(data, "region")
	if region == "" {
		region = "us-east-1"
	}
	profileArn := str(data, "profile_arn", "profileArn")
	switch authMethod {
	case "desktop":
		return &Credentials{Refresh: refresh + "|desktop", Access: access, Expires: expiresAt, Region: region, AuthMethod: "desktop", ProfileArn: profileArn}
	case "external-idp":
		clientID := str(data, "client_id", "clientId")
		issuer := str(data, "issuer_url")
		endpoint := str(data, "token_endpoint", "tokenEndpoint")
		if endpoint == "" && issuer != "" {
			endpoint = strings.TrimRight(issuer, "/") + "/v1/token"
		}
		return &Credentials{
			Refresh: refresh + "|" + clientID + "|" + endpoint + "|external-idp", Access: access, Expires: expiresAt,
			ClientID: clientID, Region: region, AuthMethod: "external-idp", ProfileArn: profileArn,
		}
	}
	clientID, clientSecret := "", ""
	prefix, _, _ := strings.Cut(tokenKey, ":")
	if dev := readValue(dbPath, prefix+":odic:device-registration"); dev != "" {
		var d map[string]any
		if json.Unmarshal([]byte(dev), &d) == nil {
			clientID = str(d, "client_id", "clientId")
			clientSecret = str(d, "client_secret", "clientSecret")
		}
	}
	return &Credentials{
		Refresh: refresh + "|" + clientID + "|" + clientSecret + "|idc", Access: access, Expires: expiresAt,
		ClientID: clientID, ClientSecret: clientSecret, Region: region, AuthMethod: "idc", ProfileArn: profileArn,
	}
}

func get(allowExpired bool) *Credentials {
	dbPath := DBPath()
	if dbPath == "" {
		return nil
	}
	if c := TryToken(dbPath, "kirocli:odic:token", "idc", allowExpired); c != nil {
		return c
	}
	if c := TryToken(dbPath, "kirocli:social:token", "desktop", allowExpired); c != nil {
		return c
	}
	return TryToken(dbPath, ExternalIdpTokenKey, "external-idp", allowExpired)
}

// GetCredentials is getKiroCliCredentials: the first unexpired login.
func GetCredentials() *Credentials { return get(false) }

// GetCredentialsAllowExpired is getKiroCliCredentialsAllowExpired.
func GetCredentialsAllowExpired() *Credentials { return get(true) }

// GetExternalIdpCredentials is getKiroCliExternalIdpCredentials.
func GetExternalIdpCredentials() *Credentials {
	dbPath := DBPath()
	if dbPath == "" {
		return nil
	}
	return TryToken(dbPath, ExternalIdpTokenKey, "external-idp", true)
}

var tokenKeysByAuthMethod = map[string][]string{
	"idc":          {"kirocli:odic:token", "codewhisperer:odic:token"},
	"desktop":      {"kirocli:social:token"},
	"external-idp": {ExternalIdpTokenKey},
}

// SaveCredentials is saveKiroCliCredentials: write a refreshed token back
// into the row it came from, so kiro-cli and every host see it.
func SaveCredentials(c *Credentials) {
	dbPath := DBPath()
	if dbPath == "" {
		return
	}
	rawRefresh, _, _ := strings.Cut(c.Refresh, "|")
	expiresAt := time.UnixMilli(int64(c.Expires) + 5*60*1000).UTC().Format("2006-01-02T15:04:05.000Z")
	for _, key := range tokenKeysByAuthMethod[c.AuthMethod] {
		existing := readValue(dbPath, key)
		if existing == "" {
			continue
		}
		obj, err := mergeToken(existing, c, rawRefresh, expiresAt)
		if err != nil {
			continue
		}
		if writeValue(dbPath, key, obj) {
			return
		}
	}
}

// LookPath finds kiro-cli; swappable for tests.
var LookPath = exec.LookPath

// RefreshViaKiroCli is refreshViaKiroCli: let kiro-cli refresh its own login,
// then re-read the store.
func RefreshViaKiroCli() *Credentials {
	bin, err := LookPath("kiro-cli")
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, "debug", "refresh-auth-token")
		var stderr strings.Builder
		cmd.Stderr = &stderr
		err = cmd.Run()
		if err != nil && stderr.Len() > 0 {
			err = fmt.Errorf("Command failed: kiro-cli debug refresh-auth-token\n%s", stderr.String())
		}
	} else {
		err = fmt.Errorf("spawnSync kiro-cli ENOENT")
	}
	if err != nil {
		logx.Warn(fmt.Sprintf("[kiro-core] kiro-cli refresh failed: %s", redact.Kiro(err.Error())))
		return nil
	}
	return GetCredentials()
}

// mergeToken updates the stored token JSON in place, keeping every other
// field (and their order) kiro-cli wrote.
func mergeToken(existing string, c *Credentials, rawRefresh, expiresAt string) (string, error) {
	v, err := jsjson.Parse([]byte(existing))
	if err != nil {
		return "", err
	}
	obj, ok := v.(*jsjson.Object)
	if !ok {
		return "", fmt.Errorf("token row is not an object")
	}
	obj.Set("access_token", c.Access)
	obj.Set("refresh_token", rawRefresh)
	obj.Set("expires_at", expiresAt)
	if c.AuthMethod != "external-idp" {
		if c.Region != "" {
			obj.Set("region", c.Region)
		}
		if c.ProfileArn != "" {
			obj.Set("profile_arn", c.ProfileArn)
		}
	}
	return jsjson.Stringify(obj), nil
}
