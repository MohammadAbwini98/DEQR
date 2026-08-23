/**
 * Where a recovered v2 segment goes.
 *
 * `SegmentedReceiver` hands a finished segment to a sink and immediately drops
 * its decoder, which is what keeps decoder memory a function of the segment
 * size rather than the file size. That guarantee is only worth anything if the
 * sink is bounded too - a sink that accumulates every segment in an array has
 * simply moved the file-sized allocation one module along.
 *
 * So the interface below has one unusual property: **`write` can say no**, and
 * it says *why*. Phase 05 shipped it as a boolean over a bounded in-memory
 * store, where the only possible refusal was "full". A real device has three,
 * and they call for three different things:
 *
 * - `FULL` - the storage this receiver was given is out of room. Terminal for
 *   the session, and the user's answer is to free space.
 * - `INVALID` - the segment's offset or length disagrees with the manifest's
 *   own segmentation. Terminal, and not a storage problem at all: it means
 *   something upstream produced a write this store must not perform.
 * - `FAILED` - the writer itself broke. Terminal, and nothing the user did.
 *
 * Collapsing those into one boolean would have made a corrupt offset look like
 * a full disk on screen, which sends someone off to delete photos over a bug.
 *
 * ## Two implementations, one contract
 *
 * `BoundedMemorySegmentStore` here holds a few megabytes and is what a browser
 * without OPFS falls back to, what the tests drive, and what a v1 transfer
 * never touches. `OpfsSegmentStore` writes through to the device and is what
 * removes the size ceiling. The pipeline knows neither: it writes segments,
 * reads bounded windows back for hashing, and asks for an export route at the
 * end.
 *
 * Nothing here hashes or verifies. `read` exists so the *caller* can verify
 * incrementally without the file ever being resident, and `seal` exists so the
 * export route can be a file on disk rather than a buffer in the heap.
 */

import { RECEIVER_POLICY } from '../../src/core/receiver-policy';
import type { RetentionPolicy } from './opfs';

/** The subset of a completed segment a store needs. Mirrors `CompletedSegment`. */
export interface StoredSegment {
  segmentIndex: number;
  byteOffset: bigint;
  bytes: Uint8Array;
}

export const STORE_WRITE = {
  OK: 'ok',
  /** No room. The device or the budget is exhausted. */
  FULL: 'full',
  /** The write disagrees with the manifest's segmentation and was not performed. */
  INVALID: 'invalid',
  /** The underlying writer threw. */
  FAILED: 'failed',
} as const;
export type StoreWriteOutcome = (typeof STORE_WRITE)[keyof typeof STORE_WRITE];

export type SegmentStoreKind = 'memory' | 'opfs';

/**
 * How a verified transfer reaches the share sheet.
 *
 * `bytes` is the v1 route and the small-file fallback: the file is already
 * resident, so it is handed over directly. `opfs` is the large-file route: no
 * payload crosses the worker boundary at all, only the path of a file the main
 * thread opens for itself. That is the difference between a 1 GiB transfer that
 * exports and one that ends the tab.
 */
export type ExportSource =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'opfs'; path: string[]; file: string; size: number };

export interface SegmentStore {
  readonly kind: SegmentStoreKind;
  /** Takes ownership of a segment's bytes. Any outcome but `OK` is terminal. */
  write(segment: StoredSegment): StoreWriteOutcome;
  /** Payload bytes durably accepted so far. */
  bytesCommitted(): number;
  segmentsWritten(): number;
  /** Bytes resident in JavaScript memory. The number the memory gate is written against. */
  residentBytes(): number;
  /**
   * Copies up to `into.length` bytes starting at `offset`, returning how many.
   *
   * The only read path, and it is deliberately a *copy into a caller-owned
   * buffer* rather than a slice the store hands out: a store that returns its
   * own memory cannot promise anything about how long that memory lives.
   */
  read(offset: number, into: Uint8Array): number;
  /**
   * Ends writing and yields the route an export will read from.
   *
   * Called once, after verification succeeds. For OPFS this closes the
   * exclusive handle - which is what lets the main thread open the same file -
   * and marks the session verified in its checkpoint.
   */
  seal(): Promise<ExportSource>;
  /** Closes handles and drops buffers, synchronously, so a cancel is immediate. */
  release(): void;
  /** Applies the retention policy to the working data. Safe to call after `release`. */
  dispose(policy: RetentionPolicy): Promise<void>;
  /**
   * Opens somewhere to put the original bytes of a **compressed** transfer.
   *
   * Present only on stores that can host a second file. A compressed transfer's
   * segments hold container bytes, so the file the user asked for does not
   * exist anywhere until decompression runs - and it cannot be decompressed
   * into the same file it is being read from.
   *
   * Returns null when this store cannot host one, which is a refusal the
   * session ends on rather than a fallback: there is no smaller answer than
   * "the file does not fit".
   */
  openOriginalSink?(size: number): Promise<OriginalSink | null>;
}

/**
 * Where the decompressed original bytes of a compressed transfer are written.
 *
 * A narrower thing than a `SegmentStore` on purpose. It has no segments, no
 * bitmap and no checkpoint, because it is filled in a single pass at the end of
 * a session that either finishes or is thrown away - there is nothing to resume
 * into. What it does keep is `read`, so verification still hashes what the
 * device actually holds rather than what the writer was handed.
 */
export interface OriginalSink {
  readonly kind: SegmentStoreKind;
  /** Writes at an absolute original-file offset. Any outcome but `OK` is terminal. */
  write(offset: number, bytes: Uint8Array): StoreWriteOutcome;
  /** Copies up to `into.length` bytes from `offset`, returning how many. */
  read(offset: number, into: Uint8Array): number;
  bytesWritten(): number;
  /** Bytes resident in JavaScript memory. Zero for the file-backed sink. */
  residentBytes(): number;
  /** Ends writing and yields the route an export will read from. */
  seal(): Promise<ExportSource>;
  release(): void;
  dispose(policy: RetentionPolicy): Promise<void>;
}

/**
 * Default budget: four Phase 04 segments at the Turbo profile's 2,048 x 1,139 B.
 *
 * Deliberately small. It is not a storage tier and is not meant to look like
 * one; it is the fallback for a browser with no OPFS, where the honest answer
 * to a large transfer is to refuse it during reception rather than to grow
 * without limit and be killed by the platform.
 */
export const DEFAULT_SEGMENT_BUDGET_BYTES = RECEIVER_POLICY.fallbackSegmentBudgetBytes;

/**
 * A bounded in-memory `SegmentStore`.
 *
 * Zeroes on release, like every other buffer this receiver holds, because a
 * segment is plaintext file content and an abandoned session must not leave it
 * readable in a heap snapshot.
 */
export class BoundedMemorySegmentStore implements SegmentStore {
  readonly kind = 'memory' as const;
  readonly budgetBytes: number;

  private readonly segments = new Map<number, StoredSegment>();
  private held = 0;
  private written = 0;
  private refused = 0;
  /** Highest offset+length seen, which is the size an assembled export has. */
  private extent = 0;

  constructor(budgetBytes: number = DEFAULT_SEGMENT_BUDGET_BYTES) {
    if (!Number.isFinite(budgetBytes) || budgetBytes < 0) {
      throw new Error(`segment budget must be a non-negative number, received ${budgetBytes}`);
    }
    this.budgetBytes = budgetBytes;
  }

  get refusedWrites(): number {
    return this.refused;
  }

  write(segment: StoredSegment): StoreWriteOutcome {
    if (segment.byteOffset < 0n || segment.byteOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.refused += 1;
      return STORE_WRITE.INVALID;
    }
    if (this.segments.has(segment.segmentIndex)) {
      // A committed segment is never re-committed by `SegmentedReceiver`, so
      // this means two sessions shared a store. Refuse rather than overwrite.
      this.refused += 1;
      return STORE_WRITE.INVALID;
    }
    if (this.held + segment.bytes.byteLength > this.budgetBytes) {
      this.refused += 1;
      return STORE_WRITE.FULL;
    }
    this.segments.set(segment.segmentIndex, segment);
    this.held += segment.bytes.byteLength;
    this.written += 1;
    this.extent = Math.max(this.extent, Number(segment.byteOffset) + segment.bytes.byteLength);
    return STORE_WRITE.OK;
  }

  bytesCommitted(): number {
    return this.held;
  }

  segmentsWritten(): number {
    return this.written;
  }

  /** Everything this store holds is resident by construction. */
  residentBytes(): number {
    return this.held;
  }

  read(offset: number, into: Uint8Array): number {
    if (!Number.isInteger(offset) || offset < 0 || into.length === 0) return 0;
    let copied = 0;
    // Segments are few - the budget admits a handful - so a linear scan per
    // read window is cheaper than an index that has to be kept in step.
    while (copied < into.length) {
      const at = offset + copied;
      const segment = this.segmentAt(at);
      if (!segment) break;
      const within = at - Number(segment.byteOffset);
      const take = Math.min(into.length - copied, segment.bytes.length - within);
      if (take <= 0) break;
      into.set(segment.bytes.subarray(within, within + take), copied);
      copied += take;
    }
    return copied;
  }

  private segmentAt(offset: number): StoredSegment | undefined {
    for (const segment of this.segments.values()) {
      const start = Number(segment.byteOffset);
      if (offset >= start && offset < start + segment.bytes.length) return segment;
    }
    return undefined;
  }

  /** Segment indices held, ascending. For tests. */
  indices(): number[] {
    return [...this.segments.keys()].sort((left, right) => left - right);
  }

  /** The bytes of one held segment, for tests. Not a read path for the app. */
  peek(segmentIndex: number): Uint8Array | undefined {
    return this.segments.get(segmentIndex)?.bytes;
  }

  /**
   * Assembles the held segments into one buffer.
   *
   * This is the allocation Phase 06 exists to avoid, and it is still correct
   * *here*: this store's whole contents are already resident and bounded by
   * `budgetBytes`, so assembling them adds a few megabytes, not a file's worth.
   * The OPFS store's `seal` allocates nothing.
   */
  async seal(): Promise<ExportSource> {
    const bytes = new Uint8Array(this.extent);
    for (const segment of this.segments.values()) {
      bytes.set(segment.bytes, Number(segment.byteOffset));
    }
    return { kind: 'bytes', bytes };
  }

  release(): void {
    for (const segment of this.segments.values()) segment.bytes.fill(0);
    this.segments.clear();
    this.held = 0;
    this.written = 0;
    this.refused = 0;
    this.extent = 0;
  }

  /** Nothing outlives this process, so both policies are the same no-op. */
  async dispose(_policy: RetentionPolicy): Promise<void> {
    this.release();
  }

  /**
   * A memory sink, if the original file fits alongside the container.
   *
   * The budget covers both: this store already holds `held` bytes of container
   * and the original has to sit next to them until the export is handed over.
   * A transfer that does not fit is refused here rather than part-way through
   * decompression, which is the same bargain the OPFS path makes by pre-sizing.
   */
  async openOriginalSink(size: number): Promise<OriginalSink | null> {
    if (!Number.isInteger(size) || size < 1) return null;
    if (this.held + size > this.budgetBytes) return null;
    return new BoundedMemoryOriginalSink(size);
  }
}

/**
 * An `OriginalSink` backed by one buffer, for the browser with no OPFS.
 *
 * Allocated at its full size up front for the same reason the OPFS file is
 * pre-sized: a receiver that discovers it cannot hold the file after
 * decompressing half of it has told the user nothing useful.
 */
export class BoundedMemoryOriginalSink implements OriginalSink {
  readonly kind = 'memory' as const;
  private buffer: Uint8Array | null;
  private written = 0;

  constructor(private readonly size: number) {
    this.buffer = new Uint8Array(size);
  }

  write(offset: number, bytes: Uint8Array): StoreWriteOutcome {
    const buffer = this.buffer;
    if (!buffer) return STORE_WRITE.FAILED;
    if (!Number.isInteger(offset) || offset < 0 || offset + bytes.length > this.size) {
      return STORE_WRITE.INVALID;
    }
    buffer.set(bytes, offset);
    this.written += bytes.length;
    return STORE_WRITE.OK;
  }

  read(offset: number, into: Uint8Array): number {
    const buffer = this.buffer;
    if (!buffer) return 0;
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.size) return 0;
    const take = Math.min(into.length, this.size - offset);
    if (take <= 0) return 0;
    into.set(buffer.subarray(offset, offset + take), 0);
    return take;
  }

  bytesWritten(): number {
    return this.written;
  }

  residentBytes(): number {
    return this.buffer?.length ?? 0;
  }

  async seal(): Promise<ExportSource> {
    const bytes = this.buffer ?? new Uint8Array(0);
    // Ownership moves to the export route, so this sink stops holding it: a
    // `release` after the hand-off must not zero the bytes being saved.
    this.buffer = null;
    return { kind: 'bytes', bytes };
  }

  release(): void {
    this.buffer?.fill(0);
    this.buffer = null;
  }

  async dispose(_policy: RetentionPolicy): Promise<void> {
    this.release();
  }
}
