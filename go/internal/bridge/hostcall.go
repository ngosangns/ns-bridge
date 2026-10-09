package bridge

// HostCall is a JSON-RPC 2.0 line the binary writes on stdout to tell the host
// something mid-call — the URL a login needs the user to open, a progress
// note. The "jsonrpc" member (instead of "type") is what tells it apart from
// an event on the wire.
type HostCall struct {
	JSONRPC string `json:"jsonrpc"`
	// ID is set for a request the host must answer (a prompt); nil for a
	// notification. v1 vendors emit notifications only.
	ID     *int64 `json:"id,omitempty"`
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

// Host notification methods a login flow may emit.
const (
	// HostAuthURL asks the host to open (or print) a URL for the user.
	// Params: {url, instructions?}.
	HostAuthURL = "host/authUrl"
	// HostProgress carries a human-readable progress note. Params: {message}.
	HostProgress = "host/progress"
)

// Notify writes one host notification — a HostCall with no id, so the host
// never answers it.
func (w *Writer) Notify(method string, params any) error {
	return w.write(HostCall{JSONRPC: "2.0", Method: method, Params: params})
}

// Host is how a vendor login asks the host for things mid-call; the sidecar
// implements it by writing JSON-RPC notifications on stdout.
type Host interface {
	// AuthURL asks the host to open (or print) url for the user.
	AuthURL(url, instructions string) error
	// Progress reports a human-readable progress note.
	Progress(message string) error
}
