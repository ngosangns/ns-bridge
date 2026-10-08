package kiro

import (
	"fmt"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
)

const syntheticFailedToolResultText = "Tool use was interrupted and did not produce a result."

type validationError struct {
	rule    string
	message string
	index   int
}

var validationMessages = map[string]string{
	"STARTS_WITH_USER_MESSAGE": "Conversation must start with a user message",
	"ENDS_WITH_USER_MESSAGE":   "Conversation must end with a user message",
	"ALTERNATING_MESSAGES":     "Between every two user messages there must be an assistant message",
	"TOOL_USES_AND_RESULTS":    "If an assistant message has tool uses, the next message must be a user message with corresponding tool results",
	"TOOL_RESULTS_AND_NO_USES": "If there is a message with tool result, there has to be a corresponding message with tool use.",
	"NON_EMPTY_USER_MESSAGE":   "User messages must have either content or tool results",
	"TOOL_RESULTS_ORPHAN_IDS":  "User message has toolResults whose toolUseIds do not match any toolUse in the preceding assistant message.",
}

func verr(rule string, index int) *validationError {
	return &validationError{rule: rule, message: validationMessages[rule], index: index}
}

func isToolStructureRule(rule string) bool {
	return rule == "TOOL_USES_AND_RESULTS" || rule == "TOOL_RESULTS_AND_NO_USES" || rule == "TOOL_RESULTS_ORPHAN_IDS"
}

func at(entries []*historyEntry, i int) *historyEntry {
	if i < 0 || i >= len(entries) {
		return nil
	}
	return entries[i]
}

func isUser(e *historyEntry) bool      { return e != nil && e.user != nil }
func isAssistant(e *historyEntry) bool { return e != nil && e.assistant != nil }

func toolResultsOf(e *historyEntry) []toolResult {
	if e == nil || e.user == nil || e.user.context == nil {
		return nil
	}
	return e.user.context.toolResults
}

func hasToolResults(e *historyEntry) bool { return len(toolResultsOf(e)) > 0 }

func toolUseIDsOf(e *historyEntry) []string {
	if e == nil || e.assistant == nil {
		return nil
	}
	var ids []string
	for _, tu := range e.assistant.toolUses {
		if tu.toolUseID != "" {
			ids = append(ids, tu.toolUseID)
		}
	}
	return ids
}

func hasToolUses(e *historyEntry) bool { return len(toolUseIDsOf(e)) > 0 }

func hasText(e *historyEntry) bool {
	if e == nil || e.user == nil {
		return false
	}
	return jsstr.Trim(e.user.content) != ""
}

func toolResultsMatch(useIDs []string, results []toolResult) bool {
	if len(useIDs) == 0 {
		return true
	}
	if len(results) == 0 {
		return false
	}
	resultIDs := map[string]bool{}
	for _, tr := range results {
		resultIDs[tr.toolUseID] = true
	}
	uses := map[string]bool{}
	for _, id := range useIDs {
		uses[id] = true
	}
	for _, id := range useIDs {
		if !resultIDs[id] {
			return false
		}
	}
	for _, tr := range results {
		if !uses[tr.toolUseID] {
			return false
		}
	}
	return true
}

func validateConversation(entries []*historyEntry) []*validationError {
	var errs []*validationError
	if len(entries) == 0 || !isUser(entries[0]) {
		errs = append(errs, verr("STARTS_WITH_USER_MESSAGE", 0))
	}
	if len(entries) == 0 || !isUser(entries[len(entries)-1]) {
		errs = append(errs, verr("ENDS_WITH_USER_MESSAGE", len(entries)-1))
	}
	for i := 1; i < len(entries); i++ {
		if isUser(entries[i-1]) && isUser(entries[i]) {
			errs = append(errs, verr("ALTERNATING_MESSAGES", i))
			break
		}
		if isAssistant(entries[i-1]) && isAssistant(entries[i]) {
			e := verr("ALTERNATING_MESSAGES", i)
			e.message = "Between every two assistant messages there must be a user message"
			errs = append(errs, e)
			break
		}
	}
	errs = append(errs, validateToolStructure(entries)...)
	for i, e := range entries {
		if isUser(e) && !hasText(e) && !hasToolResults(e) {
			errs = append(errs, verr("NON_EMPTY_USER_MESSAGE", i))
			break
		}
	}
	return errs
}

func validateToolStructure(entries []*historyEntry) []*validationError {
	var errs []*validationError
	if e := validateToolUsesAndResults(entries); e != nil {
		errs = append(errs, e)
	}
	if e := validateToolResultOrphanIDs(entries); e != nil {
		errs = append(errs, e)
	}
	return errs
}

func validateToolUsesAndResults(entries []*historyEntry) *validationError {
	for i := 0; i < len(entries)-1; i++ {
		cur, next := entries[i], entries[i+1]
		if isAssistant(cur) && hasToolUses(cur) && (!isUser(next) || !toolResultsMatch(toolUseIDsOf(cur), toolResultsOf(next))) {
			return verr("TOOL_USES_AND_RESULTS", i+1)
		}
		if isAssistant(cur) && !hasToolUses(cur) && isUser(next) && hasToolResults(next) {
			return verr("TOOL_RESULTS_AND_NO_USES", i)
		}
	}
	for i, e := range entries {
		if !isUser(e) || !hasToolResults(e) {
			continue
		}
		if !isAssistant(at(entries, i-1)) {
			return verr("TOOL_RESULTS_AND_NO_USES", i)
		}
	}
	return nil
}

func validateToolResultOrphanIDs(entries []*historyEntry) *validationError {
	for i := 1; i < len(entries); i++ {
		prev, cur := entries[i-1], entries[i]
		if !isAssistant(prev) || !hasToolUses(prev) || !isUser(cur) || !hasToolResults(cur) {
			continue
		}
		valid := map[string]bool{}
		for _, id := range toolUseIDsOf(prev) {
			valid[id] = true
		}
		orphan, dup := false, false
		seen := map[string]bool{}
		for _, tr := range toolResultsOf(cur) {
			if tr.toolUseID == "" || !valid[tr.toolUseID] {
				orphan = true
			}
		}
		for _, tr := range toolResultsOf(cur) {
			if tr.toolUseID == "" {
				continue
			}
			if seen[tr.toolUseID] {
				dup = true
				break
			}
			seen[tr.toolUseID] = true
		}
		if orphan || dup {
			return verr("TOOL_RESULTS_ORPHAN_IDS", i)
		}
	}
	return nil
}

func syntheticFailedToolResult(id string) toolResult {
	return toolResult{toolUseID: id, text: syntheticFailedToolResultText, status: "error", synthetic: true}
}

// repairConversation is repairKiroConversation.
func repairConversation(entries []*historyEntry) (out []*historyEntry, diagnostics, remaining []*validationError) {
	diagnostics = validateConversation(entries)
	if len(diagnostics) == 0 {
		return entries, nil, nil
	}
	modelID := ""
	for _, e := range entries {
		if e.user != nil && e.user.modelID != "" {
			modelID = e.user.modelID
			break
		}
	}
	working := append([]*historyEntry{}, entries...)
	for len(working) > 0 && (!isUser(working[0]) || hasToolResults(working[0])) {
		working = working[1:]
	}
	toolOnly := func(e *historyEntry) bool { return isUser(e) && hasToolResults(e) && !hasText(e) }
	var consolidated []*historyEntry
	for i := 0; i < len(working); i++ {
		entry := working[i]
		if !toolOnly(entry) {
			consolidated = append(consolidated, entry)
			continue
		}
		j := i
		var merged []toolResult
		seen := map[string]bool{}
		for j < len(working) && toolOnly(working[j]) {
			for _, tr := range toolResultsOf(working[j]) {
				if tr.toolUseID != "" && seen[tr.toolUseID] {
					continue
				}
				if tr.toolUseID != "" {
					seen[tr.toolUseID] = true
				}
				merged = append(merged, tr)
			}
			j++
		}
		if j-i == 1 {
			consolidated = append(consolidated, entry)
		} else {
			u := entry.user.clone()
			if u.context == nil {
				u.context = &userContext{}
			}
			u.context.toolResults = merged
			consolidated = append(consolidated, &historyEntry{user: u})
		}
		i = j - 1
	}
	working = consolidated
	var repaired []*historyEntry
	for i := 0; i < len(working); i++ {
		entry := working[i]
		if isUser(entry) && hasToolResults(entry) {
			var prev *historyEntry
			if len(repaired) > 0 {
				prev = repaired[len(repaired)-1]
			}
			valid := map[string]bool{}
			for _, id := range toolUseIDsOf(prev) {
				valid[id] = true
			}
			seen := map[string]bool{}
			var kept []toolResult
			for _, tr := range toolResultsOf(entry) {
				if tr.toolUseID == "" || !valid[tr.toolUseID] || seen[tr.toolUseID] {
					continue
				}
				seen[tr.toolUseID] = true
				kept = append(kept, tr)
			}
			u := entry.user.clone()
			if len(kept) == 0 {
				tools := u.context.tools
				u.context = nil
				if tools != nil {
					u.context = &userContext{tools: tools}
				}
			} else {
				u.context.toolResults = kept
			}
			repaired = append(repaired, &historyEntry{user: u})
			continue
		}
		repaired = append(repaired, entry)
		if isAssistant(entry) && hasToolUses(entry) {
			next := at(working, i+1)
			answered := map[string]bool{}
			if isUser(next) {
				for _, tr := range toolResultsOf(next) {
					answered[tr.toolUseID] = true
				}
			}
			var unanswered []string
			for _, id := range toolUseIDsOf(entry) {
				if !answered[id] {
					unanswered = append(unanswered, id)
				}
			}
			if len(unanswered) > 0 && !isUser(next) {
				results := make([]toolResult, len(unanswered))
				for k, id := range unanswered {
					results[k] = syntheticFailedToolResult(id)
				}
				repaired = append(repaired, &historyEntry{user: &userInput{content: "", modelID: modelID, context: &userContext{toolResults: results}}})
			} else if len(unanswered) > 0 && isUser(next) {
				u := next.user.clone()
				if u.context == nil {
					u.context = &userContext{}
				}
				results := append([]toolResult{}, toolResultsOf(next)...)
				for _, id := range unanswered {
					results = append(results, syntheticFailedToolResult(id))
				}
				u.context.toolResults = results
				working[i+1] = &historyEntry{user: u}
			}
		}
	}
	final := make([]*historyEntry, len(repaired))
	for i, e := range repaired {
		if !isUser(e) || hasText(e) || hasToolResults(e) {
			final[i] = e
			continue
		}
		u := e.user.clone()
		u.content = emptyContentPlaceholder
		final[i] = &historyEntry{user: u}
	}
	return final, diagnostics, validateConversation(final)
}

func describeRemaining(errs []*validationError) string {
	parts := make([]string, 0, len(errs))
	for _, e := range errs {
		parts = append(parts, fmt.Sprintf("%s@%d", e.rule, e.index))
	}
	return strings.Join(parts, ", ")
}
