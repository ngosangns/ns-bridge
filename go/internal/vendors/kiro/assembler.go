package kiro

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
	"github.com/ngosangns/ns-bridge/go/internal/redact"
	"github.com/ngosangns/ns-bridge/go/internal/tiktoken"
)

// --- blocks.ts ---

type block struct {
	kind  string // text | thinking | toolCall
	text  string
	ended bool
}

type blockBuffer struct {
	blocks map[int]*block
	order  []int
	next   int
	emit   func(bridge.Event)
}

func newBlockBuffer(emit func(bridge.Event)) *blockBuffer {
	return &blockBuffer{blocks: map[int]*block{}, emit: emit}
}

func (b *blockBuffer) add(kind string, ended bool) int {
	i := b.next
	b.next++
	b.blocks[i] = &block{kind: kind, ended: ended}
	b.order = append(b.order, i)
	return i
}

func (b *blockBuffer) openText() int {
	i := b.add("text", false)
	b.emit(bridge.TextStart(i))
	return i
}

func (b *blockBuffer) appendText(i int, delta string) {
	blk := b.blocks[i]
	if blk == nil || delta == "" {
		return
	}
	blk.text += delta
	b.emit(bridge.TextDelta(i, delta))
}

func (b *blockBuffer) endText(i int) {
	blk := b.blocks[i]
	if blk == nil || blk.ended {
		return
	}
	blk.ended = true
	b.emit(bridge.TextEnd(i, blk.text))
}

func (b *blockBuffer) openThinking() int {
	i := b.add("thinking", false)
	b.emit(bridge.ThinkingStart(i))
	return i
}

func (b *blockBuffer) appendThinking(i int, delta string) {
	blk := b.blocks[i]
	if blk == nil || delta == "" {
		return
	}
	blk.text += delta
	b.emit(bridge.ThinkingDelta(i, delta))
}

func (b *blockBuffer) endThinking(i int, signature string) {
	blk := b.blocks[i]
	if blk == nil || blk.ended {
		return
	}
	blk.ended = true
	b.emit(bridge.ThinkingEnd(i, blk.text, signature))
}

func (b *blockBuffer) reserve() int { return b.add("toolCall", true) }

func (b *blockBuffer) getText(i int) string {
	if blk := b.blocks[i]; blk != nil {
		return blk.text
	}
	return ""
}

func (b *blockBuffer) setText(i int, text string) {
	if blk := b.blocks[i]; blk != nil {
		blk.text = text
	}
}

func (b *blockBuffer) kinds() []string {
	out := make([]string, 0, len(b.order))
	for _, i := range b.order {
		out = append(out, b.blocks[i].kind)
	}
	return out
}

func (b *blockBuffer) reset() {
	b.blocks = map[int]*block{}
	b.order = nil
	b.emit(bridge.Reset())
}

// --- thinking-parser.ts ---

type tagVariant struct{ open, close string }

var thinkingVariants = []tagVariant{
	{"<thinking>", "</thinking>"},
	{"<think>", "</think>"},
	{"<reasoning>", "</reasoning>"},
	{"<thought>", "</thought>"},
}

func trailingTagPrefixLen(text, tag string) int {
	max := len(tag) - 1
	if len(text) < max {
		max = len(text)
	}
	for l := max; l > 0; l-- {
		if strings.HasSuffix(text, tag[:l]) {
			return l
		}
	}
	return 0
}

type thinkingParser struct {
	blocks        *blockBuffer
	buffer        string
	inThinking    bool
	thinkingIndex int // -1 = none
	textIndex     int
	lastTextIndex int
	activeEnd     string
}

func newThinkingParser(b *blockBuffer) *thinkingParser {
	return &thinkingParser{blocks: b, thinkingIndex: -1, textIndex: -1, lastTextIndex: -1, activeEnd: "</thinking>"}
}

func (p *thinkingParser) processChunk(chunk string) {
	p.buffer += chunk
	for len(p.buffer) > 0 {
		prev := len(p.buffer)
		if !p.inThinking {
			p.beforeThinking()
			if len(p.buffer) == 0 {
				break
			}
		}
		if p.inThinking {
			p.insideThinking()
			if len(p.buffer) == 0 {
				break
			}
		}
		if len(p.buffer) >= prev {
			break
		}
	}
}

func (p *thinkingParser) finalize() {
	if p.buffer == "" {
		return
	}
	if p.inThinking && p.thinkingIndex >= 0 {
		p.blocks.appendThinking(p.thinkingIndex, p.buffer)
		p.blocks.endThinking(p.thinkingIndex, "")
	} else {
		p.emitText(p.buffer)
	}
	p.buffer = ""
}

func (p *thinkingParser) textBlockIndex() int {
	if p.textIndex >= 0 {
		return p.textIndex
	}
	return p.lastTextIndex
}

func (p *thinkingParser) beforeThinking() {
	bestPos := -1
	var best tagVariant
	for _, v := range thinkingVariants {
		if pos := strings.Index(p.buffer, v.open); pos >= 0 && (bestPos < 0 || pos < bestPos) {
			bestPos, best = pos, v
		}
	}
	if bestPos >= 0 {
		if bestPos > 0 {
			p.emitText(p.buffer[:bestPos])
		}
		p.buffer = p.buffer[bestPos+len(best.open):]
		p.activeEnd = best.close
		p.inThinking = true
		return
	}
	trailing := 0
	for _, v := range thinkingVariants {
		if l := trailingTagPrefixLen(p.buffer, v.open); l > trailing {
			trailing = l
		}
	}
	if safe := len(p.buffer) - trailing; safe > 0 {
		p.emitText(p.buffer[:safe])
		p.buffer = p.buffer[safe:]
	}
}

func (p *thinkingParser) insideThinking() {
	if end := strings.Index(p.buffer, p.activeEnd); end >= 0 {
		if end > 0 {
			p.emitThinking(p.buffer[:end])
		}
		p.blocks.endThinking(p.ensureThinking(), "")
		p.buffer = p.buffer[end+len(p.activeEnd):]
		p.inThinking = false
		p.thinkingIndex = -1
		p.activeEnd = "</thinking>"
		if p.textIndex >= 0 {
			p.lastTextIndex = p.textIndex
		}
		p.textIndex = -1
		p.buffer = strings.TrimPrefix(p.buffer, "\n\n")
		return
	}
	trailing := trailingTagPrefixLen(p.buffer, p.activeEnd)
	if safe := len(p.buffer) - trailing; safe > 0 {
		p.emitThinking(p.buffer[:safe])
		p.buffer = p.buffer[safe:]
	}
}

func (p *thinkingParser) emitText(text string) {
	if text == "" {
		return
	}
	if p.textIndex < 0 {
		p.textIndex = p.blocks.openText()
	}
	p.blocks.appendText(p.textIndex, text)
}

func (p *thinkingParser) ensureThinking() int {
	if p.thinkingIndex < 0 {
		p.thinkingIndex = p.blocks.openThinking()
	}
	return p.thinkingIndex
}

func (p *thinkingParser) emitThinking(text string) {
	if text == "" {
		return
	}
	p.blocks.appendThinking(p.ensureThinking(), text)
}

// --- response-assembler.ts ---

var echoNoise = regexp.MustCompile(`(?i)^[` + jsstr.SpaceClass + `]*(continue|\.+)[` + jsstr.SpaceClass + `]*$`)

type toolCallState struct {
	toolUseID, name, input string
}

type attemptSummary struct {
	responseText     string
	hasText          bool
	sawAnyToolCalls  bool
	emittedToolCalls int
	isEchoLoop       bool
	isEmpty          bool
	stopReason       string
	droppedToolCalls []string
	wireStopReason   *string
	wireStopDetails  *jsjson.Object
}

type assembler struct {
	model           *Model
	thinkingEnabled bool
	aliases         map[string]string
	declared        map[string]bool

	pending []bridge.Event
	blocks  *blockBuffer
	usage   bridge.Usage

	totalContent         strings.Builder
	usageEvent           *wireUsage
	meteringEvent        *metering
	receivedContextUsage bool
	thinking             *thinkingParser
	nativeThinkingIndex  int
	nativeThinkingEnded  bool
	textIndex            int
	emittedToolCalls     int
	sawAnyToolCalls      bool
	droppedToolCalls     []string
	current              *toolCallState
	stopReason           string
}

func newAssembler(model *Model, thinkingEnabled bool, aliases map[string]string, declared map[string]bool) *assembler {
	a := &assembler{model: model, thinkingEnabled: thinkingEnabled, aliases: aliases, declared: declared, stopReason: "stop", nativeThinkingIndex: -1, textIndex: -1}
	a.blocks = newBlockBuffer(func(e bridge.Event) { a.pending = append(a.pending, e) })
	return a
}

var toolNameAliasTable = map[string]string{
	"read_file": "read", "readfile": "read", "fs_read": "read", "view_file": "read",
	"write_file": "write", "writefile": "write", "fs_write": "write", "create_file": "write",
	"edit_file": "edit", "editfile": "edit", "str_replace": "edit", "str_replace_editor": "edit",
	"str_replace_based_edit_tool": "edit", "apply_patch": "edit",
	"list_directory": "ls", "list_dir": "ls", "list_files": "ls",
	"find_files": "find", "file_search": "find",
}

func (a *assembler) originalToolName(name string) string {
	if alias, ok := a.aliases[name]; ok {
		name = alias
	}
	if len(a.declared) == 0 || a.declared[name] {
		return name
	}
	if alias, ok := toolNameAliasTable[strings.ToLower(name)]; ok && a.declared[alias] {
		return alias
	}
	return name
}

func (a *assembler) beginAttempt() {
	a.totalContent.Reset()
	a.usageEvent = nil
	a.meteringEvent = nil
	a.receivedContextUsage = false
	a.thinking = nil
	if a.thinkingEnabled {
		a.thinking = newThinkingParser(a.blocks)
	}
	a.nativeThinkingIndex = -1
	a.nativeThinkingEnded = false
	a.textIndex = -1
	a.emittedToolCalls = 0
	a.sawAnyToolCalls = false
	a.droppedToolCalls = nil
	a.current = nil
	a.usage = bridge.Usage{}
}

func (a *assembler) takeEvents() []bridge.Event {
	out := a.pending
	a.pending = nil
	return out
}

func (a *assembler) discard() {
	a.blocks.reset()
	a.textIndex = -1
}

func jsRound(f float64) int { return int(math.Floor(f + 0.5)) }

func (a *assembler) handle(ev *wireEvent) {
	switch ev.Type {
	case "contextUsage":
		a.usage.Input = jsRound(ev.Pct / 100 * a.model.ContextWindow)
		pct := ev.Pct
		a.usage.ContextPercent = &pct
		a.receivedContextUsage = true
	case "thinkingText":
		if !a.thinkingEnabled {
			return
		}
		a.blocks.appendThinking(a.ensureNativeThinking(), ev.Str)
		a.totalContent.WriteString(ev.Str)
	case "thinkingSignature":
		if !a.thinkingEnabled {
			return
		}
		a.ensureNativeThinking()
		a.endNativeThinking(ev.Str)
	case "content":
		if ev.Str == "" {
			return
		}
		a.endNativeThinking("")
		a.totalContent.WriteString(ev.Str)
		if a.thinking != nil {
			a.thinking.processChunk(ev.Str)
		} else {
			if a.textIndex < 0 {
				a.textIndex = a.blocks.openText()
			}
			a.blocks.appendText(a.textIndex, ev.Str)
		}
	case "toolUse":
		a.sawAnyToolCalls = true
		if a.current == nil || a.current.toolUseID != ev.ToolUseID {
			a.flushToolCall()
			a.current = &toolCallState{toolUseID: ev.ToolUseID, name: a.originalToolName(ev.Name)}
		}
		a.current.input += ev.Input
		a.totalContent.WriteString(ev.Input)
		if ev.Stop != nil && *ev.Stop {
			a.flushToolCall()
		}
	case "toolUseInput":
		if a.current != nil {
			a.current.input += ev.Input
		}
		a.totalContent.WriteString(ev.Input)
	case "toolUseStop":
		if ev.Stop != nil && *ev.Stop {
			a.flushToolCall()
		}
	case "usage":
		if a.usageEvent == nil {
			a.usageEvent = &wireUsage{}
		}
		a.usageEvent.merge(ev.Usage)
		if pct := ev.Usage.ContextUsagePercentage; pct != nil {
			if a.usageEvent.InputTokens == nil {
				a.usage.Input = jsRound(*pct / 100 * a.model.ContextWindow)
			}
			p := *pct
			a.usage.ContextPercent = &p
			a.receivedContextUsage = true
		}
	case "metering":
		a.meteringEvent = ev.Metering
	}
}

func (a *assembler) endTurn() attemptSummary {
	if a.current != nil {
		if a.emitToolCall(a.current) {
			a.emittedToolCalls++
		} else {
			a.droppedToolCalls = append(a.droppedToolCalls, a.current.name)
		}
	}
	a.current = nil
	a.endNativeThinking("")
	if a.thinking != nil {
		a.thinking.finalize()
		a.textIndex = a.thinking.textBlockIndex()
	}
	a.recoverTextToolCalls()
	a.stripEchoNoise()
	responseText := ""
	if a.textIndex >= 0 {
		responseText = a.blocks.getText(a.textIndex)
	}
	hasText := responseText != ""
	var wireStop *string
	if a.usageEvent != nil {
		wireStop = a.usageEvent.RawStopReason
	}
	switch {
	case wireStop != nil && *wireStop == "MAX_TOKENS":
		a.stopReason = "length"
	case wireStop != nil && (*wireStop == "END_TURN" || *wireStop == "TOOL_USE"):
		a.stopReason = "stop"
		if a.emittedToolCalls > 0 {
			a.stopReason = "toolUse"
		}
	default:
		switch {
		case !a.receivedContextUsage && a.emittedToolCalls == 0:
			a.stopReason = "length"
		case a.emittedToolCalls > 0:
			a.stopReason = "toolUse"
		default:
			a.stopReason = "stop"
		}
	}
	s := attemptSummary{
		responseText: responseText, hasText: hasText, sawAnyToolCalls: a.sawAnyToolCalls,
		emittedToolCalls: a.emittedToolCalls, isEchoLoop: hasText && !a.sawAnyToolCalls && echoNoise.MatchString(responseText),
		isEmpty: !hasText && !a.sawAnyToolCalls, stopReason: a.stopReason, droppedToolCalls: a.droppedToolCalls, wireStopReason: wireStop,
	}
	if a.usageEvent != nil {
		s.wireStopDetails = a.usageEvent.StopDetails
	}
	return s
}

func (a *assembler) stripEcho() {
	if a.textIndex >= 0 {
		a.blocks.setText(a.textIndex, "")
	}
}

func (a *assembler) contentKinds() []string { return a.blocks.kinds() }

func f64p(f float64) *float64 { return &f }

// complete is KiroResponseAssembler.complete.
func (a *assembler) complete() (stop string, usage bridge.Usage, wire *wireUsage, meter *metering, err error) {
	if a.textIndex >= 0 {
		a.blocks.endText(a.textIndex)
	}
	u := a.usageEvent
	if u != nil && u.InputTokens != nil {
		a.usage.Input = int(*u.InputTokens)
	}
	if u != nil && u.OutputTokens != nil {
		a.usage.Output = int(*u.OutputTokens)
	} else {
		n, cerr := tiktoken.CountTokens(a.totalContent.String())
		if cerr != nil {
			return "", bridge.Usage{}, nil, nil, cerr
		}
		a.usage.Output = n
	}
	if u != nil && u.TotalTokens != nil {
		a.usage.TotalTokens = int(*u.TotalTokens)
	} else {
		total := float64(a.usage.Input) + float64(a.usage.Output)
		if u != nil && u.CacheReadInputTokens != nil {
			total += *u.CacheReadInputTokens
		}
		if u != nil && u.CacheWriteInputTokens != nil {
			total += *u.CacheWriteInputTokens
		}
		a.usage.TotalTokens = int(total)
	}
	if u != nil && u.CacheReadInputTokens != nil {
		v := int(*u.CacheReadInputTokens)
		a.usage.CacheRead = &v
	}
	if u != nil && u.CacheWriteInputTokens != nil {
		v := int(*u.CacheWriteInputTokens)
		a.usage.CacheWrite = &v
	}
	if a.meteringEvent != nil && a.meteringEvent.Credits != nil {
		a.usage.Credits = f64p(*a.meteringEvent.Credits)
	}
	if a.meteringEvent != nil && a.meteringEvent.Unit != nil {
		a.usage.CreditUnit = *a.meteringEvent.Unit
	}
	a.usage.Cost = calculateCost(a.model.Cost, &a.usage)
	if debugEnabled() {
		debugLog("response.done", map[string]any{
			"stopReason": a.stopReason, "receivedContextUsage": a.receivedContextUsage, "emittedToolCalls": a.emittedToolCalls,
			"sawAnyToolCalls": a.sawAnyToolCalls, "textLen": jsstr.Len(a.blocks.getText(a.textIndex)), "usage": a.usage,
		})
	}
	return a.stopReason, a.usage, a.usageEvent, a.meteringEvent, nil
}

func calculateCost(c Cost, u *bridge.Usage) bridge.Cost {
	in := float64(u.Input) * c.Input / 1e6
	out := float64(u.Output) * c.Output / 1e6
	cr, cw := 0.0, 0.0
	if u.CacheRead != nil {
		cr = float64(*u.CacheRead) * c.CacheRead / 1e6
	}
	if u.CacheWrite != nil {
		cw = float64(*u.CacheWrite) * c.CacheWrite / 1e6
	}
	return bridge.Cost{Input: in, Output: out, CacheRead: cr, CacheWrite: cw, Total: in + out + cr + cw}
}

func (a *assembler) ensureNativeThinking() int {
	if a.nativeThinkingIndex < 0 {
		a.nativeThinkingIndex = a.blocks.openThinking()
	}
	return a.nativeThinkingIndex
}

func (a *assembler) endNativeThinking(signature string) {
	if a.nativeThinkingIndex < 0 || a.nativeThinkingEnded {
		return
	}
	a.nativeThinkingEnded = true
	a.blocks.endThinking(a.nativeThinkingIndex, signature)
}

func (a *assembler) emitToolCall(s *toolCallState) bool {
	if jsstr.Trim(s.input) == "" {
		s.input = "{}"
	}
	args, err := jsjson.Parse([]byte(s.input))
	if err != nil {
		logx.Warn(fmt.Sprintf("[kiro-core] Failed to parse tool input for %q (toolUseId: %s): %s. Raw input (%d chars): %s",
			s.name, s.toolUseID, redact.Kiro(err.Error()), jsstr.Len(s.input), redact.Kiro(jsstr.Slice(s.input, 0, 200))))
		return false
	}
	i := a.blocks.reserve()
	a.pending = append(a.pending,
		bridge.ToolCallStart(i, s.toolUseID, s.name),
		bridge.ToolCallDelta(i, s.toolUseID, s.input),
		bridge.ToolCallEnd(i, s.toolUseID, s.name, json.RawMessage(jsjson.Stringify(args)), nil),
	)
	return true
}

func (a *assembler) flushToolCall() {
	if a.current == nil {
		return
	}
	if a.emitToolCall(a.current) {
		a.emittedToolCalls++
	} else {
		a.droppedToolCalls = append(a.droppedToolCalls, a.current.name)
	}
	a.current = nil
}

func (a *assembler) recoverTextToolCalls() {
	if (a.model.RecoverTextToolCalls != nil && !*a.model.RecoverTextToolCalls) || a.sawAnyToolCalls || a.textIndex < 0 {
		return
	}
	text := a.blocks.getText(a.textIndex)
	var recovered []recoveredCall
	if calls, cleaned := parseBracketToolCalls(text); len(calls) > 0 {
		text = cleaned
		recovered = append(recovered, calls...)
	}
	if calls, cleaned := parseInvokeToolCalls(text); len(calls) > 0 {
		text = cleaned
		recovered = append(recovered, calls...)
	}
	if calls, cleaned := parseToolUseCalls(text); len(calls) > 0 {
		text = cleaned
		recovered = append(recovered, calls...)
	}
	if len(recovered) == 0 {
		return
	}
	a.blocks.setText(a.textIndex, text)
	a.sawAnyToolCalls = true
	for _, c := range recovered {
		if a.emitToolCall(&toolCallState{toolUseID: c.toolUseID, name: a.originalToolName(c.name), input: jsjson.Stringify(c.arguments)}) {
			a.emittedToolCalls++
		} else {
			a.droppedToolCalls = append(a.droppedToolCalls, a.originalToolName(c.name))
		}
	}
}

func (a *assembler) stripEchoNoise() {
	if a.emittedToolCalls == 0 || a.textIndex < 0 {
		return
	}
	if echoNoise.MatchString(a.blocks.getText(a.textIndex)) {
		a.blocks.setText(a.textIndex, "")
	}
}
