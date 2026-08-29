/**
 * Benchmark summary math — deterministic, pure.
 *
 * Inputs are counters or timeline samples; outputs are the 7 summary metrics
 * required by Phase 01 plus the two KPIs.
 */

import type { TimelineSample } from './diagnostics-schema';
import { computeVerifiedGoodput, computeOpticalUsefulYield } from './diagnostics-schema';

export interface SummaryInput {
  verifiedOriginalBytes: number;
  wallClockSeconds: number;
  presentedSymbols: number; // sender symbolsPresented (framesEmitted incl. repair)
  usefulNonRedundantSymbols: number; // receiver newSequenceNumbers
  duplicateCount: number;
  redundantCount: number;
  decoderAttempts: number;
  decoderBusyMs?: number; // sum of decodeMs if available, else wallClock*decodeFps*avgDecodeMs
  totalDecodeMs?: number;
  timeline: TimelineSample[];
}

export interface SummaryOutput {
  sustainedGoodputBytesPerSecond: number;
  bestOneSecondGoodputBytesPerSecond: number | null;
  catchRate: number; // usefulNonRedundantSymbols / presentedSymbols
  usefulOverhead: number; // presented / useful -1
  duplicateRate: number; // duplicateCount / decoderAttempts
  redundancyRate: number; // redundantCount / decoderAttempts
  decoderUtilization: number; // decoderAttempts / theoretical ceiling or decodeMs / wallMs
  verifiedGoodput: number;
  opticalUsefulYield: number;
}

export function summarizeBenchmark(input: SummaryInput): SummaryOutput {
  const verifiedGoodput = computeVerifiedGoodput(input.verifiedOriginalBytes, input.wallClockSeconds);
  const opticalUsefulYield = computeOpticalUsefulYield(input.usefulNonRedundantSymbols, input.presentedSymbols);
  const catchRate = opticalUsefulYield; // same definition for this phase (no crop distinction yet)
  const usefulOverhead = input.usefulNonRedundantSymbols > 0
    ? (input.presentedSymbols / input.usefulNonRedundantSymbols) - 1
    : 0;

  const duplicateRate = input.decoderAttempts > 0 ? input.duplicateCount / input.decoderAttempts : 0;
  const redundancyRate = input.decoderAttempts > 0 ? input.redundantCount / input.decoderAttempts : 0;

  const decoderUtilization = computeDecoderUtilization(input);

  const bestOneSecondGoodputBytesPerSecond = computeBestWindowGoodput(input.timeline);

  return {
    sustainedGoodputBytesPerSecond: verifiedGoodput,
    bestOneSecondGoodputBytesPerSecond,
    catchRate,
    usefulOverhead,
    duplicateRate,
    redundancyRate,
    decoderUtilization,
    verifiedGoodput,
    opticalUsefulYield,
  };
}

function computeDecoderUtilization(input: SummaryInput): number {
  if (input.totalDecodeMs !== undefined && input.wallClockSeconds > 0) {
    // fraction of wall clock spent decoding
    return Math.min(1, input.totalDecodeMs / (input.wallClockSeconds * 1000));
  }
  if (input.decoderAttempts > 0 && input.wallClockSeconds > 0) {
    // fallback: attempts per second relative to 20 fps decode ceiling (see PERFORMANCE-BASELINE v18 L 19 fps)
    const attemptsPerSec = input.decoderAttempts / input.wallClockSeconds;
    const ceiling = 20;
    return Math.min(1, attemptsPerSec / ceiling);
  }
  return 0;
}

/**
 * Best >=1s goodput window over timeline.
 * Uses usefulBytesRecovered cumulative field.
 */
export function computeBestWindowGoodput(timeline: TimelineSample[]): number | null {
  if (timeline.length < 2) return null;
  // Need at least 1s of wall clock to have a window
  let best: number | null = null;
  // Sliding window with two pointers
  for (let start = 0; start < timeline.length; start++) {
    for (let end = start + 1; end < timeline.length; end++) {
      const dt = timeline[end].elapsedSeconds - timeline[start].elapsedSeconds;
      if (dt < 1) continue;
      const dBytes = timeline[end].usefulBytesRecovered - timeline[start].usefulBytesRecovered;
      if (dBytes < 0) continue;
      const rate = dBytes / dt;
      if (best === null || rate > best) best = rate;
      // break early when window already > ~1.5s and further extension will only dilute
      // but we keep scanning to find true max
    }
  }
  return best;
}

// ── Helpers for timeline aggregation ─────────────────────────────────────────

export function aggregateTimeline(
  samples: Array<{ elapsedSeconds: number; captureFps: number; decodeFps: number; uniqueSymbols: number; solvedBlocks: number; usefulBytes: number; workerUtil: number; queueDepth: number; fullScans: number }>,
): TimelineSample[] {
  // Already in required shape — this helper is the tested aggregation entry point
  return samples.map(s => ({
    elapsedSeconds: s.elapsedSeconds,
    captureFps: s.captureFps,
    decodeFps: s.decodeFps,
    uniqueSymbols: s.uniqueSymbols,
    solvedBlocks: s.solvedBlocks,
    usefulBytesRecovered: s.usefulBytes,
    workerUtilization: s.workerUtil,
    queueDepth: s.queueDepth,
    cumulativeFullScans: s.fullScans,
  }));
}
