package bridge

import "fmt"

// ErrorKind classifies a terminal failure so a host adapter can route it
// (re-login, back off, compact, surface) without parsing vendor wording.
type ErrorKind string

const (
	KindInvalidRequest  ErrorKind = "invalid_request"  // the request JSON or flags are wrong
	KindUnsupported     ErrorKind = "unsupported"      // protocol version or vendor this binary does not speak
	KindAuth            ErrorKind = "auth"             // no session, or the vendor rejected it
	KindRateLimit       ErrorKind = "rate_limit"       // throttled; see RetryAfterMs
	KindCapacity        ErrorKind = "capacity"         // the vendor is out of capacity for this model
	KindContextOverflow ErrorKind = "context_overflow" // input too large for the model
	KindNetwork         ErrorKind = "network"          // transport failure
	KindTimeout         ErrorKind = "timeout"          // a deadline or stall timeout fired
	KindAborted         ErrorKind = "aborted"          // the host cancelled (stdin closed or SIGTERM)
	KindProtocol        ErrorKind = "protocol"         // the vendor answered something this core cannot read
	KindVendor          ErrorKind = "vendor"           // any other vendor-reported failure
	KindInternal        ErrorKind = "internal"         // a bug in this binary
)

// Error is the payload of the terminal {"type":"error"} line.
type Error struct {
	Kind         ErrorKind `json:"kind"`
	Message      string    `json:"message"`
	Vendor       string    `json:"vendor,omitempty"`
	Status       int       `json:"status,omitempty"`
	RetryAfterMs *int64    `json:"retryAfterMs,omitempty"`
	ReasonCode   string    `json:"reasonCode,omitempty"`
	// VendorError names the error class the in-process TypeScript core
	// throws for this failure (e.g. "KiroApiError"), so the client can
	// rebuild it; empty when the failure has no vendor class.
	VendorError string `json:"vendorError,omitempty"`
	// ProviderAttempts counts the vendor-internal retries spent before the
	// failure (Kiro: credentialRefresh, capacity).
	ProviderAttempts map[string]int `json:"providerAttempts,omitempty"`
}

func (e *Error) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("%s (%s, HTTP %d)", e.Message, e.Kind, e.Status)
	}
	return fmt.Sprintf("%s (%s)", e.Message, e.Kind)
}

// Errorf builds an Error of the given kind.
func Errorf(kind ErrorKind, format string, args ...any) *Error {
	return &Error{Kind: kind, Message: fmt.Sprintf(format, args...)}
}
