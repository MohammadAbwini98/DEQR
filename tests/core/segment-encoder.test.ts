import { describe, expect, it } from 'vitest';

import { SegmentEncoder, repairNeighbors } from '../../src/core/segment-encoder';

const SYMBOL = 16;

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function xorOf(segment: Uint8Array, indices: number[], symbolSize: number): Uint8Array {
  const out = new Uint8Array(symbolSize);
  for (const index of indices) {
    const start = index * symbolSize;
    const end = Math.min(start + symbolSize, segment.length);
    for (let offset = start; offset < end; offset += 1) out[offset - start] ^= segment[offset];
  }
  return out;
}

describe('segment symbolisation', () => {
  it('emits source symbols as the segment sliced into fixed-size blocks', () => {
    const segment = bytes(SYMBOL * 4);
    const encoder = new SegmentEncoder(SYMBOL);
    encoder.loadSegment(segment);
    expect(encoder.sourceSymbolCount).toBe(4);

    const out = new Uint8Array(SYMBOL);
    for (let index = 0; index < 4; index += 1) {
      encoder.symbolInto(index, out);
      expect(Array.from(out)).toEqual(Array.from(segment.subarray(index * SYMBOL, (index + 1) * SYMBOL)));
    }
  });

  it('zero-pads the short final symbol rather than shortening it', () => {
    // XOR repair needs every symbol in a segment to be the same length, so the
    // tail is padded, not truncated.
    const segment = bytes(SYMBOL * 2 + 5);
    const encoder = new SegmentEncoder(SYMBOL);
    encoder.loadSegment(segment);
    expect(encoder.sourceSymbolCount).toBe(3);

    const out = new Uint8Array(SYMBOL);
    encoder.symbolInto(2, out);
    expect(Array.from(out.subarray(0, 5))).toEqual(Array.from(segment.subarray(SYMBOL * 2)));
    expect(out.subarray(5).every((byte) => byte === 0)).toBe(true);
  });

  it('builds repair symbols as the XOR of the neighbours their id selects', () => {
    const segment = bytes(SYMBOL * 12, 9);
    const encoder = new SegmentEncoder(SYMBOL);
    encoder.loadSegment(segment);

    const out = new Uint8Array(SYMBOL);
    for (let symbolId = 12; symbolId < 40; symbolId += 1) {
      encoder.symbolInto(symbolId, out);
      const expected = xorOf(segment, repairNeighbors(symbolId, 12), SYMBOL);
      expect(Array.from(out), `repair ${symbolId}`).toEqual(Array.from(expected));
    }
  });

  it('reproduces the same repair symbol from the same id, which is what a receiver relies on', () => {
    const segment = bytes(SYMBOL * 8, 3);
    const first = new SegmentEncoder(SYMBOL);
    const second = new SegmentEncoder(SYMBOL);
    first.loadSegment(segment);
    second.loadSegment(segment.slice());

    const a = new Uint8Array(SYMBOL);
    const b = new Uint8Array(SYMBOL);
    for (const symbolId of [8, 9, 17, 250]) {
      first.symbolInto(symbolId, a);
      second.symbolInto(symbolId, b);
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });

  it('keeps neighbour selection inside the segment and never repeats an index', () => {
    for (const sourceSymbolCount of [1, 2, 7, 64, 2048]) {
      for (const symbolId of [sourceSymbolCount, sourceSymbolCount + 1, sourceSymbolCount + 997]) {
        const neighbors = repairNeighbors(symbolId, sourceSymbolCount);
        expect(neighbors.length).toBeGreaterThanOrEqual(1);
        expect(neighbors.length).toBeLessThanOrEqual(sourceSymbolCount);
        expect(new Set(neighbors).size).toBe(neighbors.length);
        for (const index of neighbors) {
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(sourceSymbolCount);
        }
      }
    }
  });

  it('handles a single-symbol segment, where every repair is that symbol', () => {
    const segment = bytes(5);
    const encoder = new SegmentEncoder(SYMBOL);
    encoder.loadSegment(segment);
    expect(encoder.sourceSymbolCount).toBe(1);

    const source = new Uint8Array(SYMBOL);
    const repair = new Uint8Array(SYMBOL);
    encoder.symbolInto(0, source);
    encoder.symbolInto(1, repair);
    expect(Array.from(repair)).toEqual(Array.from(source));
  });

  it('references the caller buffer instead of copying it', () => {
    const segment = bytes(SYMBOL * 2);
    const encoder = new SegmentEncoder(SYMBOL);
    encoder.loadSegment(segment);

    // The sender reuses one segment buffer for the whole transfer, so this is
    // the contract rather than an implementation detail.
    segment[0] ^= 0xff;
    const out = new Uint8Array(SYMBOL);
    encoder.symbolInto(0, out);
    expect(out[0]).toBe(segment[0]);
  });

  it('refuses a wrong-sized output buffer, an empty segment, and use before loading', () => {
    const encoder = new SegmentEncoder(SYMBOL);
    expect(() => encoder.symbolInto(0, new Uint8Array(SYMBOL))).toThrow(/no segment/);
    expect(() => encoder.loadSegment(new Uint8Array(0))).toThrow(/at least one byte/);

    encoder.loadSegment(bytes(SYMBOL));
    expect(() => encoder.symbolInto(0, new Uint8Array(SYMBOL - 1))).toThrow(/output buffer/);
    expect(() => encoder.symbolInto(-1, new Uint8Array(SYMBOL))).toThrow(/symbolId/);

    encoder.release();
    expect(encoder.hasSegment).toBe(false);
    expect(() => encoder.symbolInto(0, new Uint8Array(SYMBOL))).toThrow(/no segment/);
  });

  it('rebuilds its degree distribution per segment, so the final short segment differs', () => {
    const encoder = new SegmentEncoder(SYMBOL);
    encoder.loadSegment(bytes(SYMBOL * 32));
    expect(encoder.sourceSymbolCount).toBe(32);
    encoder.loadSegment(bytes(SYMBOL + 1));
    expect(encoder.sourceSymbolCount).toBe(2);
  });
});
