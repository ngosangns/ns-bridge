package kiro

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestEventStreamRoundTrip(t *testing.T) {
	frame := encodeESMessage([][2]string{{":message-type", "event"}, {":event-type", "assistantResponseEvent"}}, []byte(`{"content":"hi"}`))
	r := bytes.NewReader(append(append([]byte{}, frame...), frame...))
	for i := 0; i < 2; i++ {
		m, err := readESMessage(r)
		if err != nil {
			t.Fatalf("message %d: %v", i, err)
		}
		if v, _ := m.header(":event-type"); v != "assistantResponseEvent" {
			t.Fatalf("event type %q", v)
		}
		if string(m.body) != `{"content":"hi"}` {
			t.Fatalf("body %q", m.body)
		}
	}
	if _, err := readESMessage(r); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestEventStreamRejectsCorruptFrames(t *testing.T) {
	frame := encodeESMessage([][2]string{{":message-type", "event"}}, []byte(`{}`))
	frame[len(frame)-1] ^= 0xff
	if _, err := readESMessage(bytes.NewReader(frame)); err == nil {
		t.Fatal("corrupt message CRC accepted")
	}
	short := encodeESMessage(nil, []byte(`{"a":1}`))
	if _, err := readESMessage(bytes.NewReader(short[:len(short)-3])); err == nil {
		t.Fatal("truncated message accepted")
	}
}

func TestExtractReasonCode(t *testing.T) {
	cases := map[string]string{
		`{"message":"x","reason":"REQUEST_BODY_INVALID"}`: "REQUEST_BODY_INVALID",
		`plain INSUFFICIENT_MODEL_CAPACITY text`:          "INSUFFICIENT_MODEL_CAPACITY",
		`nothing here`:                                    "",
	}
	for in, want := range cases {
		if got := extractReasonCode(in); got != want {
			t.Errorf("extractReasonCode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBracketToolCalls(t *testing.T) {
	calls, rest := parseBracketToolCalls(`Sure. [Called read_file with args: {"path":"/a"}] done`)
	if len(calls) != 1 || calls[0].name != "read_file" {
		t.Fatalf("calls = %+v", calls)
	}
	if strings.Contains(rest, "Called") {
		t.Fatalf("rest still holds the call: %q", rest)
	}
}

func TestToBridgeErrorKinds(t *testing.T) {
	e := toBridgeError(&APIError{Message: "Kiro API error: 429", Status: 429, ReasonCode: "MONTHLY_REQUEST_COUNT"})
	if e.VendorError != "KiroApiError" || e.Status != 429 {
		t.Fatalf("got %+v", e)
	}
}
