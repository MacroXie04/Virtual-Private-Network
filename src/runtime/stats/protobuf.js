/**
 * Minimal protobuf wire-format helpers for the V2Ray stats service messages.
 * Only varint and length-delimited fields are produced; every wire type is
 * skipped safely when decoding so unknown fields never break a response.
 */
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('varint must be a non-negative safe integer');
  const bytes = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

export function encodeStringField(fieldNumber, text) {
  const payload = Buffer.from(String(text), 'utf8');
  return Buffer.concat([encodeVarint((fieldNumber << 3) | WIRE_LENGTH), encodeVarint(payload.length), payload]);
}

/** proto3 omits default values, so a false boolean encodes to nothing. */
export function encodeBoolField(fieldNumber, value) {
  if (!value) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((fieldNumber << 3) | WIRE_VARINT), Buffer.from([1])]);
}

function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let position = offset;
  for (;;) {
    if (position >= buffer.length) throw new RangeError('truncated varint');
    const byte = buffer[position];
    position += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new RangeError('varint too long');
  }
  return { value: result, next: position };
}

/** Decode one message into { fieldNumber, wireType, value } entries; nested messages stay buffers. */
export function decodeFields(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('message must be a buffer');
  if (buffer.length > MAX_MESSAGE_BYTES) throw new RangeError('message too large');
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    offset = tag.next;
    if (wireType === WIRE_VARINT) {
      const varint = readVarint(buffer, offset);
      fields.push({ fieldNumber, wireType, value: varint.value });
      offset = varint.next;
    } else if (wireType === WIRE_LENGTH) {
      const length = readVarint(buffer, offset);
      if (length.value > BigInt(MAX_MESSAGE_BYTES)) throw new RangeError('length-delimited field too large');
      const end = length.next + Number(length.value);
      if (end > buffer.length) throw new RangeError('truncated length-delimited field');
      fields.push({ fieldNumber, wireType, value: buffer.subarray(length.next, end) });
      offset = end;
    } else if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
      const size = wireType === WIRE_FIXED64 ? 8 : 4;
      if (offset + size > buffer.length) throw new RangeError('truncated fixed-width field');
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + size) });
      offset += size;
    } else {
      throw new RangeError(`unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

/** Interpret a varint as a signed 64-bit integer and return it as a safe number. */
export function int64FromVarint(value) {
  if (typeof value !== 'bigint') throw new TypeError('int64 must decode from a varint');
  const signed = value >= 1n << 63n ? value - (1n << 64n) : value;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('int64 exceeds the safe integer range');
  }
  return Number(signed);
}
