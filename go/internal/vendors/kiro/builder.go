package kiro

import (
	"fmt"
	"math"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
)

type builtRequest struct {
	body            *jsjson.Object
	historyLen      int
	contentLen      int
	hasImages       bool
	toolResultCount int
}

// localOverflowError is the request-builder's context_length_exceeded.
type localOverflowError struct{ message string }

func (e *localOverflowError) Error() string { return e.message }

func wasPreviousResponseTruncated(messages []Message) bool {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "assistant" {
			return messages[i].StopReason == "length"
		}
	}
	return false
}

// buildRequest is buildKiroRequest.
func buildRequest(messages []Message, model *Model, kiroModelID, systemPrompt string, tools []Tool, conversationID, profileArn string, extra *jsjson.Object) (*builtRequest, error) {
	normalized := relocateDisplacedToolResults(normalizeMessages(messages))
	rawHistory, systemPrepended, currentStart := buildHistory(normalized, kiroModelID, systemPrompt)
	history := prepareHistory(rawHistory, model.acceptsImages())
	dynamicLimit := int(math.Floor(model.ContextWindow / historyLimitContext * historyLimit))

	var current []Message
	if currentStart < 0 {
		if len(normalized) > 0 {
			current = normalized[len(normalized)-1:]
		}
	} else if currentStart <= len(normalized) {
		current = normalized[currentStart:]
	}
	var first *Message
	if len(current) > 0 {
		first = &current[0]
	}
	currentContent := ""
	var currentResults []toolResult
	var currentImages []image
	switch {
	case first != nil && first.Role == "assistant":
		armContent := ""
		var armUses []toolUse
		for _, block := range first.Content {
			switch block.Type {
			case "text":
				armContent += block.Text
			case "toolCall":
				armUses = append(armUses, toolUse{name: toKiroToolName(block.Name), toolUseID: toKiroToolUseID(block.ID), input: toKiroToolInput(block.Arguments)})
			}
		}
		if armContent != "" || len(armUses) > 0 {
			var last *historyEntry
			if len(history) > 0 {
				last = history[len(history)-1]
			}
			if last != nil && last.user == nil && last.assistant != nil {
				prev := *last.assistant
				prev.content = joinParagraphs(prev.content, armContent)
				if len(armUses) > 0 {
					prev.toolUses = append(append([]toolUse{}, prev.toolUses...), armUses...)
				}
				history[len(history)-1] = &historyEntry{assistant: &prev}
			} else {
				history = append(history, &historyEntry{assistant: &assistantResponse{content: armContent, toolUses: armUses}})
			}
		}
		var imgs []rawImage
		for i := 1; i < len(current); i++ {
			if current[i].Role != "toolResult" {
				continue
			}
			currentResults = append(currentResults, toolResultOf(&current[i]))
			imgs = append(imgs, extractImages(&current[i])...)
		}
		if c := convertImages(imgs); len(c) > 0 {
			currentImages = c
		}
	case first != nil && first.Role == "toolResult":
		var imgs []rawImage
		for i := range current {
			if current[i].Role != "toolResult" {
				continue
			}
			currentResults = append(currentResults, toolResultOf(&current[i]))
			imgs = append(imgs, extractImages(&current[i])...)
		}
		if c := convertImages(imgs); len(c) > 0 {
			currentImages = c
		}
	case first != nil && first.Role == "user":
		currentContent = contentText(first)
		if systemPrompt != "" && !systemPrepended {
			currentContent = systemPrompt + "\n\n" + currentContent
		}
	}

	if size := jsstr.Len(jsjson.Stringify(historyJSON(history))); size > dynamicLimit {
		return nil, &localOverflowError{fmt.Sprintf("Kiro API error: context_length_exceeded (local history %d chars / %d entries exceeds %d-char limit)", size, len(history), dynamicLimit)}
	}
	if wasPreviousResponseTruncated(messages) {
		if currentContent == "" {
			currentContent = truncationNotice
		} else {
			currentContent = truncationNotice + "\n\n" + currentContent
		}
	}
	var uimc *userContext
	var baseTools []toolSpec
	if len(tools) > 0 {
		baseTools = convertTools(tools)
	}
	finalTools := baseTools
	if len(history) > 0 {
		finalTools = addPlaceholderTools(baseTools, history)
	}
	if len(currentResults) > 0 || len(finalTools) > 0 {
		uimc = &userContext{}
		if len(currentResults) > 0 {
			uimc.toolResults = currentResults
		}
		if len(finalTools) > 0 {
			uimc.tools = finalTools
		}
	}
	if first != nil && first.Role == "user" {
		if c := convertImages(extractImages(first)); len(c) > 0 {
			currentImages = c
		}
	}
	if currentContent == "" && len(currentResults) == 0 {
		currentContent = emptyContentPlaceholder
	}
	entries := append(append([]*historyEntry{}, history...), &historyEntry{user: &userInput{content: currentContent, modelID: kiroModelID, context: uimc}})
	repaired, diagnostics, remaining := repairConversation(entries)
	if len(diagnostics) > 0 && debugEnabled() {
		debugLog("request.invariants", map[string]any{"errors": validationJSON(diagnostics), "remaining": validationJSON(remaining)})
	}
	var wireHistory []*historyEntry
	var wireContent string
	var wireContext *userContext
	if n := len(repaired); n > 0 && repaired[n-1].user != nil {
		wireHistory = repaired[:n-1]
		wireContent = repaired[n-1].user.content
		wireContext = repaired[n-1].user.context
	} else {
		wireContent = currentContent
		if wireContent == "" {
			wireContent = emptyContentPlaceholder
		}
		if uimc != nil && len(uimc.tools) > 0 {
			wireContext = &userContext{tools: uimc.tools}
		}
	}
	var structural []*validationError
	for _, e := range remaining {
		if isToolStructureRule(e.rule) {
			structural = append(structural, e)
		}
	}
	if len(structural) > 0 {
		logx.Warn(fmt.Sprintf("[kiro-core] outbound history still violates %s after repair — Kiro may reject this request", describeRemaining(structural)))
	}

	userMsg := userInputJSON(&userInput{content: wireContent, modelID: kiroModelID, images: currentImages, context: wireContext})
	state := jsjson.NewObject()
	state.Set("chatTriggerType", "MANUAL")
	state.Set("agentTaskType", "vibe")
	state.Set("conversationId", conversationID)
	cm := jsjson.NewObject()
	cm.Set("userInputMessage", userMsg)
	state.Set("currentMessage", cm)
	if len(wireHistory) > 0 {
		state.Set("history", historyJSON(wireHistory))
	}
	body := jsjson.NewObject()
	body.Set("conversationState", state)
	if extra != nil {
		body.Set("additionalModelRequestFields", extra)
	}
	body.Set("profileArn", profileArn)
	body.Set("agentMode", "vibe")
	count := 0
	if wireContext != nil {
		count = len(wireContext.toolResults)
	}
	return &builtRequest{body: body, historyLen: len(wireHistory), contentLen: jsstr.Len(wireContent), hasImages: currentImages != nil, toolResultCount: count}, nil
}

func validationJSON(errs []*validationError) []any {
	out := make([]any, 0, len(errs))
	for _, e := range errs {
		out = append(out, map[string]any{"rule": e.rule, "message": e.message, "index": e.index})
	}
	return out
}

// --- wire JSON, in the TypeScript core's property order ---

func imagesJSON(images []image) []jsjson.Value {
	out := make([]jsjson.Value, 0, len(images))
	for _, img := range images {
		o := jsjson.NewObject()
		o.Set("format", img.format)
		src := jsjson.NewObject()
		src.Set("bytes", img.bytes)
		o.Set("source", src)
		out = append(out, o)
	}
	return out
}

func toolResultJSON(tr toolResult) *jsjson.Object {
	o := jsjson.NewObject()
	content := jsjson.NewObject()
	content.Set("text", tr.text)
	if tr.synthetic {
		o.Set("toolUseId", tr.toolUseID)
	}
	o.Set("content", []jsjson.Value{content})
	o.Set("status", tr.status)
	o.Set("toolUseId", tr.toolUseID)
	return o
}

func toolSpecJSON(t toolSpec) *jsjson.Object {
	spec := jsjson.NewObject()
	spec.Set("name", t.name)
	if t.description != nil {
		spec.Set("description", *t.description)
	}
	schema := jsjson.NewObject()
	schema.Set("json", t.schema)
	spec.Set("inputSchema", schema)
	o := jsjson.NewObject()
	o.Set("toolSpecification", spec)
	return o
}

func userInputJSON(u *userInput) *jsjson.Object {
	o := jsjson.NewObject()
	o.Set("content", u.content)
	o.Set("modelId", u.modelID)
	o.Set("origin", "KIRO_CLI")
	if u.images != nil {
		o.Set("images", imagesJSON(u.images))
	}
	if u.context != nil {
		ctx := jsjson.NewObject()
		if u.context.toolResults != nil {
			list := make([]jsjson.Value, 0, len(u.context.toolResults))
			for _, tr := range u.context.toolResults {
				list = append(list, toolResultJSON(tr))
			}
			ctx.Set("toolResults", list)
		}
		if u.context.tools != nil {
			list := make([]jsjson.Value, 0, len(u.context.tools))
			for _, t := range u.context.tools {
				list = append(list, toolSpecJSON(t))
			}
			ctx.Set("tools", list)
		}
		o.Set("userInputMessageContext", ctx)
	}
	return o
}

func historyJSON(history []*historyEntry) []jsjson.Value {
	out := make([]jsjson.Value, 0, len(history))
	for _, e := range history {
		o := jsjson.NewObject()
		if e.user != nil {
			o.Set("userInputMessage", userInputJSON(e.user))
		}
		if e.assistant != nil {
			a := jsjson.NewObject()
			a.Set("content", e.assistant.content)
			if e.assistant.toolUses != nil {
				uses := make([]jsjson.Value, 0, len(e.assistant.toolUses))
				for _, tu := range e.assistant.toolUses {
					u := jsjson.NewObject()
					u.Set("name", tu.name)
					u.Set("toolUseId", tu.toolUseID)
					u.Set("input", tu.input)
					uses = append(uses, u)
				}
				a.Set("toolUses", uses)
			}
			o.Set("assistantResponseMessage", a)
		}
		out = append(out, o)
	}
	return out
}
