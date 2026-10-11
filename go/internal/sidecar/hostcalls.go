package sidecar

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
)

// hostCalls implements bridge.Host over the call's pipes: notifications ride
// stdout like events do; a prompt is a request carrying an id whose answer
// arrives on a stdin line, routed in by RunLogin's stdin reader.
type hostCalls struct {
	out     *bridge.Writer
	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan hostReply
}

type hostReply struct {
	result json.RawMessage
	err    error
}

func newHostCalls(out *bridge.Writer) *hostCalls {
	return &hostCalls{out: out, pending: map[int64]chan hostReply{}}
}

func (h *hostCalls) AuthURL(url, instructions string) error {
	return h.out.Notify(bridge.HostAuthURL, map[string]any{"url": url, "instructions": instructions})
}

func (h *hostCalls) Progress(message string) error {
	return h.out.Notify(bridge.HostProgress, map[string]any{"message": message})
}

// Prompt emits a host/prompt request and waits for the host's reply.
func (h *hostCalls) Prompt(ctx context.Context, params bridge.PromptParams) (string, error) {
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	replies := make(chan hostReply, 1)
	h.pending[id] = replies
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
	}()

	if err := h.out.Request(id, bridge.HostPrompt, params); err != nil {
		return "", err
	}
	select {
	case reply := <-replies:
		if reply.err != nil {
			return "", reply.err
		}
		var answer string
		if err := json.Unmarshal(reply.result, &answer); err != nil {
			return "", bridge.Errorf(bridge.KindProtocol, "host prompt reply is not a string: %s", reply.result)
		}
		return answer, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// route delivers one post-envelope stdin line to the pending host request it
// answers, if it is one. Anything else — blank lines, non-JSON bytes, replies
// to ids nobody asked — is ignored, as the discard drain did before.
func (h *hostCalls) route(line []byte) {
	var reply bridge.HostReply
	if err := json.Unmarshal(line, &reply); err != nil || reply.ID == nil {
		return
	}
	h.mu.Lock()
	replies, ok := h.pending[*reply.ID]
	delete(h.pending, *reply.ID)
	h.mu.Unlock()
	if !ok {
		return
	}
	out := hostReply{result: reply.Result}
	if reply.Error != nil {
		out.err = fmt.Errorf("host refused the call: %s", reply.Error.Message)
	}
	replies <- out
}
