package devin

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

// Cost is a per-million-token rate card.
type Cost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// ModelSpec is DevinModelSpec: one catalog entry as the core needs it.
type ModelSpec struct {
	ID                        string            `json:"id"`
	Name                      string            `json:"name"`
	RequestModelID            string            `json:"requestModelId,omitempty"`
	Reasoning                 bool              `json:"reasoning"`
	Efforts                   []string          `json:"efforts,omitempty"`
	EffortMap                 map[string]string `json:"effortMap,omitempty"`
	Input                     []string          `json:"input"`
	Cost                      Cost              `json:"cost"`
	ContextWindow             int               `json:"contextWindow"`
	MaxTokens                 *int              `json:"maxTokens,omitempty"`
	IsModelRouter             bool              `json:"isModelRouter,omitempty"`
	SupportsTools             *bool             `json:"supportsTools,omitempty"`
	SupportsParallelToolCalls *bool             `json:"supportsParallelToolCalls,omitempty"`
	BaseURL                   string            `json:"baseUrl,omitempty"`
}

// CapacityRetry is DevinCapacityRetryPolicy.
type CapacityRetry struct {
	MaxRetries  int   `json:"maxRetries"`
	BaseDelayMs int64 `json:"baseDelayMs"`
	MaxDelayMs  int64 `json:"maxDelayMs"`
}

// StreamRequest is DevinStreamRequest as the sidecar receives it.
type StreamRequest struct {
	Model          ModelSpec        `json:"model"`
	Messages       []bridge.Message `json:"messages"`
	SystemPrompt   json.RawMessage  `json:"systemPrompt,omitempty"`
	Tools          []bridge.Tool    `json:"tools,omitempty"`
	Effort         string           `json:"effort,omitempty"`
	APIKey         string           `json:"apiKey,omitempty"`
	ConversationID *string          `json:"conversationId,omitempty"`
	SessionID      *string          `json:"sessionId,omitempty"`
	MaxTokens      *int             `json:"maxTokens,omitempty"`
	Temperature    *float64         `json:"temperature,omitempty"`
	TopP           *float64         `json:"topP,omitempty"`
	StopSequences  []string         `json:"stopSequences,omitempty"`
	ChatModelUID   string           `json:"chatModelUid,omitempty"`
	// CapacityRetry, when set, retries capacity errors before any content
	// streamed (streamDevinWithCapacityRetry).
	CapacityRetry *CapacityRetry `json:"capacityRetry,omitempty"`
}

// systemPrompts reads systemPrompt as a string or a list of strings.
func (r *StreamRequest) systemPrompts() []string {
	if len(r.SystemPrompt) == 0 {
		return nil
	}
	var one string
	if json.Unmarshal(r.SystemPrompt, &one) == nil {
		return []string{one}
	}
	var many []string
	if json.Unmarshal(r.SystemPrompt, &many) == nil {
		return many
	}
	return nil
}

// DefaultStopPatterns are always sent.
var DefaultStopPatterns = []string{"<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"}

// turn is the per-turn wire state AssignModel and GetChatMessage share.
type turn struct {
	apiKey    string // the credential form GetUserJwt accepted
	userJwt   string
	cascadeID string
}

// newUUID is crypto.randomUUID (swappable in tests).
var newUUID = func() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func resolveChatModelUID(model ModelSpec, effort, override string) string {
	if override != "" {
		return override
	}
	if effort != "" && model.EffortMap[effort] != "" {
		return model.EffortMap[effort]
	}
	if model.RequestModelID != "" {
		return model.RequestModelID
	}
	return model.ID
}

func images(content []bridge.ContentBlock) []ImageData {
	var out []ImageData
	for _, part := range content {
		if part.Type == "image" {
			out = append(out, ImageData{Base64Data: part.Data, MimeType: part.MimeType})
		}
	}
	return out
}

func buildUserPrompt(msg bridge.Message, messageID string) ChatMessagePrompt {
	var prompt strings.Builder
	for _, part := range msg.Content {
		if part.Type == "text" {
			prompt.WriteString(part.Text)
		}
	}
	return ChatMessagePrompt{MessageID: messageID, Source: sourceUser, Prompt: prompt.String(), Images: images(msg.Content)}
}

// buildRouterPrompt is the current user turn on its own, with no message id.
func buildRouterPrompt(messages []bridge.Message) *ChatMessagePrompt {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			p := buildUserPrompt(messages[i], "")
			return &p
		}
	}
	return nil
}

// argumentsJSON is JSON.stringify(arguments): "" when absent.
func argumentsJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	if s, err := jsjson.Canonical(raw); err == nil {
		return s
	}
	return string(raw)
}

// buildChatMessagePrompts maps the neutral history onto Cascade prompts.
// Message ids are seeded from cascadeId\0index\0role so they stay stable
// across history rebuilds.
func buildChatMessagePrompts(messages []bridge.Message, cascadeID string) []ChatMessagePrompt {
	var prompts []ChatMessagePrompt
	for index, msg := range messages {
		seed := fmt.Sprintf("%s\x00%d\x00", cascadeID, index)
		switch msg.Role {
		case "user":
			prompts = append(prompts, buildUserPrompt(msg, deterministicUUID(seed+msg.Role)))
		case "assistant":
			native := msg.ResponseID != ""
			var text, thinking strings.Builder
			signature := ""
			var calls []ChatToolCall
			for _, part := range msg.Content {
				switch part.Type {
				case "text":
					text.WriteString(part.Text)
				case "thinking":
					thinking.WriteString(part.Thinking)
					if native && signature == "" && part.ThinkingSignature != "" {
						signature = part.ThinkingSignature
					}
				case "toolCall":
					calls = append(calls, ChatToolCall{ID: part.ID, Name: part.Name, ArgumentsJSON: argumentsJSON(part.Arguments)})
				}
			}
			if text.Len() == 0 && thinking.Len() == 0 && signature == "" && len(calls) == 0 {
				continue
			}
			id := "bot-" + deterministicUUID(seed+"assistant")
			if native {
				id = msg.ResponseID
			}
			prompts = append(prompts, ChatMessagePrompt{
				MessageID: id, Source: sourceSystem, Prompt: text.String(), Thinking: thinking.String(),
				Signature: signature, ToolCalls: calls,
			})
		default: // toolResult
			var text strings.Builder
			for _, part := range msg.Content {
				if part.Type == "text" {
					text.WriteString(part.Text)
				}
			}
			prompts = append(prompts, ChatMessagePrompt{
				MessageID:         deterministicUUID(seed + "tool\x00" + msg.ToolCallID),
				Source:            sourceTool,
				ToolCallID:        msg.ToolCallID,
				ToolResultIsError: msg.IsError,
				Prompt:            text.String(),
				Images:            images(msg.Content),
			})
		}
	}
	return prompts
}

// buildChatRequest assembles GetChatMessageRequest for one turn.
func buildChatRequest(req *StreamRequest, t turn, assignment *ModelAssignment) GetChatMessageRequest {
	model := req.Model
	stop := DefaultStopPatterns
	if len(req.StopSequences) > 0 {
		stop = append(append([]string{}, DefaultStopPatterns...), req.StopSequences...)
	}
	chatModelUID := resolveChatModelUID(model, req.Effort, req.ChatModelUID)
	if assignment != nil {
		chatModelUID = assignment.ModelUID
	}
	google := isGeminiRoutedModel(model.ID, model.RequestModelID, chatModelUID)
	var tools []ChatToolDefinition
	if model.SupportsTools == nil || *model.SupportsTools {
		for _, tool := range req.Tools {
			schema := ""
			if len(tool.Parameters) > 0 {
				if v, err := jsjson.Parse(tool.Parameters); err == nil {
					if google {
						v = normalizeSchemaForGoogle(v)
					}
					schema = jsjson.Stringify(v)
				} else {
					schema = string(tool.Parameters)
				}
			}
			tools = append(tools, ChatToolDefinition{
				Name: tool.Name, Description: tool.Description, JSONSchemaString: schema,
				Strict: tool.Strict != nil && *tool.Strict,
			})
		}
	}
	maxTokens := 64000
	if req.MaxTokens != nil {
		maxTokens = *req.MaxTokens
	} else if model.MaxTokens != nil {
		maxTokens = *model.MaxTokens
	}
	temperature, topP := 0.4, 1.0
	if req.Temperature != nil {
		temperature = *req.Temperature
	}
	if req.TopP != nil {
		topP = *req.TopP
	}
	md := wireMetadata(t.apiKey, t.userJwt)
	out := GetChatMessageRequest{
		Metadata:                 &md,
		Prompt:                   strings.Join(normalizeSystemPrompts(req.systemPrompts()), "\n\n"),
		ChatMessagePrompts:       buildChatMessagePrompts(req.Messages, t.cascadeID),
		ChatModelUID:             chatModelUID,
		RequestType:              requestTypeCascade,
		PlannerMode:              plannerModeDefault,
		ToolChoiceOption:         "auto",
		SystemPromptCacheType:    cacheControlEphemeral,
		DisableParallelToolCalls: model.SupportsParallelToolCalls == nil || !*model.SupportsParallelToolCalls,
		CascadeID:                t.cascadeID,
		ExecutionID:              newUUID(),
		Configuration: &CompletionConfiguration{
			NumCompletions:      1,
			MaxTokens:           uint64(maxTokens),
			MaxNewlines:         200,
			Temperature:         temperature,
			FirstTemperature:    temperature,
			TopK:                50,
			TopP:                topP,
			StopPatterns:        stop,
			FimEotProbThreshold: 1,
		},
		Tools: tools,
	}
	if assignment != nil {
		jwt := assignment.AssignmentJwt
		out.ModelAssignmentJwt = &jwt
	}
	return out
}
