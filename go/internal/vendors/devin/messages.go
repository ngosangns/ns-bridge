package devin

import (
	"fmt"

	"github.com/ngosangns/ns-bridge/go/internal/pbwire"
)

// The Cascade protobuf messages a turn needs, transcribed from
// packages/devin-core/src/proto/devin-messages.ts. Fields are written in that
// file's declaration order with proto3 defaults omitted, matching the
// TypeScript codec byte for byte.

// Enum values used on the wire.
const (
	sourceUser   = 1 // ChatMessageSource.USER
	sourceSystem = 2 // ChatMessageSource.SYSTEM
	sourceTool   = 4 // ChatMessageSource.TOOL

	requestTypeCascade    = 5 // ChatMessageRequestType.CASCADE
	plannerModeDefault    = 1 // ConversationalPlannerMode.DEFAULT
	cacheControlEphemeral = 1 // CacheControlType.EPHEMERAL

	stopReasonUnspecified = 0
	stopReasonMaxTokens   = 3
)

// Metadata is exa.codeium_common_pb.Metadata (the fields this client sets).
type Metadata struct {
	IdeName, IdeVersion, IdeType, ExtensionName, ExtensionVersion string
	APIKey, Locale, OS, UserJwt                                   string
}

func (m Metadata) encode() []byte {
	var w pbwire.Writer
	w.String(1, m.IdeName)
	w.String(7, m.IdeVersion)
	w.String(28, m.IdeType)
	w.String(12, m.ExtensionName)
	w.String(2, m.ExtensionVersion)
	w.String(3, m.APIKey)
	w.String(4, m.Locale)
	w.String(5, m.OS)
	w.String(21, m.UserJwt)
	return w.Finish()
}

// ImageData is exa.codeium_common_pb.ImageData.
type ImageData struct{ Base64Data, MimeType string }

func (m ImageData) encode() []byte {
	var w pbwire.Writer
	w.String(1, m.Base64Data)
	w.String(2, m.MimeType)
	return w.Finish()
}

// ChatToolCall is exa.codeium_common_pb.ChatToolCall.
type ChatToolCall struct{ ID, Name, ArgumentsJSON string }

func (m ChatToolCall) encode() []byte {
	var w pbwire.Writer
	w.String(1, m.ID)
	w.String(2, m.Name)
	w.String(3, m.ArgumentsJSON)
	return w.Finish()
}

func decodeChatToolCall(data []byte) (ChatToolCall, error) {
	var m ChatToolCall
	err := pbwire.Each(data, func(f pbwire.Field) error {
		switch f.No {
		case 1:
			m.ID = f.Str()
		case 2:
			m.Name = f.Str()
		case 3:
			m.ArgumentsJSON = f.Str()
		}
		return nil
	})
	return m, err
}

// ChatMessagePrompt is exa.chat_pb.ChatMessagePrompt.
type ChatMessagePrompt struct {
	MessageID         string
	Source            uint64
	Prompt            string
	ToolCalls         []ChatToolCall
	ToolCallID        string
	ToolResultIsError bool
	Images            []ImageData
	Thinking          string
	Signature         string
}

func (m ChatMessagePrompt) encode() []byte {
	var w pbwire.Writer
	w.String(1, m.MessageID)
	w.Uint(2, m.Source)
	w.String(3, m.Prompt)
	for _, c := range m.ToolCalls {
		w.Message(6, c.encode())
	}
	w.String(7, m.ToolCallID)
	w.Bool(9, m.ToolResultIsError)
	for _, img := range m.Images {
		w.Message(10, img.encode())
	}
	w.String(11, m.Thinking)
	w.String(12, m.Signature)
	return w.Finish()
}

// ChatToolDefinition is exa.chat_pb.ChatToolDefinition.
type ChatToolDefinition struct {
	Name, Description, JSONSchemaString string
	Strict                              bool
}

func (m ChatToolDefinition) encode() []byte {
	var w pbwire.Writer
	w.String(1, m.Name)
	w.String(2, m.Description)
	w.String(3, m.JSONSchemaString)
	w.Bool(12, m.Strict)
	return w.Finish()
}

// CompletionConfiguration is exa.codeium_common_pb.CompletionConfiguration.
type CompletionConfiguration struct {
	NumCompletions, MaxTokens, MaxNewlines uint64
	Temperature, FirstTemperature          float64
	TopK                                   uint64
	TopP                                   float64
	StopPatterns                           []string
	FimEotProbThreshold                    float64
}

func (m CompletionConfiguration) encode() []byte {
	var w pbwire.Writer
	w.Uint(1, m.NumCompletions)
	w.Uint(2, m.MaxTokens)
	w.Uint(3, m.MaxNewlines)
	w.Double(5, m.Temperature)
	w.Double(6, m.FirstTemperature)
	w.Uint(7, m.TopK)
	w.Double(8, m.TopP)
	w.RepeatedString(9, m.StopPatterns)
	w.Double(11, m.FimEotProbThreshold)
	return w.Finish()
}

// GetChatMessageRequest is exa.api_server_pb.GetChatMessageRequest.
type GetChatMessageRequest struct {
	Metadata                 *Metadata
	Prompt                   string
	ChatMessagePrompts       []ChatMessagePrompt
	ChatModelUID             string
	RequestType              uint64
	Configuration            *CompletionConfiguration
	Tools                    []ChatToolDefinition
	DisableParallelToolCalls bool
	ToolChoiceOption         string // ChatToolChoice.optionName
	SystemPromptCacheType    uint64 // PromptCacheOptions.type; 0 = absent
	CascadeID                string
	PlannerMode              uint64
	ExecutionID              string
	ModelAssignmentJwt       *string
}

func (m GetChatMessageRequest) Encode() []byte {
	var w pbwire.Writer
	if m.Metadata != nil {
		w.Message(1, m.Metadata.encode())
	}
	w.String(2, m.Prompt)
	for _, p := range m.ChatMessagePrompts {
		w.Message(3, p.encode())
	}
	w.String(21, m.ChatModelUID)
	w.Uint(7, m.RequestType)
	if m.Configuration != nil {
		w.Message(8, m.Configuration.encode())
	}
	for _, t := range m.Tools {
		w.Message(10, t.encode())
	}
	w.Bool(11, m.DisableParallelToolCalls)
	if m.ToolChoiceOption != "" {
		var c pbwire.Writer
		c.OptionalString(1, &m.ToolChoiceOption)
		w.Message(12, c.Finish())
	}
	if m.SystemPromptCacheType != 0 {
		var c pbwire.Writer
		c.Uint(1, m.SystemPromptCacheType)
		w.Message(13, c.Finish())
	}
	w.String(16, m.CascadeID)
	w.Uint(20, m.PlannerMode)
	w.String(22, m.ExecutionID)
	w.OptionalString(26, m.ModelAssignmentJwt)
	return w.Finish()
}

// encodeGetUserJwtRequest is exa.auth_pb.GetUserJwtRequest.
func encodeGetUserJwtRequest(md Metadata) []byte {
	var w pbwire.Writer
	w.Message(1, md.encode())
	return w.Finish()
}

// GetUserJwtResponse is exa.auth_pb.GetUserJwtResponse.
type GetUserJwtResponse struct{ UserJwt, CustomAPIServerURL string }

func decodeGetUserJwtResponse(data []byte) (GetUserJwtResponse, error) {
	var m GetUserJwtResponse
	err := pbwire.Each(data, func(f pbwire.Field) error {
		switch f.No {
		case 1:
			if err := pbwire.Expect(f, pbwire.Bytes); err != nil {
				return err
			}
			m.UserJwt = f.Str()
		case 2:
			if err := pbwire.Expect(f, pbwire.Bytes); err != nil {
				return err
			}
			m.CustomAPIServerURL = f.Str()
		}
		return nil
	})
	return m, err
}

// encodeAssignModelRequest is exa.api_server_pb.AssignModelRequest.
func encodeAssignModelRequest(md Metadata, routerUID, cascadeID string, prompt *ChatMessagePrompt) []byte {
	var w pbwire.Writer
	w.Message(1, md.encode())
	w.String(2, routerUID)
	w.String(3, cascadeID)
	if prompt != nil {
		w.Message(5, prompt.encode())
	}
	return w.Finish()
}

// ModelAssignment is exa.api_server_pb.ModelAssignment.
type ModelAssignment struct{ AssignmentJwt, ModelUID string }

func decodeAssignModelResponse(data []byte) (*ModelAssignment, error) {
	var out *ModelAssignment
	err := pbwire.Each(data, func(f pbwire.Field) error {
		if f.No != 1 {
			return nil
		}
		if err := pbwire.Expect(f, pbwire.Bytes); err != nil {
			return err
		}
		m := ModelAssignment{}
		if err := pbwire.Each(f.Data, func(g pbwire.Field) error {
			switch g.No {
			case 1:
				m.AssignmentJwt = g.Str()
			case 2:
				m.ModelUID = g.Str()
			}
			return nil
		}); err != nil {
			return err
		}
		out = &m
		return nil
	})
	return out, err
}

// UsageStats is exa.codeium_common_pb.ModelUsageStats (token counters).
type UsageStats struct{ InputTokens, OutputTokens, CacheWriteTokens, CacheReadTokens uint64 }

// GetChatMessageResponse is exa.api_server_pb.GetChatMessageResponse.
type GetChatMessageResponse struct {
	MessageID           string
	DeltaText           string
	StopReason          uint64
	DeltaToolCalls      []ChatToolCall
	Usage               *UsageStats
	CreditCost          int32
	DeltaThinking       string
	DeltaSignature      string
	CommittedCreditCost int32
	CommittedAcuCost    float64
	ActualModelUID      string
}

func decodeGetChatMessageResponse(data []byte) (GetChatMessageResponse, error) {
	var m GetChatMessageResponse
	str := func(f pbwire.Field, dst *string) error {
		if err := pbwire.Expect(f, pbwire.Bytes); err != nil {
			return err
		}
		*dst = f.Str()
		return nil
	}
	err := pbwire.Each(data, func(f pbwire.Field) error {
		switch f.No {
		case 1:
			return str(f, &m.MessageID)
		case 3:
			return str(f, &m.DeltaText)
		case 5:
			if err := pbwire.Expect(f, pbwire.Varint); err != nil {
				return err
			}
			m.StopReason = f.Uint
		case 6:
			if err := pbwire.Expect(f, pbwire.Bytes); err != nil {
				return err
			}
			call, err := decodeChatToolCall(f.Data)
			if err != nil {
				return err
			}
			m.DeltaToolCalls = append(m.DeltaToolCalls, call)
		case 7:
			if err := pbwire.Expect(f, pbwire.Bytes); err != nil {
				return err
			}
			u := &UsageStats{}
			if err := pbwire.Each(f.Data, func(g pbwire.Field) error {
				switch g.No {
				case 2:
					u.InputTokens = g.Uint
				case 3:
					u.OutputTokens = g.Uint
				case 4:
					u.CacheWriteTokens = g.Uint
				case 5:
					u.CacheReadTokens = g.Uint
				}
				return nil
			}); err != nil {
				return err
			}
			m.Usage = u
		case 14:
			m.CreditCost = int32(f.Uint)
		case 9:
			return str(f, &m.DeltaThinking)
		case 10:
			return str(f, &m.DeltaSignature)
		case 18:
			m.CommittedCreditCost = int32(f.Uint)
		case 22:
			if err := pbwire.Expect(f, pbwire.Fixed64); err != nil {
				return err
			}
			m.CommittedAcuCost = f.Float64()
		case 23:
			return str(f, &m.ActualModelUID)
		}
		return nil
	})
	if err != nil {
		return m, fmt.Errorf("decode GetChatMessageResponse: %w", err)
	}
	return m, nil
}
