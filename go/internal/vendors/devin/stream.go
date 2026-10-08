package devin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
)

// LargeHistoryRecoveryBytes is the history size at which Devin's opaque
// invalid_argument trailer is treated as a context overflow.
const LargeHistoryRecoveryBytes = 512 * 1024

const invalidArgumentsRawLimit = 512

var internalErrorPattern = regexp.MustCompile(`(?i)\binternal error\b`)

func debugEnabled() bool { return logx.Enabled("NS_DEVIN_DEBUG", "DEVIN_DEBUG") }

func warn(message string, data map[string]any) { logx.Line("devin", message, data) }

func calculateCost(c Cost, input, output, cacheRead, cacheWrite int) bridge.Cost {
	per := func(tokens int, rate float64) float64 { return float64(tokens) / 1_000_000 * rate }
	out := bridge.Cost{
		Input: per(input, c.Input), Output: per(output, c.Output),
		CacheRead: per(cacheRead, c.CacheRead), CacheWrite: per(cacheWrite, c.CacheWrite),
	}
	out.Total = out.Input + out.Output + out.CacheRead + out.CacheWrite
	return out
}

// parseToolCallArguments is the strict final parse: a JSON object, {} for
// empty input, or {__parseError, __rawJson} for anything else.
func parseToolCallArguments(raw string) json.RawMessage {
	if strings.TrimSpace(raw) == "" {
		return json.RawMessage("{}")
	}
	var value any
	var parseErr string
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		parseErr = jsonSyntaxMessage(err)
	} else if _, ok := value.(map[string]any); ok {
		return json.RawMessage(raw)
	} else {
		kind := "object"
		switch value.(type) {
		case []any:
			kind = "array"
		case string:
			kind = "string"
		case float64:
			kind = "number"
		case bool:
			kind = "boolean"
		}
		parseErr = "tool arguments must be a JSON object, got " + kind
	}
	rawOut := raw
	if n := jsjson.UTF16Len(raw); n > invalidArgumentsRawLimit {
		runes := []rune(raw)
		cut := 0
		units := 0
		for cut < len(runes) && units < invalidArgumentsRawLimit {
			if runes[cut] > 0xFFFF {
				units += 2
			} else {
				units++
			}
			cut++
		}
		rawOut = fmt.Sprintf("%s… [truncated %d chars]", string(runes[:cut]), n-invalidArgumentsRawLimit)
	}
	obj := jsjson.NewObject()
	obj.Set("__parseError", parseErr)
	obj.Set("__rawJson", rawOut)
	return json.RawMessage(jsjson.Stringify(obj))
}

// jsonSyntaxMessage words a Go JSON error the way V8's JSON.parse does for
// the common cases a host shows the model.
func jsonSyntaxMessage(err error) string {
	var syn *json.SyntaxError
	if errors.As(err, &syn) {
		if strings.Contains(syn.Error(), "unexpected end of JSON input") {
			return "Unexpected end of JSON input"
		}
		return fmt.Sprintf("%s in JSON at position %d", upperFirst(syn.Error()), syn.Offset-1)
	}
	if strings.Contains(err.Error(), "unexpected end of JSON input") {
		return "Unexpected end of JSON input"
	}
	return upperFirst(err.Error())
}

func upperFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

type openBlock struct {
	index     int
	text      strings.Builder
	signature string
}

type toolBlock struct {
	index int
	name  string
	json  string
}

// streamOnce runs one Cascade turn: GetUserJwt, AssignModel for routers,
// then GetChatMessage, emitting neutral events. nextIndex is shared across
// capacity retries so block indexes are never reused.
func streamOnce(ctx context.Context, req *StreamRequest, nextIndex *int, emit func(bridge.Event) error) error {
	model := req.Model
	baseURL := strings.TrimRight(model.BaseURL, "/")
	if model.BaseURL == "" {
		baseURL = DefaultBaseURL
	}
	auth, err := fetchAuthMetadata(ctx, req.APIKey, baseURL)
	if err != nil {
		return err
	}
	chatBaseURL := baseURL
	if auth.baseURL != "" {
		chatBaseURL = auth.baseURL
	}

	cascadeID := ""
	switch {
	case req.ConversationID != nil:
		cascadeID = *req.ConversationID
	case req.SessionID != nil:
		cascadeID = *req.SessionID
	default:
		cascadeID = newUUID()
	}
	t := turn{apiKey: auth.apiKey, userJwt: auth.userJwt, cascadeID: cascadeID}

	upstreamModel := ""
	var assignment *ModelAssignment
	if model.IsModelRouter {
		assignment, err = assignModel(ctx, model, t, buildRouterPrompt(req.Messages), chatBaseURL)
		if err != nil {
			return err
		}
		upstreamModel = assignment.ModelUID
	}

	chat := buildChatRequest(req, t, assignment)
	requestBytes := chat.Encode()
	frame := encodeConnectFrame(requestBytes)
	if debugEnabled() {
		warn("sending chat request", map[string]any{
			"model": model.ID, "tools": len(req.Tools), "requestBytes": len(requestBytes), "compressedBytes": len(frame) - 5,
		})
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, chatBaseURL+chatMessagePath, bytes.NewReader(frame))
	if err != nil {
		return err
	}
	httpReq.Header.Set("content-type", "application/connect+proto")
	httpReq.Header.Set("connect-protocol-version", "1")
	httpReq.Header.Set("connect-content-encoding", "gzip")
	httpReq.Header.Set("accept-encoding", "identity")
	httpReq.Header.Set("user-agent", "connect-go/1.18.1 (go1.26.3)")
	httpReq.Header.Set("connect-accept-encoding", "gzip")
	resp, err := httpClient().Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		payload, _ := io.ReadAll(resp.Body)
		return newHTTPError("API", resp, payload)
	}

	if err := emit(bridge.Start()); err != nil {
		return err
	}

	sawAnyToken := false
	latestStop := uint64(stopReasonUnspecified)
	responseID := ""
	var lastUsage *bridge.Usage
	var openText, openThinking *openBlock
	var tools []*toolBlock
	toolByID := map[string]*toolBlock{}
	toolIDs := map[*toolBlock]string{}
	activeToolCallID := ""

	closeThinking := func() error {
		if openThinking == nil {
			return nil
		}
		b := openThinking
		openThinking = nil
		return emit(bridge.ThinkingEnd(b.index, b.text.String(), b.signature))
	}
	closeText := func() error {
		if openText == nil {
			return nil
		}
		b := openText
		openText = nil
		return emit(bridge.TextEnd(b.index, b.text.String()))
	}

	for {
		env, err := readConnectFrame(resp.Body)
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				return context.Cause(ctx)
			}
			return err
		}
		if env.endStream {
			trailer := readTrailerError(strings.TrimSpace(string(env.payload)))
			if trailer == nil {
				continue
			}
			data := map[string]any{
				"model": model.ID, "code": trailer.Code, "message": trailer.Message, "rawTrailer": trailer.Raw,
				"requestBytes": len(requestBytes), "messages": len(req.Messages), "hadOutput": sawAnyToken,
			}
			if trailer.Detail != "" {
				data["detail"] = trailer.Detail
			}
			warn("stream rejected via Connect trailer", data)
			overflow := false
			if !sawAnyToken && strings.ToLower(trailer.Code) == "invalid_argument" && internalErrorPattern.MatchString(trailer.Message) {
				history := GetChatMessageRequest{ChatMessagePrompts: buildChatMessagePrompts(req.Messages, t.cascadeID)}
				historyBytes := len(history.Encode())
				overflow = historyBytes >= LargeHistoryRecoveryBytes
				if overflow {
					warn("treating large-history invalid_argument as context overflow", map[string]any{"model": model.ID, "historyBytes": historyBytes})
				}
			}
			return &StreamError{Code: trailer.Code, Message: trailer.Formatted, ContextOverflow: overflow}
		}

		msg, err := decodeGetChatMessageResponse(env.payload)
		if err != nil {
			return &ProtocolError{Kind: "envelope", Message: "Devin API error: " + err.Error()}
		}
		if msg.MessageID != "" && responseID == "" {
			responseID = msg.MessageID
		}
		if msg.ActualModelUID != "" {
			upstreamModel = msg.ActualModelUID
		}

		if msg.DeltaThinking != "" {
			sawAnyToken = true
			if openThinking == nil {
				openThinking = &openBlock{index: *nextIndex}
				*nextIndex++
				if err := emit(bridge.ThinkingStart(openThinking.index)); err != nil {
					return err
				}
			}
			openThinking.text.WriteString(msg.DeltaThinking)
			if err := emit(bridge.ThinkingDelta(openThinking.index, msg.DeltaThinking)); err != nil {
				return err
			}
		}
		if msg.DeltaSignature != "" && openThinking != nil {
			openThinking.signature = msg.DeltaSignature
		}
		if msg.DeltaText != "" {
			sawAnyToken = true
			if err := closeThinking(); err != nil {
				return err
			}
			if openText == nil {
				openText = &openBlock{index: *nextIndex}
				*nextIndex++
				if err := emit(bridge.TextStart(openText.index)); err != nil {
					return err
				}
			}
			openText.text.WriteString(msg.DeltaText)
			if err := emit(bridge.TextDelta(openText.index, msg.DeltaText)); err != nil {
				return err
			}
		}
		if len(msg.DeltaToolCalls) > 0 {
			sawAnyToken = true
			if err := closeText(); err != nil {
				return err
			}
			if err := closeThinking(); err != nil {
				return err
			}
			for _, call := range msg.DeltaToolCalls {
				id := call.ID
				if id == "" {
					id = activeToolCallID
				}
				if id == "" {
					continue
				}
				block := toolByID[id]
				if block == nil {
					block = &toolBlock{index: *nextIndex, name: call.Name}
					*nextIndex++
					toolByID[id] = block
					toolIDs[block] = id
					tools = append(tools, block)
					if err := emit(bridge.ToolCallStart(block.index, id, call.Name)); err != nil {
						return err
					}
				}
				if call.Name != "" {
					block.name = call.Name
				}
				activeToolCallID = id
				if call.ArgumentsJSON == "" {
					continue
				}
				previous := block.json
				accumulated := previous + call.ArgumentsJSON
				if strings.HasPrefix(call.ArgumentsJSON, previous) {
					accumulated = call.ArgumentsJSON
				}
				delta := accumulated[len(previous):]
				block.json = accumulated
				if err := emit(bridge.ToolCallDelta(block.index, id, delta)); err != nil {
					return err
				}
			}
		}
		if msg.StopReason != stopReasonUnspecified {
			latestStop = msg.StopReason
		}
		if msg.Usage != nil || msg.CreditCost != 0 || msg.CommittedCreditCost != 0 || msg.CommittedAcuCost != 0 {
			var input, output, cacheRead, cacheWrite int
			if msg.Usage != nil {
				input, output = int(msg.Usage.InputTokens), int(msg.Usage.OutputTokens)
				cacheRead, cacheWrite = int(msg.Usage.CacheReadTokens), int(msg.Usage.CacheWriteTokens)
			}
			total := input + output + cacheRead + cacheWrite
			credits := float64(msg.CreditCost)
			if credits == 0 {
				credits = float64(msg.CommittedCreditCost)
			}
			if credits == 0 {
				credits = msg.CommittedAcuCost
			}
			var moved bool
			if lastUsage == nil {
				moved = total > 0 || credits != 0
			} else {
				prevCredits := 0.0
				if lastUsage.Credits != nil {
					prevCredits = *lastUsage.Credits
				}
				moved = total != lastUsage.TotalTokens || credits != prevCredits
			}
			if moved {
				u := bridge.Usage{
					Input: input, Output: output, TotalTokens: total, CacheRead: &cacheRead, CacheWrite: &cacheWrite,
					Cost: calculateCost(model.Cost, input, output, cacheRead, cacheWrite),
				}
				if credits != 0 {
					c := credits
					u.Credits = &c
				}
				lastUsage = &u
				if err := emit(bridge.UsageUpdate(u)); err != nil {
					return err
				}
			}
		}
	}

	if err := closeText(); err != nil {
		return err
	}
	if err := closeThinking(); err != nil {
		return err
	}
	for _, block := range tools {
		raw := block.json
		if err := emit(bridge.ToolCallEnd(block.index, toolIDs[block], block.name, parseToolCallArguments(raw), &raw)); err != nil {
			return err
		}
	}
	stop := bridge.StopReasonStop
	switch {
	case len(tools) > 0:
		stop = bridge.StopReasonToolUse
	case latestStop == stopReasonMaxTokens:
		stop = bridge.StopReasonLength
	}
	done := bridge.Done(stop)
	done.ResponseID = responseID
	done.UpstreamModel = upstreamModel
	return emit(done)
}

// httpClient is swappable in tests.
var httpClient = defaultHTTPClient
