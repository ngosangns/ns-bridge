package kiro

import (
	"regexp"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

var effortOrder = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

func effortRank(e string) int {
	for i, v := range effortOrder {
		if v == e {
			return i
		}
	}
	return -1
}

type effortConfig struct {
	field              string // "reasoning" | "output_config"
	values             []string
	summarizedThinking bool
}

var gptModelPattern = regexp.MustCompile(`(^|-)gpt-`)

var claudeExtendedEffortModels = map[string]bool{
	"claude-opus-5": true, "claude-opus-4.8": true, "claude-opus-4.7": true, "claude-sonnet-5": true, "claude-fable-5": true,
}
var claudeMaxEffortModels = map[string]bool{
	"claude-opus-4.6": true, "claude-sonnet-4.6": true, "claude-opus-4.6-1m": true, "claude-sonnet-4.6-1m": true,
}

func objProp(v jsjson.Value, key string) (jsjson.Value, bool) {
	o, ok := v.(*jsjson.Object)
	if !ok {
		return nil, false
	}
	return o.Get(key)
}

func isRecord(v jsjson.Value) bool { _, ok := v.(*jsjson.Object); return ok }

func deriveEffort(schema jsjson.Value) *effortConfig {
	props, _ := objProp(schema, "properties")
	if !isRecord(schema) || !isRecord(props) {
		return nil
	}
	for _, field := range []string{"reasoning", "output_config"} {
		fieldSchema, _ := objProp(props, field)
		fieldProps, _ := objProp(fieldSchema, "properties")
		if !isRecord(fieldSchema) || !isRecord(fieldProps) {
			continue
		}
		effortSchema, _ := objProp(fieldProps, "effort")
		enum, _ := objProp(effortSchema, "enum")
		list, isList := enum.([]jsjson.Value)
		if !isRecord(effortSchema) || !isList || len(list) == 0 {
			continue
		}
		allStrings := true
		for _, v := range list {
			if s, ok := v.(string); !ok || s == "" {
				allStrings = false
				break
			}
		}
		if !allStrings {
			continue
		}
		thinking, _ := objProp(props, "thinking")
		thinkingProps, _ := objProp(thinking, "properties")
		summarized := false
		if isRecord(thinking) && isRecord(thinkingProps) {
			display, _ := objProp(thinkingProps, "display")
			denum, _ := objProp(display, "enum")
			if dl, ok := denum.([]jsjson.Value); ok && isRecord(display) {
				for _, v := range dl {
					if v == "summarized" {
						summarized = true
					}
				}
			}
		}
		seen := map[string]bool{}
		var values []string
		for _, v := range list {
			s := v.(string)
			if !seen[s] {
				seen[s] = true
				values = append(values, s)
			}
		}
		return &effortConfig{field: field, values: values, summarizedThinking: summarized}
	}
	return nil
}

// dottedVersion is .replace(/(\d)-(\d)/g, "$1.$2").
func dottedVersion(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if i+2 < len(s) && isDigit(s[i]) && s[i+1] == '-' && isDigit(s[i+2]) {
			b.WriteByte(s[i])
			b.WriteByte('.')
			b.WriteByte(s[i+2])
			i += 3
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func fallbackEffort(kiroModelID string) *effortConfig {
	id := dottedVersion(strings.ToLower(kiroModelID))
	switch {
	case gptModelPattern.MatchString(id):
		return &effortConfig{field: "reasoning", values: []string{"low", "medium", "high", "xhigh", "max"}}
	case claudeExtendedEffortModels[id]:
		return &effortConfig{field: "output_config", values: []string{"low", "medium", "high", "xhigh", "max"}, summarizedThinking: true}
	case claudeMaxEffortModels[id]:
		return &effortConfig{field: "output_config", values: []string{"low", "medium", "high", "max"}}
	}
	return nil
}

func (m *Model) effortConfig(kiroModelID string) *effortConfig {
	if m.AdditionalModelRequestFieldsSchema != nil {
		schema, err := jsjson.Parse(m.AdditionalModelRequestFieldsSchema)
		if err != nil {
			return nil
		}
		return deriveEffort(schema)
	}
	return fallbackEffort(kiroModelID)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// clampEffort is clampKiroEffort.
func clampEffort(m *Model, requested string) string {
	if requested == "" || !m.Reasoning {
		return ""
	}
	if len(m.Efforts) == 0 || contains(m.Efforts, requested) {
		return requested
	}
	rank := effortRank(requested)
	best, bestDistance := "", -1
	for _, c := range m.Efforts {
		d := effortRank(c) - rank
		if d < 0 {
			d = -d
		}
		if bestDistance < 0 || d < bestDistance {
			best, bestDistance = c, d
		}
	}
	return best
}

func mapEffortValue(m *Model, level string, cfg *effortConfig) string {
	if len(cfg.values) == 0 {
		return ""
	}
	if mapped, ok := m.EffortMap[level]; ok && contains(cfg.values, mapped) {
		return mapped
	}
	target := level
	if level == "minimal" {
		target = "low"
	}
	if contains(cfg.values, target) {
		return target
	}
	if idx := effortRank(target); idx >= 0 {
		for i := idx; i < len(effortOrder); i++ {
			if contains(cfg.values, effortOrder[i]) {
				return effortOrder[i]
			}
		}
		for i := idx - 1; i >= 0; i-- {
			if contains(cfg.values, effortOrder[i]) {
				return effortOrder[i]
			}
		}
	}
	return cfg.values[0]
}

// additionalFields is buildKiroAdditionalModelRequestFields (nil = none).
func additionalFields(m *Model, kiroModelID, level string) *jsjson.Object {
	if level == "" || !m.Reasoning {
		return nil
	}
	cfg := m.effortConfig(kiroModelID)
	if cfg == nil {
		return nil
	}
	clamped := clampEffort(m, level)
	if clamped == "" {
		return nil
	}
	effort := mapEffortValue(m, clamped, cfg)
	if effort == "" {
		return nil
	}
	out := jsjson.NewObject()
	inner := jsjson.NewObject()
	inner.Set("effort", effort)
	if cfg.field == "output_config" {
		out.Set("output_config", inner)
		thinking := jsjson.NewObject()
		thinking.Set("type", "adaptive")
		if cfg.summarizedThinking {
			thinking.Set("display", "summarized")
		}
		out.Set("thinking", thinking)
	} else {
		out.Set("reasoning", inner)
	}
	return out
}
