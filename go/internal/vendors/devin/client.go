package devin

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
)

func postUnary[T any](ctx context.Context, baseURL, path string, body []byte, operation string, decode func([]byte) (T, error)) (T, bool, error) {
	var zero T
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+path, bytes.NewReader(body))
	if err != nil {
		return zero, false, err
	}
	req.Header.Set("content-type", "application/proto")
	req.Header.Set("connect-protocol-version", "1")
	req.Header.Set("accept", "*/*")
	resp, err := httpClient().Do(req)
	if err != nil {
		return zero, false, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return zero, false, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return zero, false, newHTTPError(operation, resp, payload)
	}
	v, ok := decodeUnary(payload, decode)
	return v, ok, nil
}

type authMetadata struct {
	userJwt string
	apiKey  string // the credential bytes the server accepted
	baseURL string // edge URL the account is pinned to, if any
}

// fetchAuthMetadata exchanges the credential for the per-request user JWT:
// first as a session token, then — on a 401 — once as a raw legacy key.
func fetchAuthMetadata(ctx context.Context, apiKey, baseURL string) (*authMetadata, error) {
	session := cliMetadata(apiKey, "")
	wireKey := session.APIKey
	decoded, ok, err := postUnary(ctx, baseURL, authPath, encodeGetUserJwtRequest(session), "auth", decodeGetUserJwtResponse)
	if err != nil {
		apiErr, isAPI := err.(*APIError)
		raw := wireMetadata(apiKey, "")
		if !isAPI || apiErr.Status != 401 || raw.APIKey == "" || raw.APIKey == wireKey {
			return nil, err
		}
		decoded, ok, err = postUnary(ctx, baseURL, authPath, encodeGetUserJwtRequest(raw), "auth", decodeGetUserJwtResponse)
		if err != nil {
			return nil, err
		}
		wireKey = raw.APIKey
	}
	if !ok || decoded.UserJwt == "" {
		return nil, &ProtocolError{Kind: "runtime", Message: "Devin auth error: GetUserJwt returned an empty user JWT"}
	}
	out := &authMetadata{userJwt: decoded.UserJwt, apiKey: wireKey}
	if custom := strings.TrimSpace(decoded.CustomAPIServerURL); custom != "" {
		out.baseURL = strings.TrimRight(custom, "/")
	}
	return out, nil
}

// assignModel resolves a router uid into a concrete uid plus its JWT.
func assignModel(ctx context.Context, model ModelSpec, t turn, prompt *ChatMessagePrompt, baseURL string) (*ModelAssignment, error) {
	router := model.RequestModelID
	if router == "" {
		router = model.ID
	}
	body := encodeAssignModelRequest(wireMetadata(t.apiKey, ""), router, t.cascadeID, prompt)
	assignment, _, err := postUnary(ctx, baseURL, assignModelPath, body, "AssignModel", decodeAssignModelResponse)
	if err != nil {
		return nil, err
	}
	if assignment == nil || assignment.AssignmentJwt == "" || assignment.ModelUID == "" {
		return nil, &ProtocolError{Kind: "runtime", Message: "Devin AssignModel error: response carried no assignment JWT and model uid"}
	}
	return assignment, nil
}
