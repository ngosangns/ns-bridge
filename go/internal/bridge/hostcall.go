package bridge

import (
	"context"
	"encoding/json"
)

// HostCall is a JSON-RPC 2.0 line the binary writes on stdout to tell the host
// something mid-call — the URL a login needs the user to open, a progress
// note, a prompt to answer. The "jsonrpc" member (instead of "type") is what
// tells it apart from an event on the wire.
type HostCall struct {
	JSONRPC string `json:"jsonrpc"`
	// ID is set for a request the host must answer (a prompt); nil for a
	// notification.
	ID     *int64 `json:"id,omitempty"`
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

// HostReply is the host's answer to a request HostCall, written on a stdin
// line after the request envelope: a result, or an error to refuse the call.
type HostReply struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *HostReplyError `json:"error"`
}

// HostReplyError is a host's refusal of a request HostCall.
type HostReplyError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Host notification and request methods a login flow may emit.
const (
	// HostAuthURL asks the host to open (or print) a URL for the user.
	// Params: {url, instructions?}.
	HostAuthURL = "host/authUrl"
	// HostProgress carries a human-readable progress note. Params: {message}.
	HostProgress = "host/progress"
	// HostPrompt asks the host a question the user answers; a request, so the
	// host replies on stdin with a HostReply carrying the request's id.
	// Params: PromptParams.
	HostPrompt = "host/prompt"
)

// PromptParams are the params of a host/prompt request.
type PromptParams struct {
	Message     string `json:"message"`
	Placeholder string `json:"placeholder,omitempty"`
	AllowEmpty  bool   `json:"allowEmpty,omitempty"`
	Secret      bool   `json:"secret,omitempty"`
}

// Notify writes one host notification — a HostCall with no id, so the host
// never answers it.
func (w *Writer) Notify(method string, params any) error {
	return w.write(HostCall{JSONRPC: "2.0", Method: method, Params: params})
}

// Request writes one host request — a HostCall carrying an id, which the host
// answers with a HostReply on stdin.
func (w *Writer) Request(id int64, method string, params any) error {
	return w.write(HostCall{JSONRPC: "2.0", ID: &id, Method: method, Params: params})
}

// Host is how a vendor login asks the host for things mid-call; the sidecar
// implements it by writing JSON-RPC lines on stdout and, for requests, waiting
// on the host's answer line on stdin.
type Host interface {
	// AuthURL asks the host to open (or print) url for the user.
	AuthURL(url, instructions string) error
	// Progress reports a human-readable progress note.
	Progress(message string) error
	// Prompt asks the host a question the user answers; blocks until the
	// host's reply arrives on stdin or ctx ends.
	Prompt(ctx context.Context, params PromptParams) (string, error)
}
