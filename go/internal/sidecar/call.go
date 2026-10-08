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

// Caller is a vendor that also answers one-shot operations (`ns-bridge call
// --vendor <id> --op <op>`): model catalogs, usage, token refresh.
type Caller interface {
	Call(ctx context.Context, op string, request json.RawMessage) (any, error)
}

// ErrUnknownOp is what a Caller returns for an op it does not implement.
var ErrUnknownOp = errors.New("unknown op")

// RunCall executes one operation: the same envelope as Run on stdin, and on
// stdout a single `{"type":"result","result":…}` line or a terminal error line.
func RunCall(ctx context.Context, vendor, op string, registry Registry, stdin io.Reader, stdout io.Writer) int {
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
	caller, ok := core.(Caller)
	if !ok {
		return fail(bridge.Errorf(bridge.KindUnsupported, "vendor %q has no operations", vendor))
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

	result, err := caller.Call(ctx, op, envelope.Request)
	switch {
	case err == nil:
		line := `{"type":"result","result":` + jsjson.Stringify(result) + "}\n"
		if _, werr := io.WriteString(stdout, line); werr != nil {
			return ExitError
		}
		return ExitOK
	case errors.Is(err, ErrUnknownOp):
		return fail(bridge.Errorf(bridge.KindUnsupported, "vendor %q has no op %q", vendor, op))
	case ctx.Err() != nil:
		return fail(&bridge.Error{Kind: bridge.KindAborted, Message: fmt.Sprintf("cancelled: %v", context.Cause(ctx))})
	}
	var bridgeErr *bridge.Error
	if errors.As(err, &bridgeErr) {
		return fail(bridgeErr)
	}
	return fail(&bridge.Error{Kind: bridge.KindInternal, Message: err.Error()})
}
