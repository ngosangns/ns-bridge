// Package jsstr holds the JavaScript string semantics the vendor ports lean
// on: \s, String.prototype.trim, and UTF-16 lengths and slicing.
package jsstr

import (
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// SpaceClass is JavaScript's \s as an RE2 character class body.
const SpaceClass = `\t\n\x{0b}\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// IsSpace is JavaScript's \s (and what trim strips).
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// Trim is String.prototype.trim.
func Trim(s string) string { return strings.TrimFunc(s, IsSpace) }

// TrimStart is String.prototype.trimStart.
func TrimStart(s string) string { return strings.TrimLeftFunc(s, IsSpace) }

// Len is s.length (UTF-16 code units).
func Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// Units is s as UTF-16 code units.
func Units(s string) []uint16 { return utf16.Encode([]rune(s)) }

// FromUnits turns code units back into a Go string; a lone surrogate (as
// JavaScript slicing can leave) becomes U+FFFD, which is what it turns into
// once a JavaScript string is UTF-8 encoded on the wire.
func FromUnits(u []uint16) string { return string(utf16.Decode(u)) }

// Slice is s.slice(start, end) in UTF-16 units (end < 0 means to the end).
func Slice(s string, start, end int) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		if end < 0 || end > len(s) {
			end = len(s)
		}
		if start > end {
			return ""
		}
		return s[start:end]
	}
	u := Units(s)
	if end < 0 || end > len(u) {
		end = len(u)
	}
	if start > end {
		return ""
	}
	return FromUnits(u[start:end])
}
