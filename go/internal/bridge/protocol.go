package bridge

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// ProtocolVersion is the sidecar wire protocol this binary speaks; see
// docs/SIDECAR-PROTOCOL.md. A host sends it in every request envelope.
const ProtocolVersion = 1

// Envelope is the one JSON value a host writes on stdin to start a call.
type Envelope struct {
	Protocol int             `json:"protocol"`
	Request  json.RawMessage `json:"request"`
}

// TerminalError is the last line of a failed call.
type TerminalError struct {
	Type  string `json:"type"`
	Error *Error `json:"error"`
}

// Writer emits NDJSON on stdout: one event per line, flushed per line so the
// host renders as the model streams.
type Writer struct {
	mu  sync.Mutex
	buf *bufio.Writer
	enc *json.Encoder
}

func NewWriter(w io.Writer) *Writer {
	buf := bufio.NewWriter(w)
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	return &Writer{buf: buf, enc: enc}
}

// Emit writes one event line.
func (w *Writer) Emit(event Event) error { return w.write(event) }

// Fail writes the terminal error line.
func (w *Writer) Fail(err *Error) error { return w.write(TerminalError{Type: "error", Error: err}) }

func (w *Writer) write(value any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.enc.Encode(value); err != nil {
		return err
	}
	return w.buf.Flush()
}
