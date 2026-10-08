package jsjson

import "testing"

func TestFormatNumberMatchesJavaScript(t *testing.T) {
	cases := map[float64]string{
		0: "0", 1: "1", -1: "-1", 1.5: "1.5", 0.1: "0.1", 100: "100", 1e21: "1e+21", 1e20: "100000000000000000000",
		123456789012: "123456789012", 0.000001: "0.000001", 0.0000001: "1e-7", 1.25e-7: "1.25e-7", 2.5e300: "2.5e+300",
		9007199254740993: "9007199254740992", 0.30000000000000004: "0.30000000000000004",
	}
	for in, want := range cases {
		if got := FormatNumber(in); got != want {
			t.Errorf("FormatNumber(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestCanonicalKeepsJavaScriptKeyOrder(t *testing.T) {
	got, err := Canonical([]byte(`{ "b": 1, "a": [1.0, 2e3, "x\u2028\u0001"], "10": true, "2": null, "b": 3, "01": 0 }`))
	if err != nil {
		t.Fatal(err)
	}
	want := "{\"2\":null,\"10\":true,\"b\":3,\"a\":[1,2000,\"x\u2028\\u0001\"],\"01\":0}"
	if got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}

func TestUTF16Len(t *testing.T) {
	if n := UTF16Len("a😀é"); n != 4 {
		t.Fatalf("UTF16Len = %d", n)
	}
}
