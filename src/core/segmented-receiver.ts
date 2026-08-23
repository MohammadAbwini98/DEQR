/**
 * Segment sequencing for a DEQR v2 receive.
 *
 * A `SegmentDecoder` knows one segment. This is the thing that owns a manifest,
 * routes frames to the right segment, and - the part that matters for a
 * multi-gigabyte transfer - *lets segments go*.
 *
 * Three properties are the whole point:
 *
 * - **At most `maxActiveSegments` decoders exist at once**, so decoder memory is
 *   a function of the segment size and that constant, never of the file. The
 *   default is 2: the segment being received, plus one still finishing as the
 *   sender crosses a boundary.
 * - **A completed segment is committed and immediately dropped.** Its bytes are
 *   handed to the sink with ownership transferred, and its decoder state -
 *   equations, bitmap, neighbour index - is gone before the next frame arrives.
 * - **A committed segment is never rebuilt.** Later frames for it cost one bit
 *   test, which is what makes a second display pass cheap instead of quadratic.
 *
 * What this module deliberately does *not* do: storage, hashing, or
 * verification. It hands finished segments to a sink and reports what it knows.
 *
 * It *does* know how to start partway in. A receiver resuming an interrupted
 * transfer already holds some segments on disk, and the cheapest correct way to
 * express that is to hand this class the bitmap those segments are recorded in:
 * every rule that already exists - a committed segment is never rebuilt, its
 * frames cost one bit test, completion is a count - then applies to an adopted
 * segment with no second code path. See `adoptedSegments`.
 *
 * Written against `Uint8Array` only - no Node built-ins - so the iOS receiver
 * imports this module rather than reimplementing it.
 */

import {
  SEGMENT_ACCEPT,
  SegmentDecoder,
  SegmentDecoderLimits,
  SegmentRecoveryState,
  SegmentRejectReason,
} from './segment-decoder.js';
import {
  DeqrV2DataFrame,
  DeqrV2Manifest,
  SegmentPlan,
  V2ErrorCode,
  parseFrame,
  segmentByteRange,
  segmentPlanFromManifest,
  sourceSymbolCountForSegment,
  validateDataFrameAgainstManifest,
} from './protocol-v2.js';
import { RECEIVER_POLICY } from './receiver-policy.js';

/* ------------------------------------------------------------------ results */

export const RECEIVE_ACCEPT = {
  /** The frame advanced a segment. */
  ACCEPTED: 'accepted',
  /** Well formed, carried nothing new. */
  DUPLICATE: 'duplicate',
  /** For a segment already committed. One bit test, no decoder. */
  SEGMENT_COMMITTED: 'segment-committed',
  /** A manifest frame. Matched against the session's own and otherwise ignored. */
  MANIFEST: 'manifest',
  /** Refused. `reason` says why. */
  REJECTED: 'rejected',
} as const;
export type ReceiveAcceptStatus = (typeof RECEIVE_ACCEPT)[keyof typeof RECEIVE_ACCEPT];

/**
 * Why a frame was refused.
 *
 * Protocol-level codes are reused verbatim from `V2ErrorCode` so a receiver can
 * report one vocabulary rather than translating between two. `V1_FRAME` staying
 * distinguishable matters for the same reason it did in Phase 01: a version
 * mismatch must not reach a user as a camera or lighting fault.
 */
export type ReceiveRejectReason = V2ErrorCode | SegmentRejectReason | 'session-released';

export interface ReceiveAcceptResult {
  status: ReceiveAcceptStatus;
  /** Present for data frames. */
  segmentIndex?: number;
  /** Source symbols this frame recovered, ripple included. */
  solved: number;
  /** The frame completed its segment, which was committed during this call. */
  segmentCompleted: boolean;
  /** Every segment is committed. */
  sessionComplete: boolean;
  reason?: ReceiveRejectReason;
}

/** A finished segment, handed over with its buffer. */
export interface CompletedSegment {
  segmentIndex: number;
  /** Owned by the sink: the decoder has already let go of it. */
  bytes: Uint8Array;
  /** Absolute offset of this segment in the transport stream. */
  byteOffset: bigint;
  /** Source symbols recovered by repair rather than received directly. */
  symbolsRepaired: number;
  /** Bytes XORed to recover this segment. Zero when nothing was lost. */
  xorBytes: number;
}

export type SegmentSink = (segment: CompletedSegment) => void;

export interface SegmentedReceiverStats {
  framesAccepted: number;
  framesDuplicate: number;
  framesRejected: number;
  manifestFrames: number;
  segmentsCommitted: number;
  segmentsEvicted: number;
  sourceSymbolsPlaced: number;
  repairSymbolsAccepted: number;
  symbolsRepaired: number;
  /** Total elimination and ripple bytes across every segment, live or committed. */
  xorBytes: number;
  /** Decoders alive right now. Never above `maxActiveSegments`. */
  activeSegments: number;
}

export interface SegmentedReceiverOptions {
  /**
   * Decoders held at once. Two covers an in-order sender crossing a segment
   * boundary with frames still in flight; more only helps a sender that
   * interleaves segments, which this one does not.
   */
  maxActiveSegments?: number;
  /**
   * Receiver policy on how many segments a manifest may declare.
   *
   * The protocol field is a u32, and honouring it literally would mean
   * allocating a 512 MB completion bitmap from an untrusted manifest. The
   * default admits 16,777,216 segments - 16 TiB at 1 MiB segments, which at the
   * 5,120 B/s Phase 00 measured is about a century of transfer - and costs a
   * 2 MiB bitmap in that pathological case against 128 bytes for a 1 GiB file.
   */
  maxSegmentCount?: number;
  /** Per-segment work caps. Passed straight to each `SegmentDecoder`. */
  decoderLimits?: Partial<SegmentDecoderLimits>;
  /** Called once per segment, in completion order, with the bytes it owns. */
  onSegmentComplete?: SegmentSink;
  /**
   * Segments a resumed session already holds, as a bitmap, least-significant
   * bit first - the same layout the checkpoint on disk uses.
   *
   * Copied rather than retained, and sized against this manifest rather than
   * trusted: a bitmap whose length disagrees with the segment count describes a
   * different transfer, and adopting it would mark segments complete that were
   * never received. The sink is **not** called for an adopted segment; its
   * bytes are already where the sink would have put them.
   */
  adoptedSegments?: Uint8Array;
}

export const DEFAULT_MAX_ACTIVE_SEGMENTS = RECEIVER_POLICY.maxActiveSegments;
export const DEFAULT_MAX_SEGMENT_COUNT = RECEIVER_POLICY.maxSegmentCount;

/** Set bits per byte value. Built once; the adopt path counts a whole bitmap. */
const POPCOUNT = new Uint8Array(256);
for (let value = 0; value < 256; value += 1) {
  POPCOUNT[value] = (value & 1) + POPCOUNT[value >> 1];
}

interface ActiveSegment {
  decoder: SegmentDecoder;
  /** Monotonic touch counter, for least-recently-advanced eviction. */
  lastTouched: number;
}

export class SegmentedReceiver {
  readonly manifest: DeqrV2Manifest;
  readonly plan: SegmentPlan;
  readonly maxActiveSegments: number;

  private readonly decoderLimits: Partial<SegmentDecoderLimits> | undefined;
  private readonly sink: SegmentSink | undefined;
  private readonly active = new Map<number, ActiveSegment>();
  /** One bit per segment. The only state here proportional to the file. */
  private readonly committedBits: Uint8Array;
  private committedCount = 0;
  /** Of `committedCount`, how many arrived from a checkpoint rather than a camera. */
  private adoptedCount = 0;
  private touchCounter = 0;
  private released = false;

  private readonly counters: SegmentedReceiverStats = {
    framesAccepted: 0,
    framesDuplicate: 0,
    framesRejected: 0,
    manifestFrames: 0,
    segmentsCommitted: 0,
    segmentsEvicted: 0,
    sourceSymbolsPlaced: 0,
    repairSymbolsAccepted: 0,
    symbolsRepaired: 0,
    xorBytes: 0,
    activeSegments: 0,
  };

  /** XOR bytes from decoders already dropped, so the total survives commit. */
  private retiredXorBytes = 0;

  constructor(manifest: DeqrV2Manifest, options: SegmentedReceiverOptions = {}) {
    const maxSegmentCount = options.maxSegmentCount ?? DEFAULT_MAX_SEGMENT_COUNT;
    if (manifest.segmentCount > maxSegmentCount) {
      throw new Error(
        `manifest declares ${manifest.segmentCount} segments, above this receiver's limit of ${maxSegmentCount}`,
      );
    }
    this.maxActiveSegments = options.maxActiveSegments ?? DEFAULT_MAX_ACTIVE_SEGMENTS;
    if (!Number.isInteger(this.maxActiveSegments) || this.maxActiveSegments < 1) {
      throw new Error(`maxActiveSegments must be a positive integer, received ${this.maxActiveSegments}`);
    }

    this.manifest = manifest;
    // Throws on a self-inconsistent manifest, but `parseManifestFrame` already
    // re-derives and compares the plan, so anything that reached here agrees.
    this.plan = segmentPlanFromManifest(manifest);
    this.decoderLimits = options.decoderLimits;
    this.sink = options.onSegmentComplete;
    this.committedBits = new Uint8Array((manifest.segmentCount + 7) >> 3);
    if (options.adoptedSegments) this.adopt(options.adoptedSegments);
  }

  /**
   * Marks segments a previous run already committed.
   *
   * Two things make this safe rather than a way to fake progress. It refuses a
   * bitmap that is not exactly this manifest's size, so a checkpoint from
   * another transfer cannot be applied; and it masks off the bits past the last
   * segment, so a byte with its high bits set cannot inflate the committed
   * count past the segment count and declare a transfer complete that is not.
   *
   * The adopted count is genuine progress: the caller has already checked that
   * the bytes for those segments are on disk under a checkpoint that matches
   * this manifest. What it is not is *verified* - only the final SHA-256 says
   * that, and it runs over the reconstructed file whether or not the transfer
   * was resumed.
   */
  private adopt(bits: Uint8Array): void {
    if (bits.length !== this.committedBits.length) {
      throw new Error(
        `adoptedSegments is ${bits.length} bytes, but this manifest needs ${this.committedBits.length}`,
      );
    }
    this.committedBits.set(bits);
    const spare = this.manifest.segmentCount & 7;
    if (spare !== 0) {
      // Bits above the last segment index describe nothing. Clearing them is
      // what keeps `committedCount` from exceeding `segmentCount`.
      this.committedBits[this.committedBits.length - 1] &= (1 << spare) - 1;
    }
    let count = 0;
    for (const byte of this.committedBits) count += POPCOUNT[byte];
    this.committedCount = count;
    this.adoptedCount = count;
  }

  /* ------------------------------------------------------------- accessors */

  get isComplete(): boolean {
    return this.committedCount === this.manifest.segmentCount;
  }

  get segmentsCommitted(): number {
    return this.committedCount;
  }

  /**
   * Segments this session started with, adopted from a checkpoint.
   *
   * Reported separately from `segmentsCommitted` because they are a different
   * claim. "Nine hundred of a thousand segments" mixes what this run received
   * with what a previous one did, and a screen that cannot tell them apart
   * cannot say "resuming at 90%" - which is the only sentence that explains why
   * a bar starts nearly full.
   */
  get segmentsAdopted(): number {
    return this.adoptedCount;
  }

  /**
   * The lowest segment index nothing has committed, or the segment count when
   * everything has.
   *
   * This is the number a resume token carries: the point a sender restarting
   * from it will not skip anything the receiver still needs. Linear in the
   * bitmap and computed only when a token is minted, which is once per
   * interruption rather than once per frame.
   */
  firstMissingSegment(): number {
    for (let byteIndex = 0; byteIndex < this.committedBits.length; byteIndex += 1) {
      const byte = this.committedBits[byteIndex];
      if (byte === 0xff) continue;
      for (let bit = 0; bit < 8; bit += 1) {
        const segmentIndex = byteIndex * 8 + bit;
        if (segmentIndex >= this.manifest.segmentCount) return this.manifest.segmentCount;
        if ((byte & (1 << bit)) === 0) return segmentIndex;
      }
    }
    return this.manifest.segmentCount;
  }

  /** A copy of the committed bitmap. Copied so a caller cannot edit progress. */
  committedBitmap(): Uint8Array {
    return this.committedBits.slice();
  }

  get isReleased(): boolean {
    return this.released;
  }

  isSegmentCommitted(segmentIndex: number): boolean {
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= this.manifest.segmentCount) {
      return false;
    }
    return (this.committedBits[segmentIndex >> 3] & (1 << (segmentIndex & 7))) !== 0;
  }

  stats(): SegmentedReceiverStats {
    return { ...this.counters, xorBytes: this.liveXorBytes(), activeSegments: this.active.size };
  }

  /**
   * Bytes the decoders hold right now.
   *
   * Bounded by `maxActiveSegments` times a segment's worst case, and asserted
   * against that in the tests, plus the committed bitmap - one bit per segment,
   * so 128 bytes for a 1 GiB transfer at 1 MiB segments. The bitmap is included
   * because it is genuinely resident and because a receiver that reports zero
   * held bytes while holding something is the wrong kind of tidy.
   */
  heldBytes(): number {
    let total = this.committedBits.length;
    for (const entry of this.active.values()) total += entry.decoder.heldBytes();
    return total;
  }

  /** Recovery state of every live segment, for progress and stall reporting. */
  recovery(): Array<SegmentRecoveryState & { segmentIndex: number }> {
    const states: Array<SegmentRecoveryState & { segmentIndex: number }> = [];
    for (const [segmentIndex, entry] of this.active) {
      states.push({ segmentIndex, ...entry.decoder.recovery() });
    }
    return states.sort((left, right) => left.segmentIndex - right.segmentIndex);
  }

  /** Segments that are neither committed nor live: nothing has arrived for them. */
  outstandingSegments(): number {
    return this.manifest.segmentCount - this.committedCount;
  }

  /* ------------------------------------------------------------------ input */

  /**
   * Parses a raw optical payload and routes it.
   *
   * Convenience over `acceptFrame`, and the shape a capture pipeline wants: one
   * call per decoded QR payload, with every failure classified rather than
   * thrown. A manifest for this same session is verified and otherwise ignored;
   * the session was constructed from one already.
   */
  acceptFrameBytes(bytes: Uint8Array): ReceiveAcceptResult {
    if (this.released) return this.reject('session-released');

    const parsed = parseFrame(bytes);
    if (!parsed.ok) {
      // `detectProtocolVersion` already separates a v1 frame from noise, and
      // `parseFrame` reports it as `V1_FRAME`; passing the code straight
      // through keeps that distinction all the way to the caller.
      return this.reject(parsed.error.code);
    }

    if (parsed.value.kind === 'manifest') {
      const incoming = parsed.value.manifest;
      this.counters.manifestFrames += 1;
      if (incoming.sessionId !== this.manifest.sessionId || incoming.fileId !== this.manifest.fileId) {
        return this.reject('SESSION_MISMATCH');
      }
      return {
        status: RECEIVE_ACCEPT.MANIFEST,
        solved: 0,
        segmentCompleted: false,
        sessionComplete: this.isComplete,
      };
    }

    return this.acceptFrame(parsed.value.frame);
  }

  /**
   * Routes one parsed data frame to its segment.
   *
   * Validation is not optional and is not the decoder's job: a frame is checked
   * against the manifest first, so a decoder only ever sees a symbol that
   * belongs to the segment it was built for.
   */
  acceptFrame(frame: DeqrV2DataFrame): ReceiveAcceptResult {
    if (this.released) return this.reject('session-released');

    const valid = validateDataFrameAgainstManifest(frame, this.manifest, this.plan);
    if (!valid.ok) return this.reject(valid.error.code, frame.segmentIndex);

    // Cheapest possible answer for a segment already written out, and the
    // reason a repeated display pass costs nothing after the first.
    if (this.isSegmentCommitted(frame.segmentIndex)) {
      this.counters.framesDuplicate += 1;
      return {
        status: RECEIVE_ACCEPT.SEGMENT_COMMITTED,
        segmentIndex: frame.segmentIndex,
        solved: 0,
        segmentCompleted: false,
        sessionComplete: this.isComplete,
      };
    }

    const entry = this.activate(frame.segmentIndex);
    entry.lastTouched = ++this.touchCounter;

    const before = entry.decoder.stats();
    const result = entry.decoder.accept(frame.symbolId, frame.payload);
    const after = entry.decoder.stats();

    this.counters.sourceSymbolsPlaced += after.sourcePlaced - before.sourcePlaced;
    this.counters.repairSymbolsAccepted += after.repairAccepted - before.repairAccepted;
    this.counters.symbolsRepaired += after.repairSolvedSymbols - before.repairSolvedSymbols;

    if (result.status === SEGMENT_ACCEPT.REJECTED) {
      this.counters.framesRejected += 1;
      return {
        status: RECEIVE_ACCEPT.REJECTED,
        segmentIndex: frame.segmentIndex,
        solved: 0,
        segmentCompleted: false,
        sessionComplete: this.isComplete,
        reason: result.reason,
      };
    }

    const isDuplicate = result.status === SEGMENT_ACCEPT.DUPLICATE
      || result.status === SEGMENT_ACCEPT.REDUNDANT;
    if (isDuplicate) this.counters.framesDuplicate += 1;
    else this.counters.framesAccepted += 1;

    let segmentCompleted = false;
    if (result.complete) {
      this.commit(frame.segmentIndex, entry.decoder);
      segmentCompleted = true;
    }

    return {
      status: isDuplicate ? RECEIVE_ACCEPT.DUPLICATE : RECEIVE_ACCEPT.ACCEPTED,
      segmentIndex: frame.segmentIndex,
      solved: result.solved,
      segmentCompleted,
      sessionComplete: this.isComplete,
    };
  }

  /**
   * Drops every decoder and forgets the session's progress.
   *
   * Cancel and reset are the same operation: a receive that is abandoned must
   * not leave a segment's worth of buffers alive, and a receive that is
   * restarted must not inherit half a segment from the last attempt.
   */
  release(): void {
    for (const entry of this.active.values()) entry.decoder.release();
    this.active.clear();
    this.released = true;
  }

  /* ---------------------------------------------------------------- internals */

  private reject(reason: ReceiveRejectReason, segmentIndex?: number): ReceiveAcceptResult {
    this.counters.framesRejected += 1;
    return {
      status: RECEIVE_ACCEPT.REJECTED,
      segmentIndex,
      solved: 0,
      segmentCompleted: false,
      sessionComplete: this.isComplete,
      reason,
    };
  }

  private liveXorBytes(): number {
    let total = this.retiredXorBytes;
    for (const entry of this.active.values()) total += entry.decoder.stats().xorBytes;
    return total;
  }

  /** Returns the decoder for a segment, creating and making room if needed. */
  private activate(segmentIndex: number): ActiveSegment {
    const existing = this.active.get(segmentIndex);
    if (existing) return existing;

    if (this.active.size >= this.maxActiveSegments) this.evictLeastRecent();

    const entry: ActiveSegment = {
      decoder: new SegmentDecoder({
        sourceSymbolCount: sourceSymbolCountForSegment(this.plan, segmentIndex),
        symbolSizeBytes: this.manifest.symbolSizeBytes,
        segmentBytes: this.segmentByteLength(segmentIndex),
        limits: this.decoderLimits,
      }),
      lastTouched: this.touchCounter,
    };
    this.active.set(segmentIndex, entry);
    return entry;
  }

  /**
   * Frees a decoder slot.
   *
   * The evicted segment loses whatever partial progress it had and is simply
   * not committed, so a later pass rebuilds it from scratch. That is the honest
   * cost of a fixed decoder budget, and it is why the budget is a configured
   * number rather than an implicit one.
   */
  private evictLeastRecent(): void {
    let victimIndex = -1;
    let victimTouched = Number.POSITIVE_INFINITY;
    for (const [segmentIndex, entry] of this.active) {
      if (entry.lastTouched < victimTouched) {
        victimTouched = entry.lastTouched;
        victimIndex = segmentIndex;
      }
    }
    if (victimIndex < 0) return;

    const victim = this.active.get(victimIndex)!;
    this.retiredXorBytes += victim.decoder.stats().xorBytes;
    victim.decoder.release();
    this.active.delete(victimIndex);
    this.counters.segmentsEvicted += 1;
  }

  /** Hands a finished segment to the sink and drops its decoder. */
  private commit(segmentIndex: number, decoder: SegmentDecoder): void {
    const stats = decoder.stats();
    const bytes = decoder.detach();

    this.retiredXorBytes += stats.xorBytes;
    this.active.delete(segmentIndex);
    this.committedBits[segmentIndex >> 3] |= 1 << (segmentIndex & 7);
    this.committedCount += 1;
    this.counters.segmentsCommitted += 1;

    this.sink?.({
      segmentIndex,
      bytes,
      byteOffset: segmentByteRange(this.plan, segmentIndex).start,
      symbolsRepaired: stats.repairSolvedSymbols,
      xorBytes: stats.xorBytes,
    });
  }

  private segmentByteLength(segmentIndex: number): number {
    const range = segmentByteRange(this.plan, segmentIndex);
    return Number(range.end - range.start);
  }
}
