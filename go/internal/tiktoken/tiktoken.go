// Package tiktoken counts cl100k_base tokens exactly as js-tiktoken does
// (ns-kiro-core's fallback when Kiro reports no output token count): the same
// pre-tokenizer pattern, the same byte-pair merge, the same special-token
// refusal. The ranks are embedded; scripts/gen-tiktoken-ranks.mjs regenerates
// them from js-tiktoken.
package tiktoken

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

//go:embed cl100k_base.tkn.gz
var ranksGz []byte

var (
	loadOnce sync.Once
	rankMap  map[string]int
	loadErr  error
)

// The special tokens js-tiktoken refuses inside ordinary text.
var specialTokens = []string{"<|endoftext|>", "<|fim_prefix|>", "<|fim_middle|>", "<|fim_suffix|>", "<|endofprompt|>"}

func load() {
	zr, err := gzip.NewReader(bytes.NewReader(ranksGz))
	if err != nil {
		loadErr = err
		return
	}
	data, err := io.ReadAll(zr)
	if err != nil {
		loadErr = err
		return
	}
	if len(data) < 8 || string(data[:4]) != "TKN1" {
		loadErr = errors.New("tiktoken: bad ranks header")
		return
	}
	count := int(binary.BigEndian.Uint32(data[4:8]))
	rankMap = make(map[string]int, count)
	pos := 8
	for rank := 0; rank < count; rank++ {
		n, w := binary.Uvarint(data[pos:])
		if w <= 0 || pos+w+int(n) > len(data) {
			loadErr = errors.New("tiktoken: truncated ranks")
			return
		}
		pos += w
		rankMap[string(data[pos:pos+int(n)])] = rank
		pos += int(n)
	}
}

// CountTokens is len(encode(text)) for cl100k_base. Like js-tiktoken's
// encode with its defaults, text containing a special token is an error.
func CountTokens(text string) (int, error) {
	if text == "" {
		return 0, nil
	}
	loadOnce.Do(load)
	if loadErr != nil {
		return 0, loadErr
	}
	if tok := firstSpecial(text); tok != "" {
		return 0, fmt.Errorf("The text contains a special token that is not allowed: %s", tok)
	}
	total := 0
	for _, piece := range Split(text) {
		b := []byte(piece)
		if _, ok := rankMap[string(b)]; ok {
			total++
			continue
		}
		total += bytePairCount(b)
	}
	return total, nil
}

func firstSpecial(text string) string {
	best, bestAt := "", -1
	for _, tok := range specialTokens {
		if i := strings.Index(text, tok); i >= 0 && (bestAt < 0 || i < bestAt) {
			best, bestAt = tok, i
		}
	}
	return best
}

// bytePairCount runs js-tiktoken's bytePairMerge and counts the parts that
// have a rank.
func bytePairCount(piece []byte) int {
	if len(piece) == 1 {
		if _, ok := rankMap[string(piece)]; ok {
			return 1
		}
		return 0
	}
	starts := make([]int, len(piece)+1) // part i is piece[starts[i]:starts[i+1]]
	for i := range starts {
		starts[i] = i
	}
	for len(starts) > 2 {
		minRank, minAt := -1, -1
		for i := 0; i < len(starts)-2; i++ {
			rank, ok := rankMap[string(piece[starts[i]:starts[i+2]])]
			if !ok {
				continue
			}
			if minRank < 0 || rank < minRank {
				minRank, minAt = rank, i
			}
		}
		if minAt < 0 {
			break
		}
		starts = append(starts[:minAt+1], starts[minAt+2:]...)
	}
	n := 0
	for i := 0; i < len(starts)-1; i++ {
		if _, ok := rankMap[string(piece[starts[i]:starts[i+1]])]; ok {
			n++
		}
	}
	return n
}

// isJSSpace is JavaScript's \s.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func isLetter(r rune) bool { return unicode.IsLetter(r) }
func isNumber(r rune) bool { return unicode.In(r, unicode.N) }
func isCRLF(r rune) bool   { return r == '\r' || r == '\n' }

// Split is cl100k_base's pre-tokenizer:
//
//	('s|'S|'t|'T|'re|…|'D)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
//
// hand-coded as an ordered alternation over code points.
func Split(text string) []string {
	rs := []rune(text)
	// Invalid UTF-8 cannot come from a JS string; keep it as U+FFFD like TextEncoder.
	var out []string
	for i := 0; i < len(rs); {
		n := matchAt(rs, i)
		if n <= 0 { // unreachable: every code point matches some branch
			n = 1
		}
		out = append(out, string(rs[i:i+n]))
		i += n
	}
	return out
}

var contractions = []string{"s", "S", "t", "T", "re", "rE", "Re", "RE", "ve", "vE", "Ve", "VE", "m", "M", "ll", "lL", "Ll", "LL", "d", "D"}

func matchAt(rs []rune, i int) int {
	c := rs[i]
	// 1: contractions
	if c == '\'' {
		for _, suf := range contractions {
			sr := []rune(suf)
			if i+1+len(sr) <= len(rs) && string(rs[i+1:i+1+len(sr)]) == suf {
				return 1 + len(sr)
			}
		}
	}
	// 2: [^\r\n\p{L}\p{N}]?\p{L}+
	if !isCRLF(c) && !isLetter(c) && !isNumber(c) && i+1 < len(rs) && isLetter(rs[i+1]) {
		j := i + 1
		for j < len(rs) && isLetter(rs[j]) {
			j++
		}
		return j - i
	}
	if isLetter(c) {
		j := i
		for j < len(rs) && isLetter(rs[j]) {
			j++
		}
		return j - i
	}
	// 3: \p{N}{1,3}
	if isNumber(c) {
		j := i
		for j < len(rs) && j-i < 3 && isNumber(rs[j]) {
			j++
		}
		return j - i
	}
	// 4: ' ?[^\s\p{L}\p{N}]+[\r\n]*'
	isOther := func(r rune) bool { return !isJSSpace(r) && !isLetter(r) && !isNumber(r) }
	start := i
	if c == ' ' && i+1 < len(rs) && isOther(rs[i+1]) {
		start = i + 1
	}
	if isOther(rs[start]) {
		j := start
		for j < len(rs) && isOther(rs[j]) {
			j++
		}
		for j < len(rs) && isCRLF(rs[j]) {
			j++
		}
		return j - i
	}
	// Whitespace from here on.
	end := i
	lastCRLF := -1
	for end < len(rs) && isJSSpace(rs[end]) {
		if isCRLF(rs[end]) {
			lastCRLF = end
		}
		end++
	}
	// 5: \s*[\r\n]+
	if lastCRLF >= 0 {
		return lastCRLF + 1 - i
	}
	// 6: \s+(?!\S)
	if end == len(rs) {
		return end - i
	}
	if end-i >= 2 {
		return end - i - 1
	}
	// 7: \s+
	return end - i
}

// valid reports whether s is valid UTF-8 (helper for tests).
func valid(s string) bool { return utf8.ValidString(s) }
