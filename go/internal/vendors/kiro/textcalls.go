package kiro

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
)

// recoveredCall is a tool call lifted out of the model's prose.
type recoveredCall struct {
	toolUseID string
	name      string
	arguments jsjson.Value
}

// newUUID is crypto.randomUUID (swappable for tests).
var newUUID = func() string { return uuid.NewString() }

type span struct{ start, end int }

func removeSpans(text string, spans []span) string {
	for i := len(spans) - 1; i >= 0; i-- {
		text = text[:spans[i].start] + text[spans[i].end:]
	}
	return text
}

// findJSONEnd is bracket-tool-parser's findJsonEnd (byte offsets; the
// structural characters are ASCII so offsets agree with UTF-16 ones).
func findJSONEnd(text string, start int) int {
	depth := 0
	inString, escape := false, false
	for i := start; i < len(text); i++ {
		c := text[i]
		if escape {
			escape = false
			continue
		}
		if c == '\\' {
			escape = true
			continue
		}
		if c == '"' {
			inString = !inString
			continue
		}
		if !inString {
			if c == '{' {
				depth++
			} else if c == '}' {
				depth--
				if depth == 0 {
					return i
				}
			}
		}
	}
	return -1
}

var bracketPattern = regexp.MustCompile(`\[Called[` + jsstr.SpaceClass + `]+([\w-]+)[` + jsstr.SpaceClass + `]+with[` + jsstr.SpaceClass + `]+args:[` + jsstr.SpaceClass + `]*`)

func parseBracketToolCalls(text string) ([]recoveredCall, string) {
	var calls []recoveredCall
	var removals []span
	for _, m := range bracketPattern.FindAllStringSubmatchIndex(text, -1) {
		name := text[m[2]:m[3]]
		jsonStart := m[1]
		brace := strings.Index(text[jsonStart:], "{")
		if brace != 0 {
			continue
		}
		end := findJSONEnd(text, jsonStart)
		if end < 0 {
			continue
		}
		after := strings.Index(text[end+1:], "]")
		if after < 0 {
			continue
		}
		after += end + 1
		if jsstr.Trim(text[end+1:after]) != "" {
			continue
		}
		args, err := jsjson.Parse([]byte(text[jsonStart : end+1]))
		if err != nil {
			continue
		}
		calls = append(calls, recoveredCall{toolUseID: newUUID(), name: name, arguments: args})
		removals = append(removals, span{m[0], after + 1})
	}
	return calls, removeSpans(text, removals)
}

const fence = "```"

func fencedRanges(text string) []span {
	var out []span
	from := 0
	for {
		open := strings.Index(text[from:], fence)
		if open < 0 {
			break
		}
		open += from
		close := strings.Index(text[open+len(fence):], fence)
		if close < 0 {
			out = append(out, span{open, len(text)})
			break
		}
		close += open + len(fence)
		out = append(out, span{open, close + len(fence)})
		from = close + len(fence)
	}
	return out
}

func containingFence(fences []span, pos int) *span {
	for i := range fences {
		if pos >= fences[i].start && pos < fences[i].end {
			return &fences[i]
		}
	}
	return nil
}

var (
	invokeOpenAnchored = regexp.MustCompile(`^<invoke name="([\w-]+)">`)
	invokeOpenAnywhere = regexp.MustCompile(`<invoke name="[\w-]+">`)
	paramOpenAnchored  = regexp.MustCompile(`^<parameter name="([^"]*)">`)
)

const (
	invokeOpenSearch = "<invoke name="
	invokeClose      = "</invoke>"
	paramClose       = "</parameter>"
)

// parseInvokeBlock returns (name, args, end, ok); ambiguous means give up.
func parseInvokeBlock(text string, start int) (string, *jsjson.Object, int, bool, bool) {
	open := invokeOpenAnchored.FindStringSubmatch(text[start:])
	if open == nil {
		return "", nil, 0, false, false
	}
	args := jsjson.NewObject()
	cursor := start + len(open[0])
	for {
		rest := text[cursor:]
		cursor += len(rest) - len(jsstr.TrimStart(rest))
		if strings.HasPrefix(text[cursor:], invokeClose) {
			end := cursor + len(invokeClose)
			if end < len(text) {
				r, _ := utf8.DecodeRuneInString(text[end:])
				if !jsstr.IsSpace(r) {
					return "", nil, 0, false, false
				}
			}
			return open[1], args, end, true, false
		}
		param := paramOpenAnchored.FindStringSubmatch(text[cursor:])
		if param == nil {
			return "", nil, 0, false, false
		}
		valueStart := cursor + len(param[0])
		valueEnd := strings.Index(text[valueStart:], paramClose)
		if valueEnd < 0 {
			return "", nil, 0, false, false
		}
		valueEnd += valueStart
		value := text[valueStart:valueEnd]
		if invokeOpenAnywhere.MatchString(value) {
			return "", nil, 0, false, true
		}
		args.Set(param[1], value)
		cursor = valueEnd + len(paramClose)
	}
}

func parseInvokeToolCalls(text string) ([]recoveredCall, string) {
	var calls []recoveredCall
	var removals []span
	fences := fencedRanges(text)
	cursor := 0
	for cursor < len(text) {
		openStart := strings.Index(text[cursor:], invokeOpenSearch)
		if openStart < 0 {
			break
		}
		openStart += cursor
		if f := containingFence(fences, openStart); f != nil {
			cursor = f.end
			continue
		}
		name, args, end, ok, ambiguous := parseInvokeBlock(text, openStart)
		if ambiguous || !ok {
			return nil, text
		}
		nextOpen := strings.Index(text[end:], invokeOpenSearch)
		interstitialEnd := len(text)
		if nextOpen >= 0 {
			interstitialEnd = end + nextOpen
		}
		interstitial := text[end:interstitialEnd]
		if strings.Contains(interstitial, paramClose) || strings.Contains(interstitial, invokeClose) {
			return nil, text
		}
		calls = append(calls, recoveredCall{toolUseID: newUUID(), name: name, arguments: args})
		removals = append(removals, span{openStart, end})
		cursor = end
	}
	return calls, removeSpans(text, removals)
}

var toolTagNames = []string{"tool_use", "tool_call", "function_call", "tool"}

type tagHit struct{ openStart, bodyStart, closeIdx, closeEnd int }

func nextTagBlock(text string, from int) *tagHit {
	var best *tagHit
	for _, name := range toolTagNames {
		open, close := "<"+name+">", "</"+name+">"
		openStart := strings.Index(text[from:], open)
		if openStart < 0 {
			continue
		}
		openStart += from
		if best != nil && openStart >= best.openStart {
			continue
		}
		bodyStart := openStart + len(open)
		closeIdx := strings.Index(text[bodyStart:], close)
		if closeIdx < 0 {
			continue
		}
		closeIdx += bodyStart
		best = &tagHit{openStart, bodyStart, closeIdx, closeIdx + len(close)}
	}
	return best
}

type descriptor struct {
	name string
	args jsjson.Value
}

func normalizeDescriptor(v jsjson.Value) *descriptor {
	rec, ok := v.(*jsjson.Object)
	if !ok {
		return nil
	}
	rawName := get(rec, "tool_name")
	if rawName == nil {
		rawName = get(rec, "name")
	}
	name, ok := rawName.(string)
	if !ok || name == "" {
		return nil
	}
	// rawArgs = tool_input ?? input ?? arguments
	var rawArgs jsjson.Value
	if v := get(rec, "tool_input"); v != nil {
		rawArgs = v
	} else if v := get(rec, "input"); v != nil {
		rawArgs = v
	} else if !has(rec, "arguments") {
		return &descriptor{name: name, args: jsjson.NewObject()}
	} else {
		rawArgs = get(rec, "arguments")
	}
	if _, ok := rawArgs.(*jsjson.Object); !ok {
		return nil
	}
	return &descriptor{name: name, args: rawArgs}
}

func extractDescriptors(v jsjson.Value) []descriptor {
	if rec, ok := v.(*jsjson.Object); ok {
		wrapped := get(rec, "tool_calls")
		if wrapped == nil {
			wrapped = get(rec, "calls")
		}
		if list, ok := wrapped.([]jsjson.Value); ok {
			var out []descriptor
			for _, entry := range list {
				d := normalizeDescriptor(entry)
				if d == nil {
					return nil
				}
				out = append(out, *d)
			}
			return out
		}
	}
	if d := normalizeDescriptor(v); d != nil {
		return []descriptor{*d}
	}
	return nil
}

func parseToolUseCalls(text string) ([]recoveredCall, string) {
	var calls []recoveredCall
	var removals []span
	fences := fencedRanges(text)
	cursor := 0
	for cursor < len(text) {
		hit := nextTagBlock(text, cursor)
		if hit == nil {
			break
		}
		if f := containingFence(fences, hit.openStart); f != nil {
			cursor = f.end
			continue
		}
		braceStart := strings.Index(text[hit.bodyStart:], "{")
		if braceStart < 0 || braceStart+hit.bodyStart > hit.closeIdx {
			cursor = hit.closeEnd
			continue
		}
		braceStart += hit.bodyStart
		braceEnd := findJSONEnd(text, braceStart)
		if braceEnd < 0 || braceEnd > hit.closeIdx {
			cursor = hit.closeEnd
			continue
		}
		if jsstr.Trim(text[hit.bodyStart:braceStart]) != "" || jsstr.Trim(text[braceEnd+1:hit.closeIdx]) != "" {
			cursor = hit.closeEnd
			continue
		}
		var descs []descriptor
		if v, err := jsjson.Parse([]byte(text[braceStart : braceEnd+1])); err == nil {
			descs = extractDescriptors(v)
		}
		if len(descs) == 0 {
			cursor = hit.closeEnd
			continue
		}
		for _, d := range descs {
			calls = append(calls, recoveredCall{toolUseID: newUUID(), name: d.name, arguments: d.args})
		}
		removals = append(removals, span{hit.openStart, hit.closeEnd})
		cursor = hit.closeEnd
	}
	return calls, removeSpans(text, removals)
}
