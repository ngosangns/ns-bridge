// Package logx writes the vendor cores' diagnostics to stderr in the same
// "[vendor] message {json}" shape the TypeScript cores print. The sidecar
// client forwards the binary's stderr to the host's, so these land where the
// in-process cores' console output used to.
package logx

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
)

var (
	mu  sync.Mutex
	out io.Writer = os.Stderr
)

// SetOutput redirects diagnostics (tests).
func SetOutput(w io.Writer) {
	mu.Lock()
	out = w
	mu.Unlock()
}

// Enabled reports whether any of the named switches is set to a truthy value.
func Enabled(names ...string) bool {
	for _, n := range names {
		v, ok := os.LookupEnv(n)
		if ok && v != "" && v != "0" && v != "false" {
			return true
		}
	}
	return false
}

// Line prints "[prefix] message {data}".
func Line(prefix, message string, data map[string]any) {
	line := fmt.Sprintf("[%s] %s", prefix, message)
	if data != nil {
		if b, err := json.Marshal(data); err == nil {
			line += " " + string(b)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	fmt.Fprintln(out, line)
}

// Warn prints one raw line (console.warn).
func Warn(message string) {
	mu.Lock()
	defer mu.Unlock()
	fmt.Fprintln(out, message)
}
