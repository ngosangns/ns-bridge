package tiktoken

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCountsMatchJsTiktoken(t *testing.T) {
	raw, err := os.ReadFile("testdata/counts.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Text  string `json:"text"`
		Count int    `json:"count"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if !valid(c.Text) {
			t.Fatalf("fixture text is not UTF-8: %q", c.Text)
		}
		got, err := CountTokens(c.Text)
		if err != nil {
			t.Fatalf("%q: %v", c.Text, err)
		}
		if got != c.Count {
			t.Errorf("%q: got %d tokens, js-tiktoken says %d (pieces %q)", c.Text, got, c.Count, Split(c.Text))
		}
	}
}

func TestSpecialTokenRefused(t *testing.T) {
	_, err := CountTokens("a <|endoftext|> b")
	if err == nil || err.Error() != "The text contains a special token that is not allowed: <|endoftext|>" {
		t.Fatalf("got %v", err)
	}
}
