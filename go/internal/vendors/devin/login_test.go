package devin

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

type fakeHost struct {
	authURLs  []string
	instruct  []string
	progress  []string
	onAuthURL func()
	authURLCh chan string
}

func newFakeHost() *fakeHost { return &fakeHost{authURLCh: make(chan string, 1)} }

func (h *fakeHost) AuthURL(u, instructions string) error {
	h.authURLs = append(h.authURLs, u)
	h.instruct = append(h.instruct, instructions)
	select {
	case h.authURLCh <- u:
	default:
	}
	if h.onAuthURL != nil {
		h.onAuthURL()
	}
	return nil
}

func (h *fakeHost) Progress(message string) error {
	h.progress = append(h.progress, message)
	return nil
}

// freeAddr hands back 127.0.0.1:<port> on a port the kernel just released —
// good enough for tests on a quiet machine.
func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	defer l.Close()
	return l.Addr().String()
}

func withLoginVars(t *testing.T, webapp, management, addr string) {
	t.Helper()
	oldW, oldM, oldA := loginWebappURL, loginManagementURL, loginListenAddr
	loginWebappURL, loginManagementURL, loginListenAddr = webapp, management, addr
	t.Cleanup(func() { loginWebappURL, loginManagementURL, loginListenAddr = oldW, oldM, oldA })
}

func TestLoginPKCEHappyPath(t *testing.T) {
	token := "tok.payload.sig"
	exchange := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != loginTokenPath {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("exchange body: %v", err)
		}
		if body["code"] != "the-code" || body["code_verifier"] == "" {
			t.Errorf("exchange body missing code/verifier: %v", body)
		}
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"token":%q}`, token)
	}))
	defer exchange.Close()

	addr := freeAddr(t)
	withLoginVars(t, "https://webapp.test", exchange.URL, addr)

	host := newFakeHost()
	go func() {
		raw := <-host.authURLCh
		u, err := url.Parse(raw)
		if err != nil {
			return
		}
		q := u.Query()
		if q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
			return
		}
		resp, err := http.Get("http://" + addr + loginCallbackPath + "?code=the-code&state=" + q.Get("state"))
		if err == nil {
			resp.Body.Close()
		}
	}()

	result, err := Vendor{}.Login(context.Background(), json.RawMessage(`{"timeoutMs":5000}`), host)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(jsjson.Stringify(result)), &out); err != nil {
		t.Fatalf("result json: %v", err)
	}
	if out["access"] != token || out["refresh"] != token || out["authMethod"] != "oauth" {
		t.Fatalf("credentials: %v", out)
	}
	if exp, _ := out["expires"].(float64); exp <= float64(time.Now().UnixMilli()) {
		t.Fatalf("expires: %v", out["expires"])
	}
	if len(host.authURLs) != 1 || !strings.HasPrefix(host.authURLs[0], "https://webapp.test/auth/cli/continue?") {
		t.Fatalf("auth url: %v", host.authURLs)
	}
	if len(host.instruct) != 1 || host.instruct[0] != "Sign in to Devin in your browser." {
		t.Fatalf("instructions: %v", host.instruct)
	}
	if len(host.progress) != 1 || host.progress[0] != "Exchanging authorization code..." {
		t.Fatalf("progress: %v", host.progress)
	}
}

func TestLoginCallbackRejectsBadState(t *testing.T) {
	addr := freeAddr(t)
	withLoginVars(t, "https://webapp.test", "http://unused", addr)
	host := newFakeHost()
	go func() {
		<-host.authURLCh
		resp, err := http.Get("http://" + addr + loginCallbackPath + "?code=x&state=wrong")
		if err == nil {
			resp.Body.Close()
		}
	}()
	_, err := Vendor{}.Login(context.Background(), json.RawMessage(`{"timeoutMs":5000}`), host)
	be, ok := err.(*bridge.Error)
	if !ok || be.Kind != bridge.KindAuth {
		t.Fatalf("want auth error, got %v", err)
	}
	if !strings.Contains(be.Message, "mismatched state/code") {
		t.Fatalf("message: %v", be.Message)
	}
}

func TestLoginTimesOut(t *testing.T) {
	addr := freeAddr(t)
	withLoginVars(t, "https://webapp.test", "http://unused", addr)
	host := newFakeHost()
	_, err := Vendor{}.Login(context.Background(), json.RawMessage(`{"timeoutMs":50}`), host)
	be, ok := err.(*bridge.Error)
	if !ok || be.Kind != bridge.KindTimeout {
		t.Fatalf("want timeout, got %v", err)
	}
}
