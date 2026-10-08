package kiro

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
)

const (
	toolResultLimit         = 250000
	emptyContentPlaceholder = "Please proceed with the task."
	truncationNotice        = "[NOTE: Your previous response was cut off due to length limits. Please continue from where you left off.]"
	historyLimit            = 850000
	historyLimitContext     = 200000
	historyImageBase64Limit = 512 * 1024
)

type image struct {
	format string
	bytes  string
}

type toolResult struct {
	text      string
	status    string // "success" | "error"
	toolUseID string
	synthetic bool // built as {toolUseId, content, status}
}

type toolSpec struct {
	name        string
	description *string
	schema      jsjson.Value
}

type toolUse struct {
	name      string
	toolUseID string
	input     *jsjson.Object
}

type userContext struct {
	toolResults []toolResult // nil = absent
	tools       []toolSpec   // nil = absent
}

type userInput struct {
	content string
	modelID string
	images  []image // nil = absent
	context *userContext
}

type assistantResponse struct {
	content  string
	toolUses []toolUse // nil = absent
}

type historyEntry struct {
	user      *userInput
	assistant *assistantResponse
}

func (u *userInput) clone() *userInput {
	c := *u
	if u.context != nil {
		ctx := *u.context
		c.context = &ctx
	}
	return &c
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func truncate(text string, limit int) string {
	if jsstr.Len(text) <= limit {
		return text
	}
	half := limit / 2
	n := jsstr.Len(text)
	return jsstr.Slice(text, 0, half) + "\n... [TRUNCATED] ...\n" + jsstr.Slice(text, n-half, -1)
}

var toolUseIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,64}$`)
var toolNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func toKiroToolUseID(id string) string {
	if toolUseIDPattern.MatchString(id) {
		return id
	}
	sum := sha256.Sum256([]byte(id))
	return "pi_" + b64url(sum[:])[:32]
}

func toKiroToolName(name string) string {
	if toolNamePattern.MatchString(name) {
		return name
	}
	var clean strings.Builder
	for _, r := range name {
		if r < 0x80 && (r == '_' || r == '-' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			clean.WriteRune(r)
		} else {
			clean.WriteString(strings.Repeat("_", utf16.RuneLen(r)))
		}
	}
	c := clean.String()
	if len(c) > 55 {
		c = c[:55]
	}
	if c == "" {
		c = "tool"
	}
	sum := sha256.Sum256([]byte(name))
	return c + "_" + b64url(sum[:])[:8]
}

// toolNameAliases is kiroToolNameAliases: wire name → declared name.
func toolNameAliases(tools []Tool) map[string]string {
	out := map[string]string{}
	for _, t := range tools {
		if w := toKiroToolName(t.Name); w != t.Name {
			out[w] = t.Name
		}
	}
	return out
}

func normalizeMessages(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for _, m := range messages {
		if m.Role == "assistant" && (m.StopReason == "error" || m.StopReason == "aborted") {
			continue
		}
		out = append(out, m)
	}
	return out
}

func relocateDisplacedToolResults(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	pending := append([]Message(nil), messages...)
	for len(pending) > 0 {
		msg := pending[0]
		pending = pending[1:]
		out = append(out, msg)
		if msg.Role != "assistant" {
			continue
		}
		for _, block := range msg.Content {
			if block.Type != "toolCall" {
				continue
			}
			for at, p := range pending {
				if p.Role == "toolResult" && p.ToolCallID == block.ID {
					out = append(out, p)
					pending = append(pending[:at:at], pending[at+1:]...)
					break
				}
			}
		}
	}
	return out
}

type rawImage struct{ mimeType, data string }

func extractImages(m *Message) []rawImage {
	var out []rawImage
	for _, c := range m.Content {
		if c.Type == "image" {
			out = append(out, rawImage{c.MimeType, c.Data})
		}
	}
	return out
}

func contentText(m *Message) string {
	var b strings.Builder
	for _, c := range m.Content {
		switch c.Type {
		case "text":
			b.WriteString(c.Text)
		case "thinking":
			b.WriteString(c.Thinking)
		}
	}
	return b.String()
}

// jsString is String(v) for a JSON value.
func jsString(v jsjson.Value) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		n := jsjson.FormatNumber(t)
		if n == "null" {
			return "NaN"
		}
		return n
	case []jsjson.Value:
		parts := make([]string, len(t))
		for i, e := range t {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

func toKiroInputSchema(raw json.RawMessage) jsjson.Value {
	if raw != nil {
		if v, err := jsjson.Parse(raw); err == nil {
			if o, ok := v.(*jsjson.Object); ok {
				if !o.Has("type") {
					out := jsjson.NewObject()
					out.Set("type", "object")
					for _, k := range o.Keys() {
						val, _ := o.Get(k)
						out.Set(k, val)
					}
					return out
				}
				return o
			}
		}
	}
	out := jsjson.NewObject()
	out.Set("type", "object")
	out.Set("properties", jsjson.NewObject())
	return out
}

func toKiroToolDescription(raw json.RawMessage) *string {
	if raw == nil {
		return nil
	}
	v, err := jsjson.Parse(raw)
	if err != nil || v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		if s == "" {
			return nil
		}
		return &s
	}
	s := jsString(v)
	return &s
}

func convertTools(tools []Tool) []toolSpec {
	out := make([]toolSpec, 0, len(tools))
	for _, t := range tools {
		out = append(out, toolSpec{name: toKiroToolName(t.Name), description: toKiroToolDescription(t.Description), schema: toKiroInputSchema(t.Parameters)})
	}
	return out
}

var imageFormatAliases = map[string]string{"png": "png", "x-png": "png", "jpeg": "jpeg", "jpg": "jpeg", "pjpeg": "jpeg", "gif": "gif", "webp": "webp"}

func toKiroImageFormat(mimeType string) string {
	m := strings.ToLower(jsstr.Trim(mimeType))
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	if i := strings.Index(m, ";"); i >= 0 {
		m = m[:i]
	}
	return imageFormatAliases[jsstr.Trim(m)]
}

func toKiroImageBytes(data string) string {
	trimmed := jsstr.Trim(data)
	const marker = "base64,"
	if !strings.HasPrefix(trimmed, "data:") || !strings.Contains(trimmed, marker) {
		return trimmed
	}
	return trimmed[strings.Index(trimmed, marker)+len(marker):]
}

func convertImages(images []rawImage) []image {
	var out []image
	for _, img := range images {
		format := toKiroImageFormat(img.mimeType)
		bytes := toKiroImageBytes(img.data)
		if format == "" || bytes == "" {
			continue
		}
		out = append(out, image{format, bytes})
	}
	return out
}

// toKiroToolInput: a plain object, a JSON string holding one, else {}.
func toKiroToolInput(raw json.RawMessage) *jsjson.Object {
	if raw != nil {
		if v, err := jsjson.Parse(raw); err == nil {
			switch t := v.(type) {
			case *jsjson.Object:
				return t
			case string:
				if inner, err := jsjson.Parse([]byte(t)); err == nil {
					if o, ok := inner.(*jsjson.Object); ok {
						return o
					}
				}
			}
		}
	}
	return jsjson.NewObject()
}

func toolResultOf(m *Message) toolResult {
	status := "success"
	if m.IsError {
		status = "error"
	}
	return toolResult{text: truncate(contentText(m), toolResultLimit), status: status, toolUseID: toKiroToolUseID(m.ToolCallID)}
}

func joinParagraphs(prev, next string) string {
	if prev != "" && next != "" {
		return prev + "\n\n" + next
	}
	if prev != "" {
		return prev
	}
	return next
}

// buildHistory is transform.ts buildHistory.
func buildHistory(messages []Message, modelID, systemPrompt string) (history []*historyEntry, systemPrepended bool, currentStart int) {
	currentStart = len(messages) - 1
	for currentStart > 0 && messages[currentStart].Role == "toolResult" {
		currentStart--
	}
	if currentStart >= 0 {
		boundary := messages[currentStart]
		if boundary.Role == "assistant" {
			hasCall := false
			for _, b := range boundary.Content {
				if b.Type == "toolCall" {
					hasCall = true
				}
			}
			if !hasCall {
				currentStart++
			}
		}
	}
	end := currentStart
	if end < 0 {
		end = 0
	}
	hist := messages[:end]
	last := func() *historyEntry {
		if len(history) == 0 {
			return nil
		}
		return history[len(history)-1]
	}
	for i := 0; i < len(hist); i++ {
		msg := &hist[i]
		switch msg.Role {
		case "user":
			content := contentText(msg)
			if systemPrompt != "" && !systemPrepended {
				content = systemPrompt + "\n\n" + content
				systemPrepended = true
			}
			images := convertImages(extractImages(msg))
			uim := &userInput{content: content, modelID: modelID}
			if len(images) > 0 {
				uim.images = images
			}
			if prev := last(); prev != nil && prev.user != nil {
				prev.user.content = joinParagraphs(prev.user.content, uim.content)
				if uim.images != nil {
					prev.user.images = append(append([]image{}, prev.user.images...), uim.images...)
				}
			} else {
				history = append(history, &historyEntry{user: uim})
			}
		case "assistant":
			content := ""
			var uses []toolUse
			hadBlocks := false
			for _, block := range msg.Content {
				switch block.Type {
				case "text":
					content += block.Text
					hadBlocks = true
				case "thinking":
					hadBlocks = true
				case "toolCall":
					uses = append(uses, toolUse{name: toKiroToolName(block.Name), toolUseID: toKiroToolUseID(block.ID), input: toKiroToolInput(block.Arguments)})
					hadBlocks = true
				}
			}
			if content == "" && len(uses) == 0 && !hadBlocks {
				continue
			}
			history = append(history, &historyEntry{assistant: &assistantResponse{content: content, toolUses: uses}})
		default:
			results := []toolResult{toolResultOf(msg)}
			images := extractImages(msg)
			j := i + 1
			for j < len(hist) && hist[j].Role == "toolResult" {
				results = append(results, toolResultOf(&hist[j]))
				images = append(images, extractImages(&hist[j])...)
				j++
			}
			i = j - 1
			converted := convertImages(images)
			if prev := last(); prev != nil && prev.user != nil {
				if len(converted) > 0 {
					prev.user.images = append(append([]image{}, prev.user.images...), converted...)
				}
				if prev.user.context == nil {
					prev.user.context = &userContext{}
				}
				prev.user.context.toolResults = append(append([]toolResult{}, prev.user.context.toolResults...), results...)
			} else {
				uim := &userInput{content: "", modelID: modelID, context: &userContext{toolResults: results}}
				if len(converted) > 0 {
					uim.images = converted
				}
				history = append(history, &historyEntry{user: uim})
			}
		}
	}
	return history, systemPrepended, currentStart
}

// --- history.ts ---

func stripHistoryImages(history []*historyEntry, keepNewestBounded bool) []*historyEntry {
	newest := -1
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].user != nil && len(history[i].user.images) > 0 {
			newest = i
			break
		}
	}
	keepNewest := false
	if keepNewestBounded && newest >= 0 && history[newest].user.images != nil {
		size := 0
		for _, img := range history[newest].user.images {
			size += jsstr.Len(img.bytes)
		}
		keepNewest = size <= historyImageBase64Limit
	}
	out := make([]*historyEntry, len(history))
	for i, e := range history {
		if e.user == nil || e.user.images == nil || (i == newest && keepNewest) {
			out[i] = e
			continue
		}
		u := e.user.clone()
		u.images = nil
		out[i] = &historyEntry{user: u}
	}
	return out
}

func sanitizeHistory(history []*historyEntry) []*historyEntry {
	for len(history) > 0 && (history[0].user == nil || (history[0].user.context != nil && history[0].user.context.toolResults != nil)) {
		history = history[1:]
	}
	var result []*historyEntry
	for i, m := range history {
		if m.assistant != nil && m.assistant.toolUses == nil && m.assistant.content == "" {
			continue
		}
		if m.assistant != nil && m.assistant.toolUses != nil {
			if i+1 < len(history) {
				next := history[i+1]
				if next.user != nil && next.user.context != nil && next.user.context.toolResults != nil {
					result = append(result, m)
				}
			}
		} else if m.user != nil && m.user.context != nil && m.user.context.toolResults != nil {
			if len(result) > 0 {
				prev := result[len(result)-1]
				if prev.assistant != nil && prev.assistant.toolUses != nil {
					result = append(result, m)
				}
			}
		} else {
			result = append(result, m)
		}
	}
	return result
}

func injectSyntheticToolCalls(history []*historyEntry) []*historyEntry {
	valid := map[string]bool{}
	for _, e := range history {
		if e.assistant != nil {
			for _, tu := range e.assistant.toolUses {
				if tu.toolUseID != "" {
					valid[tu.toolUseID] = true
				}
			}
		}
	}
	var result []*historyEntry
	for _, e := range history {
		if e.user != nil && e.user.context != nil && e.user.context.toolResults != nil {
			var orphaned []toolResult
			for _, tr := range e.user.context.toolResults {
				if !valid[tr.toolUseID] {
					orphaned = append(orphaned, tr)
				}
			}
			if len(orphaned) > 0 {
				uses := make([]toolUse, len(orphaned))
				for i, tr := range orphaned {
					uses[i] = toolUse{name: "unknown_tool", toolUseID: tr.toolUseID, input: jsjson.NewObject()}
				}
				result = append(result, &historyEntry{assistant: &assistantResponse{content: "Tool calls were made.", toolUses: uses}})
				for _, tr := range orphaned {
					valid[tr.toolUseID] = true
				}
			}
		}
		result = append(result, e)
	}
	return result
}

func prepareHistory(history []*historyEntry, keepNewestBoundedImage bool) []*historyEntry {
	return injectSyntheticToolCalls(sanitizeHistory(stripHistoryImages(history, keepNewestBoundedImage)))
}

func addPlaceholderTools(tools []toolSpec, history []*historyEntry) []toolSpec {
	var names []string
	seen := map[string]bool{}
	for _, e := range history {
		if e.assistant == nil {
			continue
		}
		for _, tu := range e.assistant.toolUses {
			if tu.name != "" && !seen[tu.name] {
				seen[tu.name] = true
				names = append(names, tu.name)
			}
		}
	}
	if len(names) == 0 {
		return tools
	}
	existing := map[string]bool{}
	for _, t := range tools {
		if t.name != "" {
			existing[t.name] = true
		}
	}
	var missing []string
	for _, n := range names {
		if !existing[n] {
			missing = append(missing, n)
		}
	}
	if len(missing) == 0 {
		return tools
	}
	out := append([]toolSpec{}, tools...)
	desc := "Tool"
	for _, n := range missing {
		schema := jsjson.NewObject()
		schema.Set("type", "object")
		schema.Set("properties", jsjson.NewObject())
		out = append(out, toolSpec{name: n, description: &desc, schema: schema})
	}
	return out
}
