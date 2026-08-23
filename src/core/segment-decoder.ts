/**
 * Systematic-first, segment-scoped recovery for DEQR v2.
 *
 * v1's decoder (`src/core/fountain-decoder.ts`) treats every frame as an
 * equation, including the systematic ones: a degree-1 node is built, pushed
 * into a graph, rippled, and copied back out. On a clean channel that is pure
 * ceremony - the frame already *is* the block. It also holds one graph for the
 * whole file, so its cost grows with the transfer rather than with the window.
 *
 * This decoder inverts both.
 *
 * - **A source symbol is written straight into the segment.** No node, no
 *   graph, no algebra. A loss-free segment therefore does zero XOR work, which
 *   is measured rather than asserted: `stats().xorBytes` is 0.
 * - **Algebra runs only for symbols that are actually missing.** A repair
 *   symbol is eliminated against what is already held, and is stored as an
 *   equation only if something unknown survives.
 * - **Nothing is scoped wider than one segment.** The store is the segment, the
 *   bitmap is one bit per source symbol, and every cap below is written in
 *   terms of `sourceSymbolCount`.
 *
 * ## Work caps
 *
 * Every quantity a hostile or corrupt stream can influence is capped, and the
 * cheap rejections are tested *before* the expensive ones, so a saturated
 * decoder costs O(1) per frame rather than O(K):
 *
 * | Quantity | Cap | Why |
 * |---|---|---|
 * | pending equations | `sourceSymbolCount` | K unknowns need at most K independent equations |
 * | pending neighbour references | `12 x K + 1024` | K equations at the robust soliton's mean degree, plus headroom |
 * | tracked repair ids | `4 x K + 64` | duplicate suppression is a memory cost, so it is a bounded one |
 * | degree of one equation | `sourceSymbolCount` | enforced by the shared neighbour function, re-checked here |
 *
 * Past a cap the decoder keeps working and keeps rejecting: correctness never
 * depends on a cap being generous, only completeness does.
 *
 * Written against `Uint8Array` only - no Node built-ins - so the iOS receiver
 * imports this module rather than reimplementing it.
 */

import { RepairNeighborFn, repairNeighbors } from './segment-encoder.js';
import { RobustSoliton } from './prng.js';
import { RECEIVER_POLICY } from './receiver-policy.js';

/* --------------------------------------------------------------- outcomes */

export const SEGMENT_ACCEPT = {
  /** A source symbol went straight into the segment. The whole cheap path. */
  SOURCE_PLACED: 'source-placed',
  /** A repair symbol resolved to exactly one unknown and was consumed at once. */
  REPAIR_SOLVED: 'repair-solved',
  /** A repair symbol was stored as an equation. It may resolve later, or never. */
  REPAIR_PENDING: 'repair-pending',
  /** Already held. Costs one bitmap or set lookup. */
  DUPLICATE: 'duplicate',
  /** Well formed and carries nothing new: every neighbour is already known. */
  REDUNDANT: 'redundant',
  /** Refused. `reason` says why. */
  REJECTED: 'rejected',
} as const;
export type SegmentAcceptStatus = (typeof SEGMENT_ACCEPT)[keyof typeof SEGMENT_ACCEPT];

export type SegmentRejectReason =
  /** `symbolId` is not a u32. */
  | 'symbol-id-out-of-range'
  /** Payload is not exactly `symbolSizeBytes`. */
  | 'payload-length'
  /** A neighbour index outside the segment, or a degree outside 1..K. */
  | 'invalid-equation'
  /** A work cap is full. The decoder is still correct; it is no longer growing. */
  | 'saturated'
  /** The segment was already committed or released. */
  | 'closed';

export interface SegmentAcceptResult {
  status: SegmentAcceptStatus;
  /** Source symbols newly recovered: this frame and the ripple it started. */
  solved: number;
  /** True once every source symbol is held. */
  complete: boolean;
  reason?: SegmentRejectReason;
}

/**
 * Counters a caller can act on, and the two a gate reads.
 *
 * `xorBytes` is the CPU proxy: bytes actually run through elimination and
 * ripple. It is exactly zero for a loss-free segment, which is the phase gate's
 * "near-zero repair work" turned into a number. `repairSolvedSymbols` is the
 * other one: how much of the segment repair had to reconstruct.
 */
export interface SegmentDecoderStats {
  sourcePlaced: number;
  sourceDuplicates: number;
  repairAccepted: number;
  repairDuplicates: number;
  repairRedundant: number;
  /** Equations that were useful when stored and became empty as others resolved. */
  repairObsoleted: number;
  repairRejected: number;
  repairSolvedSymbols: number;
  /** Equations held right now. */
  pendingEquations: number;
  /** Neighbour references held right now, against `maxPendingNeighborRefs`. */
  pendingNeighborRefs: number;
  /** Bytes XORed during elimination and ripple. Zero on a loss-free segment. */
  xorBytes: number;
  /** Equations visited by the ripple. */
  rippleSteps: number;
}

/**
 * How close a segment is to done, and whether repair is what is holding it up.
 *
 * `needsMoreRepair` is the receiver-side signal Phase 04 needs in order to pick
 * a repair ratio and Phase 09 needs in order to explain a stall.
 */
export interface SegmentRecoveryState {
  sourceSymbolCount: number;
  solvedCount: number;
  missingCount: number;
  pendingEquations: number;
  complete: boolean;
  needsMoreRepair: boolean;
}

/**
 * One unresolved equation.
 *
 * `neighbors` is a plain array with swap-removal rather than a `Set`. A degree
 * is about a dozen entries, so a linear scan is a handful of comparisons, and
 * an array allocates once instead of building a hash table per equation.
 * Measured against the `Set` version it made no difference to decode time -
 * this is the cheaper of two equal options, not an optimisation.
 */
interface PendingEquation {
  symbolId: number;
  neighbors: number[];
  payload: Uint8Array;
}

/** Removes `value` from `list` by swapping the last entry into its place. */
function swapRemove(list: number[], value: number): boolean {
  const index = list.indexOf(value);
  if (index < 0) return false;
  const last = list.pop()!;
  if (index < list.length) list[index] = last;
  return true;
}

export interface SegmentDecoderLimits {
  maxPendingEquations: number;
  maxPendingNeighborRefs: number;
  maxTrackedRepairIds: number;
}

export interface SegmentDecoderOptions {
  /** Source symbols in this segment, from the manifest. */
  sourceSymbolCount: number;
  symbolSizeBytes: number;
  /**
   * Real transport bytes in this segment. At most
   * `sourceSymbolCount x symbolSizeBytes`; smaller for the final segment, whose
   * last symbol is zero-padded on the wire.
   */
  segmentBytes: number;
  /** Overrides for the work caps. Defaults are derived from `sourceSymbolCount`. */
  limits?: Partial<SegmentDecoderLimits>;
  /**
   * FEC profile override, which must match the sender's. Omitted means the
   * shipping robust-soliton rule; see `RepairNeighborFn`.
   */
  neighborsFor?: RepairNeighborFn;
}

/**
 * Mean degree of the robust soliton distribution is close to ln(K/delta),
 * which lands between 9 and 15 across the segment sizes this program
 * benchmarks. Twelve references per source symbol therefore buys room for a
 * full K equations at the distribution's own mean, and the cap is a ceiling
 * rather than a target.
 *
 * Re-exported from `receiver-policy.ts` rather than declared here: every
 * receiver-side maximum lives in one module since Phase 10, so a test and this
 * decoder cannot be asserting against two different numbers.
 */
export const PENDING_NEIGHBOR_REFS_PER_SYMBOL = RECEIVER_POLICY.pendingNeighborRefsPerSymbol;

export function defaultSegmentDecoderLimits(sourceSymbolCount: number): SegmentDecoderLimits {
  return {
    maxPendingEquations: sourceSymbolCount,
    maxPendingNeighborRefs:
      RECEIVER_POLICY.pendingNeighborRefsPerSymbol * sourceSymbolCount
      + RECEIVER_POLICY.pendingNeighborRefsFloor,
    maxTrackedRepairIds:
      RECEIVER_POLICY.trackedRepairIdsPerSymbol * sourceSymbolCount
      + RECEIVER_POLICY.trackedRepairIdsFloor,
  };
}

/** u32 ceiling, the width `symbolId` and `sourceSymbolCount` occupy on the wire. */
const MAX_U32 = 0xffff_ffff;

export class SegmentDecoder {
  readonly sourceSymbolCount: number;
  readonly symbolSizeBytes: number;
  readonly segmentBytes: number;
  readonly limits: SegmentDecoderLimits;

  /** The segment itself. Source symbols are written directly into their slot. */
  private store: Uint8Array | null;
  /** One bit per source symbol. */
  private readonly solvedBits: Uint8Array;
  private solvedCount = 0;
  private closed = false;

  private readonly pending = new Map<number, PendingEquation>();
  /** Unsolved block index to the equations that still reference it. */
  private readonly dependents = new Map<number, number[]>();
  private pendingNeighborRefs = 0;
  private readonly seenRepairIds = new Set<number>();
  /** Rebuilt per segment, sized to this segment. Never spans the file. */
  private readonly soliton: RobustSoliton;
  private readonly neighborsFor: RepairNeighborFn | undefined;

  private readonly counters: SegmentDecoderStats = {
    sourcePlaced: 0,
    sourceDuplicates: 0,
    repairAccepted: 0,
    repairDuplicates: 0,
    repairRedundant: 0,
    repairObsoleted: 0,
    repairRejected: 0,
    repairSolvedSymbols: 0,
    pendingEquations: 0,
    pendingNeighborRefs: 0,
    xorBytes: 0,
    rippleSteps: 0,
  };

  constructor(options: SegmentDecoderOptions) {
    const { sourceSymbolCount, symbolSizeBytes, segmentBytes } = options;

    if (!Number.isInteger(sourceSymbolCount) || sourceSymbolCount < 1 || sourceSymbolCount > MAX_U32) {
      throw new Error(`sourceSymbolCount must be an integer in 1..${MAX_U32}, received ${sourceSymbolCount}`);
    }
    if (!Number.isInteger(symbolSizeBytes) || symbolSizeBytes < 1) {
      throw new Error(`symbolSizeBytes must be a positive integer, received ${symbolSizeBytes}`);
    }
    const capacity = sourceSymbolCount * symbolSizeBytes;
    if (!Number.isInteger(segmentBytes) || segmentBytes < 1 || segmentBytes > capacity) {
      throw new Error(`segmentBytes must be an integer in 1..${capacity}, received ${segmentBytes}`);
    }
    // The manifest's symbol count has to be the one the byte length implies, or
    // the padding rules and every derived offset disagree with the sender.
    if (Math.ceil(segmentBytes / symbolSizeBytes) !== sourceSymbolCount) {
      throw new Error(`${segmentBytes} bytes in ${symbolSizeBytes}-byte symbols is not ${sourceSymbolCount} symbols`);
    }

    this.sourceSymbolCount = sourceSymbolCount;
    this.symbolSizeBytes = symbolSizeBytes;
    this.segmentBytes = segmentBytes;
    this.limits = { ...defaultSegmentDecoderLimits(sourceSymbolCount), ...options.limits };
    this.store = new Uint8Array(capacity);
    this.solvedBits = new Uint8Array((sourceSymbolCount + 7) >> 3);
    this.soliton = new RobustSoliton(sourceSymbolCount);
    this.neighborsFor = options.neighborsFor;
  }

  /* ------------------------------------------------------------- accessors */

  get isComplete(): boolean {
    return this.solvedCount === this.sourceSymbolCount;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get solved(): number {
    return this.solvedCount;
  }

  /**
   * Repair identities currently remembered for duplicate suppression.
   *
   * Exposed so `maxTrackedRepairIds` can be asserted rather than merely
   * stated. A cap nothing can observe is a cap nothing can prove holds, and
   * this one bounds a set that a hostile stream feeds directly.
   */
  get trackedRepairIds(): number {
    return this.seenRepairIds.size;
  }

  /** Bytes held by this decoder: the segment, the bitmap, and the equations. */
  heldBytes(): number {
    return (this.store?.length ?? 0)
      + this.solvedBits.length
      + this.pending.size * this.symbolSizeBytes;
  }

  stats(): SegmentDecoderStats {
    return {
      ...this.counters,
      pendingEquations: this.pending.size,
      pendingNeighborRefs: this.pendingNeighborRefs,
    };
  }

  recovery(): SegmentRecoveryState {
    const missingCount = this.sourceSymbolCount - this.solvedCount;
    return {
      sourceSymbolCount: this.sourceSymbolCount,
      solvedCount: this.solvedCount,
      missingCount,
      pendingEquations: this.pending.size,
      complete: missingCount === 0,
      // Nothing pending can resolve on its own: every equation still held is
      // degree 2 or more, or it would already have been consumed. So while
      // symbols are missing, only a new symbol can move the segment forward.
      needsMoreRepair: missingCount > 0,
    };
  }

  has(symbolId: number): boolean {
    return symbolId >= 0 && symbolId < this.sourceSymbolCount && this.isSolved(symbolId);
  }

  /** Source symbol indices still missing. Allocates, so it is for reporting. */
  missingSymbolIds(): number[] {
    const missing: number[] = [];
    for (let index = 0; index < this.sourceSymbolCount; index += 1) {
      if (!this.isSolved(index)) missing.push(index);
    }
    return missing;
  }

  /**
   * The reconstructed segment, trimmed of the final symbol's zero padding.
   *
   * A view into the decoder's own store, not a copy - the caller is expected to
   * write it out and then `release()`. Throws while symbols are still missing,
   * because a partially decoded segment is not a thing anyone should be handed.
   */
  segment(): Uint8Array {
    if (!this.store) throw new Error('segment decoder has been released');
    if (!this.isComplete) {
      throw new Error(`segment is not complete: ${this.sourceSymbolCount - this.solvedCount} symbols missing`);
    }
    return this.store.subarray(0, this.segmentBytes);
  }

  /**
   * Hands the reconstructed segment to the caller and closes the decoder.
   *
   * The difference from `segment()` is ownership. `segment()` lends a view that
   * `release()` invalidates; `detach()` transfers the buffer out and releases
   * everything else, so a caller may hold it across an `await` - which is what
   * an asynchronous storage writer needs, and what Phase 06 will need.
   */
  detach(): Uint8Array {
    const bytes = this.segment();
    this.store = null;
    this.pending.clear();
    this.dependents.clear();
    this.seenRepairIds.clear();
    this.pendingNeighborRefs = 0;
    this.closed = true;
    return bytes;
  }

  /**
   * Drops every buffer this decoder holds.
   *
   * Called as soon as a segment is committed. That is the property that keeps a
   * multi-gigabyte transfer inside one segment of memory: decoder state has a
   * lifetime shorter than the transfer, by construction rather than by luck.
   */
  release(): void {
    this.store = null;
    this.pending.clear();
    this.dependents.clear();
    this.seenRepairIds.clear();
    this.pendingNeighborRefs = 0;
    this.closed = true;
  }

  /* --------------------------------------------------------------- accept */

  /**
   * Takes one symbol.
   *
   * `payload` is copied only when it has to be kept, so a caller may reuse its
   * buffer between calls. Never throws for bad input: a corrupt or hostile
   * frame becomes a `REJECTED` result with a reason.
   */
  accept(symbolId: number, payload: Uint8Array): SegmentAcceptResult {
    if (this.closed || !this.store) return this.reject('closed');
    if (this.isComplete) {
      // Nothing left to learn. Answering `duplicate` rather than doing the work
      // is what makes a trailing repair stream free.
      return { status: SEGMENT_ACCEPT.DUPLICATE, solved: 0, complete: true };
    }
    if (!Number.isInteger(symbolId) || symbolId < 0 || symbolId > MAX_U32) {
      return this.reject('symbol-id-out-of-range');
    }
    if (payload.length !== this.symbolSizeBytes) {
      return this.reject('payload-length');
    }

    return symbolId < this.sourceSymbolCount
      ? this.acceptSource(symbolId, payload)
      : this.acceptRepair(symbolId, payload);
  }

  /** The cheap path: the frame is the block, so it is written where it belongs. */
  private acceptSource(symbolId: number, payload: Uint8Array): SegmentAcceptResult {
    if (this.isSolved(symbolId)) {
      this.counters.sourceDuplicates += 1;
      return { status: SEGMENT_ACCEPT.DUPLICATE, solved: 0, complete: this.isComplete };
    }

    this.store!.set(payload, symbolId * this.symbolSizeBytes);
    this.markSolved(symbolId);
    this.counters.sourcePlaced += 1;

    // Only equations that name this block are touched, and only if any exist.
    // On a loss-free channel there are none, so this costs a map lookup.
    const solved = 1 + this.ripple(symbolId);
    return { status: SEGMENT_ACCEPT.SOURCE_PLACED, solved, complete: this.isComplete };
  }

  private acceptRepair(symbolId: number, payload: Uint8Array): SegmentAcceptResult {
    // Ordered cheapest-first on purpose. A stream of duplicate or unusable
    // repair frames must not be able to buy O(K) of work per frame, so both
    // O(1) refusals come before the neighbour computation.
    if (this.seenRepairIds.has(symbolId) || this.pending.has(symbolId)) {
      this.counters.repairDuplicates += 1;
      return { status: SEGMENT_ACCEPT.DUPLICATE, solved: 0, complete: this.isComplete };
    }
    if (this.pending.size >= this.limits.maxPendingEquations
      || this.pendingNeighborRefs >= this.limits.maxPendingNeighborRefs) {
      this.counters.repairRejected += 1;
      return this.reject('saturated');
    }

    const neighbors = this.neighborsFor
      ? this.neighborsFor(symbolId, this.sourceSymbolCount)
      : repairNeighbors(symbolId, this.sourceSymbolCount, this.soliton);
    // The neighbour set is derived, not transmitted, so this can only fail if
    // the shared generator itself is wrong. Checking anyway is the difference
    // between a guarantee and an assumption, and it costs one pass over a list
    // about twelve entries long.
    if (neighbors.length < 1 || neighbors.length > this.sourceSymbolCount) {
      this.counters.repairRejected += 1;
      return this.reject('invalid-equation');
    }
    for (const neighbor of neighbors) {
      if (!Number.isInteger(neighbor) || neighbor < 0 || neighbor >= this.sourceSymbolCount) {
        this.counters.repairRejected += 1;
        return this.reject('invalid-equation');
      }
    }

    this.rememberRepairId(symbolId);
    this.counters.repairAccepted += 1;

    // Eliminate everything already known out of the equation.
    const residual = payload.slice();
    const unknown: number[] = [];
    for (const neighbor of neighbors) {
      if (this.isSolved(neighbor)) {
        this.xorBlockInto(residual, neighbor);
      } else {
        unknown.push(neighbor);
      }
    }

    if (unknown.length === 0) {
      this.counters.repairRedundant += 1;
      return { status: SEGMENT_ACCEPT.REDUNDANT, solved: 0, complete: this.isComplete };
    }

    if (unknown.length === 1) {
      const solved = this.solveWith(unknown[0], residual);
      return { status: SEGMENT_ACCEPT.REPAIR_SOLVED, solved, complete: this.isComplete };
    }

    this.storeEquation({ symbolId, neighbors: unknown, payload: residual });
    return { status: SEGMENT_ACCEPT.REPAIR_PENDING, solved: 0, complete: false };
  }

  /* ------------------------------------------------------------- internals */

  private reject(reason: SegmentRejectReason): SegmentAcceptResult {
    return { status: SEGMENT_ACCEPT.REJECTED, solved: 0, complete: this.isComplete, reason };
  }

  private isSolved(index: number): boolean {
    return (this.solvedBits[index >> 3] & (1 << (index & 7))) !== 0;
  }

  private markSolved(index: number): void {
    this.solvedBits[index >> 3] |= 1 << (index & 7);
    this.solvedCount += 1;
  }

  /** Writes a recovered block into the segment and ripples from it. */
  private solveWith(index: number, block: Uint8Array): number {
    this.store!.set(block, index * this.symbolSizeBytes);
    this.markSolved(index);
    this.counters.repairSolvedSymbols += 1;
    return 1 + this.ripple(index);
  }

  private xorBlockInto(target: Uint8Array, blockIndex: number): void {
    const start = blockIndex * this.symbolSizeBytes;
    // Indexed rather than taken as a `subarray` view. Both forms measured the
    // same on decode time, and the indexed one does not allocate a view per
    // neighbour - this loop runs once per neighbour of every repair symbol, on
    // a phone, inside the camera loop.
    const store = this.store!;
    for (let offset = 0; offset < this.symbolSizeBytes; offset += 1) {
      target[offset] ^= store[start + offset];
    }
    this.counters.xorBytes += this.symbolSizeBytes;
  }

  private storeEquation(equation: PendingEquation): void {
    this.pending.set(equation.symbolId, equation);
    this.pendingNeighborRefs += equation.neighbors.length;
    for (const neighbor of equation.neighbors) {
      const referring = this.dependents.get(neighbor);
      if (referring) referring.push(equation.symbolId);
      else this.dependents.set(neighbor, [equation.symbolId]);
    }
  }

  private dropEquation(equation: PendingEquation): void {
    this.pending.delete(equation.symbolId);
    this.pendingNeighborRefs -= equation.neighbors.length;
    for (const neighbor of equation.neighbors) {
      const referring = this.dependents.get(neighbor);
      if (!referring) continue;
      swapRemove(referring, equation.symbolId);
      if (referring.length === 0) this.dependents.delete(neighbor);
    }
  }

  /**
   * Belief propagation, driven by an index rather than a scan.
   *
   * v1 walks every unsolved frame each time a block is solved, so a segment
   * with P pending equations costs O(P) per solve and O(K x P) to finish. Here
   * a solved block goes straight to the equations that name it, so total work
   * is proportional to the neighbour references actually held - which is the
   * quantity `maxPendingNeighborRefs` caps.
   */
  private ripple(solvedIndex: number): number {
    let solved = 0;
    const queue: number[] = [solvedIndex];

    while (queue.length > 0) {
      const blockIndex = queue.pop()!;
      const referring = this.dependents.get(blockIndex);
      if (!referring) continue;
      this.dependents.delete(blockIndex);

      for (const equationId of referring) {
        const equation = this.pending.get(equationId);
        if (!equation) continue;
        this.counters.rippleSteps += 1;

        this.xorBlockInto(equation.payload, blockIndex);
        swapRemove(equation.neighbors, blockIndex);
        this.pendingNeighborRefs -= 1;

        if (equation.neighbors.length === 0) {
          // Every unknown it had is now known: it says nothing new.
          this.pending.delete(equation.symbolId);
          this.counters.repairObsoleted += 1;
          continue;
        }
        if (equation.neighbors.length > 1) continue;

        const remaining = equation.neighbors[0];
        this.dropEquation(equation);
        if (this.isSolved(remaining)) continue;

        this.store!.set(equation.payload, remaining * this.symbolSizeBytes);
        this.markSolved(remaining);
        this.counters.repairSolvedSymbols += 1;
        solved += 1;
        queue.push(remaining);
      }
    }

    return solved;
  }

  /**
   * Remembers a repair id for duplicate suppression, within a bound.
   *
   * Suppression is an optimisation, not a correctness requirement: an untracked
   * duplicate is eliminated to degree 0 and discarded as redundant. So when the
   * budget is spent, tracking stops rather than growing.
   */
  private rememberRepairId(symbolId: number): void {
    if (this.seenRepairIds.size < this.limits.maxTrackedRepairIds) {
      this.seenRepairIds.add(symbolId);
    }
  }
}
