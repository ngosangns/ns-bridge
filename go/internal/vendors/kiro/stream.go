// Package kiro is the Go port of ns-kiro-core's streaming path: Kiro's
// generateAssistantResponse over AWS event-stream, with the TS core's
// request building, history repair, retry ladder (header/first-token/idle
// timeouts, capacity, request-rate window, 403 credential refresh, empty and
// echo responses) and response assembly, emitting BridgeStreamEvents.
package kiro

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf16"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/httpx"
	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
	"github.com/ngosangns/ns-bridge/go/internal/kirocli"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
	"github.com/ngosangns/ns-bridge/go/internal/redact"
)

const (
	defaultFirstTokenTimeoutMs    = 90000
	defaultRequestHeaderTimeoutMs = 90000
	maxRetryDelayMs               = 10000
	requestRateFallbackDelayMs    = 10000
	diagnosticQuoteLimit          = 200
)

// httpClient is swappable for tests.
var httpClient = httpx.Client

// session is one turn's mutable state.
type session struct {
	client   *http.Client
	profiles *profileCache
}

// UsageEvent is the usage event plus whether Kiro reported cache counters
// (the facade's cache estimator needs it; hosts never see the field).
type UsageEvent struct {
	bridge.UsageEvent
	WireCache bool `json:"kiroWireCache,omitempty"`
}

// DoneEvent is done plus the profile ARN cache changes for the facade.
type DoneEvent struct {
	bridge.DoneEvent
	ProfileArns map[string]*string `json:"kiroProfileArns,omitempty"`
	// Where the turn ran, so the facade can refresh that region's catalog.
	RuntimeRegion string `json:"kiroRuntimeRegion,omitempty"`
	ProfileArn    string `json:"kiroProfileArn,omitempty"`
}

func exponentialBackoff(attempt int, baseMs, maxMs float64) float64 {
	return math.Min(baseMs*math.Pow(2, float64(attempt)), maxMs)
}

func sleep(ctx context.Context, ms float64) error {
	if ms <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(time.Duration(ms * float64(time.Millisecond)))
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func describeAttempts(n int) string {
	if n == 1 {
		return "1 attempt"
	}
	return fmt.Sprintf("%d attempts", n)
}

func clampForDiagnostic(text string) string {
	if jsstr.Len(text) <= diagnosticQuoteLimit {
		return text
	}
	return jsstr.Slice(text, 0, diagnosticQuoteLimit) + "… (truncated)"
}

func encodeToolName(name string) string {
	var b strings.Builder
	for _, u := range utf16.Encode([]rune(name)) {
		b.WriteByte(byte(65 + (u >> 12)))
		b.WriteByte(byte(65 + ((u >> 8) & 0x0f)))
		b.WriteByte(byte(65 + ((u >> 4) & 0x0f)))
		b.WriteByte(byte(65 + (u & 0x0f)))
	}
	return b.String()
}

func describeDroppedToolNames(names []string) string {
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = "A-P:" + encodeToolName(n)
	}
	encoded := strings.Join(parts, ", ")
	if len(encoded) <= diagnosticQuoteLimit {
		return encoded
	}
	list := make([]jsjson.Value, len(names))
	for i, n := range names {
		list[i] = n
	}
	sum := sha256.Sum256([]byte(jsjson.Stringify(list)))
	var b strings.Builder
	for _, c := range sum {
		b.WriteByte(65 + (c >> 4))
		b.WriteByte(65 + (c & 0x0f))
	}
	return "A-P-DIGEST:" + b.String() + " (tool identities fingerprinted)"
}

func describeReturnedContent(kinds []string) string {
	seen := map[string]bool{}
	var unique []string
	for _, k := range kinds {
		if !seen[k] {
			seen[k] = true
			unique = append(unique, k)
		}
	}
	sort.Strings(unique)
	if len(unique) == 0 {
		return "returning empty content"
	}
	return "returning only " + strings.Join(unique, " and ") + " content"
}

func terminalWireStop(reason *string, details *jsjson.Object) error {
	if reason == nil {
		return nil
	}
	switch *reason {
	case "MODEL_CONTEXT_WINDOW_EXCEEDED":
		return errors.New("Kiro API error: context_length_exceeded (MODEL_CONTEXT_WINDOW_EXCEEDED)")
	case "CONTENT_FILTERED":
		var d jsjson.Value = jsjson.NewObject()
		if details != nil {
			d = details
		}
		return errors.New("Kiro content filtered: " + clampForDiagnostic(redact.Kiro(jsjson.Stringify(d))))
	case "PAUSE_TURN":
		return errors.New("Kiro paused the turn (PAUSE_TURN); automatic continuation is not supported")
	}
	return nil
}

// jsNumber is Number(s) for header values (NaN when unparseable).
func jsNumber(s string) float64 {
	t := jsstr.Trim(s)
	if t == "" {
		return 0
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	lower := strings.ToLower(t)
	for prefix, base := range map[string]int{"0x": 16, "0o": 8, "0b": 2} {
		if strings.HasPrefix(lower, prefix) {
			if n, err := strconv.ParseUint(t[2:], base, 64); err == nil {
				return float64(n)
			}
			return math.NaN()
		}
	}
	for _, c := range lower {
		if !(c >= '0' && c <= '9' || c == '.' || c == 'e' || c == '+' || c == '-') {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		var ne *strconv.NumError
		if errors.As(err, &ne) && ne.Err == strconv.ErrRange {
			return f
		}
		return math.NaN()
	}
	return f
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func nonNegative(h http.Header, name string) (float64, bool) {
	v, ok := h[http.CanonicalHeaderKey(name)]
	if !ok || len(v) == 0 || jsstr.Trim(strings.Join(v, ", ")) == "" {
		return 0, false
	}
	n := jsNumber(strings.Join(v, ", "))
	return n, finite(n) && n >= 0
}

// parseRetryAfterMs is retry.ts parseRetryAfterMs.
func parseRetryAfterMs(h http.Header, now time.Time) *float64 {
	if ms, ok := nonNegative(h, "retry-after-ms"); ok {
		r := math.Round(ms)
		return &r
	}
	if vals, ok := h["Retry-After"]; ok && len(vals) > 0 {
		v := strings.Join(vals, ", ")
		if jsstr.Trim(v) != "" {
			seconds := jsNumber(v)
			if finite(seconds) {
				if seconds >= 0 && finite(seconds*1000) {
					r := math.Round(seconds * 1000)
					return &r
				}
			} else if t, err := http.ParseTime(jsstr.Trim(v)); err == nil {
				d := math.Max(0, float64(t.UnixMilli()-now.UnixMilli()))
				return &d
			}
		}
	}
	if s, ok := nonNegative(h, "x-ratelimit-reset-after"); ok && finite(s*1000) {
		r := math.Round(s * 1000)
		return &r
	}
	return nil
}

func ptrOr(p *float64, def float64) float64 {
	if p != nil {
		return *p
	}
	return def
}

func errStr(err error) string { return redact.Kiro(err.Error()) }

// Stream runs one Kiro turn.
func Stream(ctx context.Context, req *StreamRequest, emit func(bridge.Event) error) error {
	s := &session{client: httpClient(), profiles: newProfileCache(req.ProfileArnCache)}
	model := &req.Model
	if req.AccessToken == "" {
		return errors.New("Kiro credentials not set. Run `kiro-cli login`, or set KIRO_API_KEY.")
	}
	accessToken := req.AccessToken
	region := model.Region
	if region == "" {
		region = "us-east-1"
	}
	auth := managementAuth{accessToken, region}
	cliCreds := kirocli.GetCredentials()
	if cliCreds == nil {
		cliCreds = kirocli.GetCredentialsAllowExpired()
	}
	cliProfileArn := ""
	if cliCreds != nil && cliCreds.Access == accessToken {
		cliProfileArn = cliCreds.ProfileArn
	}
	resolve := func(a managementAuth) (string, error) {
		if req.TestProfileArn != "" {
			return req.TestProfileArn, nil
		}
		return s.resolveProfileArn(ctx, a)
	}
	profileArn := model.ProfileArn
	if profileArn == "" {
		profileArn = req.ProfileArn
	}
	if profileArn == "" {
		profileArn = cliProfileArn
	}
	if profileArn == "" {
		arn, err := resolve(auth)
		if err != nil {
			var m *ManagementHTTPError
			if !errors.As(err, &m) || m.Status != 403 {
				return err
			}
			stored := kirocli.GetCredentials()
			fresh := stored
			if stored == nil || stored.Access == "" || stored.Access == accessToken {
				fresh = kirocli.RefreshViaKiroCli()
			}
			if fresh == nil || fresh.Access == "" {
				return err
			}
			accessToken = fresh.Access
			auth = managementAuth{accessToken, region}
			arn = fresh.ProfileArn
			if arn == "" {
				if arn, err = resolve(auth); err != nil {
					return err
				}
			}
		}
		profileArn = arn
	}
	runtimeRegion := regionFromProfileArn(profileArn)
	if runtimeRegion == "" {
		runtimeRegion = region
	}
	endpoint := resolveURL("generateAssistantResponse", runtimeBase(runtimeRegion))

	kiroModelID := model.KiroModelID
	if kiroModelID == "" {
		return fmt.Errorf("Unknown Kiro model ID: %s", model.ID)
	}
	effort := clampEffort(model, req.Effort)
	cfg := model.effortConfig(kiroModelID)
	extra := additionalFields(model, kiroModelID, req.Effort)
	thinkingEnabled := effort != "" || model.Reasoning
	if debugEnabled() {
		debugLog("request.init", map[string]any{
			"endpoint": endpoint, "model": model.ID, "kiroModelId": kiroModelID, "contextWindow": model.ContextWindow,
			"thinkingEnabled": thinkingEnabled, "reasoning": effort, "messageCount": len(req.Messages), "toolCount": len(req.Tools),
			"hasSystemPrompt": req.SystemPrompt != "", "profileArn": profileArn, "sessionId": req.SessionID,
		})
	}
	systemPrompt := req.SystemPrompt
	sendsThinking := extra != nil && extra.Has("thinking")
	if thinkingEnabled && (cfg == nil || cfg.field != "reasoning") && !sendsThinking {
		budget := 10000
		switch effort {
		case "xhigh", "max":
			budget = 50000
		case "high":
			budget = 30000
		case "medium":
			budget = 20000
		}
		prefix := fmt.Sprintf("<thinking_mode>enabled</thinking_mode><max_thinking_length>%d</max_thinking_length>", budget)
		if systemPrompt != "" {
			systemPrompt = prefix + "\n" + systemPrompt
		} else {
			systemPrompt = prefix
		}
	}
	declared := map[string]bool{}
	for _, t := range req.Tools {
		declared[t.Name] = true
	}
	asm := newAssembler(model, thinkingEnabled, toolNameAliases(req.Tools), declared)
	tracking := req.UsageTracking
	if tracking == nil {
		tracking = &UsageTracking{USDPerCredit: 0.04, EstimatedCacheTimeout: 300000}
	}
	firstTokenMs := float64(defaultFirstTokenTimeoutMs)
	if model.FirstTokenTimeout > 0 {
		firstTokenMs = model.FirstTokenTimeout
	}
	headerMs := float64(defaultRequestHeaderTimeoutMs)
	idle := defaultIdleTimeout
	if t := req.Timeouts; t != nil {
		if t.FirstTokenMs > 0 {
			firstTokenMs = t.FirstTokenMs
		}
		if t.RequestHeaderMs > 0 {
			headerMs = t.RequestHeaderMs
		}
		if t.IdleMs > 0 {
			idle = time.Duration(t.IdleMs * float64(time.Millisecond))
		}
	}
	capacityMax, capacityBase := 3, 5000.0
	if c := req.CapacityRetry; c != nil {
		capacityMax, capacityBase = c.MaxRetries, c.BaseDelayMs
	}
	flush := func() error {
		for _, e := range asm.takeEvents() {
			if err := emit(e); err != nil {
				return err
			}
		}
		return nil
	}

	retryCount, maxRetries := 0, 3
	emptyAttempts, echoAttempts := 0, 0
	credentialRefreshTotal, capacityRetryTotal := 0, 0
	conversationID := req.ConversationID
	if conversationID == "" {
		conversationID = req.SessionID
	}
	if conversationID == "" {
		conversationID = newUUID()
	}

requestLoop:
	for retryCount <= maxRetries {
		if err := ctx.Err(); err != nil {
			return err
		}
		built, err := buildRequest(req.Messages, model, kiroModelID, systemPrompt, req.Tools, conversationID, profileArn, extra)
		if err != nil {
			return err
		}
		body := jsjson.Stringify(built.body)
		var resp *http.Response
		var cancelAttempt context.CancelFunc = func() {}
		capacityRetryCount := 0
		refreshed := false
		for {
			mid := strings.ReplaceAll(newUUID(), "-", "")
			ua := "aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-" + mid
			if debugEnabled() {
				var reqJSON any
				_ = json.Unmarshal([]byte(body), &reqJSON)
				debugLog("request.send", map[string]any{
					"attempt": retryCount, "capacityAttempt": capacityRetryCount, "historyLen": built.historyLen,
					"currentContentLen": built.contentLen, "hasImages": built.hasImages, "toolResultCount": built.toolResultCount, "request": reqJSON,
				})
			}
			attemptCtx, cancel := context.WithCancel(ctx)
			cancelAttempt = cancel
			var headerTimedOut atomic.Bool
			deadline := time.AfterFunc(time.Duration(headerMs*float64(time.Millisecond)), func() {
				headerTimedOut.Store(true)
				cancel()
			})
			httpReq, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, endpoint, strings.NewReader(body))
			if err != nil {
				deadline.Stop()
				cancel()
				return err
			}
			h := httpReq.Header
			h.Set("Content-Type", "application/json")
			h.Set("Accept", "application/vnd.amazon.eventstream")
			authHeaders(h, accessToken, true)
			h.Set("x-amzn-codewhisperer-optout", "true")
			h.Set("amz-sdk-invocation-id", newUUID())
			h.Set("amz-sdk-request", "attempt=1; max=1")
			h.Set("x-amzn-kiro-agent-mode", "vibe")
			h.Set("x-amz-user-agent", ua)
			h.Set("user-agent", ua)
			resp, err = s.client.Do(httpReq)
			deadline.Stop()
			if err != nil {
				cancel()
				if !headerTimedOut.Load() || ctx.Err() != nil {
					if ctx.Err() != nil {
						return ctx.Err()
					}
					return &networkError{err}
				}
				if retryCount >= maxRetries {
					return errors.New("Kiro API error: response headers timeout after max retries")
				}
				retryCount++
				if err := sleep(ctx, exponentialBackoff(retryCount-1, 1000, maxRetryDelayMs)); err != nil {
					return err
				}
				continue requestLoop
			}
			if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
				break
			}
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			cancel()
			errText := redact.Kiro(string(raw))
			safeStatus := redact.Kiro(statusText(resp))
			reason := extractReason(errText)
			rateExceeded := resp.StatusCode == 429 && reason == reasonUserRequestRate && !isNonRetryableBodyError(errText) && !isCapacityError(errText)
			if debugEnabled() {
				data := map[string]any{"status": resp.StatusCode, "statusText": safeStatus}
				if rateExceeded {
					data["reasonCode"] = reason
				} else {
					data["body"] = errText
				}
				debugLog("response.error", data)
			}
			if isCapacityError(errText) && capacityRetryCount < capacityMax {
				capacityRetryCount++
				capacityRetryTotal++
				delay := exponentialBackoff(capacityRetryCount-1, capacityBase, 30000)
				logCapacityEvent(fmt.Sprintf("INSUFFICIENT_MODEL_CAPACITY — retrying in %sms (%d/%d)", jsjson.FormatNumber(delay), capacityRetryCount, capacityMax))
				if err := sleep(ctx, delay); err != nil {
					return err
				}
				continue
			}
			if isCapacityError(errText) {
				logCapacityEvent(fmt.Sprintf("INSUFFICIENT_MODEL_CAPACITY — exhausted %d retries, giving up", capacityMax))
			}
			if rateExceeded {
				if retryCount >= maxRetries {
					return fmt.Errorf("Kiro API error: request window retry budget exhausted (%s)", reasonUserRequestRate)
				}
				retryCount++
				advertised := parseRetryAfterMs(resp.Header, time.Now())
				requested := ptrOr(advertised, requestRateFallbackDelayMs)
				delay := math.Min(requested, maxRetryDelayMs)
				if debugEnabled() {
					data := map[string]any{"attempt": retryCount, "maxRetries": maxRetries, "delayMs": delay, "capped": requested > maxRetryDelayMs, "reasonCode": reason}
					if advertised != nil {
						data["advertisedDelayMs"] = *advertised
					}
					debugLog("request.rateWindowRetry", data)
				}
				if err := sleep(ctx, delay); err != nil {
					return err
				}
				continue requestLoop
			}
			if resp.StatusCode == 403 && !isCapacityError(errText) && retryCount < maxRetries {
				retryCount++
				credentialRefreshTotal++
				s.profiles.invalidate(auth)
				rejectedToken, rejectedArn := accessToken, profileArn
				stored := kirocli.GetCredentials()
				var rejectedCli *kirocli.Credentials
				if stored != nil && stored.Access == rejectedToken {
					rejectedCli = stored
				} else if cliCreds != nil && cliCreds.Access == rejectedToken {
					rejectedCli = cliCreds
				}
				var fresh *kirocli.Credentials
				if stored != nil && stored.Access != "" && stored.Access != rejectedToken {
					fresh = stored
				} else {
					fresh = kirocli.RefreshViaKiroCli()
				}
				if fresh != nil && fresh.Access != "" {
					accessToken = fresh.Access
				}
				auth = managementAuth{accessToken, region}
				inherited := ""
				if rejectedCli != nil && rejectedCli.AuthMethod == "desktop" && fresh != nil && fresh.AuthMethod == "desktop" {
					inherited = rejectedArn
				}
				switch {
				case fresh != nil && fresh.ProfileArn != "":
					profileArn = fresh.ProfileArn
				case inherited != "":
					profileArn = inherited
				default:
					arn, err := resolve(auth)
					if err != nil {
						return err
					}
					profileArn = arn
				}
				runtimeRegion = regionFromProfileArn(profileArn)
				if runtimeRegion == "" {
					runtimeRegion = region
				}
				endpoint = resolveURL("generateAssistantResponse", runtimeBase(runtimeRegion))
				if err := sleep(ctx, exponentialBackoff(retryCount-1, 500, maxRetryDelayMs)); err != nil {
					return err
				}
				refreshed = true
				break
			}
			retryAfter := parseRetryAfterMs(resp.Header, time.Now())
			apiErr := &APIError{Status: resp.StatusCode, ReasonCode: extractReasonCode(errText), RetryAfterMs: retryAfter, CredentialRefresh: credentialRefreshTotal, Capacity: capacityRetryTotal}
			switch {
			case isNonRetryableBodyError(errText) || isCapacityError(errText):
				detail := errText
				if detail == "" {
					detail = safeStatus
				}
				apiErr.Message = "Kiro API error: " + detail
			case isTooBigError(resp.StatusCode, errText):
				apiErr.Message = fmt.Sprintf("Kiro API error: context_length_exceeded (%d %s)", resp.StatusCode, errText)
			default:
				apiErr.Message = fmt.Sprintf("Kiro API error: %d %s %s", resp.StatusCode, safeStatus, errText)
			}
			return apiErr
		}
		if refreshed {
			continue requestLoop
		}
		if capacityRetryCount > 0 {
			logCapacityEvent(fmt.Sprintf("INSUFFICIENT_MODEL_CAPACITY — succeeded after %d retries", capacityRetryCount))
		}
		if err := emit(bridge.Start()); err != nil {
			resp.Body.Close()
			cancelAttempt()
			return err
		}
		asm.beginAttempt()
		var emitErr error
		outcome := readEventStream(ctx, resp.Body, time.Duration(firstTokenMs*float64(time.Millisecond)), idle, func(ev *wireEvent) {
			if emitErr != nil {
				return
			}
			if debugEnabled() {
				debugLog("stream.events", []any{ev.Type})
			}
			asm.handle(ev)
			emitErr = flush()
		})
		resp.Body.Close()
		cancelAttempt()
		if emitErr != nil {
			return emitErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := flush(); err != nil {
			return err
		}
		if outcome.firstTokenTimedOut || outcome.idleTimedOut || outcome.err != "" {
			if retryCount < maxRetries {
				retryCount++
				if outcome.errData != nil && debugEnabled() {
					debugLog("stream.error.typed", []any{outcome.errData})
				}
				asm.discard()
				if err := flush(); err != nil {
					return err
				}
				if err := sleep(ctx, exponentialBackoff(retryCount-1, 1000, maxRetryDelayMs)); err != nil {
					return err
				}
				continue
			}
			if outcome.err != "" {
				return errors.New("Kiro API stream error after max retries: " + outcome.err)
			}
			which := "idle"
			if outcome.firstTokenTimedOut {
				which = "first token"
			}
			return fmt.Errorf("Kiro API error: %s timeout after max retries", which)
		}
		summary := asm.endTurn()
		if err := terminalWireStop(summary.wireStopReason, summary.wireStopDetails); err != nil {
			return err
		}
		if err := flush(); err != nil {
			return err
		}
		degenerate := summary.isEmpty || summary.isEchoLoop
		if summary.isEchoLoop {
			echoAttempts++
		} else if degenerate {
			emptyAttempts++
		}
		errorMessage := ""
		if degenerate {
			mayRetry := retryCount < maxRetries && (!summary.isEchoLoop || req.CanDiscardEmittedBlocks)
			if mayRetry {
				retryCount++
				what := "Empty response (no text, no tool calls)"
				if summary.isEchoLoop {
					what = `Echo loop detected (model responded with just "Continue")`
				}
				logx.Warn(fmt.Sprintf("[kiro-core] %s — retrying (%d/%d)", what, retryCount, maxRetries))
				asm.discard()
				if err := flush(); err != nil {
					return err
				}
				if err := sleep(ctx, exponentialBackoff(retryCount-1, 1000, maxRetryDelayMs)); err != nil {
					return err
				}
				continue
			}
			if summary.isEchoLoop {
				asm.stripEcho()
				alsoEmpty := ""
				if emptyAttempts > 0 {
					alsoEmpty = " (plus " + describeAttempts(emptyAttempts) + " with no text at all)"
				}
				logx.Warn(fmt.Sprintf(`[kiro-core] Echo loop persisted across %s%s — stripping "Continue" response (%d chars)`, describeAttempts(echoAttempts), alsoEmpty, jsstr.Len(summary.responseText)))
				errorMessage = fmt.Sprintf(`Kiro model echoed its own continuation prompt (%s) on %s%s and emitted no tool calls; retry budget exhausted, text stripped, stopReason:"%s"`,
					jsjson.QuoteString(clampForDiagnostic(summary.responseText)), describeAttempts(echoAttempts), alsoEmpty, summary.stopReason)
			} else {
				alsoEchoed := ""
				if echoAttempts > 0 {
					alsoEchoed = " (plus " + describeAttempts(echoAttempts) + " that echoed the continuation prompt)"
				}
				logx.Warn(fmt.Sprintf(`[kiro-core] Empty response on %s%s, retry budget exhausted — returning stopReason:"%s" to avoid agent loop stall`, describeAttempts(emptyAttempts), alsoEchoed, summary.stopReason))
				errorMessage = fmt.Sprintf(`Kiro returned no text and no tool calls on %s%s; retry budget exhausted, %s with stopReason:"%s"`,
					describeAttempts(emptyAttempts), alsoEchoed, describeReturnedContent(asm.contentKinds()), summary.stopReason)
			}
		}
		if n := len(summary.droppedToolCalls); n > 0 {
			calls, it := "tool calls", "they were"
			if n == 1 {
				calls, it = "a tool call", "it was"
			}
			drop := fmt.Sprintf(`Kiro sent %s with unparseable arguments (%s); %s dropped and never reached the agent, stopReason:"%s"`,
				calls, describeDroppedToolNames(summary.droppedToolCalls), it, summary.stopReason)
			if errorMessage != "" {
				errorMessage += ". " + drop
			} else {
				errorMessage = drop
			}
		}
		stopReason, usage, wire, meter, err := asm.complete()
		if err != nil {
			return err
		}
		if err := flush(); err != nil {
			return err
		}
		if errorMessage == "" {
			if cost := estimateCreditCost(tracking, meter); cost != nil {
				usage.Cost.Total = *cost
			}
		}
		wireCache := wire != nil && (wire.CacheReadInputTokens != nil || wire.CacheWriteInputTokens != nil)
		if err := emit(UsageEvent{UsageEvent: bridge.UsageUpdate(usage), WireCache: wireCache}); err != nil {
			return err
		}
		done := bridge.Done(stopReason)
		done.ErrorMessage = errorMessage
		var changes map[string]*string
		if len(s.profiles.changes) > 0 {
			changes = s.profiles.changes
		}
		return emit(DoneEvent{DoneEvent: done, ProfileArns: changes, RuntimeRegion: runtimeRegion, ProfileArn: profileArn})
	}
	return errors.New("Kiro API error: retry budget exhausted")
}

// estimateCreditCost is estimateKiroCreditCost.
func estimateCreditCost(t *UsageTracking, m *metering) *float64 {
	if !t.EstimateDollarValue || m == nil || m.Unit == nil {
		return nil
	}
	if u := strings.ToLower(*m.Unit); u != "credit" && u != "credits" {
		return nil
	}
	if m.Credits == nil || !finite(*m.Credits) || *m.Credits < 0 {
		return nil
	}
	v := *m.Credits * t.USDPerCredit
	return &v
}
