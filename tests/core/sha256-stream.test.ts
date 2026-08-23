import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  SHA256_BLOCK_BYTES,
  Sha256Stream,
  digestFromHex,
  digestToHex,
  sameDigest,
  sha256Bytes,
} from '../../src/core/sha256-stream';

/**
 * A hand-written hash is only worth having if it is pinned to a reference, so
 * every assertion here compares against the platform's own SHA-256 rather than
 * against a stored constant. The cases are chosen around the two things that
 * actually break an incremental implementation: the padding boundary at 56
 * bytes inside the final block, and a chunk split that lands anywhere other
 * than a block edge.
 */

function reference(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

function pseudoRandomBytes(length: number, seed = 0x243f_6a88): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b_79f5) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

describe('Sha256Stream', () => {
  it('matches the platform digest for the empty message', () => {
    expect(Array.from(sha256Bytes(new Uint8Array(0)))).toEqual(Array.from(reference(new Uint8Array(0))));
  });

  it('matches the platform digest across every length that touches a padding boundary', () => {
    // 0..129 covers both padding shapes (one final block and two) in every
    // position, plus the exact block multiples on either side of them.
    for (let length = 0; length <= 129; length += 1) {
      const data = pseudoRandomBytes(length, 0x9e37_79b9 ^ length);
      expect(digestToHex(sha256Bytes(data))).toBe(digestToHex(reference(data)));
    }
  });

  it('matches the platform digest for sizes that span many blocks', () => {
    for (const length of [SHA256_BLOCK_BYTES * 17, 4_096, 65_536, 100_003]) {
      const data = pseudoRandomBytes(length, length);
      expect(digestToHex(sha256Bytes(data))).toBe(digestToHex(reference(data)));
    }
  });

  it('is independent of how the message is split into updates', () => {
    const data = pseudoRandomBytes(9_973, 0x1234_5678);
    const expected = digestToHex(reference(data));

    // Deliberately awkward splits: a single byte, a prime that never aligns to
    // a block, exactly one block, and one byte under a block.
    for (const chunkSize of [1, 7, 63, 64, 65, 1_000, 4_096]) {
      const stream = new Sha256Stream();
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        stream.update(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
      }
      expect(digestToHex(stream.digest())).toBe(expected);
    }
  });

  it('ignores empty updates and reports the byte count it absorbed', () => {
    const stream = new Sha256Stream();
    stream.update(new Uint8Array(0));
    stream.update(pseudoRandomBytes(500));
    stream.update(new Uint8Array(0));
    expect(stream.byteLength).toBe(500);
    expect(digestToHex(stream.digest())).toBe(digestToHex(reference(pseudoRandomBytes(500))));
  });

  it('hashes a subarray by its own bounds, not its backing buffer', () => {
    const backing = pseudoRandomBytes(1_024);
    const window = backing.subarray(100, 400);
    expect(digestToHex(sha256Bytes(window))).toBe(digestToHex(reference(backing.slice(100, 400))));
  });

  it('refuses to be reused after finalising', () => {
    const stream = new Sha256Stream();
    stream.update(pseudoRandomBytes(10));
    stream.digest();
    expect(() => stream.update(pseudoRandomBytes(10))).toThrow(/update after digest/);
    expect(() => stream.digest()).toThrow(/digest called twice/);
  });

  it('round-trips a digest through hex and refuses malformed hex', () => {
    const digest = sha256Bytes(pseudoRandomBytes(64));
    const hex = digestToHex(digest);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(sameDigest(digestFromHex(hex)!, digest)).toBe(true);
    expect(digestFromHex('abc')).toBeNull();
    expect(digestFromHex('zz')).toBeNull();
    expect(digestFromHex('AB')).toBeNull();
  });

  it('compares digests by content and rejects a length mismatch', () => {
    const digest = sha256Bytes(pseudoRandomBytes(32));
    const altered = Uint8Array.from(digest);
    altered[31] ^= 0x01;
    expect(sameDigest(digest, Uint8Array.from(digest))).toBe(true);
    expect(sameDigest(digest, altered)).toBe(false);
    expect(sameDigest(digest, digest.subarray(0, 31))).toBe(false);
  });
});
