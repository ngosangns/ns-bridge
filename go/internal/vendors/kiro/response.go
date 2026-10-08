package kiro

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
)

const defaultIdleTimeout = 300 * time.Second

// streamOutcome is KiroEventStreamOutcome.
type streamOutcome struct {
	firstTokenTimedOut bool
	idleTimedOut       bool
	err                string // "" = none
	errData            *errorData
}

type frameOrErr struct {
	key     string
	payload *jsjson.Object
	errText string
	errData *errorData
	done    bool
}

// unmarshal is the @smithy message unmarshaller plus response-stream.ts's
// deserializer callback, for one message.
func unmarshal(m *esMessage) frameOrErr {
	msgType, _ := m.header(":message-type")
	switch msgType {
	case "error":
		text, _ := m.header(":error-message")
		if text == "" {
			text = "UnknownError"
		}
		return frameOrErr{errText: text}
	case "exception":
		key, _ := m.header(":exception-type")
		parsed := jsjson.NewObject()
		if v, err := jsjson.Parse(m.body); err == nil {
			if o, ok := v.(*jsjson.Object); ok {
				parsed = o
			}
		}
		data := parseExceptionFrame(key, parsed)
		if data == nil {
			data = &errorData{Error: key, Kind: "unknown", Message: strp(get(parsed, "message")), Reason: strp(get(parsed, "reason")), RetryAfterMilliseconds: num(get(parsed, "retryAfterMilliseconds"))}
		}
		return frameOrErr{errText: data.text(), errData: data}
	case "event":
		key, _ := m.header(":event-type")
		v, err := jsjson.Parse(m.body)
		if err != nil {
			return frameOrErr{errText: "Unexpected token in JSON: " + err.Error()}
		}
		o, _ := v.(*jsjson.Object)
		return frameOrErr{key: key, payload: o}
	default:
		key, _ := m.header(":event-type")
		return frameOrErr{errText: "Unrecognizable event type: " + key}
	}
}

// readEventStream decodes the response body, calling onFrame for each
// event frame (after parseKiroEvent), and reports how the stream ended.
func readEventStream(ctx context.Context, body io.ReadCloser, firstTokenTimeout, idleTimeout time.Duration, onFrame func(*wireEvent)) streamOutcome {
	var out streamOutcome
	frames := make(chan frameOrErr, 16)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		defer close(frames)
		for {
			m, err := readESMessage(body)
			var f frameOrErr
			switch {
			case errors.Is(err, io.EOF):
				f = frameOrErr{done: true}
			case err != nil:
				f = frameOrErr{errText: err.Error()}
			default:
				f = unmarshal(m)
			}
			select {
			case frames <- f:
			case <-stop:
				return
			}
			if f.done || f.errText != "" {
				return
			}
		}
	}()
	timer := time.NewTimer(firstTokenTimeout)
	defer timer.Stop()
	gotFirst := false
	for {
		select {
		case <-ctx.Done():
			body.Close()
			out.err = "Request aborted"
			return out
		case <-timer.C:
			body.Close()
			if !gotFirst {
				out.firstTokenTimedOut = true
			} else {
				out.idleTimedOut = true
			}
			return out
		case f, ok := <-frames:
			if !ok || f.done {
				return out
			}
			if f.errText != "" {
				out.err = f.errText
				out.errData = f.errData
				return out
			}
			gotFirst = true
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(idleTimeout)
			ev := parseEvent(f.key, f.payload)
			if ev == nil {
				continue
			}
			if ev.Type == "ignored" {
				if debugEnabled() {
					debugLog("stream.events.ignored", []any{ev.Key})
				}
				continue
			}
			if ev.Type == "error" {
				out.err = ev.Err.text()
				out.errData = ev.Err
				body.Close()
				return out
			}
			onFrame(ev)
		}
	}
}
