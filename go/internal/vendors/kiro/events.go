package kiro

import (
	"math"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

// wireUsage is KiroWireUsage; nil fields were absent.
type wireUsage struct {
	InputTokens            *float64
	OutputTokens           *float64
	TotalTokens            *float64
	CacheReadInputTokens   *float64
	CacheWriteInputTokens  *float64
	ContextUsagePercentage *float64
	NormalizedTokenUsage   *float64
	RawStopReason          *string
	StopDetails            *jsjson.Object
}

func (u *wireUsage) merge(o *wireUsage) {
	if o.InputTokens != nil {
		u.InputTokens = o.InputTokens
	}
	if o.OutputTokens != nil {
		u.OutputTokens = o.OutputTokens
	}
	if o.TotalTokens != nil {
		u.TotalTokens = o.TotalTokens
	}
	if o.CacheReadInputTokens != nil {
		u.CacheReadInputTokens = o.CacheReadInputTokens
	}
	if o.CacheWriteInputTokens != nil {
		u.CacheWriteInputTokens = o.CacheWriteInputTokens
	}
	if o.ContextUsagePercentage != nil {
		u.ContextUsagePercentage = o.ContextUsagePercentage
	}
	if o.NormalizedTokenUsage != nil {
		u.NormalizedTokenUsage = o.NormalizedTokenUsage
	}
	if o.RawStopReason != nil {
		u.RawStopReason = o.RawStopReason
	}
	if o.StopDetails != nil {
		u.StopDetails = o.StopDetails
	}
}

type metering struct {
	Credits    *float64
	Unit       *string
	UnitPlural *string
}

// errorData is KiroErrorData.
type errorData struct {
	Error                  string
	Message                *string
	Kind                   string
	Reason                 *string
	RetryAfterMilliseconds *float64
}

func (e *errorData) text() string {
	if e.Message != nil && *e.Message != "" {
		return e.Error + ": " + *e.Message
	}
	return e.Error
}

// wireEvent is KiroWireEvent.
type wireEvent struct {
	Type string
	// content, thinkingText, thinkingSignature, followupPrompt
	Str string
	// toolUse / toolUseInput / toolUseStop
	Name, ToolUseID, Input string
	Stop                   *bool
	// contextUsage
	Pct float64
	// usage, metering, error, ignored
	Usage    *wireUsage
	Metering *metering
	Err      *errorData
	Key      string
}

type errorMember struct{ kind, exception string }

var errorMembers = map[string]errorMember{
	"error":                       {"internalServer", "InternalServerException"},
	"throttlingError":             {"throttling", "ThrottlingException"},
	"validationError":             {"validation", "ValidationException"},
	"serviceUnavailableError":     {"serviceUnavailable", "ServiceUnavailableException"},
	"InternalServerException":     {"internalServer", "InternalServerException"},
	"ThrottlingException":         {"throttling", "ThrottlingException"},
	"ValidationException":         {"validation", "ValidationException"},
	"ServiceUnavailableException": {"serviceUnavailable", "ServiceUnavailableException"},
}

func get(o *jsjson.Object, key string) jsjson.Value {
	if o == nil {
		return nil
	}
	v, _ := o.Get(key)
	return v
}

func has(o *jsjson.Object, key string) bool { return o != nil && o.Has(key) }

func num(v jsjson.Value) *float64 {
	if f, ok := v.(float64); ok {
		return &f
	}
	return nil
}

func strp(v jsjson.Value) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func tokenCount(v jsjson.Value) *float64 {
	if f, ok := v.(float64); ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= 0 {
		return &f
	}
	return nil
}

func firstTokenCount(o *jsjson.Object, keys ...string) *float64 {
	for _, k := range keys {
		if c := tokenCount(get(o, k)); c != nil {
			return c
		}
	}
	return nil
}

// jsTruthy is JavaScript truthiness for a JSON value.
func jsTruthy(v jsjson.Value) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0 && !math.IsNaN(t)
	default:
		return true
	}
}

func toolInput(raw jsjson.Value) string {
	switch t := raw.(type) {
	case string:
		return t
	case *jsjson.Object:
		if t.Len() > 0 {
			return jsjson.Stringify(t)
		}
	case []jsjson.Value:
		if len(t) > 0 {
			return jsjson.Stringify(t)
		}
	}
	return ""
}

// asBool is `parsed.stop as boolean` truthiness as the assembler reads it.
func asBool(v jsjson.Value) *bool {
	if v == nil {
		return nil
	}
	b := jsTruthy(v)
	return &b
}

func parseToolUse(p *jsjson.Object) *wireEvent {
	if jsTruthy(get(p, "name")) && jsTruthy(get(p, "toolUseId")) {
		name, _ := get(p, "name").(string)
		id, _ := get(p, "toolUseId").(string)
		ev := &wireEvent{Type: "toolUse", Name: name, ToolUseID: id, Input: toolInput(get(p, "input"))}
		if has(p, "stop") {
			ev.Stop = asBool(get(p, "stop"))
		}
		return ev
	}
	if has(p, "input") {
		return &wireEvent{Type: "toolUseInput", Input: toolInput(get(p, "input"))}
	}
	if has(p, "stop") {
		return &wireEvent{Type: "toolUseStop", Stop: asBool(get(p, "stop"))}
	}
	return nil
}

func parseMetadata(p *jsjson.Object) *wireEvent {
	tu, _ := get(p, "tokenUsage").(*jsjson.Object)
	u := &wireUsage{
		OutputTokens:           tokenCount(get(tu, "outputTokens")),
		TotalTokens:            tokenCount(get(tu, "totalTokens")),
		CacheReadInputTokens:   firstTokenCount(tu, "cacheReadInputTokens", "cache_read_input_tokens", "cacheReadTokens"),
		CacheWriteInputTokens:  firstTokenCount(tu, "cacheWriteInputTokens", "cache_creation_input_tokens", "cacheCreationInputTokens", "cacheWriteTokens"),
		ContextUsagePercentage: num(get(tu, "contextUsagePercentage")),
		NormalizedTokenUsage:   num(get(tu, "normalizedTokenUsage")),
		RawStopReason:          strp(get(p, "stopReason")),
	}
	u.InputTokens = tokenCount(get(tu, "uncachedInputTokens"))
	if u.InputTokens == nil {
		u.InputTokens = tokenCount(get(tu, "inputTokens"))
	}
	if sd, ok := get(p, "stopDetails").(*jsjson.Object); ok {
		u.StopDetails = sd
	}
	if u.InputTokens == nil && u.OutputTokens == nil && u.TotalTokens == nil && u.CacheReadInputTokens == nil &&
		u.CacheWriteInputTokens == nil && u.ContextUsagePercentage == nil && u.NormalizedTokenUsage == nil &&
		u.RawStopReason == nil && u.StopDetails == nil {
		return nil
	}
	return &wireEvent{Type: "usage", Usage: u}
}

func parseError(p *jsjson.Object, kind, fallback string) *wireEvent {
	// rawError = parsed.error ?? parsed.Error (JSON null is nullish too)
	raw, defined := get(p, "error"), has(p, "error")
	if raw == nil {
		raw, defined = get(p, "Error"), has(p, "Error")
	}
	var name string
	switch t := raw.(type) {
	case string:
		name = t
	default:
		if defined {
			name = jsjson.Stringify(t)
		} else if s, ok := get(p, "name").(string); ok {
			name = s
		} else {
			name = fallback
		}
	}
	data := &errorData{Error: name, Kind: kind}
	msg := get(p, "message")
	if msg == nil {
		msg = get(p, "Message")
	}
	if msg == nil {
		msg = get(p, "reason")
	}
	if s, ok := msg.(string); ok {
		data.Message = &s
	}
	data.Reason = strp(get(p, "reason"))
	data.RetryAfterMilliseconds = num(get(p, "retryAfterMilliseconds"))
	return &wireEvent{Type: "error", Err: data}
}

func parseMetering(p *jsjson.Object) *wireEvent {
	return &wireEvent{Type: "metering", Metering: &metering{Credits: tokenCount(get(p, "usage")), Unit: strp(get(p, "unit")), UnitPlural: strp(get(p, "unitPlural"))}}
}

// parseEvent is parseKiroEvent.
func parseEvent(key string, p *jsjson.Object) *wireEvent {
	switch key {
	case "assistantResponseEvent":
		if s := strp(get(p, "content")); s != nil {
			return &wireEvent{Type: "content", Str: *s}
		}
		return nil
	case "reasoningContentEvent":
		if s := strp(get(p, "text")); s != nil {
			return &wireEvent{Type: "thinkingText", Str: *s}
		}
		if s := strp(get(p, "signature")); s != nil {
			return &wireEvent{Type: "thinkingSignature", Str: *s}
		}
		return &wireEvent{Type: "ignored", Key: key}
	case "toolUseEvent":
		return parseToolUse(p)
	case "contextUsageEvent":
		if f := num(get(p, "contextUsagePercentage")); f != nil {
			return &wireEvent{Type: "contextUsage", Pct: *f}
		}
		return nil
	case "metadataEvent":
		return parseMetadata(p)
	case "meteringEvent":
		return parseMetering(p)
	case "codeReferenceEvent", "documentCitationEvent", "toolResultEvent":
		return &wireEvent{Type: "ignored", Key: key}
	}
	if m, ok := errorMembers[key]; ok {
		return parseError(p, m.kind, m.exception)
	}
	return parseEventByShape(p)
}

func parseExceptionFrame(key string, p *jsjson.Object) *errorData {
	m, ok := errorMembers[key]
	if !ok {
		return nil
	}
	return parseError(p, m.kind, m.exception).Err
}

// parseEventByShape is parseKiroEventByShape.
func parseEventByShape(p *jsjson.Object) *wireEvent {
	if has(p, "content") {
		s, _ := get(p, "content").(string)
		return &wireEvent{Type: "content", Str: s}
	}
	if s := strp(get(p, "text")); s != nil {
		return &wireEvent{Type: "thinkingText", Str: *s}
	}
	if s := strp(get(p, "signature")); s != nil {
		return &wireEvent{Type: "thinkingSignature", Str: *s}
	}
	if jsTruthy(get(p, "name")) && jsTruthy(get(p, "toolUseId")) {
		return parseToolUse(p)
	}
	if has(p, "input") && !jsTruthy(get(p, "name")) {
		return &wireEvent{Type: "toolUseInput", Input: toolInput(get(p, "input"))}
	}
	if has(p, "stop") && !has(p, "contextUsagePercentage") {
		return &wireEvent{Type: "toolUseStop", Stop: asBool(get(p, "stop"))}
	}
	if has(p, "contextUsagePercentage") {
		f, _ := get(p, "contextUsagePercentage").(float64)
		return &wireEvent{Type: "contextUsage", Pct: f}
	}
	if has(p, "followupPrompt") {
		s, _ := get(p, "followupPrompt").(string)
		return &wireEvent{Type: "followupPrompt", Str: s}
	}
	if has(p, "tokenUsage") || has(p, "stopReason") || has(p, "stopDetails") {
		return parseMetadata(p)
	}
	if has(p, "error") || has(p, "Error") {
		return parseError(p, "unknown", "unknown")
	}
	if _, ok := get(p, "usage").(float64); ok {
		return parseMetering(p)
	}
	return nil
}
