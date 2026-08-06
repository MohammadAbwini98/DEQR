import { createHash } from 'crypto';

/**
 * Computes the SHA-256 hash of a buffer.
 * @param data The input buffer.
 * @returns A 32-byte Buffer containing the SHA-256 hash.
 */
export function computeSha256(data: Buffer): Buffer {
  const hash = createHash('sha256');
  hash.update(data);
  return hash.digest();
}

/**
 * Verifies if the computed SHA-256 hash of data matches the expected hash.
 * @param data The input buffer.
 * @param expectedHash The 32-byte expected hash buffer.
 * @returns True if they match, false otherwise.
 */
export function verifySha256(data: Buffer, expectedHash: Buffer): boolean {
  if (expectedHash.length !== 32) {
    return false;
  }
  const actualHash = computeSha256(data);
  return actualHash.equals(expectedHash);
}
