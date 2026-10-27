import { BSON } from 'bson';
import { LocoError } from '../errors/loco-error.js';

export interface LocoHeader {
  id: number;
  status: number;
  method: string;
  dataType: number;
  bodyLength: number;
}

export interface LocoPacket<T = Record<string, unknown>> {
  header: LocoHeader;
  data: T;
}

export const LOCO_HEADER_SIZE = 22;

export function encodeLocoPacket<T extends Record<string, unknown>>(
  id: number,
  status: number,
  method: string,
  data: T,
  dataType = 0
): Uint8Array {
  const serializedBody = BSON.serialize(data);
  const totalLength = LOCO_HEADER_SIZE + serializedBody.byteLength;
  const buffer = new Uint8Array(totalLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // 1. Packet ID (uint32 LE)
  view.setUint32(0, id, true);
  // 2. Status code (uint16 LE)
  view.setUint16(4, status, true);
  // 3. Method name (11 bytes ASCII, null-padded)
  const encoder = new TextEncoder();
  const methodBytes = encoder.encode(method);
  if (methodBytes.length > 11) {
    throw new LocoError('INVALID_ARGUMENT', `LOCO method exceeds 11 bytes: ${method}`);
  }
  buffer.set(methodBytes, 6);
  // null-fill remainder of the 11-byte method field
  buffer.fill(0, 6 + methodBytes.length, 17);

  // 4. Data type (uint8)
  view.setUint8(17, dataType);
  // 5. Body length (uint32 LE)
  view.setUint32(18, serializedBody.byteLength, true);

  // 6. Body
  buffer.set(serializedBody, LOCO_HEADER_SIZE);

  return buffer;
}

export function decodeLocoHeader(headerBytes: Uint8Array): LocoHeader {
  if (headerBytes.length < LOCO_HEADER_SIZE) {
    throw new LocoError('MALFORMED', `Buffer too short for LOCO header: expected ${LOCO_HEADER_SIZE}, got ${headerBytes.length}`);
  }
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const id = view.getUint32(0, true);
  const status = view.getUint16(4, true);

  let endOfMethod = 6;
  while (endOfMethod < 17 && headerBytes[endOfMethod] !== 0) {
    endOfMethod++;
  }
  const method = new TextDecoder('ascii').decode(headerBytes.subarray(6, endOfMethod));
  const dataType = view.getUint8(17);
  const bodyLength = view.getUint32(18, true);

  return { id, status, method, dataType, bodyLength };
}

export function decodeLocoPacket<T = Record<string, unknown>>(packetBytes: Uint8Array): LocoPacket<T> {
  const header = decodeLocoHeader(packetBytes.subarray(0, LOCO_HEADER_SIZE));
  const bodyBytes = packetBytes.subarray(LOCO_HEADER_SIZE, LOCO_HEADER_SIZE + header.bodyLength);
  const data = (header.dataType === 0 ? BSON.deserialize(bodyBytes) : bodyBytes) as T;
  return { header, data };
}
