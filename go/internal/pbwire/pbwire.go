// Package pbwire is the small slice of the protobuf binary wire format the
// Devin core needs: writing fields in declaration order (proto3 defaults
// omitted, as the TypeScript codec does) and walking a message's fields.
// Hand-rolled so the module stays dependency-free.
package pbwire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Wire types.
const (
	Varint  = 0
	Fixed64 = 1
	Bytes   = 2
	Fixed32 = 5
)

// Writer appends fields to a buffer.
type Writer struct{ buf []byte }

func (w *Writer) Finish() []byte { return w.buf }

func (w *Writer) tag(no, wt int) { w.varint(uint64(no)<<3 | uint64(wt)) }

func (w *Writer) varint(v uint64) { w.buf = binary.AppendUvarint(w.buf, v) }

// String writes a string field unless it is empty.
func (w *Writer) String(no int, s string) {
	if s == "" {
		return
	}
	w.tag(no, Bytes)
	w.varint(uint64(len(s)))
	w.buf = append(w.buf, s...)
}

// OptionalString writes a string field when present, even if empty.
func (w *Writer) OptionalString(no int, s *string) {
	if s == nil {
		return
	}
	w.tag(no, Bytes)
	w.varint(uint64(len(*s)))
	w.buf = append(w.buf, *s...)
}

// RepeatedString writes each element (empty strings included).
func (w *Writer) RepeatedString(no int, items []string) {
	for _, s := range items {
		w.tag(no, Bytes)
		w.varint(uint64(len(s)))
		w.buf = append(w.buf, s...)
	}
}

// Uint writes a uint64/uint32/enum field unless it is zero.
func (w *Writer) Uint(no int, v uint64) {
	if v == 0 {
		return
	}
	w.tag(no, Varint)
	w.varint(v)
}

// Int32 writes an int32 field unless it is zero (negatives sign-extend).
func (w *Writer) Int32(no int, v int32) {
	if v == 0 {
		return
	}
	w.tag(no, Varint)
	w.varint(uint64(int64(v)))
}

// Bool writes a bool field unless it is false.
func (w *Writer) Bool(no int, v bool) {
	if !v {
		return
	}
	w.tag(no, Varint)
	w.varint(1)
}

// Double writes a double field unless it is zero.
func (w *Writer) Double(no int, v float64) {
	if v == 0 {
		return
	}
	w.tag(no, Fixed64)
	w.buf = binary.LittleEndian.AppendUint64(w.buf, math.Float64bits(v))
}

// Message writes an embedded message (present even when empty).
func (w *Writer) Message(no int, body []byte) {
	w.tag(no, Bytes)
	w.varint(uint64(len(body)))
	w.buf = append(w.buf, body...)
}

// Field is one decoded field.
type Field struct {
	No   int
	Type int
	// Varint value, or the raw bits of a fixed field.
	Uint uint64
	// Bytes for length-delimited fields.
	Data []byte
}

// Str is the field as a string.
func (f Field) Str() string { return string(f.Data) }

// Float64 is a fixed64 field as a double.
func (f Field) Float64() float64 { return math.Float64frombits(f.Uint) }

var errTruncated = errors.New("protobuf: truncated message")

// Each calls fn for every field of a message, in wire order.
func Each(data []byte, fn func(Field) error) error {
	for len(data) > 0 {
		key, n := binary.Uvarint(data)
		if n <= 0 {
			return errTruncated
		}
		data = data[n:]
		f := Field{No: int(key >> 3), Type: int(key & 7)}
		if f.No == 0 {
			return errors.New("protobuf: field number 0")
		}
		switch f.Type {
		case Varint:
			v, n := binary.Uvarint(data)
			if n <= 0 {
				return errTruncated
			}
			f.Uint, data = v, data[n:]
		case Fixed64:
			if len(data) < 8 {
				return errTruncated
			}
			f.Uint, data = binary.LittleEndian.Uint64(data), data[8:]
		case Fixed32:
			if len(data) < 4 {
				return errTruncated
			}
			f.Uint, data = uint64(binary.LittleEndian.Uint32(data)), data[4:]
		case Bytes:
			l, n := binary.Uvarint(data)
			if n <= 0 || uint64(len(data)-n) < l {
				return errTruncated
			}
			f.Data, data = data[n:n+int(l)], data[n+int(l):]
		default:
			return fmt.Errorf("protobuf: unsupported wire type %d", f.Type)
		}
		if err := fn(f); err != nil {
			return err
		}
	}
	return nil
}

// Expect fails when a known field arrives with the wrong wire type.
func Expect(f Field, wt int) error {
	if f.Type != wt {
		return fmt.Errorf("protobuf: field %d has wire type %d, want %d", f.No, f.Type, wt)
	}
	return nil
}
