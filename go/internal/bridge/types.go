// Package bridge is the Go side of ns-bridge's host-neutral vocabulary.
//
// It mirrors packages/bridge-core/src/types.ts field for field: the JSON a Go
// vendor core writes is exactly the BridgeStreamEvent the TypeScript host
// bridges (ns-bridge-core/pi, ns-bridge-core/dsh) already consume. Change one
// side only together with the other.
package bridge

import "encoding/json"

// Effort is a user-facing reasoning level ("minimal" … "max").
type Effort string

// EffortOrder lists the levels least to most intensive.
var EffortOrder = []Effort{"minimal", "low", "medium", "high", "xhigh", "max"}

// ContentBlock is one block of a message: text, image, thinking or toolCall.
// Fields not used by the block's type stay empty.
type ContentBlock struct {
	Type string `json:"type"`

	// text
	Text string `json:"text,omitempty"`

	// image: base64 bytes without a data-URL prefix
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`

	// thinking
	Thinking          string `json:"thinking,omitempty"`
	ThinkingSignature string `json:"thinkingSignature,omitempty"`

	// toolCall: arguments stay raw so numbers and key order survive the trip
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// Message is a user, assistant or toolResult turn.
type Message struct {
	Role    string         `json:"role"`
	Content []ContentBlock `json:"content"`

	// assistant
	StopReason string `json:"stopReason,omitempty"`
	ResponseID string `json:"responseId,omitempty"`

	// toolResult
	ToolCallID string `json:"toolCallId,omitempty"`
	ToolName   string `json:"toolName,omitempty"`
	IsError    bool   `json:"isError,omitempty"`
}

// Tool is one tool offered to the model, in JSON-schema form.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
	Strict      *bool           `json:"strict,omitempty"`
}

// Context is the neutral request context every vendor core reads.
type Context struct {
	SystemPrompt string    `json:"systemPrompt,omitempty"`
	Messages     []Message `json:"messages"`
	Tools        []Tool    `json:"tools,omitempty"`
}

// Cost is a usage cost breakdown.
type Cost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

// Usage for one response. Counters a vendor does not report stay nil rather
// than zero, so a host can tell "not reported" from "none".
type Usage struct {
	Input          int      `json:"input"`
	Output         int      `json:"output"`
	TotalTokens    int      `json:"totalTokens"`
	CacheRead      *int     `json:"cacheRead,omitempty"`
	CacheWrite     *int     `json:"cacheWrite,omitempty"`
	ContextPercent *float64 `json:"contextPercent,omitempty"`
	Credits        *float64 `json:"credits,omitempty"`
	CreditUnit     string   `json:"creditUnit,omitempty"`
	CacheEstimated *bool    `json:"cacheEstimated,omitempty"`
	Cost           Cost     `json:"cost"`
}
