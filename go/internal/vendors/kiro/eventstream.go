package kiro

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
)

// esMessage is one decoded application/vnd.amazon.eventstream message.
type esMessage struct {
	headers map[string]any // string values for string headers; others typed
	body    []byte
}

func (m *esMessage) header(name string) (string, bool) {
	v, ok := m.headers[name]
	if !ok {
		return "", false
	}
	s, isString := v.(string)
	return s, isString
}

// readESMessage reads one message the way @smithy's EventStreamCodec does,
// with the same error wording where a test can see it.
func readESMessage(r io.Reader) (*esMessage, error) {
	var prelude [4]byte
	n, err := io.ReadFull(r, prelude[:])
	if err != nil {
		if n == 0 && errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, errors.New("Truncated event message received.")
		}
		return nil, err
	}
	total := binary.BigEndian.Uint32(prelude[:])
	if total < 16 {
		return nil, errors.New("Provided message too short to accommodate event stream message overhead")
	}
	if total > 64<<20 {
		return nil, fmt.Errorf("event stream message of %d bytes exceeds the 64 MiB cap", total)
	}
	buf := make([]byte, total)
	copy(buf, prelude[:])
	if _, err := io.ReadFull(r, buf[4:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
			return nil, errors.New("Truncated event message received.")
		}
		return nil, err
	}
	headersLen := binary.BigEndian.Uint32(buf[4:8])
	expectedPrelude := binary.BigEndian.Uint32(buf[8:12])
	expectedMessage := binary.BigEndian.Uint32(buf[total-4:])
	if got := crc32.ChecksumIEEE(buf[:8]); got != expectedPrelude {
		return nil, fmt.Errorf("The prelude checksum specified in the message (%d) does not match the calculated CRC32 checksum (%d)", expectedPrelude, got)
	}
	if got := crc32.ChecksumIEEE(buf[:total-4]); got != expectedMessage {
		return nil, fmt.Errorf("The message checksum (%d) did not match the expected value of %d", got, expectedMessage)
	}
	if 12+int(headersLen) > int(total)-4 {
		return nil, errors.New("Reported message length does not match received message length")
	}
	headers, err := parseESHeaders(buf[12 : 12+headersLen])
	if err != nil {
		return nil, err
	}
	return &esMessage{headers: headers, body: buf[12+headersLen : total-4]}, nil
}

func parseESHeaders(b []byte) (map[string]any, error) {
	out := map[string]any{}
	need := func(pos, n int) error {
		if pos+n > len(b) {
			return errors.New("Unrecognized header type tag")
		}
		return nil
	}
	for pos := 0; pos < len(b); {
		nameLen := int(b[pos])
		pos++
		if err := need(pos, nameLen+1); err != nil {
			return nil, err
		}
		name := string(b[pos : pos+nameLen])
		pos += nameLen
		tag := b[pos]
		pos++
		switch tag {
		case 0:
			out[name] = true
		case 1:
			out[name] = false
		case 2:
			if err := need(pos, 1); err != nil {
				return nil, err
			}
			out[name] = int64(int8(b[pos]))
			pos++
		case 3:
			if err := need(pos, 2); err != nil {
				return nil, err
			}
			out[name] = int64(int16(binary.BigEndian.Uint16(b[pos:])))
			pos += 2
		case 4:
			if err := need(pos, 4); err != nil {
				return nil, err
			}
			out[name] = int64(int32(binary.BigEndian.Uint32(b[pos:])))
			pos += 4
		case 5, 8:
			if err := need(pos, 8); err != nil {
				return nil, err
			}
			out[name] = int64(binary.BigEndian.Uint64(b[pos:]))
			pos += 8
		case 6, 7:
			if err := need(pos, 2); err != nil {
				return nil, err
			}
			l := int(binary.BigEndian.Uint16(b[pos:]))
			pos += 2
			if err := need(pos, l); err != nil {
				return nil, err
			}
			if tag == 7 {
				out[name] = string(b[pos : pos+l])
			} else {
				out[name] = append([]byte(nil), b[pos:pos+l]...)
			}
			pos += l
		case 9:
			if err := need(pos, 16); err != nil {
				return nil, err
			}
			out[name] = fmt.Sprintf("%x-%x-%x-%x-%x", b[pos:pos+4], b[pos+4:pos+6], b[pos+6:pos+8], b[pos+8:pos+10], b[pos+10:pos+16])
			pos += 16
		default:
			return nil, errors.New("Unrecognized header type tag")
		}
	}
	return out, nil
}

// encodeESMessage builds a message with string headers (tests).
func encodeESMessage(headers [][2]string, body []byte) []byte {
	var hb []byte
	for _, h := range headers {
		hb = append(hb, byte(len(h[0])))
		hb = append(hb, h[0]...)
		hb = append(hb, 7)
		hb = binary.BigEndian.AppendUint16(hb, uint16(len(h[1])))
		hb = append(hb, h[1]...)
	}
	total := 12 + len(hb) + len(body) + 4
	out := make([]byte, 0, total)
	out = binary.BigEndian.AppendUint32(out, uint32(total))
	out = binary.BigEndian.AppendUint32(out, uint32(len(hb)))
	out = binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(out[:8]))
	out = append(out, hb...)
	out = append(out, body...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(out))
}
