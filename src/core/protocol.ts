/**
 * DEQR Frame Protocol — Version 1
 *
 * Defines the 20-byte binary header for each optical fountain frame.
 *
 * Frame Header (20 bytes):
 *   Protocol Version          (1 byte)
 *   Session ID                (4 bytes, uint32 BE)
 *   Segment Number            (2 bytes, uint16 BE)
 *   Fountain Sequence Num     (4 bytes, uint32 BE)
 *   Block Count (K)           (2 bytes, uint16 BE)
 *   Block Size                (2 bytes, uint16 BE)
 *   Total Payload Length      (4 bytes, uint32 BE)
 *   Header Checksum           (1 byte, XOR of preceding 19 bytes)
 */

export const FRAME_PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 20;

export interface FrameHeader {
  protocolVersion: number;
  sessionId: number;
  segmentNumber: number;
  sequenceNumber: number;
  blockCount: number;
  blockSize: number;
  totalPayloadLength: number;
}

export interface Frame {
  header: FrameHeader;
  payload: Buffer; // The fountain-coded block data
}

/**
 * Calculates a simple XOR checksum for the first length bytes of a buffer.
 */
export function calculateChecksum(buffer: Buffer, length: number): number {
  let checksum = 0;
  for (let i = 0; i < length; i++) {
    checksum ^= buffer[i];
  }
  return checksum;
}

/**
 * Serializes a frame header into a 20-byte buffer.
 */
export function serializeFrameHeader(header: FrameHeader): Buffer {
  if (header.protocolVersion !== FRAME_PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${header.protocolVersion}`);
  }

  const buffer = Buffer.alloc(HEADER_SIZE);
  let offset = 0;

  buffer.writeUInt8(header.protocolVersion, offset);
  offset += 1;

  buffer.writeUInt32BE(header.sessionId, offset);
  offset += 4;

  buffer.writeUInt16BE(header.segmentNumber, offset);
  offset += 2;

  buffer.writeUInt32BE(header.sequenceNumber, offset);
  offset += 4;

  buffer.writeUInt16BE(header.blockCount, offset);
  offset += 2;

  buffer.writeUInt16BE(header.blockSize, offset);
  offset += 2;

  buffer.writeUInt32BE(header.totalPayloadLength, offset);
  offset += 4;

  const checksum = calculateChecksum(buffer, HEADER_SIZE - 1);
  buffer.writeUInt8(checksum, offset);

  return buffer;
}

/**
 * Deserializes a frame header from a buffer.
 * Performs length, version, and checksum validation.
 */
export function deserializeFrameHeader(buffer: Buffer): FrameHeader {
  if (buffer.length < HEADER_SIZE) {
    throw new Error(`Buffer too small for frame header: ${buffer.length} < ${HEADER_SIZE}`);
  }

  const expectedChecksum = calculateChecksum(buffer, HEADER_SIZE - 1);
  const actualChecksum = buffer.readUInt8(HEADER_SIZE - 1);

  if (expectedChecksum !== actualChecksum) {
    throw new Error('Frame header checksum mismatch (corrupted frame)');
  }

  let offset = 0;
  const protocolVersion = buffer.readUInt8(offset);
  offset += 1;

  if (protocolVersion !== FRAME_PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version in frame: ${protocolVersion}`);
  }

  const sessionId = buffer.readUInt32BE(offset);
  offset += 4;

  const segmentNumber = buffer.readUInt16BE(offset);
  offset += 2;

  const sequenceNumber = buffer.readUInt32BE(offset);
  offset += 4;

  const blockCount = buffer.readUInt16BE(offset);
  offset += 2;

  const blockSize = buffer.readUInt16BE(offset);
  offset += 2;

  const totalPayloadLength = buffer.readUInt32BE(offset);

  return {
    protocolVersion,
    sessionId,
    segmentNumber,
    sequenceNumber,
    blockCount,
    blockSize,
    totalPayloadLength,
  };
}

/**
 * Helper to serialize a full frame (header + payload)
 */
export function serializeFrame(frame: Frame): Buffer {
  const headerBuffer = serializeFrameHeader(frame.header);
  return Buffer.concat([headerBuffer, frame.payload]);
}

/**
 * Helper to deserialize a full frame (header + payload)
 */
export function deserializeFrame(buffer: Buffer): Frame {
  const header = deserializeFrameHeader(buffer);
  const payload = Buffer.from(buffer.subarray(HEADER_SIZE));
  return { header, payload };
}
