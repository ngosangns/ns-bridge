// Package devin is the Go port of ns-devin-core's streaming path: Cascade
// over Connect (GetUserJwt → AssignModel for routers → GetChatMessage),
// emitting the neutral BridgeStreamEvent sequence, plus the optional capacity
// backoff. Login stays in TypeScript; the request carries the session token.
package devin

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/httpx"
)

func defaultHTTPClient() *http.Client { return httpx.Client() }

// Vendor implements sidecar.Streamer for --vendor devin.
type Vendor struct{}

func (Vendor) Stream(ctx context.Context, raw json.RawMessage, emit func(bridge.Event) error) error {
	var req StreamRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return bridge.Errorf(bridge.KindInvalidRequest, "devin request: %v", err)
	}
	if req.Model.ID == "" {
		return bridge.Errorf(bridge.KindInvalidRequest, "devin request: model.id is required")
	}
	err := Stream(ctx, &req, emit)
	if err == nil || ctx.Err() != nil {
		return err
	}
	return toBridgeError(err)
}

// Stream runs one turn, with capacity retries when the request asks for them.
func Stream(ctx context.Context, req *StreamRequest, emit func(bridge.Event) error) error {
	nextIndex := 0
	if req.CapacityRetry == nil {
		return streamOnce(ctx, req, &nextIndex, emit)
	}
	policy := *req.CapacityRetry
	for attempt := 0; ; attempt++ {
		// Hold `start` until real content arrives: a capacity failure before
		// any block is still retryable; after one, it propagates unchanged.
		heldStart := false
		committed := false
		err := streamOnce(ctx, req, &nextIndex, func(event bridge.Event) error {
			if !committed && event.EventType() == "start" {
				heldStart = true
				return nil
			}
			if !committed {
				committed = true
				if heldStart {
					if err := emit(bridge.Start()); err != nil {
						return err
					}
				}
			}
			return emit(event)
		})
		if err == nil {
			if !committed && heldStart {
				return emit(bridge.Start())
			}
			return nil
		}
		if committed || attempt >= policy.MaxRetries || !IsCapacityError(err) {
			return err
		}
		delay := policy.BaseDelayMs << attempt
		if delay > policy.MaxDelayMs || delay < 0 {
			delay = policy.MaxDelayMs
		}
		timer := time.NewTimer(time.Duration(delay) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return context.Cause(ctx)
		case <-timer.C:
		}
	}
}
