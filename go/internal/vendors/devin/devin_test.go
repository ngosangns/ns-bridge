package devin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/pbwire"
)

func TestParseToolCallArguments(t *testing.T) {
	cases := map[string]string{
		"":        `{}`,
		`{"a":1}`: `{"a":1}`,
		`[1]`:     `{"__parseError":"tool arguments must be a JSON object, got array","__rawJson":"[1]"}`,
		`null`:    `{"__parseError":"tool arguments must be a JSON object, got object","__rawJson":"null"}`,
		`{"a":`:   `{"__parseError":"Unexpected end of JSON input","__rawJson":"{\"a\":"}`,
	}
	for in, want := range cases {
		if got := string(parseToolCallArguments(in)); got != want {
			t.Errorf("parseToolCallArguments(%q) = %s, want %s", in, got, want)
		}
	}
	long := `{"x":"` + strings.Repeat("y", 600)
	var parsed map[string]string
	_ = json.Unmarshal(parseToolCallArguments(long), &parsed)
	if !strings.HasSuffix(parsed["__rawJson"], "… [truncated 94 chars]") {
		t.Fatalf("truncation: %q", parsed["__rawJson"][500:])
	}
}

func TestTrailerAndClassification(t *testing.T) {
	tr := readTrailerError(`{"error":{"code":"resource_exhausted","message":"quota","details":[{"type":"a","value":"b"}]}}`)
	if tr == nil || tr.Formatted != "Devin stream error resource_exhausted: quota [details: a: b]" {
		t.Fatalf("trailer: %+v", tr)
	}
	if readTrailerError(`{}`) != nil || readTrailerError(`not json`) != nil {
		t.Fatal("non-error trailers must be nil")
	}
	cases := []struct {
		err  error
		kind bridge.ErrorKind
	}{
		{&StreamError{Code: "resource_exhausted"}, bridge.KindRateLimit},
		{&StreamError{Code: "unavailable"}, bridge.KindCapacity},
		{&StreamError{Code: "invalid_argument", ContextOverflow: true}, bridge.KindContextOverflow},
		{&StreamError{Code: "unauthenticated"}, bridge.KindAuth},
		{&APIError{Status: 529}, bridge.KindCapacity},
		{&APIError{Status: 403}, bridge.KindAuth},
		{&APIError{Status: 400}, bridge.KindVendor},
		{&ProtocolError{Kind: "runtime"}, bridge.KindProtocol},
	}
	for _, c := range cases {
		if got := toBridgeError(c.err).Kind; got != c.kind {
			t.Errorf("%#v: kind %s, want %s", c.err, got, c.kind)
		}
	}
}

func TestDeterministicUUIDAndRedaction(t *testing.T) {
	if got := deterministicUUID("abc"); got != "ba7816bf-8f01-cfea-4141-40de5dae2223" {
		t.Fatalf("uuid %s", got)
	}
	if got := RedactSensitiveCredentials("token: abcdef123 and devin-session-token$zz"); got != "token:[REDACTED] and d[REDACTED]" {
		t.Fatalf("redact %q", got)
	}
}

// A minimal end-to-end turn against a fake Cascade server.
func TestStreamAgainstFakeServer(t *testing.T) {
	jwt := func() []byte { var w pbwire.Writer; w.String(1, "jwt"); return w.Finish() }()
	chat := func() []byte {
		var w pbwire.Writer
		w.String(1, "m1")
		w.String(3, "hello")
		frame := []byte{0, 0, 0, 0, 0}
		body := w.Finish()
		frame[4] = byte(len(body))
		return append(frame, body...)
	}()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "GetUserJwt") {
			_, _ = w.Write(jwt)
			return
		}
		_, _ = w.Write(chat)
	}))
	defer srv.Close()
	req := &StreamRequest{Model: ModelSpec{ID: "m", BaseURL: srv.URL}, Messages: []bridge.Message{{Role: "user", Content: []bridge.ContentBlock{{Type: "text", Text: "hi"}}}}}
	var out bytes.Buffer
	w := bridge.NewWriter(&out)
	if err := Stream(context.Background(), req, func(e bridge.Event) error { return w.Emit(e) }); err != nil {
		t.Fatal(err)
	}
	want := `{"type":"start"}
{"type":"text_start","index":0}
{"type":"text_delta","index":0,"delta":"hello"}
{"type":"text_end","index":0,"text":"hello"}
{"type":"done","stopReason":"stop","responseId":"m1"}
`
	if out.String() != want {
		t.Fatalf("events:\n%s", out.String())
	}
}
