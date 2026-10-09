package kiro

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

type loginHost struct{ progress []string }

func (h *loginHost) AuthURL(string, string) error { return nil }
func (h *loginHost) Progress(m string) error {
	h.progress = append(h.progress, m)
	return nil
}

func withManagementBase(t *testing.T, base string) {
	t.Helper()
	t.Setenv("KIRO_MANAGEMENT_ENDPOINT", base+"/{region}")
}

func TestLoginAPIKeyValidates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Amz-Target") != getProfileTarget {
			t.Errorf("target %q", r.Header.Get("X-Amz-Target"))
		}
		if r.Header.Get("Authorization") != "Bearer ksk_good" {
			t.Errorf("auth %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"profile":{"arn":"arn:aws:profile/abc"}}`))
	}))
	defer server.Close()
	withManagementBase(t, server.URL)

	host := &loginHost{}
	result, err := Vendor{}.Login(context.Background(), json.RawMessage(`{"apiKey":"ksk_good"}`), host)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(jsjson.Stringify(result)), &out); err != nil {
		t.Fatalf("result: %v", err)
	}
	if out["access"] != "ksk_good" || out["refresh"] != "ksk_good|apikey" || out["authMethod"] != "apikey" {
		t.Fatalf("credentials: %v", out)
	}
	if out["profileArn"] != "arn:aws:profile/abc" || out["region"] != "us-east-1" {
		t.Fatalf("credentials: %v", out)
	}
	if len(host.progress) != 1 || host.progress[0] != "Validating API key..." {
		t.Fatalf("progress: %v", host.progress)
	}
}

func TestLoginAPIKeyRejectsBadShape(t *testing.T) {
	_, err := Vendor{}.Login(context.Background(), json.RawMessage(`{"apiKey":"nope"}`), &loginHost{})
	be, ok := err.(*bridge.Error)
	if !ok || be.Kind != bridge.KindInvalidRequest {
		t.Fatalf("want invalid_request, got %v", err)
	}
}

func TestLoginAPIKeyRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	withManagementBase(t, server.URL)
	_, err := Vendor{}.Login(context.Background(), json.RawMessage(`{"apiKey":"ksk_bad"}`), &loginHost{})
	be, ok := err.(*bridge.Error)
	if !ok || be.Kind != bridge.KindAuth || !strings.Contains(be.Message, "rejected by Kiro") {
		t.Fatalf("want auth rejection, got %v", err)
	}
}
