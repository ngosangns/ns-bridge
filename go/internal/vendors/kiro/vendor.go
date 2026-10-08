package kiro

import (
	"context"
	"encoding/json"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
)

// Vendor implements sidecar.Streamer for --vendor kiro.
type Vendor struct{}

func (Vendor) Stream(ctx context.Context, raw json.RawMessage, emit func(bridge.Event) error) error {
	var req StreamRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return bridge.Errorf(bridge.KindInvalidRequest, "kiro request: %v", err)
	}
	if req.Model.ID == "" {
		return bridge.Errorf(bridge.KindInvalidRequest, "kiro request: model.id is required")
	}
	err := Stream(ctx, &req, emit)
	if err == nil || ctx.Err() != nil {
		return err
	}
	return toBridgeError(err)
}
