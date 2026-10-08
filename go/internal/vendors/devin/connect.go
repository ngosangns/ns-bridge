package devin

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
)

const (
	connectCompressedFlag = 0x01
	connectEndStreamFlag  = 0x02
	// maxConnectFramePayload bounds one frame so a corrupt length prefix
	// cannot make the reader buffer gigabytes.
	maxConnectFramePayload = 16 * 1024 * 1024
)

// encodeConnectFrame gzips and envelopes a request the way connect-go does.
func encodeConnectFrame(message []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(message)
	_ = zw.Close()
	frame := make([]byte, 5, 5+buf.Len())
	frame[0] = connectCompressedFlag
	binary.BigEndian.PutUint32(frame[1:5], uint32(buf.Len()))
	return append(frame, buf.Bytes()...)
}

type connectEnvelope struct {
	payload   []byte
	endStream bool
}

// readConnectFrame reads the next frame; io.EOF at a clean frame boundary.
func readConnectFrame(r io.Reader) (*connectEnvelope, error) {
	var head [5]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		if err == io.ErrUnexpectedEOF {
			return nil, io.EOF // a partial header at the end is dropped, as the TS reader does
		}
		return nil, err
	}
	length := binary.BigEndian.Uint32(head[1:5])
	if length > maxConnectFramePayload {
		return nil, &ProtocolError{Kind: "envelope", Message: fmt.Sprintf("Devin Connect frame length %d exceeds %d-byte cap", length, maxConnectFramePayload)}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		if err == io.ErrUnexpectedEOF {
			return nil, io.EOF
		}
		return nil, err
	}
	if head[0]&connectCompressedFlag != 0 {
		zr, err := gzip.NewReader(bytes.NewReader(payload))
		if err != nil {
			return nil, &ProtocolError{Kind: "envelope", Message: "Devin Connect frame: " + err.Error()}
		}
		payload, err = io.ReadAll(zr)
		if err != nil {
			return nil, &ProtocolError{Kind: "envelope", Message: "Devin Connect frame: " + err.Error()}
		}
	}
	return &connectEnvelope{payload: payload, endStream: head[0]&connectEndStreamFlag != 0}, nil
}

// decodeUnary decodes a unary response body, bare or gzipped.
func decodeUnary[T any](payload []byte, decode func([]byte) (T, error)) (T, bool) {
	if v, err := decode(payload); err == nil {
		return v, true
	}
	var zero T
	zr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return zero, false
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return zero, false
	}
	v, err := decode(raw)
	if err != nil {
		return zero, false
	}
	return v, true
}
