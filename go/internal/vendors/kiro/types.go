package kiro

import "encoding/json"

// Cost is the model's per-million-token price.
type Cost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// Model is the KiroModel a host passes; the TS facade has already resolved
// kiroModelId and firstTokenTimeout.
type Model struct {
	ID                                 string            `json:"id"`
	KiroModelID                        string            `json:"kiroModelId"`
	Name                               string            `json:"name"`
	Reasoning                          bool              `json:"reasoning"`
	Efforts                            []string          `json:"efforts"`
	EffortMap                          map[string]string `json:"effortMap"`
	AdditionalModelRequestFieldsSchema json.RawMessage   `json:"additionalModelRequestFieldsSchema"`
	Input                              []string          `json:"input"`
	Cost                               Cost              `json:"cost"`
	ContextWindow                      float64           `json:"contextWindow"`
	MaxTokens                          float64           `json:"maxTokens"`
	Region                             string            `json:"region"`
	ProfileArn                         string            `json:"profileArn"`
	FirstTokenTimeout                  float64           `json:"firstTokenTimeout"`
	RecoverTextToolCalls               *bool             `json:"recoverTextToolCalls"`
}

func (m *Model) acceptsImages() bool {
	for _, in := range m.Input {
		if in == "image" {
			return true
		}
	}
	return false
}

// Content is one message block (text, image, thinking or toolCall).
type Content struct {
	Type              string          `json:"type"`
	Text              string          `json:"text"`
	Data              string          `json:"data"`
	MimeType          string          `json:"mimeType"`
	Thinking          string          `json:"thinking"`
	ThinkingSignature string          `json:"thinkingSignature"`
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	Arguments         json.RawMessage `json:"arguments"`
}

// Message is a KiroMessage (user, assistant or toolResult).
type Message struct {
	Role       string    `json:"role"`
	Content    []Content `json:"content"`
	StopReason string    `json:"stopReason"`
	ToolCallID string    `json:"toolCallId"`
	ToolName   string    `json:"toolName"`
	IsError    bool      `json:"isError"`
}

// Tool is a KiroTool.
type Tool struct {
	Name        string          `json:"name"`
	Description json.RawMessage `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// UsageTracking is KiroUsageTracking (already resolved by the host).
type UsageTracking struct {
	EstimateDollarValue   bool    `json:"estimateDollarValue"`
	USDPerCredit          float64 `json:"usdPerCredit"`
	EstimateCacheUsage    bool    `json:"estimateCacheUsage"`
	EstimatedCacheTimeout float64 `json:"estimatedCacheTimeout"`
}

// Timeouts override the stream deadlines (the TS core's mutable retryConfig).
type Timeouts struct {
	FirstTokenMs    float64 `json:"firstTokenMs"`
	RequestHeaderMs float64 `json:"requestHeaderMs"`
	IdleMs          float64 `json:"idleMs"`
}

// CapacityRetry is the INSUFFICIENT_MODEL_CAPACITY backoff (capacityRetryConfig).
type CapacityRetry struct {
	MaxRetries  int     `json:"maxRetries"`
	BaseDelayMs float64 `json:"baseDelayMs"`
}

// StreamRequest is KiroStreamRequest plus the per-process state the TS
// facade carries between calls (a sidecar process lives for one turn).
type StreamRequest struct {
	Model                   Model          `json:"model"`
	Messages                []Message      `json:"messages"`
	SystemPrompt            string         `json:"systemPrompt"`
	Tools                   []Tool         `json:"tools"`
	Effort                  string         `json:"effort"`
	AccessToken             string         `json:"accessToken"`
	SessionID               string         `json:"sessionId"`
	ProfileArn              string         `json:"profileArn"`
	CanDiscardEmittedBlocks bool           `json:"canDiscardEmittedBlocks"`
	UsageTracking           *UsageTracking `json:"usageTracking"`

	// The conversation id (sessionId, or one the facade minted).
	ConversationID string `json:"conversationId"`
	// Profile ARNs the facade's in-memory cache holds, by profileCacheKey.
	ProfileArnCache map[string]string `json:"profileArnCache"`
	Timeouts        *Timeouts         `json:"timeouts"`
	CapacityRetry   *CapacityRetry    `json:"capacityRetry"`
	// Set by tests that skip management lookups (resetProfileArnCache(true)).
	TestProfileArn string `json:"testProfileArn"`
}
