package kiroide

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReadAppliesTwoMinuteBuffer(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := filepath.Join(home, ".aws", "sso", "cache")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(expires time.Time) {
		t.Helper()
		tok := `{"accessToken":"at","refreshToken":"rt","expiresAt":"` + expires.UTC().Format(time.RFC3339) + `","region":"eu-central-1","clientIdHash":"abc"}`
		if err := os.WriteFile(filepath.Join(dir, "kiro-auth-token.json"), []byte(tok), 0o644); err != nil {
			t.Fatal(err)
		}
		reg := `{"clientId":"cid","clientSecret":"csec"}`
		if err := os.WriteFile(filepath.Join(dir, "abc.json"), []byte(reg), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write(time.Now().Add(10 * time.Minute))
	got := Get()
	if got == nil || got.Access != "at" || got.Refresh != "rt|cid|csec|idc" || got.Region != "eu-central-1" || got.AuthMethod != "idc" {
		t.Fatalf("%+v", got)
	}
	// The returned expiry is the file's expiry minus the 2-minute buffer.
	if got.Expires > float64(time.Now().Add(9*time.Minute).UnixMilli()) {
		t.Fatalf("expires %v was not reduced", got.Expires)
	}

	write(time.Now().Add(90 * time.Second))
	if Get() != nil {
		t.Fatal("token inside the 2-minute buffer was returned")
	}
	stale := GetAllowExpired()
	if stale == nil || stale.Access != "at" {
		t.Fatalf("%+v", stale)
	}
}

func TestReadMissingFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if Get() != nil || GetAllowExpired() != nil {
		t.Fatal("missing token file returned credentials")
	}
}
