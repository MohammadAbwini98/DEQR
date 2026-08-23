/**
 * The cheapest thing that can happen to a decoded frame.
 *
 * A DEQR display loops. At the profile cadences Phase 04 settled on, a receiver
 * that is keeping up sees each symbol again every pass, and a receiver that is
 * not keeping up sees the *same* symbol several times in a row while it works
 * through one. Either way, the majority of successfully decoded frames in a
 * long transfer carry nothing new.
 *
 * So the first thing done with decoded bytes is a hash and a set lookup - two
 * passes over roughly 700 bytes - and a hit returns before the protocol parser,
 * the CRC, the manifest validation, and the FEC engine have been entered at
 * all. The plan's rule is "dedupe as early and cheaply as possible"; this is
 * as early as it can be, since the bytes do not exist before jsQR returns them.
 *
 * ## Why the errors are asymmetric
 *
 * The set is bounded, so it forgets. Forgetting is free: a frame that has aged
 * out is parsed again and the session's own duplicate detection catches it, at
 * the cost of one parse. A *false* hit is not free - it would discard a symbol
 * the transfer needs, and the receiver would have to wait for the sender to
 * repeat it or for repair to cover it.
 *
 * That asymmetry sets the hash width. A single 32-bit hash with 4,096 live
 * entries collides with probability around 1 in 500 per session, which is a
 * lost symbol often enough to be a real effect. Two independent accumulators
 * folded into 53 bits put that around 1 in a billion, for one extra multiply
 * per byte in a loop that costs a thousandth of the decode it precedes.
 */

/** FNV-1a over the bytes, twice, with independent parameters. */
const FNV_OFFSET_A = 0x811c9dc5;
const FNV_PRIME_A = 0x01000193;
const FNV_OFFSET_B = 0x84222325;
const FNV_PRIME_B = 0x000001b3;

/**
 * A collision-resistant-enough key for one frame, safe as a JS number.
 *
 * Not a checksum and not an integrity check: DEQR v2 CRCs every frame and
 * SHA-256s the file. This exists only to answer "have I already looked at
 * exactly these bytes", and the protocol remains the authority on whether they
 * are any good.
 */
export function frameFingerprint(bytes: Uint8Array): number {
  let a = FNV_OFFSET_A;
  let b = FNV_OFFSET_B;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    a = Math.imul(a ^ byte, FNV_PRIME_A);
    b = Math.imul(b ^ byte, FNV_PRIME_B);
  }
  // 32 bits of `a` above 21 bits of `b`, which stays inside 2^53.
  return (a >>> 0) * 0x20_0000 + ((b >>> 11) & 0x1f_ffff);
}

export const DEFAULT_DEDUPE_CAPACITY = 4_096;

/**
 * A fixed-capacity, insertion-ordered fingerprint set.
 *
 * Capacity is a memory bound, not a correctness parameter - see the module
 * note. 4,096 entries is roughly one Phase 04 segment's worth of distinct
 * symbols including its repair budget, so a receiver keeping up with one
 * segment at a time answers almost every repeat from here.
 */
export class BoundedFingerprintSet {
  readonly capacity: number;

  private readonly present = new Set<number>();
  /** Insertion order, as a ring, so eviction is O(1) and allocates nothing. */
  private readonly ring: Float64Array;
  private head = 0;
  private count = 0;

  constructor(capacity: number = DEFAULT_DEDUPE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`dedupe capacity must be a positive integer, received ${capacity}`);
    }
    this.capacity = capacity;
    // Float64 because a fingerprint uses 53 bits and Int32Array would truncate
    // it back to the collision rate this class exists to avoid.
    this.ring = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  has(fingerprint: number): boolean {
    return this.present.has(fingerprint);
  }

  /**
   * Records a fingerprint and says whether it was already known.
   *
   * One call, so a caller cannot check and then forget to insert - which would
   * turn the set into a permanent miss and quietly restore the full parse cost
   * on every repeated frame.
   */
  observe(fingerprint: number): boolean {
    if (this.present.has(fingerprint)) return true;

    if (this.count === this.capacity) {
      this.present.delete(this.ring[this.head]);
      this.count -= 1;
    }
    this.ring[this.head] = fingerprint;
    this.head = (this.head + 1) % this.capacity;
    this.present.add(fingerprint);
    this.count += 1;
    return false;
  }

  clear(): void {
    this.present.clear();
    this.ring.fill(0);
    this.head = 0;
    this.count = 0;
  }
}
