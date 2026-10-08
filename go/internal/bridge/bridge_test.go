package bridge

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func encode(t *testing.T, events ...Event) []string {
	t.Helper()
	var out bytes.Buffer
	w := NewWriter(&out)
	for _, event := range events {
		if err := w.Emit(event); err != nil {
			t.Fatal(err)
		}
	}
	return strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
}

func TestEventsMatchTheTypeScriptVocabulary(t *testing.T) {
	raw := `{"path":"a.ts","n":1e3}`
	lines := encode(t,
		Start(),
		TextStart(0),
		TextDelta(0, "<b>&"),
		TextEnd(0, "<b>&"),
		ThinkingEnd(1, "hm", ""),
		ToolCallEnd(2, "c1", "read", json.RawMessage(raw), &raw),
		ToolCallEnd(3, "c2", "ls", nil, nil),
		Reset(),
		Done(StopReasonToolUse),
	)
	want := []string{
		`{"type":"start"}`,
		`{"type":"text_start","index":0}`,
		`{"type":"text_delta","index":0,"delta":"<b>&"}`,
		`{"type":"text_end","index":0,"text":"<b>&"}`,
		`{"type":"thinking_end","index":1,"thinking":"hm"}`,
		`{"type":"tool_call_end","index":2,"id":"c1","name":"read","arguments":{"path":"a.ts","n":1e3},"argumentsJson":"{\"path\":\"a.ts\",\"n\":1e3}"}`,
		`{"type":"tool_call_end","index":3,"id":"c2","name":"ls","arguments":{}}`,
		`{"type":"reset"}`,
		`{"type":"done","stopReason":"toolUse"}`,
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

func TestUsageKeepsUnreportedCountersAbsent(t *testing.T) {
	zero := 0
	lines := encode(t,
		UsageUpdate(Usage{Input: 1, Output: 2, TotalTokens: 3}),
		UsageUpdate(Usage{Input: 1, Output: 2, TotalTokens: 3, CacheRead: &zero}),
	)
	usage := func(line string) map[string]any {
		var event struct {
			Usage map[string]any `json:"usage"`
		}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		return event.Usage
	}
	if _, present := usage(lines[0])["cacheRead"]; present {
		t.Fatalf("unreported cacheRead serialized: %s", lines[0])
	}
	if value, present := usage(lines[1])["cacheRead"]; !present || value != float64(0) {
		t.Fatalf("reported zero cacheRead dropped: %s", lines[1])
	}
}

func TestTerminalErrorLine(t *testing.T) {
	var out bytes.Buffer
	w := NewWriter(&out)
	if err := w.Fail(&Error{Kind: KindRateLimit, Message: "slow down", Vendor: "kiro", Status: 429, RetryAfterMs: ptr(int64(1500))}); err != nil {
		t.Fatal(err)
	}
	want := `{"type":"error","error":{"kind":"rate_limit","message":"slow down","vendor":"kiro","status":429,"retryAfterMs":1500}}` + "\n"
	if out.String() != want {
		t.Fatalf("got %s want %s", out.String(), want)
	}
}

func TestContextDecodesBridgeMessages(t *testing.T) {
	in := `{"systemPrompt":"sys","messages":[
	  {"role":"user","content":[{"type":"text","text":"hi"},{"type":"image","data":"AA==","mimeType":"image/png"}]},
	  {"role":"assistant","content":[{"type":"toolCall","id":"c","name":"t","arguments":{"b":1,"a":2}}],"stopReason":"toolUse"},
	  {"role":"toolResult","toolCallId":"c","toolName":"t","content":[{"type":"text","text":"ok"}],"isError":false}
	],"tools":[{"name":"t","description":"d","parameters":{"type":"object"}}]}`
	var ctx Context
	if err := json.Unmarshal([]byte(in), &ctx); err != nil {
		t.Fatal(err)
	}
	if ctx.SystemPrompt != "sys" || len(ctx.Messages) != 3 || len(ctx.Tools) != 1 {
		t.Fatalf("decoded %+v", ctx)
	}
	if got := string(ctx.Messages[1].Content[0].Arguments); got != `{"b":1,"a":2}` {
		t.Fatalf("tool call arguments reordered or reformatted: %s", got)
	}
	if ctx.Messages[2].ToolCallID != "c" || ctx.Messages[0].Content[1].MimeType != "image/png" {
		t.Fatalf("decoded %+v", ctx.Messages)
	}
}

func ptr[T any](v T) *T { return &v }
