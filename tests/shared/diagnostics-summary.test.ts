import { describe, it, expect } from 'vitest';
import { summarizeBenchmark, computeBestWindowGoodput, aggregateTimeline } from '../../src/shared/diagnostics-summary';

describe('diagnostics-summary', () => {
  it('computes sustained goodput', () => {
    const out = summarizeBenchmark({
      verifiedOriginalBytes: 102400,
      wallClockSeconds: 12.5,
      presentedSymbols: 100,
      usefulNonRedundantSymbols: 60,
      duplicateCount: 10,
      redundantCount: 5,
      decoderAttempts: 80,
      timeline: [],
    });
    expect(out.sustainedGoodputBytesPerSecond).toBeCloseTo(8192, 1);
    expect(out.verifiedGoodput).toBeCloseTo(8192, 1);
  });

  it('computes catch rate and overhead', () => {
    const out = summarizeBenchmark({
      verifiedOriginalBytes: 0,
      wallClockSeconds: 10,
      presentedSymbols: 100,
      usefulNonRedundantSymbols: 60,
      duplicateCount: 10,
      redundantCount: 5,
      decoderAttempts: 80,
      timeline: [],
    });
    expect(out.catchRate).toBeCloseTo(0.6, 5);
    expect(out.opticalUsefulYield).toBeCloseTo(0.6, 5);
    expect(out.usefulOverhead).toBeCloseTo(100 / 60 - 1, 5); // 0.666...
  });

  it('computes duplicate and redundancy rates', () => {
    const out = summarizeBenchmark({
      verifiedOriginalBytes: 0,
      wallClockSeconds: 10,
      presentedSymbols: 100,
      usefulNonRedundantSymbols: 60,
      duplicateCount: 20,
      redundantCount: 10,
      decoderAttempts: 100,
      timeline: [],
    });
    expect(out.duplicateRate).toBeCloseTo(0.2, 5);
    expect(out.redundancyRate).toBeCloseTo(0.1, 5);
  });

  it('duplicate and redundant are separated', () => {
    const a = summarizeBenchmark({
      verifiedOriginalBytes: 0, wallClockSeconds: 10,
      presentedSymbols: 100, usefulNonRedundantSymbols: 50,
      duplicateCount: 30, redundantCount: 5, decoderAttempts: 100, timeline: [],
    });
    const b = summarizeBenchmark({
      verifiedOriginalBytes: 0, wallClockSeconds: 10,
      presentedSymbols: 100, usefulNonRedundantSymbols: 50,
      duplicateCount: 5, redundantCount: 30, decoderAttempts: 100, timeline: [],
    });
    expect(a.duplicateRate).not.toBe(a.redundancyRate);
    expect(a.duplicateRate).toBeCloseTo(0.3, 5);
    expect(b.redundancyRate).toBeCloseTo(0.3, 5);
    // Swapping counts swaps rates, not collapsed
    expect(a.duplicateRate).toBeCloseTo(b.redundancyRate, 5);
  });

  it('computes decoder utilization via decodeMs', () => {
    const out = summarizeBenchmark({
      verifiedOriginalBytes: 0, wallClockSeconds: 10,
      presentedSymbols: 100, usefulNonRedundantSymbols: 60,
      duplicateCount: 0, redundantCount: 0, decoderAttempts: 50,
      totalDecodeMs: 5000, // 5s decoding over 10s wall = 50%
      timeline: [],
    });
    expect(out.decoderUtilization).toBeCloseTo(0.5, 5);
  });

  it('falls back to attempts per sec vs ceiling when no totalDecodeMs', () => {
    const out = summarizeBenchmark({
      verifiedOriginalBytes: 0, wallClockSeconds: 10,
      presentedSymbols: 100, usefulNonRedundantSymbols: 60,
      duplicateCount: 0, redundantCount: 0, decoderAttempts: 100, // 10 per sec vs 20 ceiling = 0.5
      timeline: [],
    });
    expect(out.decoderUtilization).toBeCloseTo(0.5, 5);
  });

  it('computes best >=1s goodput window', () => {
    const timeline = [
      { elapsedSeconds: 0, captureFps: 22, decodeFps: 18, uniqueSymbols: 0, solvedBlocks: 0, usefulBytesRecovered: 0, workerUtilization: 0, queueDepth: 0, cumulativeFullScans: 0 },
      { elapsedSeconds: 0.5, captureFps: 22, decodeFps: 18, uniqueSymbols: 6, solvedBlocks: 6, usefulBytesRecovered: 4116, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 11 },
      { elapsedSeconds: 1.0, captureFps: 22, decodeFps: 18, uniqueSymbols: 12, solvedBlocks: 12, usefulBytesRecovered: 8232, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 22 },
      { elapsedSeconds: 1.5, captureFps: 22, decodeFps: 18, uniqueSymbols: 18, solvedBlocks: 18, usefulBytesRecovered: 12348, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 33 },
      // Burst: 2s window with more bytes
      { elapsedSeconds: 2.5, captureFps: 22, decodeFps: 18, uniqueSymbols: 36, solvedBlocks: 36, usefulBytesRecovered: 24696, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 55 },
    ];
    const best = computeBestWindowGoodput(timeline);
    // Best 1s window is 0.5->1.5 = 8232 bytes in 1s = 8232 B/s, or 1.5->2.5 = 12348 in 1s = 12348, so best is 12348
    expect(best).toBeCloseTo(12348, 0);
  });

  it('returns null when insufficient timeline for 1s window', () => {
    expect(computeBestWindowGoodput([{ elapsedSeconds: 0, captureFps: 0, decodeFps: 0, uniqueSymbols: 0, solvedBlocks: 0, usefulBytesRecovered: 0, workerUtilization: 0, queueDepth: 0, cumulativeFullScans: 0 }])).toBeNull();
    expect(computeBestWindowGoodput([])).toBeNull();
  });

  it('aggregateTimeline is deterministic and pure', () => {
    const input = [{ elapsedSeconds: 0.5, captureFps: 22, decodeFps: 18, uniqueSymbols: 6, solvedBlocks: 6, usefulBytes: 4116, workerUtil: 0.5, queueDepth: 1, fullScans: 11 }];
    const a = aggregateTimeline(input);
    const b = aggregateTimeline(input);
    expect(a).toEqual(b);
    expect(a[0].usefulBytesRecovered).toBe(4116);
    expect(a[0].workerUtilization).toBe(0.5);
  });

  it('transfer-rate calculations are not collapsed', () => {
    // verifiedGoodput uses wallClock, not presentation rate
    const out = summarizeBenchmark({
      verifiedOriginalBytes: 102400, wallClockSeconds: 20,
      presentedSymbols: 200, usefulNonRedundantSymbols: 100,
      duplicateCount: 10, redundantCount: 5, decoderAttempts: 100, timeline: [],
    });
    // verifiedGoodput 5120, but presentedSymbols 200 over 20s would be 10/s — different
    expect(out.verifiedGoodput).toBe(5120);
    expect(out.catchRate).toBe(0.5);
    // Not same value
    expect(out.verifiedGoodput).not.toBe(out.catchRate);
  });
});
