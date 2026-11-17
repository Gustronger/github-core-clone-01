// pkt-line framing for the git smart-HTTP protocol (git-client.ts codec,
// mirrored here so the entry speaks exactly the framing the suite parses).
//
// A pkt-line is 4 hex length bytes (payload length + 4) followed by the
// payload. Length 0000 is a flush, 0001 a delim, 0002 a response-end.
// No packet may exceed 65520 bytes including its header. Sideband packets
// (band 1 = data, 2 = progress, 3 = error) are pkt-lines whose payload
// starts with the band byte; the pack bytes ride in band-1 packets.

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte header. */
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** The largest sideband payload: one band byte plus pack bytes. */
export const SIDEBAND_MAX_PAYLOAD = PKT_LINE_MAX_PAYLOAD - 1;

/** The flush packet, `0000`. */
export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
/** The delim packet, `0001` (separates v2 sections and request parts). */
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');
/** The response-end packet, `0002`. */
export const PKT_RESPONSE_END: Buffer = Buffer.from('0002', 'ascii');

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes then the payload. One allocation: the header is written into the same buffer the payload is copied into, instead of concatenating a header buffer and a payload buffer. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const out = Buffer.allocUnsafe(data.length + 4);
  out.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}

/** Encode a mixed sequence; `'flush'` / `'delim'` / `'response-end'` are the control packets. */
export function pktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** One decoded pkt-line. */
export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * The numeric value of one ASCII hex digit byte, or -1 when the byte is not
 * a hex digit. Lets the decoders below read a 4-byte length header straight
 * out of the buffer instead of slicing a string and running a regex and a
 * parseInt on every packet.
 */
function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return -1;
}

/**
 * Read one pkt-line length header at `offset` and return the announced
 * length. Throws on a truncated header or on non-hex bytes, with the same
 * messages the old string-based read produced.
 */
function readPktLength(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) {
    throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
  }
  const v0 = hexValue(buffer[offset]);
  const v1 = hexValue(buffer[offset + 1]);
  const v2 = hexValue(buffer[offset + 2]);
  const v3 = hexValue(buffer[offset + 3]);
  if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) {
    // Error path only: build the header string for the message.
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
  }
  return (v0 << 12) | (v1 << 8) | (v2 << 4) | v3;
}

/**
 * Validate an announced length the way both decoders did: 3 is invalid,
 * anything past the max is invalid, and a packet that runs past the end of
 * the buffer is truncated. Returns the length when it is usable.
 */
function checkPktLength(buffer: Buffer, offset: number, length: number): number {
  if (length === 3) throw new Error('invalid pkt-line length 0003');
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
  if (offset + length > buffer.length) {
    throw new Error(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
  }
  return length;
}

/**
 * Decode a complete buffer into packets. Throws on a malformed header or a
 * truncated packet — callers that must survive garbage (the malformed
 * pkt-line probe) catch this and answer an error instead of crashing.
 */
export function decodePktLines(bytes: Uint8Array): PktPacket[] {
  const buffer = asBuffer(bytes);
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const length = readPktLength(buffer, offset);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    checkPktLength(buffer, offset, length);
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Split a buffer at the first flush packet: the packets before it, and the
 * byte offset just past it. A receive-pack body is command pkt-lines, a
 * flush, then the raw pack bytes — this is how the handler finds where the
 * pack starts. Throws on a malformed header or a missing flush.
 */
export function splitAtFlush(bytes: Uint8Array): { packets: PktPacket[]; restOffset: number } {
  const buffer = asBuffer(bytes);
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const length = readPktLength(buffer, offset);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, restOffset: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    checkPktLength(buffer, offset, length);
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('pkt-line stream has no flush packet');
}

/** The decoded text of every data packet, control packets dropped. */
export function packetLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/**
 * Split `data` into sideband packets of the given band (1 = pack data,
 * 2 = progress, 3 = error), each a pkt-line holding one band byte plus a
 * chunk of the data. The whole result is one Buffer, ready to send. The
 * framing is written straight into one pre-sized buffer instead of building
 * a framed buffer per chunk and concatenating them.
 */
export function sideband(data: Uint8Array, band: 1 | 2 | 3): Buffer {
  const body = asBuffer(data);
  if (body.length === 0) return pktLine(Buffer.from([band]));
  const chunks = Math.ceil(body.length / SIDEBAND_MAX_PAYLOAD);
  // Per chunk: 4 header bytes + 1 band byte + the chunk's bytes.
  const out = Buffer.allocUnsafe(body.length + chunks * 5);
  let pos = 0;
  for (let offset = 0; offset < body.length; offset += SIDEBAND_MAX_PAYLOAD) {
    const chunkLen = Math.min(SIDEBAND_MAX_PAYLOAD, body.length - offset);
    out.write((chunkLen + 5).toString(16).padStart(4, '0'), pos, 4, 'ascii');
    out[pos + 4] = band;
    body.copy(out, pos + 5, offset, offset + chunkLen);
    pos += 5 + chunkLen;
  }
  return out;
}
