package sidecar

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

// runLoginInteractive pipes the request envelope, answers host requests the
// binary emits on stdout, and returns the exit code and every line the binary
// wrote.
func runLoginInteractive(t *testing.T, vendor, request string, answer func(msg map[string]any) (string, bool)) (int, []map[string]any) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	go func() {
		_, _ = inW.Write([]byte(request + "\n"))
	}()
	codeCh := make(chan int, 1)
	go func() { codeCh <- RunLogin(context.Background(), vendor, testRegistry, inR, outW) }()

	var lines []map[string]any
	scanner := bufio.NewScanner(outR)
	for scanner.Scan() {
		var msg map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			t.Fatalf("line is not JSON: %q", scanner.Text())
		}
		lines = append(lines, msg)
		if msg["type"] == "result" || msg["type"] == "error" {
			break
		}
		if method, ok := msg["method"].(string); ok && msg["id"] != nil {
			response, reply := answer(msg)
			if !reply {
				t.Fatalf("no scripted answer for host call %s", method)
			}
			if _, err := fmt.Fprintf(inW, "%s\n", response); err != nil {
				t.Fatalf("write host reply: %v", err)
			}
		}
	}
	select {
	case code := <-codeCh:
		return code, lines
	case <-time.After(10 * time.Second):
		t.Fatal("login did not finish")
		return 0, nil
	}
}

func TestLoginPromptRoundTrip(t *testing.T) {
	code, lines := runLoginInteractive(t, "echo",
		`{"protocol":1,"request":{"echo":{"login":{"prompt":"API key?"}}}}`,
		func(msg map[string]any) (string, bool) {
			if msg["method"] != "host/prompt" {
				return "", false
			}
			if params := msg["params"].(map[string]any); params["message"] != "API key?" {
				t.Fatalf("prompt params %v", params)
			}
			return fmt.Sprintf(`{"jsonrpc":"2.0","id":%v,"result":"ksk_test"}`, msg["id"]), true
		})
	if code != ExitOK {
		t.Fatalf("exit %d, lines %v", code, lines)
	}
	result := last(lines)["result"].(map[string]any)
	if result["prompt"] != "ksk_test" {
		t.Fatalf("prompt answer did not reach the result: %v", result)
	}
}

func TestLoginPromptRefused(t *testing.T) {
	code, lines := runLoginInteractive(t, "echo",
		`{"protocol":1,"request":{"echo":{"login":{"prompt":"API key?"}}}}`,
		func(msg map[string]any) (string, bool) {
			return fmt.Sprintf(`{"jsonrpc":"2.0","id":%v,"error":{"code":-32603,"message":"no prompt support"}}`, msg["id"]), true
		})
	if code != ExitError || errorKind(last(lines)) != "internal" {
		t.Fatalf("exit %d, lines %v", code, lines)
	}
	if msg := last(lines)["error"].(map[string]any)["message"]; !strings.Contains(msg.(string), "no prompt support") {
		t.Fatalf("refusal message lost: %v", msg)
	}
}
