/**
 * Segment-scoped symbol production for DEQR v2.
 *
 * One segment at a time, systematic-first: symbol ids below the segment's
 * source-symbol count are source blocks verbatim, and ids at or above it are
 * XOR repair symbols over a soliton-selected subset. That is the identity rule
 * DEQR v2 frames encode, so a symbol's role is readable from its header alone.
 *
 * Two properties matter more than speed here:
 *
 * - **Nothing scales with the file.** The encoder holds a reference to the
 *   caller's segment buffer and one degree distribution sized to that segment.
 *   It never sees, and never needs, the rest of the file.
 * - **Repair symbols are reproducible from the frame.** `symbolId` is the seed
 *   and `sourceSymbolCount` sizes the distribution; both travel in every data
 *   frame, so a receiver regenerates the same neighbour set with no extra
 *   metadata and no shared state.
 *
 * Written against `Uint8Array` only, with no `Buffer` and no Node built-ins, so
 * the receiver can share this module the way it shares the v2 codec.
 *
 * Scope note: the degree distribution, repair overhead, and recovery guarantees
 * are Phase 03's subject. This module establishes the segment-bounded shape and
 * the identity rule; it does not claim a tuned code.
 */

import { PRNG, RobustSoliton } from './prng.js';

/**
 * The one thing an FEC profile gets to choose.
 *
 * Everything else about a repair symbol - that it is an XOR, that its id is its
 * seed, that ids at or above `sourceSymbolCount` are repair - is fixed by the
 * v2 frame format. Which source blocks a repair symbol combines is not, so the
 * degree rule is expressed as a function and the manifest's `fecProfileId`
 * names which one both ends are using.
 *
 * The seam exists so a candidate rule can be measured against the shipping one
 * through the real encoder and the real decoder rather than a copy of them.
 * `repairNeighbors` is the only implementation this build ships.
 */
export type RepairNeighborFn = (symbolId: number, sourceSymbolCount: number) => number[];

/**
 * Source-block indices a repair symbol combines.
 *
 * Deterministic in `symbolId` and `sourceSymbolCount` alone. A receiver calls
 * this with the two fields the frame carries and gets the same answer the
 * sender did.
 */
export function repairNeighbors(
  symbolId: number,
  sourceSymbolCount: number,
  soliton: RobustSoliton = new RobustSoliton(sourceSymbolCount),
): number[] {
  const prng = new PRNG(symbolId);
  const degree = Math.min(soliton.sampleDegree(prng), sourceSymbolCount);
  const selected = new Set<number>();
  // Rejection sampling terminates because `degree` is capped at the population.
  while (selected.size < degree) {
    selected.add(prng.nextInt(0, sourceSymbolCount));
  }
  return [...selected];
}

export class SegmentEncoder {
  private segment: Uint8Array | null = null;
  private soliton: RobustSoliton | null = null;
  private symbols = 0;

  /**
   * @param symbolSizeBytes Payload bytes per symbol. Every symbol in a segment
   * is exactly this long, including the segment's short final symbol, which is
   * zero-padded. XOR repair requires uniform length within a segment.
   */
  constructor(
    public readonly symbolSizeBytes: number,
    /** Profile override. Omitted means the shipping robust-soliton rule. */
    private readonly neighborsFor?: RepairNeighborFn,
  ) {
    if (!Number.isInteger(symbolSizeBytes) || symbolSizeBytes < 1) {
      throw new Error(`symbolSizeBytes must be a positive integer, received ${symbolSizeBytes}`);
    }
  }

  /**
   * Points the encoder at a segment.
   *
   * The buffer is **referenced, not copied** — the sender reuses one segment
   * buffer for the whole transfer, which is the point. It must not be mutated
   * until the segment's symbols have all been emitted.
   */
  loadSegment(segmentBytes: Uint8Array): void {
    if (segmentBytes.length < 1) {
      throw new Error('a segment must carry at least one byte');
    }
    this.segment = segmentBytes;
    this.symbols = Math.ceil(segmentBytes.length / this.symbolSizeBytes);
    // Sized to this segment, so the distribution cost is bounded by the segment
    // rather than by the file. Rebuilt per segment because the final segment is
    // usually shorter and therefore has a different source-symbol count.
    this.soliton = new RobustSoliton(this.symbols);
  }

  /** Releases the segment reference so the caller's buffer can be reused or freed. */
  release(): void {
    this.segment = null;
    this.soliton = null;
    this.symbols = 0;
  }

  get sourceSymbolCount(): number {
    return this.symbols;
  }

  get hasSegment(): boolean {
    return this.segment !== null;
  }

  /**
   * Writes one symbol into `out`.
   *
   * `out` must be exactly `symbolSizeBytes` long. The caller owns it, so a
   * single scratch buffer can serve the whole transfer.
   */
  symbolInto(symbolId: number, out: Uint8Array): void {
    const segment = this.segment;
    if (!segment || !this.soliton) throw new Error('no segment is loaded');
    if (out.length !== this.symbolSizeBytes) {
      throw new Error(`output buffer must be ${this.symbolSizeBytes} bytes, received ${out.length}`);
    }
    if (!Number.isInteger(symbolId) || symbolId < 0) {
      throw new Error(`symbolId must be a non-negative integer, received ${symbolId}`);
    }

    out.fill(0);
    if (symbolId < this.symbols) {
      this.copySourceSymbol(segment, symbolId, out);
      return;
    }
    const neighbors = this.neighborsFor
      ? this.neighborsFor(symbolId, this.symbols)
      : repairNeighbors(symbolId, this.symbols, this.soliton);
    for (const neighbor of neighbors) {
      this.xorSourceSymbol(segment, neighbor, out);
    }
  }

  /** Zero-padded source block `index` of the loaded segment. */
  private copySourceSymbol(segment: Uint8Array, index: number, out: Uint8Array): void {
    const start = index * this.symbolSizeBytes;
    const end = Math.min(start + this.symbolSizeBytes, segment.length);
    out.set(segment.subarray(start, end));
  }

  /**
   * XORs source block `index` into `out`.
   *
   * Only the bytes the segment actually has are touched; the implicit padding
   * is zero, and XOR with zero changes nothing.
   */
  private xorSourceSymbol(segment: Uint8Array, index: number, out: Uint8Array): void {
    const start = index * this.symbolSizeBytes;
    const end = Math.min(start + this.symbolSizeBytes, segment.length);
    for (let offset = start; offset < end; offset += 1) {
      out[offset - start] ^= segment[offset];
    }
  }
}
