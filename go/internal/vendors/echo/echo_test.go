package echo

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
)

func collect(t *testing.T, request string) ([]string, error) {
	t.Helper()
	var types []string
	err := Vendor{}.Stream(context.Background(), json.RawMessage(request), func(event bridge.Event) error {
		types = append(types, event.EventType())
		return nil
	})
	return types, err
}

func TestThinkingTextAndToolCall(t *testing.T) {
	types, err := collect(t, `{"messages":[{"role":"user","content":[{"type":"text","text":"a b"}]}],
		"echo":{"thinking":"hm","toolCall":{"name":"read","arguments":{"p":1}}}}`)
	if err != nil {
		t.Fatal(err)
	}
	want := "start thinking_start thinking_delta thinking_end text_start text_delta text_delta text_delta text_end " +
		"tool_call_start tool_call_delta tool_call_end usage done"
	if got := strings.Join(types, " "); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestEchoesTheLastUserMessage(t *testing.T) {
	var text string
	err := Vendor{}.Stream(context.Background(), json.RawMessage(`{"messages":[
		{"role":"user","content":[{"type":"text","text":"first"}]},
		{"role":"assistant","content":[{"type":"text","text":"x"}]},
		{"role":"user","content":[{"type":"text","text":"second"}]}]}`),
		func(event bridge.Event) error {
			if end, ok := event.(bridge.TextEndEvent); ok {
				text = end.Text
			}
			return nil
		})
	if err != nil || text != "echo: second" {
		t.Fatalf("text %q err %v", text, err)
	}
}

func TestErrorOptionIsReturnedAsBridgeError(t *testing.T) {
	_, err := collect(t, `{"messages":[],"echo":{"error":{"kind":"auth","message":"no session"}}}`)
	bridgeErr, ok := err.(*bridge.Error)
	if !ok || bridgeErr.Kind != bridge.KindAuth {
		t.Fatalf("err %v", err)
	}
}
