// Package kiroide reads the credentials the Kiro IDE writes under
// ~/.aws/sso/cache. It is the Go port of ns-kiro-core's kiro-ide.ts.
package kiroide

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"time"
)

// Credentials matches the IDC session kiro-ide.ts returns. Expires is epoch
// milliseconds already reduced by the 2-minute buffer (NaN when the file's
// expiresAt does not parse, as new Date(invalid).getTime() is).
type Credentials struct {
	Access       string
	Refresh      string
	Expires      float64
	ClientID     string
	ClientSecret string
	Region       string
	AuthMethod   string
}

// Now is swappable for tests.
var Now = func() time.Time { return time.Now() }

const expiryBufferMs = 2 * 60 * 1000

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return ""
}

// CacheDir is ~/.aws/sso/cache.
func CacheDir() string {
	return filepath.Join(homeDir(), ".aws", "sso", "cache")
}

type tokenFile struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    string `json:"expiresAt"`
	Region       string `json:"region"`
	ClientIDHash string `json:"clientIdHash"`
}

type clientFile struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

// Get is getKiroIdeCredentials.
func Get() *Credentials { return read(false) }

// GetAllowExpired is getKiroIdeCredentialsAllowExpired.
func GetAllowExpired() *Credentials { return read(true) }

func read(allowExpired bool) *Credentials {
	raw, err := os.ReadFile(filepath.Join(CacheDir(), "kiro-auth-token.json"))
	if err != nil {
		return nil
	}
	var token tokenFile
	if json.Unmarshal(raw, &token) != nil || token.AccessToken == "" || token.RefreshToken == "" {
		return nil
	}
	expiresAt, parsed := parseExpires(token.ExpiresAt)
	now := float64(Now().UnixMilli())
	if parsed && !allowExpired && now >= expiresAt-expiryBufferMs {
		return nil
	}
	expires := math.NaN()
	if parsed {
		expires = expiresAt - expiryBufferMs
	}
	region := token.Region
	if region == "" {
		region = "us-east-1"
	}
	clientID, clientSecret := "", ""
	if token.ClientIDHash != "" {
		if regRaw, err := os.ReadFile(filepath.Join(CacheDir(), token.ClientIDHash+".json")); err == nil {
			var reg clientFile
			if json.Unmarshal(regRaw, &reg) == nil {
				clientID = reg.ClientID
				clientSecret = reg.ClientSecret
			}
		}
	}
	return &Credentials{
		Refresh:      token.RefreshToken + "|" + clientID + "|" + clientSecret + "|idc",
		Access:       token.AccessToken,
		Expires:      expires,
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Region:       region,
		AuthMethod:   "idc",
	}
}

func parseExpires(s string) (float64, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if ts, err := time.Parse(layout, s); err == nil {
			return float64(ts.UnixMilli()), true
		}
	}
	return 0, false
}
