package devin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
)

// APIError is an HTTP-level rejection from a Cascade endpoint.
type APIError struct {
	Operation string
	Status    int
	Message   string
	Header    http.Header
}

func (e *APIError) Error() string { return e.Message }

// StreamError is a rejection carried by the Connect end-of-stream trailer.
type StreamError struct {
	Code            string
	Message         string
	ContextOverflow bool
}

func (e *StreamError) Error() string { return e.Message }

// ProtocolError is malformed wire data.
type ProtocolError struct {
	Kind    string // empty-body | envelope | runtime
	Message string
}

func (e *ProtocolError) Error() string { return e.Message }

const maxErrorDetailChars = 4096

var htmlBodyPattern = regexp.MustCompile(`(?i)^\s*(?:<!doctype\s+html\b|<html\b)`)
var whitespaceRun = regexp.MustCompile(`\s+`)

// errorDetail extracts a bounded human error without leaking proxy HTML or
// binary protobuf.
func errorDetail(header http.Header, payload []byte) string {
	if !utf8.Valid(payload) {
		return ""
	}
	text := strings.TrimSpace(string(payload))
	if strings.Contains(strings.ToLower(header.Get("content-type")), "text/html") {
		return ""
	}
	var decoded any
	if json.Unmarshal([]byte(text), &decoded) == nil {
		if obj, ok := decoded.(map[string]any); ok {
			if errObj, ok := obj["error"].(map[string]any); ok {
				if msg, ok := errObj["message"].(string); ok {
					text = strings.TrimSpace(msg)
				}
			} else if s, ok := obj["error"].(string); ok {
				text = strings.TrimSpace(s)
			} else if msg, ok := obj["message"].(string); ok {
				text = strings.TrimSpace(msg)
			}
		}
	}
	normalized := strings.TrimSpace(whitespaceRun.ReplaceAllString(text, " "))
	if normalized == "" || htmlBodyPattern.MatchString(normalized) || !isCleanText(normalized) {
		return ""
	}
	runes := []rune(normalized)
	if len(runes) > maxErrorDetailChars {
		return string(runes[:maxErrorDetailChars])
	}
	return normalized
}

func statusText(resp *http.Response) string {
	code := strconv.Itoa(resp.StatusCode)
	text := strings.TrimSpace(strings.TrimPrefix(resp.Status, code))
	if text == "" {
		return code
	}
	return code + " " + text
}

func newHTTPError(operation string, resp *http.Response, payload []byte) *APIError {
	msg := fmt.Sprintf("Devin %s error %s", operation, statusText(resp))
	if detail := errorDetail(resp.Header, payload); detail != "" {
		msg += ": " + detail
	}
	return &APIError{Operation: operation, Status: resp.StatusCode, Message: msg, Header: resp.Header}
}

// TrailerError is a Connect end-of-stream trailer's error.
type TrailerError struct {
	Code, Message, Formatted, Detail, Raw string
}

const maxTrailerEvidence = 2000

func truncateEvidence(s string) string {
	r := []rune(s)
	if len(r) > maxTrailerEvidence {
		return string(r[:maxTrailerEvidence]) + "…"
	}
	return s
}

func summarizeDetails(details any) string {
	list, ok := details.([]any)
	if !ok || len(list) == 0 {
		return ""
	}
	summary := ""
	for _, entry := range list {
		rec, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		typ, _ := rec["type"].(string)
		value, _ := rec["value"].(string)
		debug := ""
		hasDebug := false
		if d, present := rec["debug"]; present {
			if s, ok := d.(string); ok {
				debug, hasDebug = s, true
			} else if b, err := json.Marshal(d); err == nil {
				debug, hasDebug = string(b), true
			}
		}
		evidence := value
		if hasDebug {
			evidence = debug
		}
		if typ != "" {
			typ = truncateEvidence(typ)
		}
		if evidence != "" {
			evidence = truncateEvidence(evidence)
		}
		var part string
		switch {
		case typ != "" && evidence != "":
			part = typ + ": " + evidence
		case typ != "":
			part = typ
		default:
			part = evidence
		}
		if part == "" {
			continue
		}
		next := part
		if summary != "" {
			next = summary + "; " + part
		}
		if utf8.RuneCountInString(next) > maxTrailerEvidence {
			return truncateEvidence(next)
		}
		summary = next
	}
	return summary
}

// readTrailerError parses a Connect end-of-stream JSON trailer; nil when it
// carries no error.
func readTrailerError(text string) *TrailerError {
	if text == "" {
		return nil
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(text), &parsed) != nil {
		return nil
	}
	errObj, ok := parsed["error"].(map[string]any)
	if !ok {
		return nil
	}
	code, _ := errObj["code"].(string)
	message, _ := errObj["message"].(string)
	if code == "" && message == "" {
		return nil
	}
	t := &TrailerError{Code: code, Message: message, Raw: truncateEvidence(text)}
	t.Formatted = "Devin stream error"
	if code != "" {
		t.Formatted += " " + code
	}
	t.Formatted += ": " + message
	if d := summarizeDetails(errObj["details"]); d != "" {
		t.Detail = d
		t.Formatted += " [details: " + d + "]"
	}
	return t
}

// retryAfterMs reads Retry-After (seconds or HTTP-date).
func retryAfterMs(h http.Header) int64 {
	raw := h.Get("retry-after")
	if raw == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(strings.TrimSpace(raw), 64); err == nil {
		if secs < 0 {
			return 0
		}
		return int64(secs * 1000)
	}
	if t, err := http.ParseTime(raw); err == nil {
		if d := time.Until(t); d > 0 {
			return d.Milliseconds()
		}
	}
	return 0
}

var (
	rateLimitPattern = regexp.MustCompile(`(?i)rate.?limit|quota`)
	capacityPattern  = regexp.MustCompile(`(?i)capacity|overload`)
)

// IsAuthError mirrors isDevinAuthError.
func IsAuthError(err error) bool {
	switch e := err.(type) {
	case *APIError:
		return e.Status == 401 || e.Status == 403
	case *StreamError:
		return e.Code == "unauthenticated" || e.Code == "permission_denied"
	}
	return false
}

// IsRateLimitError mirrors isDevinRateLimitError.
func IsRateLimitError(err error) bool {
	switch e := err.(type) {
	case *APIError:
		return e.Status == 429
	case *StreamError:
		return e.Code == "resource_exhausted" || rateLimitPattern.MatchString(e.Message)
	}
	return false
}

// IsCapacityError mirrors isDevinCapacityError.
func IsCapacityError(err error) bool {
	switch e := err.(type) {
	case *APIError:
		return e.Status == 502 || e.Status == 503 || e.Status == 529
	case *StreamError:
		return e.Code == "unavailable" || e.Code == "deadline_exceeded" || capacityPattern.MatchString(e.Message)
	}
	return false
}

// toBridgeError classifies a core failure for the host, in the order the
// TypeScript adapters route Devin errors.
func toBridgeError(err error) *bridge.Error {
	if be, ok := err.(*bridge.Error); ok {
		return be
	}
	out := &bridge.Error{Message: err.Error()}
	switch e := err.(type) {
	case *APIError:
		out.Status = e.Status
		out.RetryAfterMs = retryAfterMs(e.Header)
	case *StreamError:
		out.ReasonCode = e.Code
	case *ProtocolError:
		out.Kind = bridge.KindProtocol
		out.ReasonCode = e.Kind
		return out
	}
	se, isStream := err.(*StreamError)
	switch {
	case isStream && se.ContextOverflow:
		out.Kind = bridge.KindContextOverflow
	case IsRateLimitError(err):
		out.Kind = bridge.KindRateLimit
	case IsCapacityError(err):
		out.Kind = bridge.KindCapacity
	case IsAuthError(err):
		out.Kind = bridge.KindAuth
	default:
		out.Kind = bridge.KindVendor
	}
	return out
}
