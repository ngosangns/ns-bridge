package sidecar

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/vendors/echo"
)

var testRegistry = Registry{"echo": echo.Vendor{}, "silent": silent{}, "chatty": chatty{}}

// silent returns without ever emitting done.
type silent struct{}

func (silent) Stream(context.Context, json.RawMessage, func(bridge.Event) error) error { return nil }

// chatty tries to keep talking after done.
type chatty struct{}

func (chatty) Stream(_ context.Context, _ json.RawMessage, emit func(bridge.Event) error) error {
	if err := emit(bridge.Done(bridge.StopReasonStop)); err != nil {
		return err
	}
	return emit(bridge.Start())
}

func run(t *testing.T, vendor string, stdin io.Reader, opts Options) (int, []map[string]any) {
	t.Helper()
	var out bytes.Buffer
	code := Run(context.Background(), vendor, testRegistry, opts, stdin, &out)
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var value map[string]any
		if err := json.Unmarshal([]byte(line), &value); err != nil {
			t.Fatalf("line is not JSON: %q", line)
		}
		lines = append(lines, value)
	}
	return code, lines
}

func last(lines []map[string]any) map[string]any { return lines[len(lines)-1] }

func errorKind(line map[string]any) string {
	if line["type"] != "error" {
		return ""
	}
	return line["error"].(map[string]any)["kind"].(string)
}

const hello = `{"protocol":1,"request":{"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}}`

func TestEchoEndsWithDone(t *testing.T) {
	code, lines := run(t, "echo", strings.NewReader(hello), Options{IgnoreStdinEOF: true})
	if code != ExitOK {
		t.Fatalf("exit %d, lines %v", code, lines)
	}
	if lines[0]["type"] != "start" || last(lines)["type"] != "done" || last(lines)["stopReason"] != "stop" {
		t.Fatalf("lines %v", lines)
	}
}

func TestEnvelopeFailures(t *testing.T) {
	cases := map[string]struct {
		vendor, stdin, kind string
	}{
		"not json":         {"echo", "nope", "invalid_request"},
		"missing request":  {"echo", `{"protocol":1}`, "invalid_request"},
		"newer protocol":   {"echo", `{"protocol":2,"request":{}}`, "unsupported"},
		"unknown vendor":   {"kiro2", hello, "unsupported"},
		"no done":          {"silent", hello, "internal"},
		"bad echo request": {"echo", `{"protocol":1,"request":{"messages":"x"}}`, "invalid_request"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			code, lines := run(t, tc.vendor, strings.NewReader(tc.stdin), Options{IgnoreStdinEOF: true})
			if code != ExitError || errorKind(last(lines)) != tc.kind {
				t.Fatalf("exit %d, lines %v", code, lines)
			}
			if vendor := last(lines)["error"].(map[string]any)["vendor"]; vendor != tc.vendor {
				t.Fatalf("vendor %v", vendor)
			}
		})
	}
}

func TestNothingAfterDone(t *testing.T) {
	code, lines := run(t, "chatty", strings.NewReader(hello), Options{IgnoreStdinEOF: true})
	if code != ExitOK || len(lines) != 1 || lines[0]["type"] != "done" {
		t.Fatalf("exit %d, lines %v", code, lines)
	}
}

func TestVendorErrorBecomesTerminalLine(t *testing.T) {
	in := `{"protocol":1,"request":{"messages":[],"echo":{"error":{"kind":"rate_limit","message":"slow","status":429,"retryAfterMs":20}}}}`
	code, lines := run(t, "echo", strings.NewReader(in), Options{IgnoreStdinEOF: true})
	if code != ExitError || errorKind(last(lines)) != "rate_limit" {
		t.Fatalf("exit %d, lines %v", code, lines)
	}
	if lines[len(lines)-2]["type"] != "text_end" {
		t.Fatalf("partial output before the error was lost: %v", lines)
	}
}

func TestClosingStdinCancels(t *testing.T) {
	reader, writer := io.Pipe()
	go func() {
		_, _ = writer.Write([]byte(`{"protocol":1,"request":{"messages":[],"echo":{"hang":true}}}` + "\n"))
		time.Sleep(50 * time.Millisecond)
		_ = writer.Close()
	}()
	finished := make(chan struct{})
	var code int
	var lines []map[string]any
	go func() {
		code, lines = run(t, "echo", reader, Options{})
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("closing stdin did not cancel the call")
	}
	if code != ExitError || errorKind(last(lines)) != "aborted" {
		t.Fatalf("exit %d, lines %v", code, lines)
	}
}

func TestContextCancellationAborts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	var out bytes.Buffer
	in := strings.NewReader(`{"protocol":1,"request":{"messages":[],"echo":{"hang":true}}}`)
	code := Run(ctx, "echo", testRegistry, Options{IgnoreStdinEOF: true}, in, &out)
	if code != ExitError || !strings.Contains(out.String(), `"kind":"aborted"`) {
		t.Fatalf("exit %d, out %s", code, out.String())
	}
}
