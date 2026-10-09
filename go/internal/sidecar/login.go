package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

// Loginer is a vendor with an interactive login (`ns-bridge login --vendor
// <id>`): Devin's PKCE browser round trip, a Kiro API-key check.
type Loginer interface {
	Login(ctx context.Context, request json.RawMessage, host bridge.Host) (any, error)
}

// hostNotify implements Host over a bridge.Writer.
type hostNotify struct{ out *bridge.Writer }

func (h hostNotify) AuthURL(url, instructions string) error {
	return h.out.Notify(bridge.HostAuthURL, map[string]any{"url": url, "instructions": instructions})
}

func (h hostNotify) Progress(message string) error {
	return h.out.Notify(bridge.HostProgress, map[string]any{"message": message})
}

// RunLogin executes one interactive login: the same envelope as RunCall on
// stdin, host notifications and then a single {"type":"result"} or terminal
// error line on stdout. stdin stays the cancel signal throughout.
func RunLogin(ctx context.Context, vendor string, registry Registry, stdin io.Reader, stdout io.Writer) int {
	out := bridge.NewWriter(stdout)
	fail := func(err *bridge.Error) int {
		if err.Vendor == "" {
			err.Vendor = vendor
		}
		_ = out.Fail(err)
		return ExitError
	}

	core, ok := registry[vendor]
	if !ok {
		return fail(bridge.Errorf(bridge.KindUnsupported, "unknown vendor %q (this binary has: %v)", vendor, registry.IDs()))
	}
	loginer, ok := core.(Loginer)
	if !ok {
		return fail(bridge.Errorf(bridge.KindUnsupported, "vendor %q has no login", vendor))
	}

	dec := json.NewDecoder(stdin)
	var envelope bridge.Envelope
	if err := dec.Decode(&envelope); err != nil {
		return fail(bridge.Errorf(bridge.KindInvalidRequest, "read request envelope: %v", err))
	}
	if envelope.Protocol != bridge.ProtocolVersion {
		return fail(bridge.Errorf(bridge.KindUnsupported,
			"protocol %d not supported (this binary speaks %d)", envelope.Protocol, bridge.ProtocolVersion))
	}
	if len(envelope.Request) == 0 || string(envelope.Request) == "null" {
		envelope.Request = json.RawMessage("{}")
	}

	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	rest := io.MultiReader(dec.Buffered(), stdin)
	go func() {
		_, _ = io.Copy(io.Discard, rest)
		cancel(errStdinClosed)
	}()

	result, err := loginer.Login(ctx, envelope.Request, hostNotify{out})
	switch {
	case err == nil:
		line := `{"type":"result","result":` + jsjson.Stringify(result) + "}\n"
		if _, werr := io.WriteString(stdout, line); werr != nil {
			return ExitError
		}
		return ExitOK
	case ctx.Err() != nil:
		return fail(&bridge.Error{Kind: bridge.KindAborted, Message: fmt.Sprintf("cancelled: %v", context.Cause(ctx))})
	}
	var bridgeErr *bridge.Error
	if errors.As(err, &bridgeErr) {
		return fail(bridgeErr)
	}
	return fail(&bridge.Error{Kind: bridge.KindInternal, Message: err.Error()})
}
