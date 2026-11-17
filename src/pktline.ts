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

/** Encode one data packet: 4 hex length bytes then the payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
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

const HEX4 = /^[0-9a-fA-F]{4}$/;

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
    if (offset + 4 > buffer.length) {
      throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    }
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
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
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buffer.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
    }
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
    if (offset + 4 > buffer.length) {
      throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    }
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
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
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buffer.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
    }
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
 * chunk of the data. The whole result is one Buffer, ready to send.
 */
export function sideband(data: Uint8Array, band: 1 | 2 | 3): Buffer {
  const body = asBuffer(data);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += SIDEBAND_MAX_PAYLOAD) {
    const chunk = body.subarray(offset, Math.min(body.length, offset + SIDEBAND_MAX_PAYLOAD));
    const framed = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktLine(framed));
  }
  if (body.length === 0) parts.push(pktLine(Buffer.from([band])));
  return Buffer.concat(parts);
}
