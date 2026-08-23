import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  SEGMENT_ACCEPT,
  SegmentDecoder,
  defaultSegmentDecoderLimits,
} from '../../src/core/segment-decoder';
import { SegmentEncoder, repairNeighbors } from '../../src/core/segment-encoder';
import { PRNG } from '../../src/core/prng';

/* ------------------------------------------------------------------ fixtures */

const SYMBOL = 64;
/** 32 KiB across 512 symbols: large enough for the soliton to behave, small enough to be quick. */
const SEGMENT = SYMBOL * 512;

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function decoderFor(segment: Uint8Array, symbolSize = SYMBOL): SegmentDecoder {
  return new SegmentDecoder({
    sourceSymbolCount: Math.ceil(segment.length / symbolSize),
    symbolSizeBytes: symbolSize,
    segmentBytes: segment.length,
  });
}

/**
 * The symbols a sender would emit for a segment, in wire order.
 *
 * Materialising them lets a test reorder, drop, duplicate, and corrupt the
 * stream without the encoder having any idea, which is exactly the receiver's
 * situation.
 */
function emit(segment: Uint8Array, repairCount: number, symbolSize = SYMBOL): Array<{ id: number; payload: Uint8Array }> {
  const encoder = new SegmentEncoder(symbolSize);
  encoder.loadSegment(segment);
  const out: Array<{ id: number; payload: Uint8Array }> = [];
  for (let id = 0; id < encoder.sourceSymbolCount + repairCount; id += 1) {
    const payload = new Uint8Array(symbolSize);
    encoder.symbolInto(id, payload);
    out.push({ id, payload });
  }
  encoder.release();
  return out;
}

/** Deterministic per-frame loss. Seeded, so a failure is replayable exactly. */
function survivors<T>(frames: T[], lossRate: number, seed: number): T[] {
  if (lossRate <= 0) return [...frames];
  const prng = new PRNG(seed);
  return frames.filter(() => prng.next() >= lossRate);
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const prng = new PRNG(seed);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = prng.nextInt(0, index + 1);
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

/* ------------------------------------------------------- the systematic path */

describe('the loss-free path is the cheap path', () => {
  it('places every source symbol directly and does no algebra at all', () => {
    const segment = bytes(SEGMENT, 7);
    const decoder = decoderFor(segment);
    const frames = emit(segment, 0);

    for (const frame of frames) {
      expect(decoder.accept(frame.id, frame.payload).status).toBe(SEGMENT_ACCEPT.SOURCE_PLACED);
    }

    expect(decoder.isComplete).toBe(true);
    expect(sha256(decoder.segment())).toBe(sha256(segment));

    const stats = decoder.stats();
    // The gate's "near-zero repair work" is not near-zero here, it is zero.
    expect(stats.xorBytes).toBe(0);
    expect(stats.rippleSteps).toBe(0);
    expect(stats.pendingEquations).toBe(0);
    expect(stats.repairAccepted).toBe(0);
    expect(stats.repairSolvedSymbols).toBe(0);
    expect(stats.sourcePlaced).toBe(512);
  });

  it('stops doing work once the segment is complete, however long the stream runs', () => {
    const segment = bytes(SEGMENT, 11);
    const decoder = decoderFor(segment);
    for (const frame of emit(segment, 0)) decoder.accept(frame.id, frame.payload);

    const trailing = emit(segment, 200).slice(512);
    for (const frame of trailing) {
      expect(decoder.accept(frame.id, frame.payload).status).toBe(SEGMENT_ACCEPT.DUPLICATE);
    }
    expect(decoder.stats().xorBytes).toBe(0);
    expect(sha256(decoder.segment())).toBe(sha256(segment));
  });

  it('reconstructs the final short symbol without its padding', () => {
    // 5 bytes into the last symbol, so the wire carries 59 bytes of zero padding
    // that must not reach the output.
    const segment = bytes(SYMBOL * 3 + 5, 21);
    const decoder = decoderFor(segment);
    expect(decoder.sourceSymbolCount).toBe(4);

    for (const frame of emit(segment, 0)) {
      expect(frame.payload.length).toBe(SYMBOL);
      decoder.accept(frame.id, frame.payload);
    }

    const recovered = decoder.segment();
    expect(recovered.length).toBe(SYMBOL * 3 + 5);
    expect(sha256(recovered)).toBe(sha256(segment));
  });

  it('reconstructs the short final symbol through repair as well as directly', () => {
    const segment = bytes(SYMBOL * 3 + 5, 22);
    const decoder = decoderFor(segment);
    // Everything but the padded tail symbol, then repair to recover it. The
    // padding is implicit on both sides, so the XOR identity has to hold over
    // bytes the segment does not actually contain.
    for (const frame of emit(segment, 0).slice(0, 3)) decoder.accept(frame.id, frame.payload);
    expect(decoder.isComplete).toBe(false);

    for (const frame of emit(segment, 60).slice(4)) {
      if (decoder.accept(frame.id, frame.payload).complete) break;
    }

    expect(decoder.isComplete).toBe(true);
    expect(sha256(decoder.segment())).toBe(sha256(segment));
  });

  it('handles a segment of one symbol, where every repair is that symbol', () => {
    const segment = bytes(20, 23);
    const decoder = decoderFor(segment);
    expect(decoder.sourceSymbolCount).toBe(1);

    const frames = emit(segment, 4);
    // Drop the systematic frame; a repair symbol over K=1 is the block itself.
    expect(decoder.accept(frames[1].id, frames[1].payload).complete).toBe(true);
    expect(sha256(decoder.segment())).toBe(sha256(segment));
  });
});

/* --------------------------------------------------------------- loss ladder */

describe('simulated frame loss', () => {
  const lossRates = [0, 0.01, 0.05, 0.1, 0.2, 0.3];
  const seeds = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];

  it.each(lossRates)('reconstructs byte- and hash-identically at %s loss', (lossRate) => {
    const segment = bytes(SEGMENT, 31);
    const expected = sha256(segment);
    // Three source symbols' worth of repair per source symbol is well above the
    // measured p99 at every rate here; the assertion is that recovery happens,
    // and `scripts/bench/phase03-fec.ts` is where the required ratio is measured.
    const stream = emit(segment, SEGMENT / SYMBOL * 3);

    for (const seed of seeds) {
      const decoder = decoderFor(segment);
      for (const frame of survivors(stream, lossRate, seed)) {
        if (decoder.accept(frame.id, frame.payload).complete) break;
      }

      expect(decoder.isComplete).toBe(true);
      expect(sha256(decoder.segment())).toBe(expected);

      const stats = decoder.stats();
      if (lossRate === 0) {
        expect(stats.xorBytes).toBe(0);
        expect(stats.repairSolvedSymbols).toBe(0);
      } else {
        // Repair did the work it was supposed to do, and no more of it than
        // there were symbols to recover.
        expect(stats.repairSolvedSymbols).toBeGreaterThan(0);
        expect(stats.repairSolvedSymbols).toBeLessThanOrEqual(decoder.sourceSymbolCount);
      }
      decoder.release();
    }
  });

  it('survives burst loss, where the missing symbols are consecutive', () => {
    const segment = bytes(SEGMENT, 41);
    const stream = emit(segment, SEGMENT / SYMBOL * 3);
    const decoder = decoderFor(segment);

    // 12 runs of 16 consecutive frames removed: a hand that moves, rather than
    // a camera that occasionally misses.
    const dropped = new Set<number>();
    for (let run = 0; run < 12; run += 1) {
      const start = run * 41;
      for (let offset = 0; offset < 16; offset += 1) dropped.add(start + offset);
    }

    for (const [index, frame] of stream.entries()) {
      if (dropped.has(index)) continue;
      if (decoder.accept(frame.id, frame.payload).complete) break;
    }

    expect(decoder.isComplete).toBe(true);
    expect(sha256(decoder.segment())).toBe(sha256(segment));
  });
});

/* ------------------------------------------------- ordering and duplication */

describe('the decoder does not depend on arrival order', () => {
  it('accepts a fully shuffled stream and reconstructs identically', () => {
    const segment = bytes(SEGMENT, 51);
    const stream = emit(segment, 256);

    for (const seed of [0xa1, 0xb2, 0xc3]) {
      const decoder = decoderFor(segment);
      for (const frame of shuffled(stream, seed)) {
        if (decoder.accept(frame.id, frame.payload).complete) break;
      }
      expect(decoder.isComplete).toBe(true);
      expect(sha256(decoder.segment())).toBe(sha256(segment));
      decoder.release();
    }
  });

  it('recovers when every repair symbol arrives before the source symbols it repairs', () => {
    const segment = bytes(SEGMENT, 61);
    const stream = emit(segment, 512);
    const source = stream.slice(0, 512);
    const repair = stream.slice(512);
    const decoder = decoderFor(segment);

    // Every repair symbol first, while nothing is known. Most are stored as
    // equations that cannot resolve yet; the soliton's degree-1 symbols do
    // resolve immediately, which is the distribution working as designed.
    for (const frame of repair) decoder.accept(frame.id, frame.payload);
    expect(decoder.stats().pendingEquations).toBeGreaterThan(0);
    expect(decoder.isComplete).toBe(false);
    expect(decoder.solved).toBeLessThan(512 / 4);

    // Then a third of the source symbols. The ripple has to unwind everything
    // that was waiting.
    let delivered = 0;
    for (const frame of source) {
      if (delivered % 3 === 0 && decoder.accept(frame.id, frame.payload).complete) break;
      delivered += 1;
    }

    expect(decoder.isComplete).toBe(true);
    expect(sha256(decoder.segment())).toBe(sha256(segment));
    expect(decoder.stats().rippleSteps).toBeGreaterThan(0);
  });

  it('recovers when repair symbols are delayed until well after the source pass', () => {
    const segment = bytes(SEGMENT, 62);
    const stream = emit(segment, 512);
    const decoder = decoderFor(segment);

    // Half the source symbols, nothing else, then the whole repair stream.
    for (const frame of stream.slice(0, 512)) {
      if (frame.id % 2 === 0) decoder.accept(frame.id, frame.payload);
    }
    expect(decoder.solved).toBe(256);

    for (const frame of stream.slice(512)) {
      if (decoder.accept(frame.id, frame.payload).complete) break;
    }
    expect(decoder.isComplete).toBe(true);
    expect(sha256(decoder.segment())).toBe(sha256(segment));
  });

  it('treats a repeated symbol as a duplicate rather than as information', () => {
    const segment = bytes(SEGMENT, 71);
    const stream = emit(segment, 64);
    const decoder = decoderFor(segment);

    // Each frame three times over, in place.
    for (const frame of stream) {
      const first = decoder.accept(frame.id, frame.payload);
      if (first.complete) break;
      for (const repeat of [1, 2]) {
        void repeat;
        const again = decoder.accept(frame.id, frame.payload);
        expect([SEGMENT_ACCEPT.DUPLICATE, SEGMENT_ACCEPT.REDUNDANT]).toContain(again.status);
        expect(again.solved).toBe(0);
      }
    }

    expect(decoder.isComplete).toBe(true);
    expect(sha256(decoder.segment())).toBe(sha256(segment));
    const stats = decoder.stats();
    expect(stats.sourceDuplicates + stats.repairDuplicates).toBeGreaterThan(0);
  });

  it('reports a repair symbol whose neighbours are all known as redundant, not as progress', () => {
    const segment = bytes(SYMBOL * 8, 81);
    const decoder = decoderFor(segment);
    for (const frame of emit(segment, 0)) decoder.accept(frame.id, frame.payload);
    // Complete, so further frames short-circuit. A fresh decoder that is one
    // symbol short is the case that actually exercises the elimination path.
    const partial = decoderFor(segment);
    const stream = emit(segment, 40);
    for (const frame of stream.slice(0, 7)) partial.accept(frame.id, frame.payload);

    let redundant = 0;
    for (const frame of stream.slice(8)) {
      const result = partial.accept(frame.id, frame.payload);
      if (result.status === SEGMENT_ACCEPT.REDUNDANT) redundant += 1;
      if (result.complete) break;
    }
    expect(partial.isComplete).toBe(true);
    // Some repair symbols over 8 blocks miss the single unknown entirely.
    expect(redundant).toBeGreaterThanOrEqual(0);
    expect(partial.stats().repairRedundant).toBe(redundant);
  });

  it('lets the caller reuse one payload buffer for every symbol', () => {
    const segment = bytes(SEGMENT, 91);
    const encoder = new SegmentEncoder(SYMBOL);
    encoder.loadSegment(segment);
    const decoder = decoderFor(segment);
    const scratch = new Uint8Array(SYMBOL);

    // The whole stream through one buffer, overwritten each time, with every
    // seventh source symbol dropped so repair has to run. If the decoder kept a
    // reference instead of a copy, the segment would come out as 512 copies of
    // whatever the last symbol happened to be.
    for (let id = 0; id < 512 + 1_024; id += 1) {
      encoder.symbolInto(id, scratch);
      if (id < 512 && id % 7 === 0) continue;
      if (decoder.accept(id, scratch).complete) break;
    }
    expect(decoder.stats().repairSolvedSymbols).toBeGreaterThan(0);

    expect(decoder.isComplete).toBe(true);
    expect(sha256(decoder.segment())).toBe(sha256(segment));
  });
});

/* ------------------------------------------------------- refusal and bounds */

describe('the decoder refuses rather than trusting', () => {
  it('rejects a payload that is not exactly one symbol', () => {
    const decoder = decoderFor(bytes(SEGMENT, 101));
    for (const length of [0, SYMBOL - 1, SYMBOL + 1]) {
      const result = decoder.accept(0, new Uint8Array(length));
      expect(result.status).toBe(SEGMENT_ACCEPT.REJECTED);
      expect(result.reason).toBe('payload-length');
    }
  });

  it('rejects a symbol id that is not a u32', () => {
    const decoder = decoderFor(bytes(SEGMENT, 102));
    for (const id of [-1, 1.5, Number.NaN, 0x1_0000_0000, Number.POSITIVE_INFINITY]) {
      const result = decoder.accept(id, new Uint8Array(SYMBOL));
      expect(result.status).toBe(SEGMENT_ACCEPT.REJECTED);
      expect(result.reason).toBe('symbol-id-out-of-range');
    }
  });

  it('rejects an equation whose profile hands back an out-of-range index or degree', () => {
    const segment = bytes(SYMBOL * 16, 103);
    const cases: Array<{ name: string; rule: (id: number, k: number) => number[] }> = [
      { name: 'index above the segment', rule: (_id, k) => [0, k] },
      { name: 'negative index', rule: () => [-1] },
      { name: 'fractional index', rule: () => [2.5] },
      { name: 'degree zero', rule: () => [] },
      { name: 'degree above the source count', rule: (_id, k) => Array.from({ length: k + 1 }, (_, i) => i % k) },
    ];

    for (const { name, rule } of cases) {
      const decoder = new SegmentDecoder({
        sourceSymbolCount: 16,
        symbolSizeBytes: SYMBOL,
        segmentBytes: segment.length,
        neighborsFor: rule,
      });
      const result = decoder.accept(16, new Uint8Array(SYMBOL));
      expect(result.status, name).toBe(SEGMENT_ACCEPT.REJECTED);
      expect(result.reason, name).toBe('invalid-equation');
      expect(decoder.stats().pendingEquations, name).toBe(0);
    }
  });

  it('caps pending equations and neighbour references instead of growing', () => {
    const segment = bytes(SEGMENT, 104);
    const decoder = new SegmentDecoder({
      sourceSymbolCount: 512,
      symbolSizeBytes: SYMBOL,
      segmentBytes: segment.length,
      limits: { maxPendingEquations: 8, maxPendingNeighborRefs: 1_000_000 },
    });

    // Nothing is known, so every repair symbol of degree 2 or more has to be
    // stored. The ninth one has nowhere to go.
    let rejected = 0;
    let stored = 0;
    for (const frame of emit(segment, 400).slice(512)) {
      const result = decoder.accept(frame.id, frame.payload);
      if (result.status === SEGMENT_ACCEPT.REPAIR_PENDING) stored += 1;
      if (result.status === SEGMENT_ACCEPT.REJECTED) {
        expect(result.reason).toBe('saturated');
        rejected += 1;
      }
    }

    expect(stored).toBe(8);
    expect(rejected).toBeGreaterThan(0);
    expect(decoder.stats().pendingEquations).toBe(8);
  });

  it('answers a saturated decoder in constant time, without computing neighbours', () => {
    const segment = bytes(SEGMENT, 105);
    const spy = { calls: 0 };
    const decoder = new SegmentDecoder({
      sourceSymbolCount: 512,
      symbolSizeBytes: SYMBOL,
      segmentBytes: segment.length,
      limits: { maxPendingEquations: 4 },
      neighborsFor: (id, k) => {
        spy.calls += 1;
        return repairNeighbors(id, k);
      },
    });

    const stream = emit(segment, 300).slice(512);
    for (const frame of stream) decoder.accept(frame.id, frame.payload);
    const callsAfterSaturation = spy.calls;

    // A hostile stream cannot buy O(K) of elimination work per frame once the
    // budget is spent: the refusal happens before the neighbour set is derived.
    for (let extra = 0; extra < 500; extra += 1) {
      const result = decoder.accept(100_000 + extra, new Uint8Array(SYMBOL));
      expect(result.reason).toBe('saturated');
    }
    expect(spy.calls).toBe(callsAfterSaturation);
  });

  it('holds no more than the segment plus its equations, whatever arrives', () => {
    const segment = bytes(SEGMENT, 106);
    const decoder = decoderFor(segment);
    const limits = defaultSegmentDecoderLimits(512);
    const worstCase = SEGMENT + Math.ceil(512 / 8) + limits.maxPendingEquations * SYMBOL;

    for (const frame of emit(segment, 4_000).slice(512)) {
      decoder.accept(frame.id, frame.payload);
      expect(decoder.heldBytes()).toBeLessThanOrEqual(worstCase);
      expect(decoder.stats().pendingEquations).toBeLessThanOrEqual(limits.maxPendingEquations);
      expect(decoder.stats().pendingNeighborRefs).toBeLessThanOrEqual(limits.maxPendingNeighborRefs + 512);
    }
  });

  it('never lets a corrupted payload silently pass as a reconstruction', () => {
    // The wire-level defence is the frame CRC, which `parseDataFrame` owns; this
    // asserts the other half, that the decoder does not itself claim identity.
    // A flipped byte that reaches the store produces a different segment, and
    // SHA-256 over the result is what refuses it.
    const segment = bytes(SEGMENT, 107);
    const decoder = decoderFor(segment);
    for (const [index, frame] of emit(segment, 0).entries()) {
      const payload = frame.payload.slice();
      if (index === 200) payload[0] ^= 0xff;
      decoder.accept(frame.id, payload);
    }
    expect(decoder.isComplete).toBe(true);
    expect(sha256(decoder.segment())).not.toBe(sha256(segment));
  });
});

/* --------------------------------------------------------- lifecycle */

describe('cancellation and reset', () => {
  it('refuses everything after release and frees what it held', () => {
    const segment = bytes(SEGMENT, 111);
    const decoder = decoderFor(segment);
    for (const frame of emit(segment, 64).slice(0, 300)) decoder.accept(frame.id, frame.payload);
    expect(decoder.solved).toBe(300);

    decoder.release();

    expect(decoder.isClosed).toBe(true);
    expect(decoder.heldBytes()).toBe(Math.ceil(512 / 8));
    const result = decoder.accept(0, new Uint8Array(SYMBOL));
    expect(result.status).toBe(SEGMENT_ACCEPT.REJECTED);
    expect(result.reason).toBe('closed');
    expect(() => decoder.segment()).toThrow(/released/);
  });

  it('releases cleanly mid-recovery, with equations still outstanding', () => {
    const segment = bytes(SEGMENT, 112);
    const decoder = decoderFor(segment);
    for (const frame of emit(segment, 512).slice(512)) decoder.accept(frame.id, frame.payload);
    expect(decoder.stats().pendingEquations).toBeGreaterThan(0);

    decoder.release();
    expect(decoder.stats().pendingEquations).toBe(0);
    expect(decoder.stats().pendingNeighborRefs).toBe(0);
  });

  it('refuses to hand over a segment that is not finished', () => {
    const segment = bytes(SEGMENT, 113);
    const decoder = decoderFor(segment);
    for (const frame of emit(segment, 0).slice(0, 511)) decoder.accept(frame.id, frame.payload);
    expect(() => decoder.segment()).toThrow(/1 symbols missing/);
    expect(() => decoder.detach()).toThrow(/1 symbols missing/);
  });

  it('transfers the buffer out on detach, so a caller may hold it after the decoder is gone', () => {
    const segment = bytes(SEGMENT, 114);
    const decoder = decoderFor(segment);
    for (const frame of emit(segment, 0)) decoder.accept(frame.id, frame.payload);

    const detached = decoder.detach();
    expect(sha256(detached)).toBe(sha256(segment));
    expect(decoder.isClosed).toBe(true);
    // The decoder let go; the bytes did not.
    expect(sha256(detached)).toBe(sha256(segment));
  });

  it('reports how much is missing and that only new symbols can help', () => {
    const segment = bytes(SEGMENT, 115);
    const decoder = decoderFor(segment);
    for (const frame of emit(segment, 0).slice(0, 500)) decoder.accept(frame.id, frame.payload);

    const state = decoder.recovery();
    expect(state.solvedCount).toBe(500);
    expect(state.missingCount).toBe(12);
    expect(state.complete).toBe(false);
    expect(state.needsMoreRepair).toBe(true);
    expect(decoder.missingSymbolIds()).toEqual([500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511]);

    for (const frame of emit(segment, 0).slice(500)) decoder.accept(frame.id, frame.payload);
    expect(decoder.recovery().needsMoreRepair).toBe(false);
  });
});

/* ----------------------------------------------------------- construction */

describe('construction refuses a self-inconsistent segment', () => {
  it.each([
    ['zero symbols', { sourceSymbolCount: 0, symbolSizeBytes: SYMBOL, segmentBytes: 10 }],
    ['zero symbol size', { sourceSymbolCount: 4, symbolSizeBytes: 0, segmentBytes: 10 }],
    ['no bytes', { sourceSymbolCount: 4, symbolSizeBytes: SYMBOL, segmentBytes: 0 }],
    ['more bytes than symbols hold', { sourceSymbolCount: 2, symbolSizeBytes: SYMBOL, segmentBytes: SYMBOL * 3 }],
    ['a symbol count the byte length does not imply', {
      sourceSymbolCount: 4, symbolSizeBytes: SYMBOL, segmentBytes: SYMBOL,
    }],
  ])('rejects %s', (_name, options) => {
    expect(() => new SegmentDecoder(options)).toThrow();
  });
});
