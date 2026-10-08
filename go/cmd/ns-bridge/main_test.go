package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCommands(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"version"}, nil, &out, &errOut); code != 0 || !strings.Contains(out.String(), "protocol 1") {
		t.Fatalf("version: %d %q", code, out.String())
	}
	out.Reset()
	if code := run([]string{"vendors"}, nil, &out, &errOut); code != 0 || strings.TrimSpace(out.String()) != strings.Join(registry().IDs(), "\n") || !strings.Contains(out.String(), "echo") {
		t.Fatalf("vendors: %d %q", code, out.String())
	}
	if code := run([]string{"stream"}, nil, &out, &errOut); code != exitUsage {
		t.Fatalf("stream without --vendor: %d", code)
	}
	if code := run([]string{"bogus"}, nil, &out, &errOut); code != exitUsage {
		t.Fatalf("unknown command: %d", code)
	}
}
