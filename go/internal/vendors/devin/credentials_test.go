package devin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func credPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.toml")
	t.Setenv("DEVIN_CREDENTIALS_PATH", path)
	return path
}

func TestLoadCredentialsReadsFlatFile(t *testing.T) {
	path := credPath(t)
	body := "windsurf_api_key = \"tok-123\"\napi_server_url = \"https://edge.example.com/\"\n# comment\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got := LoadCredentials()
	if got == nil || got.APIKey != "tok-123" || got.APIServerURL != "https://edge.example.com" {
		t.Fatalf("%+v", got)
	}
}

func TestLoadCredentialsMissingOrTokenless(t *testing.T) {
	path := credPath(t)
	if LoadCredentials() != nil {
		t.Fatal("missing file returned credentials")
	}
	if err := os.WriteFile(path, []byte("other_key = \"x\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if LoadCredentials() != nil {
		t.Fatal("tokenless file returned credentials")
	}
}

func TestLoadCredentialsPrefersWindsurfKey(t *testing.T) {
	path := credPath(t)
	body := "api_key = \"second\"\nwindsurf_api_key = \"first\"\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := LoadCredentials(); got == nil || got.APIKey != "first" {
		t.Fatalf("%+v", got)
	}
}

func TestSaveCredentialsPreservesUnrelatedKeys(t *testing.T) {
	path := credPath(t)
	if err := os.WriteFile(path, []byte("windsurf_api_key = \"old\"\ncustom_key = \"keep\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	url := "https://edge.example.com"
	if err := SaveCredentials([]byte(`{"apiKey":"new-tok","apiServerUrl":"` + url + `"}`)); err != nil {
		t.Fatal(err)
	}
	got := LoadCredentials()
	if got == nil || got.APIKey != "new-tok" || got.APIServerURL != url {
		t.Fatalf("%+v", got)
	}
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(text), `custom_key = "keep"`) {
		t.Fatal(string(text))
	}
	if !strings.HasPrefix(string(text), `windsurf_api_key = "new-tok"`) {
		t.Fatal(string(text))
	}
}

func TestSaveCredentialsEscapesQuotes(t *testing.T) {
	path := credPath(t)
	if err := SaveCredentials([]byte(`{"apiKey":"say \"hi\"\\"}`)); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(text), `windsurf_api_key = "say \"hi\"\\"`) {
		t.Fatal(string(text))
	}
	if got := LoadCredentials(); got == nil || got.APIKey != `say "hi"\` {
		t.Fatalf("%+v text %s", got, text)
	}
}
