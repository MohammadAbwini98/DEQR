/**
 * SHA-256 that never sees the whole message at once.
 *
 * `crypto.subtle.digest` is one-shot: it takes a `BufferSource` and therefore
 * requires the entire input to be resident in JavaScript memory. That is fine
 * for a 32 MiB v1 transfer and it is exactly the constraint Phase 06 exists to
 * remove - a receiver that writes a gigabyte to OPFS without ever holding it
 * cannot then verify it by handing a gigabyte back to WebCrypto.
 *
 * So the digest is computed incrementally here, over whatever chunk size the
 * caller can afford, and the only state carried between chunks is eight words
 * of hash plus at most one 64-byte block of remainder.
 *
 * ## Why hand-written rather than a dependency
 *
 * DEQR is strictly offline and bundles everything it uses; a hash is the last
 * place to add a supply-chain surface. The algorithm is FIPS 180-4 and does not
 * change, the implementation is about a hundred lines, and its correctness is
 * pinned against the platform's own SHA-256 across sizes, chunk boundaries and
 * padding edge cases in `tests/core/sha256-stream.test.ts`.
 *
 * ## What it is not
 *
 * Not a MAC, not a KDF, and not constant-time. It verifies a transfer against a
 * digest the manifest carries in the clear, which is a check against corruption
 * and truncation, not against an adversary who controls the manifest. That
 * distinction is Phase 10's subject and is stated here so nothing downstream
 * mistakes this for an authenticity guarantee.
 */

/** Round constants: first 32 bits of the fractional cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial state: first 32 bits of the fractional square roots of the first 8 primes. */
const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

export const SHA256_BLOCK_BYTES = 64;
export const SHA256_DIGEST_BYTES = 32;

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * An incremental SHA-256.
 *
 * `update` may be called any number of times with chunks of any size, and the
 * result equals the digest of their concatenation. `digest` finalises, and the
 * stream is spent afterwards.
 */
export class Sha256Stream {
  private readonly state = new Uint32Array(INITIAL_STATE);
  /** Partial block carried between updates. Never larger than one block. */
  private readonly tail = new Uint8Array(SHA256_BLOCK_BYTES);
  /** Message schedule, allocated once, so a per-chunk update allocates nothing. */
  private readonly schedule = new Uint32Array(64);
  private tailBytes = 0;
  /** Exact byte count. `number` is precise to 2^53 bytes, or 8 PiB. */
  private totalBytes = 0;
  private finished = false;

  /** Bytes absorbed so far. */
  get byteLength(): number {
    return this.totalBytes;
  }

  update(chunk: Uint8Array): this {
    if (this.finished) throw new Error('Sha256Stream: update after digest');
    if (chunk.length === 0) return this;
    this.totalBytes += chunk.length;

    let offset = 0;

    // Top up a carried partial block first, so the loop below always sits on a
    // block boundary and can read straight out of the caller's buffer.
    if (this.tailBytes > 0) {
      const wanted = Math.min(SHA256_BLOCK_BYTES - this.tailBytes, chunk.length);
      this.tail.set(chunk.subarray(0, wanted), this.tailBytes);
      this.tailBytes += wanted;
      offset = wanted;
      if (this.tailBytes < SHA256_BLOCK_BYTES) return this;
      this.compress(this.tail, 0);
      this.tailBytes = 0;
    }

    while (offset + SHA256_BLOCK_BYTES <= chunk.length) {
      this.compress(chunk, offset);
      offset += SHA256_BLOCK_BYTES;
    }

    const remaining = chunk.length - offset;
    if (remaining > 0) {
      this.tail.set(chunk.subarray(offset), 0);
      this.tailBytes = remaining;
    }
    return this;
  }

  /** Finalises and returns the 32-byte digest. */
  digest(): Uint8Array {
    if (this.finished) throw new Error('Sha256Stream: digest called twice');
    this.finished = true;

    // Padding is 0x80, then zeros, then the message length in bits as a 64-bit
    // big-endian integer. The length is split into two words rather than
    // multiplied by eight as one `number`, because a byte count above 2^50
    // would lose its low bits in that multiplication.
    const lengthHigh = Math.floor(this.totalBytes / 0x2000_0000);
    const lengthLow = ((this.totalBytes % 0x2000_0000) * 8) >>> 0;

    const padded = new Uint8Array(this.tailBytes < 56 ? SHA256_BLOCK_BYTES : SHA256_BLOCK_BYTES * 2);
    padded.set(this.tail.subarray(0, this.tailBytes), 0);
    padded[this.tailBytes] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, lengthHigh, false);
    view.setUint32(padded.length - 4, lengthLow, false);
    for (let offset = 0; offset < padded.length; offset += SHA256_BLOCK_BYTES) {
      this.compress(padded, offset);
    }

    const digest = new Uint8Array(SHA256_DIGEST_BYTES);
    const digestView = new DataView(digest.buffer);
    for (let index = 0; index < 8; index += 1) digestView.setUint32(index * 4, this.state[index], false);

    // State and carried block are message-derived, and a receiver's message is
    // plaintext file content, so neither is left readable behind us.
    padded.fill(0);
    this.tail.fill(0);
    this.state.fill(0);
    this.schedule.fill(0);
    return digest;
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = this.schedule;

    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      w[index] = ((block[at] << 24) | (block[at + 1] << 16) | (block[at + 2] << 8) | block[at + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = w[index - 15];
      const recent = w[index - 2];
      const s0 = (rotr(previous, 7) ^ rotr(previous, 18) ^ (previous >>> 3)) >>> 0;
      const s1 = (rotr(recent, 17) ^ rotr(recent, 19) ^ (recent >>> 10)) >>> 0;
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const choose = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + sigma1 + choose + K[index] + w[index]) >>> 0;
      const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (sigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

/** One-shot convenience over the streaming implementation. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Sha256Stream().update(data).digest();
}

/** Length-checked digest comparison. Not constant-time; see the module note. */
export function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

/** Lowercase hex, for checkpoint metadata that has to survive a JSON round trip. */
export function digestToHex(digest: Uint8Array): string {
  let hex = '';
  for (let index = 0; index < digest.length; index += 1) hex += digest[index].toString(16).padStart(2, '0');
  return hex;
}

/** Inverse of `digestToHex`. Returns null rather than throwing on malformed input. */
export function digestFromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
