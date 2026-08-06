import { gzipSync, gunzipSync } from 'zlib';

/**
 * Compresses data using gzip if it yields a smaller size.
 * Returns the compressed buffer if beneficial, otherwise the original buffer.
 * Also returns a boolean indicating if compression was applied.
 *
 * @param data The input buffer.
 * @returns An object with the best buffer and a flag if it was compressed.
 */
export function compressIfBeneficial(data: Buffer): { buffer: Buffer; compressed: boolean } {
  // Don't bother compressing if the file is very small (e.g. < 64 bytes)
  // Gzip header overhead is ~20 bytes, plus dictionary overhead
  if (data.length < 64) {
    return { buffer: data, compressed: false };
  }

  try {
    const compressedData = gzipSync(data, { level: 6 });
    
    // Only use compressed data if it actually saves space
    if (compressedData.length < data.length) {
      return { buffer: compressedData, compressed: true };
    }
  } catch (err) {
    // If compression fails for some reason, fallback to uncompressed
    console.warn('Compression failed, using uncompressed payload.', err);
  }

  return { buffer: data, compressed: false };
}

/**
 * Decompresses gzip data.
 * @param data The compressed input buffer.
 * @param maxOutputLength Maximum expected decompressed size (for safety).
 * @returns The decompressed buffer.
 */
export function decompress(data: Buffer, maxOutputLength?: number): Buffer {
  return gunzipSync(data, { maxOutputLength });
}
