package kiro

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/redact"
)

var debugMu sync.Mutex

func debugEnabled() bool {
	v := os.Getenv("KIRO_DEBUG")
	return v != "" && v != "0"
}

func debugLogFile() string {
	if p := os.Getenv("KIRO_DEBUG_LOG"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ns-kiro-provider", "logs", "kiro-debug.log")
}

// redactValue mirrors debug.ts's JSON.stringify replacer.
func redactValue(key string, v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = redactValue(k, e)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = redactValue("", e)
		}
		return out
	case string:
		k := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(key))
		if k == "authorization" || k == "access" || k == "refresh" || k == "profilearn" || strings.Contains(k, "token") || strings.Contains(k, "secret") {
			if k == "profilearn" {
				return "<redacted-profile-arn>"
			}
			return "<redacted>"
		}
		return redact.Kiro(t)
	}
	return v
}

// debugLog appends "<ts> [section] <json>" to the Kiro debug log.
func debugLog(section string, data any) {
	if !debugEnabled() {
		return
	}
	body := ""
	switch t := data.(type) {
	case nil:
	case string:
		body = " " + redact.Kiro(t)
	default:
		raw, err := json.Marshal(t)
		if err == nil {
			var generic any
			if json.Unmarshal(raw, &generic) == nil {
				if pretty, err := json.MarshalIndent(redactValue("", generic), "", "  "); err == nil {
					body = " " + string(pretty)
				}
			}
		}
	}
	debugMu.Lock()
	defer debugMu.Unlock()
	file := debugLogFile()
	_ = os.MkdirAll(filepath.Dir(file), 0o755)
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z") + " [" + section + "]" + body + "\n")
}

// logCapacityEvent appends to ~/.ns-kiro-provider/logs/capacity-retries.log.
func logCapacityEvent(message string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir := filepath.Join(home, ".ns-kiro-provider", "logs")
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "capacity-retries.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z") + " " + message + "\n")
}
