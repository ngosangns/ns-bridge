// Package sidecar runs one `ns-bridge stream` call: it reads the request
// envelope from stdin, hands it to a vendor, and writes the vendor's events to
// stdout as NDJSON, ending in either a done event or a terminal error line.
package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
)

// Streamer is one vendor core. Stream emits events through emit and returns
// nil after emitting done, or an error (preferably *bridge.Error) without one.
type Streamer interface {
	Stream(ctx context.Context, request json.RawMessage, emit func(bridge.Event) error) error
}

// Registry maps a vendor id (the --vendor flag) to its core.
type Registry map[string]Streamer

// IDs lists the registered vendor ids, sorted.
func (r Registry) IDs() []string {
	ids := make([]string, 0, len(r))
	for id := range r {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Options tune one call.
type Options struct {
	// IgnoreStdinEOF keeps running after stdin closes. Hosts leave it off —
	// closing stdin is how they cancel — but a person piping a request in by
	// hand needs it on.
	IgnoreStdinEOF bool
}

var (
	errStdinClosed = errors.New("stdin closed by the host")
	errAfterDone   = errors.New("event emitted after done")
)

// Exit codes. Anything else means the binary crashed.
const (
	ExitOK    = 0 // the call ended with a done event
	ExitError = 1 // the call ended with a terminal error line
)

// Run executes one call and returns the process exit code.
func Run(ctx context.Context, vendor string, registry Registry, opts Options, stdin io.Reader, stdout io.Writer) int {
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
		return fail(bridge.Errorf(bridge.KindInvalidRequest, "request envelope has no request"))
	}

	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	if !opts.IgnoreStdinEOF {
		// Whatever follows the envelope is reserved for host→sidecar messages
		// (login callbacks, later). End of stdin means the host is gone or
		// cancelled: stop.
		rest := io.MultiReader(dec.Buffered(), stdin)
		go func() {
			_, _ = io.Copy(io.Discard, rest)
			cancel(errStdinClosed)
		}()
	}

	done := false
	emit := func(event bridge.Event) error {
		if done {
			return errAfterDone
		}
		if err := ctx.Err(); err != nil {
			return context.Cause(ctx)
		}
		if event.EventType() == "done" {
			done = true
		}
		return out.Emit(event)
	}

	err := core.Stream(ctx, envelope.Request, emit)
	switch {
	case done:
		// The turn is complete; a late error (a write after done, say) cannot
		// un-deliver it.
		return ExitOK
	case err == nil:
		return fail(bridge.Errorf(bridge.KindInternal, "vendor %q ended without a done event", vendor))
	case ctx.Err() != nil:
		return fail(&bridge.Error{Kind: bridge.KindAborted, Message: fmt.Sprintf("cancelled: %v", context.Cause(ctx))})
	}
	var bridgeErr *bridge.Error
	if errors.As(err, &bridgeErr) {
		return fail(bridgeErr)
	}
	return fail(&bridge.Error{Kind: bridge.KindInternal, Message: err.Error()})
}
