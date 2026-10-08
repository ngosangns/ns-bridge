package devin

import (
	"regexp"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

// Keywords Google's function-calling schema subset rejects.
var googleUnsupported = map[string]bool{}

func init() {
	for _, k := range strings.Fields(`$schema $id $ref $defs definitions additionalProperties patternProperties
		propertyNames minItems maxItems minLength maxLength minProperties maxProperties uniqueItems contains if then
		else not const examples default exclusiveMinimum exclusiveMaximum multipleOf contentEncoding contentMediaType
		contentSchema dependentRequired dependentSchemas unevaluatedItems unevaluatedProperties prefixItems`) {
		googleUnsupported[k] = true
	}
}

// normalizeSchemaForGoogle rewrites a JSON Schema into the subset Gemini's
// tool endpoint accepts (type arrays → type + nullable / anyOf, unsupported
// keywords dropped, default/examples folded into description).
func normalizeSchemaForGoogle(node jsjson.Value) jsjson.Value {
	switch t := node.(type) {
	case []jsjson.Value:
		out := make([]jsjson.Value, len(t))
		for i, e := range t {
			out[i] = normalizeSchemaForGoogle(e)
		}
		return out
	case *jsjson.Object:
		return normalizeSchemaObject(t)
	default:
		return node
	}
}

func normalizeSchemaObject(node *jsjson.Object) *jsjson.Object {
	out := jsjson.NewObject()
	var notes []string
	for _, key := range node.Keys() {
		raw, _ := node.Get(key)
		if googleUnsupported[key] {
			if key == "default" || key == "examples" || key == "format" {
				notes = append(notes, key+": "+jsjson.Stringify(raw))
			}
			continue
		}
		if arr, ok := raw.([]jsjson.Value); ok && key == "type" {
			var types, concrete []string
			for _, e := range arr {
				if s, ok := e.(string); ok {
					types = append(types, s)
					if s != "null" {
						concrete = append(concrete, s)
					}
				}
			}
			for _, s := range types {
				if s == "null" {
					out.Set("nullable", true)
					break
				}
			}
			if len(concrete) == 1 {
				out.Set("type", concrete[0])
			} else if len(concrete) > 1 {
				arms := make([]jsjson.Value, len(concrete))
				for i, c := range concrete {
					arm := jsjson.NewObject()
					arm.Set("type", c)
					arms[i] = arm
				}
				out.Set("anyOf", arms)
			}
			continue
		}
		if key == "properties" {
			if props, ok := raw.(*jsjson.Object); ok {
				np := jsjson.NewObject()
				for _, name := range props.Keys() {
					sub, _ := props.Get(name)
					np.Set(name, normalizeSchemaForGoogle(sub))
				}
				out.Set("properties", np)
				continue
			}
		}
		out.Set(key, normalizeSchemaForGoogle(raw))
	}
	typ, _ := out.Get("type")
	props, _ := out.Get("properties")
	_, propsIsObject := props.(*jsjson.Object)
	if typ == "object" && !propsIsObject {
		out.Set("properties", jsjson.NewObject())
	}
	props, _ = out.Get("properties")
	if _, ok := props.(*jsjson.Object); ok && !out.Has("type") {
		out.Set("type", "object")
	}
	if len(notes) > 0 {
		note := "(" + strings.Join(notes, "; ") + ")"
		if d, ok := out.Get("description"); ok {
			if s, ok := d.(string); ok && s != "" {
				out.Set("description", s+" "+note)
			} else {
				out.Set("description", note)
			}
		} else {
			out.Set("description", note)
		}
	}
	return out
}

var geminiPattern = regexp.MustCompile(`(?i)gemini`)

// isGeminiRoutedModel detects Gemini routes, including router-assigned
// server enum uids (MODEL_GOOGLE_GEMINI_*).
func isGeminiRoutedModel(candidates ...string) bool {
	for _, c := range candidates {
		if c != "" && (strings.HasPrefix(c, "MODEL_GOOGLE_GEMINI_") || geminiPattern.MatchString(c)) {
			return true
		}
	}
	return false
}
