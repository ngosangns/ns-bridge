// Package jsjson reads and writes JSON the way JavaScript's JSON.parse and
// JSON.stringify do, so a Go core can produce byte-identical request bodies
// to the TypeScript cores it replaces: object keys keep JavaScript's order
// (integer-like keys first, ascending; then insertion order), numbers print as
// Number.prototype.toString prints them, and strings escape exactly the
// characters JSON.stringify escapes.
package jsjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Value is nil, bool, float64, string, []Value or *Object.
type Value = any

// Object is a JSON object with JavaScript property order.
type Object struct {
	keys []string
	vals map[string]Value
}

// NewObject returns an empty object.
func NewObject() *Object { return &Object{vals: map[string]Value{}} }

// Len is the number of properties.
func (o *Object) Len() int { return len(o.keys) }

// Get returns a property.
func (o *Object) Get(key string) (Value, bool) {
	v, ok := o.vals[key]
	return v, ok
}

// Has reports whether the property exists.
func (o *Object) Has(key string) bool { _, ok := o.vals[key]; return ok }

// Set assigns a property; an existing one keeps its position.
func (o *Object) Set(key string, v Value) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

// Delete removes a property.
func (o *Object) Delete(key string) {
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// Keys lists property names in JavaScript enumeration order.
func (o *Object) Keys() []string {
	var ints, rest []string
	for _, k := range o.keys {
		if isArrayIndex(k) {
			ints = append(ints, k)
		} else {
			rest = append(rest, k)
		}
	}
	if len(ints) > 1 {
		sort.Slice(ints, func(i, j int) bool {
			a, _ := strconv.ParseUint(ints[i], 10, 64)
			b, _ := strconv.ParseUint(ints[j], 10, 64)
			return a < b
		})
	}
	return append(ints, rest...)
}

// Clone deep-copies a value.
func Clone(v Value) Value {
	switch t := v.(type) {
	case *Object:
		out := NewObject()
		for _, k := range t.keys {
			out.Set(k, Clone(t.vals[k]))
		}
		return out
	case []Value:
		out := make([]Value, len(t))
		for i, e := range t {
			out[i] = Clone(e)
		}
		return out
	default:
		return v
	}
}

func isArrayIndex(k string) bool {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return err == nil && n < 4294967295
}

// Parse decodes one JSON document.
func Parse(data []byte) (Value, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after JSON value")
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := NewObject()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := kt.(string)
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				obj.Set(key, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []Value{}
			for dec.More() {
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			// JSON.parse yields ±Infinity for out-of-range literals.
			var numErr *strconv.NumError
			if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
				return f, nil
			}
			return nil, err
		}
		return f, nil
	default:
		return t, nil // string, bool, nil
	}
}

// Stringify encodes like JSON.stringify(v) with no indentation.
func Stringify(v Value) string {
	var b strings.Builder
	write(&b, v)
	return b.String()
}

// Canonical re-encodes raw JSON the way JSON.stringify(JSON.parse(raw)) would.
func Canonical(raw []byte) (string, error) {
	v, err := Parse(raw)
	if err != nil {
		return "", err
	}
	return Stringify(v), nil
}

func write(b *strings.Builder, v Value) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case float64:
		b.WriteString(FormatNumber(t))
	case int:
		b.WriteString(FormatNumber(float64(t)))
	case string:
		Quote(b, t)
	case []Value:
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			write(b, e)
		}
		b.WriteByte(']')
	case *Object:
		b.WriteByte('{')
		for i, k := range t.Keys() {
			if i > 0 {
				b.WriteByte(',')
			}
			Quote(b, k)
			b.WriteByte(':')
			write(b, t.vals[k])
		}
		b.WriteByte('}')
	case json.RawMessage:
		if c, err := Canonical(t); err == nil {
			b.WriteString(c)
		} else {
			b.WriteString("null")
		}
	default:
		raw, err := json.Marshal(t)
		if err != nil {
			b.WriteString("null")
			return
		}
		write(b, json.RawMessage(raw))
	}
}

// FormatNumber prints a float the way Number.prototype.toString does
// (non-finite values become null, as in JSON.stringify).
func FormatNumber(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		return "0"
	}
	neg := f < 0
	if neg {
		f = -f
	}
	// Shortest round-trip digits and exponent: d.ddd e±x.
	s := strconv.FormatFloat(f, 'e', -1, 64)
	mant, expStr, _ := strings.Cut(s, "e")
	exp, _ := strconv.Atoi(expStr)
	digits := strings.Replace(mant, ".", "", 1)
	k := len(digits)
	n := exp + 1 // decimal point position
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		sign := "+"
		if e < 0 {
			sign = "-"
			e = -e
		}
		if k == 1 {
			out = digits + "e" + sign + strconv.Itoa(e)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(e)
		}
	}
	if neg {
		return "-" + out
	}
	return out
}

// Quote writes s as a JSON string exactly as JSON.stringify escapes it.
// Invalid UTF-8 bytes (which a JS string cannot hold) become U+FFFD.
func Quote(b *strings.Builder, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// QuoteString returns s as a JSON string literal.
func QuoteString(s string) string {
	var b strings.Builder
	Quote(&b, s)
	return b.String()
}

// UTF16Len is a string's length in UTF-16 code units (JavaScript's .length).
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// StringifyIndent encodes like JSON.stringify(v, null, indent).
func StringifyIndent(v Value, indent string) string {
	var b strings.Builder
	writeIndent(&b, normalizeForIndent(v), indent, "")
	return b.String()
}

// normalizeForIndent turns anything write() would marshal through
// encoding/json into plain Values first.
func normalizeForIndent(v Value) Value {
	switch t := v.(type) {
	case nil, bool, float64, string, *Object, []Value:
		return t
	case int:
		return float64(t)
	case json.RawMessage:
		p, err := Parse(t)
		if err != nil {
			return nil
		}
		return p
	default:
		raw, err := json.Marshal(t)
		if err != nil {
			return nil
		}
		p, err := Parse(raw)
		if err != nil {
			return nil
		}
		return p
	}
}

func writeIndent(b *strings.Builder, v Value, indent, prefix string) {
	switch t := v.(type) {
	case []Value:
		if len(t) == 0 {
			b.WriteString("[]")
			return
		}
		inner := prefix + indent
		b.WriteString("[\n")
		for i, e := range t {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			writeIndent(b, normalizeForIndent(e), indent, inner)
		}
		b.WriteString("\n" + prefix + "]")
	case *Object:
		keys := t.Keys()
		if len(keys) == 0 {
			b.WriteString("{}")
			return
		}
		inner := prefix + indent
		b.WriteString("{\n")
		for i, k := range keys {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(inner)
			Quote(b, k)
			b.WriteString(": ")
			writeIndent(b, normalizeForIndent(t.vals[k]), indent, inner)
		}
		b.WriteString("\n" + prefix + "}")
	default:
		write(b, t)
	}
}
