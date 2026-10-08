package bridge

import "encoding/json"

// Event is one BridgeStreamEvent. Block indexes are allocated monotonically
// and never reused, including across an internal retry.
type Event interface {
	EventType() string
}

// Stop reasons a successful turn can end with.
const (
	StopReasonStop    = "stop"
	StopReasonToolUse = "toolUse"
	StopReasonLength  = "length"
)

type typed struct {
	Type string `json:"type"`
}

func (t typed) EventType() string { return t.Type }

type StartEvent struct{ typed }

type ResetEvent struct{ typed }

type TextStartEvent struct {
	typed
	Index int `json:"index"`
}

type TextDeltaEvent struct {
	typed
	Index int    `json:"index"`
	Delta string `json:"delta"`
}

type TextEndEvent struct {
	typed
	Index int    `json:"index"`
	Text  string `json:"text"`
}

type ThinkingStartEvent struct {
	typed
	Index int `json:"index"`
}

type ThinkingDeltaEvent struct {
	typed
	Index int    `json:"index"`
	Delta string `json:"delta"`
}

type ThinkingEndEvent struct {
	typed
	Index     int    `json:"index"`
	Thinking  string `json:"thinking"`
	Signature string `json:"signature,omitempty"`
}

type ToolCallStartEvent struct {
	typed
	Index int    `json:"index"`
	ID    string `json:"id"`
	Name  string `json:"name"`
}

type ToolCallDeltaEvent struct {
	typed
	Index          int    `json:"index"`
	ID             string `json:"id"`
	ArgumentsDelta string `json:"argumentsDelta"`
}

type ToolCallEndEvent struct {
	typed
	Index int    `json:"index"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	// Parsed arguments; always a JSON object.
	Arguments json.RawMessage `json:"arguments"`
	// The raw argument JSON exactly as the model produced it, when kept.
	ArgumentsJSON *string `json:"argumentsJson,omitempty"`
}

type UsageEvent struct {
	typed
	Usage Usage `json:"usage"`
}

type DoneEvent struct {
	typed
	StopReason    string `json:"stopReason"`
	ErrorMessage  string `json:"errorMessage,omitempty"`
	ResponseID    string `json:"responseId,omitempty"`
	UpstreamModel string `json:"upstreamModel,omitempty"`
}

func Start() StartEvent { return StartEvent{typed{"start"}} }
func Reset() ResetEvent { return ResetEvent{typed{"reset"}} }

func TextStart(index int) TextStartEvent { return TextStartEvent{typed{"text_start"}, index} }
func TextDelta(index int, delta string) TextDeltaEvent {
	return TextDeltaEvent{typed{"text_delta"}, index, delta}
}
func TextEnd(index int, text string) TextEndEvent {
	return TextEndEvent{typed{"text_end"}, index, text}
}

func ThinkingStart(index int) ThinkingStartEvent {
	return ThinkingStartEvent{typed{"thinking_start"}, index}
}
func ThinkingDelta(index int, delta string) ThinkingDeltaEvent {
	return ThinkingDeltaEvent{typed{"thinking_delta"}, index, delta}
}
func ThinkingEnd(index int, thinking, signature string) ThinkingEndEvent {
	return ThinkingEndEvent{typed{"thinking_end"}, index, thinking, signature}
}

func ToolCallStart(index int, id, name string) ToolCallStartEvent {
	return ToolCallStartEvent{typed{"tool_call_start"}, index, id, name}
}
func ToolCallDelta(index int, id, delta string) ToolCallDeltaEvent {
	return ToolCallDeltaEvent{typed{"tool_call_delta"}, index, id, delta}
}

// ToolCallEnd closes a tool call. Empty arguments become {}; argumentsJSON is
// the model's raw text when the core kept it (nil otherwise).
func ToolCallEnd(index int, id, name string, arguments json.RawMessage, argumentsJSON *string) ToolCallEndEvent {
	if len(arguments) == 0 {
		arguments = json.RawMessage("{}")
	}
	return ToolCallEndEvent{typed{"tool_call_end"}, index, id, name, arguments, argumentsJSON}
}

func UsageUpdate(usage Usage) UsageEvent { return UsageEvent{typed{"usage"}, usage} }

// Done ends a successful turn. stopReason is one of the StopReason constants.
func Done(stopReason string) DoneEvent {
	return DoneEvent{typed: typed{"done"}, StopReason: stopReason}
}
