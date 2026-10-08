package kiro

import (
	"errors"
	"math"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

const (
	reasonContentLengthExceeds = "CONTENT_LENGTH_EXCEEDS_THRESHOLD"
	reasonInputTooLong         = "Input is too long"
	reasonMonthlyRequestCount  = "MONTHLY_REQUEST_COUNT"
	reasonCapacity             = "INSUFFICIENT_MODEL_CAPACITY"
	reasonUserRequestRate      = "USER_REQUEST_RATE_EXCEEDED"
	reasonRequestBodyInvalid   = "REQUEST_BODY_INVALID"
)

// APIError is KiroApiError.
type APIError struct {
	Message           string
	Status            int
	ReasonCode        string
	RetryAfterMs      *float64
	CredentialRefresh int
	Capacity          int
}

func (e *APIError) Error() string { return e.Message }

// ManagementHTTPError is KiroManagementHttpError.
type ManagementHTTPError struct {
	Message string
	Status  int
}

func (e *ManagementHTTPError) Error() string { return e.Message }

// networkError is a fetch-level failure (TypeError: fetch failed in Node).
type networkError struct{ err error }

func (e *networkError) Error() string { return e.err.Error() }
func (e *networkError) Unwrap() error { return e.err }

func isTooBigError(status int, text string) bool {
	return status == 413 || (status == 400 && (strings.Contains(text, reasonContentLengthExceeds) || strings.Contains(text, reasonInputTooLong)))
}
func isNonRetryableBodyError(text string) bool {
	return strings.Contains(text, reasonMonthlyRequestCount)
}
func isCapacityError(text string) bool { return strings.Contains(text, reasonCapacity) }

// extractReason is retry.ts extractKiroReason.
func extractReason(text string) string {
	if text == "" {
		return ""
	}
	v, err := jsjson.Parse([]byte(text))
	if err != nil {
		return ""
	}
	o, ok := v.(*jsjson.Object)
	if !ok {
		return ""
	}
	s, _ := get(o, "reason").(string)
	return s
}

// extractReasonCode is errors.ts extractKiroReasonCode.
func extractReasonCode(text string) string {
	if text == "" {
		return ""
	}
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "{") {
		if v, err := jsjson.Parse([]byte(trimmed)); err == nil {
			if o, ok := v.(*jsjson.Object); ok {
				reason := get(o, "reason")
				if reason == nil {
					reason = get(o, "reasonCode")
				}
				if s, ok := reason.(string); ok && s != "" {
					return s
				}
			}
		}
	}
	for _, code := range []string{reasonContentLengthExceeds, reasonMonthlyRequestCount, reasonCapacity, reasonRequestBodyInvalid} {
		if strings.Contains(text, code) {
			return code
		}
	}
	return ""
}

// toBridgeError classifies a Kiro failure and names the TS class it stands for.
func toBridgeError(err error) *bridge.Error {
	var be *bridge.Error
	if errors.As(err, &be) {
		return be
	}
	out := &bridge.Error{Message: err.Error()}
	var api *APIError
	var mgmt *ManagementHTTPError
	var netErr *networkError
	switch {
	case errors.As(err, &api):
		out.VendorError = "KiroApiError"
		out.Status = api.Status
		out.ReasonCode = api.ReasonCode
		if api.RetryAfterMs != nil && !math.IsNaN(*api.RetryAfterMs) {
			ms := int64(*api.RetryAfterMs)
			out.RetryAfterMs = &ms
		}
		out.ProviderAttempts = map[string]int{"credentialRefresh": api.CredentialRefresh, "capacity": api.Capacity}
		switch {
		case strings.Contains(api.Message, "context_length_exceeded"):
			out.Kind = bridge.KindContextOverflow
		case api.ReasonCode == reasonCapacity:
			out.Kind = bridge.KindCapacity
		case api.Status == 429:
			out.Kind = bridge.KindRateLimit
		case api.Status == 401 || api.Status == 403:
			out.Kind = bridge.KindAuth
		default:
			out.Kind = bridge.KindVendor
		}
	case errors.As(err, &mgmt):
		out.VendorError = "KiroManagementHttpError"
		out.Status = mgmt.Status
		out.Kind = bridge.KindVendor
		if mgmt.Status == 401 || mgmt.Status == 403 {
			out.Kind = bridge.KindAuth
		}
	case errors.As(err, &netErr):
		out.Kind = bridge.KindNetwork
	default:
		out.VendorError = "Error"
		switch {
		case strings.Contains(out.Message, "context_length_exceeded"):
			out.Kind = bridge.KindContextOverflow
		case strings.Contains(out.Message, "Kiro credentials not set"):
			out.Kind = bridge.KindAuth
		case strings.Contains(out.Message, "timeout"):
			out.Kind = bridge.KindTimeout
		default:
			out.Kind = bridge.KindVendor
		}
	}
	return out
}
