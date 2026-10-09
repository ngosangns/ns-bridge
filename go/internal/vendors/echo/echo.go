// Package echo is a vendor that calls no service: it streams back the last
// user message. It exists to exercise the sidecar protocol end to end — the
// TypeScript sidecar client, both host bridges, abort and error mapping —
// without credentials or network.
package echo

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
)

// Request is a neutral context plus test knobs under "echo".
type Request struct {
	bridge.Context
	Echo Options `json:"echo"`
}

// Options steer what the echo vendor emits.
type Options struct {
	// Text replaces the default reply ("echo: <last user text>").
	Text *string `json:"text,omitempty"`
	// Thinking, when set, streams a thinking block before the text.
	Thinking string `json:"thinking,omitempty"`
	// ThinkingSignature is attached to the thinking block's end event.
	ThinkingSignature string `json:"thinkingSignature,omitempty"`
	// ToolCall, when set, streams a tool call after the text and stops with toolUse.
	ToolCall *ToolCall `json:"toolCall,omitempty"`
	// DelayMs sleeps between events (cancellable).
	DelayMs int `json:"delayMs,omitempty"`
	// Error ends the call with this terminal error after the text block.
	Error *bridge.Error `json:"error,omitempty"`
	// Hang emits start, then blocks until the host cancels.
	Hang bool `json:"hang,omitempty"`
	// ResponseID is reported on the done event.
	ResponseID string `json:"responseId,omitempty"`
	// Login steers `ns-bridge login --vendor echo` (below).
	Login *LoginOptions `json:"login,omitempty"`
}

// LoginOptions steers the echo vendor's interactive login: which host
// notifications to emit and what to answer.
type LoginOptions struct {
	// AuthURL emits a host/authUrl notification with this url/instructions.
	AuthURL      string `json:"authUrl,omitempty"`
	Instructions string `json:"instructions,omitempty"`
	// Progress emits one host/progress notification per entry, in order.
	Progress []string `json:"progress,omitempty"`
	// Result is the login's result (default {"echo":"ok"}).
	Result json.RawMessage `json:"result,omitempty"`
	// Error, when set, fails the login with this terminal error instead.
	Error *bridge.Error `json:"error,omitempty"`
}

// ToolCall describes the tool call to emit.
type ToolCall struct {
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// Vendor implements sidecar.Streamer.
type Vendor struct{}

func (Vendor) Stream(ctx context.Context, raw json.RawMessage, emit func(bridge.Event) error) error {
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		return bridge.Errorf(bridge.KindInvalidRequest, "echo request: %v", err)
	}
	opts := req.Echo
	delay := time.Duration(opts.DelayMs) * time.Millisecond
	send := func(event bridge.Event) error {
		if err := emit(event); err != nil {
			return err
		}
		return sleep(ctx, delay)
	}

	if err := send(bridge.Start()); err != nil {
		return err
	}
	if opts.Hang {
		<-ctx.Done()
		return ctx.Err()
	}

	index := 0
	output := 0
	if opts.Thinking != "" {
		if err := streamBlock(send, index, opts.Thinking, true, opts.ThinkingSignature); err != nil {
			return err
		}
		output += estimateTokens(opts.Thinking)
		index++
	}

	text := "echo: " + lastUserText(req.Messages)
	if opts.Text != nil {
		text = *opts.Text
	}
	if text != "" {
		if err := streamBlock(send, index, text, false, ""); err != nil {
			return err
		}
		output += estimateTokens(text)
		index++
	}

	if opts.Error != nil {
		return opts.Error
	}

	stop := bridge.StopReasonStop
	if call := opts.ToolCall; call != nil {
		id := call.ID
		if id == "" {
			id = "echo-call-1"
		}
		args := call.Arguments
		if len(args) == 0 {
			args = json.RawMessage("{}")
		}
		argsJSON := string(args)
		for _, event := range []bridge.Event{
			bridge.ToolCallStart(index, id, call.Name),
			bridge.ToolCallDelta(index, id, argsJSON),
			bridge.ToolCallEnd(index, id, call.Name, args, &argsJSON),
		} {
			if err := send(event); err != nil {
				return err
			}
		}
		output += estimateTokens(argsJSON)
		stop = bridge.StopReasonToolUse
	}

	input := estimateTokens(req.SystemPrompt)
	for _, message := range req.Messages {
		for _, block := range message.Content {
			input += estimateTokens(block.Text)
		}
	}
	if err := send(bridge.UsageUpdate(bridge.Usage{Input: input, Output: output, TotalTokens: input + output})); err != nil {
		return err
	}
	done := bridge.Done(stop)
	done.ResponseID = opts.ResponseID
	return emit(done)
}

// streamBlock emits start, one delta per word, and end for a text or thinking block.
func streamBlock(send func(bridge.Event) error, index int, text string, thinking bool, signature string) error {
	start := bridge.Event(bridge.TextStart(index))
	if thinking {
		start = bridge.ThinkingStart(index)
	}
	if err := send(start); err != nil {
		return err
	}
	for _, word := range strings.SplitAfter(text, " ") {
		if word == "" {
			continue
		}
		delta := bridge.Event(bridge.TextDelta(index, word))
		if thinking {
			delta = bridge.ThinkingDelta(index, word)
		}
		if err := send(delta); err != nil {
			return err
		}
	}
	end := bridge.Event(bridge.TextEnd(index, text))
	if thinking {
		end = bridge.ThinkingEnd(index, text, signature)
	}
	return send(end)
}

// Login implements sidecar.Loginer: it replays the host notifications and
// result the request asks for, exercising the login wire path end to end.
func (Vendor) Login(ctx context.Context, raw json.RawMessage, host bridge.Host) (any, error) {
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, bridge.Errorf(bridge.KindInvalidRequest, "echo login request: %v", err)
	}
	opts := req.Echo.Login
	if opts == nil {
		opts = &LoginOptions{}
	}
	for _, message := range opts.Progress {
		if err := host.Progress(message); err != nil {
			return nil, err
		}
	}
	if opts.AuthURL != "" {
		if err := host.AuthURL(opts.AuthURL, opts.Instructions); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if opts.Error != nil {
		return nil, opts.Error
	}
	if len(opts.Result) > 0 {
		var out any
		if err := json.Unmarshal(opts.Result, &out); err != nil {
			return nil, bridge.Errorf(bridge.KindInvalidRequest, "echo login result: %v", err)
		}
		return out, nil
	}
	return map[string]any{"echo": "ok"}, nil
}

func lastUserText(messages []bridge.Message) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role != "user" {
			continue
		}
		var parts []string
		for _, block := range messages[i].Content {
			if block.Type == "text" {
				parts = append(parts, block.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// estimateTokens is a deterministic stand-in (~4 characters per token).
func estimateTokens(text string) int {
	return (utf8.RuneCountInString(text) + 3) / 4
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
