/**
 * DEQR Container Format — Version 1
 *
 * Serializes and deserializes the DEQR transfer container that wraps
 * an arbitrary binary file with metadata for reconstruction.
 *
 * Container Layout:
 *   Magic "DEQR"        (4 bytes)
 *   Protocol Version     (2 bytes, uint16 BE)
 *   Filename Length       (2 bytes, uint16 BE)
 *   Filename             (variable, UTF-8, sanitized)
 *   MIME Type Length      (2 bytes, uint16 BE)
 *   MIME Type             (variable, UTF-8)
 *   Original File Size   (8 bytes, uint64 BE)
 *   Compression Flag     (1 byte: 0x00=none, 0x01=gzip)
 *   Encryption Flag      (1 byte: 0x00=none — reserved for future)
 *   Creation Timestamp   (8 bytes, uint64 BE, ms since epoch)
 *   SHA-256 Digest       (32 bytes, of original uncompressed file)
 *   Payload Bytes        (remainder)
 */

import { sanitizeFilename } from './filename-sanitizer.js';

export const DEQR_MAGIC = Buffer.from('DEQR', 'ascii');
export const PROTOCOL_VERSION = 1;
export const MAX_FILE_SIZE = 64 * 1024 * 1024; // 64 MB

export interface ContainerMetadata {
  protocolVersion: number;
  filename: string;
  mimeType: string;
  originalSize: number;
  compressed: boolean;
  encrypted: boolean;
  timestamp: number;
  sha256: Buffer;
}

export interface DeqrContainer {
  metadata: ContainerMetadata;
  payload: Buffer;
}

/**
 * Serialize a DEQR container from metadata and payload.
 */
export function serializeContainer(container: DeqrContainer): Buffer {
  const { metadata, payload } = container;
  const safeFilename = sanitizeFilename(metadata.filename);
  const filenameBytes = Buffer.from(safeFilename, 'utf-8');
  const mimeBytes = Buffer.from(metadata.mimeType, 'utf-8');

  if (metadata.sha256.length !== 32) {
    throw new Error('SHA-256 digest must be exactly 32 bytes');
  }
  if (metadata.originalSize > MAX_FILE_SIZE) {
    throw new Error(`File size ${metadata.originalSize} exceeds maximum ${MAX_FILE_SIZE} bytes`);
  }
  if (metadata.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${metadata.protocolVersion}`);
  }

  // Calculate total size
  const headerSize =
    4 +  // magic
    2 +  // protocol version
    2 +  // filename length
    filenameBytes.length +
    2 +  // mime length
    mimeBytes.length +
    8 +  // original file size
    1 +  // compression flag
    1 +  // encryption flag
    8 +  // timestamp
    32;  // sha256

  const totalSize = headerSize + payload.length;
  const buffer = Buffer.alloc(totalSize);
  let offset = 0;

  // Magic
  DEQR_MAGIC.copy(buffer, offset);
  offset += 4;

  // Protocol Version
  buffer.writeUInt16BE(metadata.protocolVersion, offset);
  offset += 2;

  // Filename
  buffer.writeUInt16BE(filenameBytes.length, offset);
  offset += 2;
  filenameBytes.copy(buffer, offset);
  offset += filenameBytes.length;

  // MIME Type
  buffer.writeUInt16BE(mimeBytes.length, offset);
  offset += 2;
  mimeBytes.copy(buffer, offset);
  offset += mimeBytes.length;

  // Original File Size (uint64 BE)
  buffer.writeBigUInt64BE(BigInt(metadata.originalSize), offset);
  offset += 8;

  // Compression Flag
  buffer.writeUInt8(metadata.compressed ? 0x01 : 0x00, offset);
  offset += 1;

  // Encryption Flag (reserved)
  buffer.writeUInt8(metadata.encrypted ? 0x01 : 0x00, offset);
  offset += 1;

  // Timestamp (uint64 BE)
  buffer.writeBigUInt64BE(BigInt(metadata.timestamp), offset);
  offset += 8;

  // SHA-256 Digest
  metadata.sha256.copy(buffer, offset);
  offset += 32;

  // Payload
  payload.copy(buffer, offset);

  return buffer;
}

/**
 * Deserialize a DEQR container from raw bytes.
 * Validates magic, protocol version, and metadata consistency.
 */
export function deserializeContainer(data: Buffer): DeqrContainer {
  let offset = 0;

  // Magic
  if (data.length < 4) {
    throw new Error('Container too small: missing magic bytes');
  }
  const magic = data.subarray(offset, offset + 4);
  if (!magic.equals(DEQR_MAGIC)) {
    throw new Error(`Invalid container magic: expected "DEQR", got "${magic.toString('ascii')}"`);
  }
  offset += 4;

  // Protocol Version
  if (data.length < offset + 2) {
    throw new Error('Container truncated: missing protocol version');
  }
  const protocolVersion = data.readUInt16BE(offset);
  offset += 2;
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${protocolVersion} (expected ${PROTOCOL_VERSION})`);
  }

  // Filename
  if (data.length < offset + 2) {
    throw new Error('Container truncated: missing filename length');
  }
  const filenameLen = data.readUInt16BE(offset);
  offset += 2;
  if (data.length < offset + filenameLen) {
    throw new Error('Container truncated: incomplete filename');
  }
  const filename = sanitizeFilename(data.subarray(offset, offset + filenameLen).toString('utf-8'));
  offset += filenameLen;

  // MIME Type
  if (data.length < offset + 2) {
    throw new Error('Container truncated: missing MIME type length');
  }
  const mimeLen = data.readUInt16BE(offset);
  offset += 2;
  if (data.length < offset + mimeLen) {
    throw new Error('Container truncated: incomplete MIME type');
  }
  const mimeType = data.subarray(offset, offset + mimeLen).toString('utf-8');
  offset += mimeLen;

  // Original File Size
  if (data.length < offset + 8) {
    throw new Error('Container truncated: missing file size');
  }
  const originalSize = Number(data.readBigUInt64BE(offset));
  offset += 8;
  if (originalSize > MAX_FILE_SIZE) {
    throw new Error(`Declared file size ${originalSize} exceeds maximum ${MAX_FILE_SIZE} bytes`);
  }

  // Compression Flag
  if (data.length < offset + 1) {
    throw new Error('Container truncated: missing compression flag');
  }
  const compressed = data.readUInt8(offset) === 0x01;
  offset += 1;

  // Encryption Flag
  if (data.length < offset + 1) {
    throw new Error('Container truncated: missing encryption flag');
  }
  const encrypted = data.readUInt8(offset) === 0x01;
  offset += 1;

  // Timestamp
  if (data.length < offset + 8) {
    throw new Error('Container truncated: missing timestamp');
  }
  const timestamp = Number(data.readBigUInt64BE(offset));
  offset += 8;

  // SHA-256 Digest
  if (data.length < offset + 32) {
    throw new Error('Container truncated: missing SHA-256 digest');
  }
  const sha256 = Buffer.from(data.subarray(offset, offset + 32));
  offset += 32;

  // Payload
  const payload = Buffer.from(data.subarray(offset));

  return {
    metadata: {
      protocolVersion,
      filename,
      mimeType,
      originalSize,
      compressed,
      encrypted,
      timestamp,
      sha256,
    },
    payload,
  };
}
