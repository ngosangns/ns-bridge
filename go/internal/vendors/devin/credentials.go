package devin

// The Devin CLI credential file (~/.local/share/devin/credentials.toml, or
// DEVIN_CREDENTIALS_PATH). The Go port of ns-devin-core's credentials.ts:
// a flat `key = "value"` file, unrelated keys preserved on write.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	tomlLine     = regexp.MustCompile(`^([\w.-]+)\s*=\s*"(.*)"\s*$`)
	tomlUnescape = regexp.MustCompile(`\\(["\\])`)
	tomlEscape   = regexp.MustCompile(`(["\\])`)
)

type tomlField struct {
	key   string
	value string
}

// StoredCredentials is DevinStoredCredentials.
type StoredCredentials struct {
	APIKey          string `json:"apiKey"`
	APIServerURL    string `json:"apiServerUrl,omitempty"`
	DevinAPIURL     string `json:"devinApiUrl,omitempty"`
	DevinWebappHost string `json:"devinWebappHost,omitempty"`
}

type saveCredentialsRequest struct {
	APIKey          string  `json:"apiKey"`
	APIServerURL    *string `json:"apiServerUrl"`
	DevinAPIURL     *string `json:"devinApiUrl"`
	DevinWebappHost *string `json:"devinWebappHost"`
}

// CredentialsPath is devinCredentialsPath.
func CredentialsPath() string {
	if p := os.Getenv("DEVIN_CREDENTIALS_PATH"); p != "" {
		return p
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = ""
		}
		data = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(data, "devin", "credentials.toml")
}

// LoadCredentials is resolveDevinCredentials. Nil when the file is missing
// or carries no usable token.
func LoadCredentials() *StoredCredentials {
	text, err := os.ReadFile(CredentialsPath())
	if err != nil {
		return nil
	}
	fields := parseCredentialsToml(string(text))
	apiKey := strings.TrimSpace(fieldValue(fields, "windsurf_api_key"))
	if apiKey == "" {
		apiKey = strings.TrimSpace(fieldValue(fields, "api_key"))
	}
	if apiKey == "" {
		return nil
	}
	return &StoredCredentials{
		APIKey:          apiKey,
		APIServerURL:    trimURL(fieldValue(fields, "api_server_url")),
		DevinAPIURL:     trimURL(fieldValue(fields, "devin_api_url")),
		DevinWebappHost: trimURL(fieldValue(fields, "devin_webapp_host")),
	}
}

// SaveCredentials is saveDevinCredentials.
func SaveCredentials(raw json.RawMessage) error {
	var req saveCredentialsRequest
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &req); err != nil {
			return err
		}
	}
	path := CredentialsPath()
	text, err := os.ReadFile(path)
	if err != nil {
		text = nil
	}
	fields := parseCredentialsToml(string(text))
	fields = setField(fields, "windsurf_api_key", req.APIKey)
	if req.APIServerURL != nil && *req.APIServerURL != "" {
		fields = setField(fields, "api_server_url", *req.APIServerURL)
	}
	if req.DevinAPIURL != nil && *req.DevinAPIURL != "" {
		fields = setField(fields, "devin_api_url", *req.DevinAPIURL)
	}
	if req.DevinWebappHost != nil && *req.DevinWebappHost != "" {
		fields = setField(fields, "devin_webapp_host", *req.DevinWebappHost)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(renderCredentialsToml(fields)), 0o600)
}

func parseCredentialsToml(text string) []tomlField {
	var out []tomlField
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "[") {
			continue
		}
		m := tomlLine.FindStringSubmatch(trimmed)
		if m == nil {
			continue
		}
		out = append(out, tomlField{key: m[1], value: tomlUnescape.ReplaceAllString(m[2], "$1")})
	}
	return out
}

func fieldValue(fields []tomlField, key string) string {
	for _, f := range fields {
		if f.key == key {
			return f.value
		}
	}
	return ""
}

func setField(fields []tomlField, key, value string) []tomlField {
	for i := range fields {
		if fields[i].key == key {
			fields[i].value = value
			return fields
		}
	}
	return append(fields, tomlField{key: key, value: value})
}

func trimURL(value string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(value), "/")
	return trimmed
}

func renderCredentialsToml(fields []tomlField) string {
	var b strings.Builder
	for i, f := range fields {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(f.key)
		b.WriteString(` = "`)
		b.WriteString(tomlEscape.ReplaceAllString(f.value, `\$1`))
		b.WriteByte('"')
	}
	b.WriteByte('\n')
	return b.String()
}
