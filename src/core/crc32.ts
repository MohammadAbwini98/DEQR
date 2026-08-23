/**
 * CRC-32/ISO-HDLC — the CRC used by gzip, zip, and PNG.
 *
 * Reflected algorithm, polynomial 0xEDB88320, init 0xFFFFFFFF, final XOR
 * 0xFFFFFFFF. Chosen because it is the one 32-bit CRC every platform DEQR
 * targets already agrees on, so a mismatch between the Electron sender and a
 * browser receiver would be a defect in this file rather than a disagreement
 * about which CRC was meant.
 *
 * This module is deliberately free of `Buffer` and of every other Node built-in
 * so the desktop sender and the iOS PWA receiver can share one implementation
 * instead of maintaining two that drift.
 *
 * It is an integrity check against transmission damage, not a security
 * primitive. SHA-256 over the reconstructed original file remains the sole
 * authority on file identity.
 */

let table: Uint32Array | null = null;

/** Builds the 256-entry lookup table on first use. */
function crcTable(): Uint32Array {
  if (table) return table;
  const next = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    next[index] = value >>> 0;
  }
  table = next;
  return next;
}

/**
 * CRC-32 over a byte range.
 *
 * @param bytes Source bytes.
 * @param start First byte to include, defaults to 0.
 * @param end One past the last byte to include, defaults to `bytes.length`.
 * @returns The checksum as an unsigned 32-bit integer.
 */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  const lookup = crcTable();
  const from = Math.max(0, Math.min(start, bytes.length));
  const to = Math.max(from, Math.min(end, bytes.length));
  let crc = 0xffffffff;
  for (let index = from; index < to; index += 1) {
    crc = lookup[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
