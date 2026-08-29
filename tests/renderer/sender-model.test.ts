import { describe, expect, it } from 'vitest';
import { COMPRESSION_REASON } from '../../src/core/compression-policy';
import { V2_COMPRESSION } from '../../src/core/protocol-v2';
import { TRANSPORT_PROFILE_ID } from '../../src/core/transport-profiles';
import type { StreamingProgressView, StreamingTransferMetadata } from '../../src/shared/types';
import {
  ETA_STABILITY_TOLERANCE,
  EtaEstimator,
  MIN_ETA_SAMPLES,
  MIN_ETA_WINDOW_MS,
  MIN_RATE_SAMPLES,
  OpticalRateMeter,
  etaCopy,
  formatByteString,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
  nominalTransferSeconds,
  parseByteCount,
  progressSummary,
  ratioOf,
  readTransfer,
  recoveryStatusLine,
  remainingCopy,
  summarizeCompression,
} from '../../src/renderer/sender-model';

const GIB = 1024n * 1024n * 1024n;

function metadata(overrides: Partial<StreamingTransferMetadata> = {}): StreamingTransferMetadata {
  return {
    filename: 'archive.tar',
    originalSizeBytes: (4n * GIB).toString(),
    sha256: 'a'.repeat(64),
    segmentCount: 1024,
    segmentSizeBytes: 4 * 1024 * 1024,
    symbolSizeBytes: 686,
    sourceSymbolsTotal: 6_400_000,
    sampledCompressionRatio: 1,
    transportSizeBytes: (4n * GIB).toString(),
    compressionMode: V2_COMPRESSION.NONE,
    compressionRatio: 1,
    compressionReason: COMPRESSION_REASON.BELOW_THRESHOLD,
    compressionBytesPerSecond: 0,
    preflightHashMs: 9_000,
    resumed: false,
    resumeFromSegment: 0,
    transportProfileId: TRANSPORT_PROFILE_ID.BALANCED,
    ...overrides,
  };
}

function progress(overrides: Partial<StreamingProgressView> = {}): StreamingProgressView {
  return {
    originalBytesTotal: (4n * GIB).toString(),
    transportBytesTotal: (4n * GIB).toString(),
    transportBytesCovered: '0',
    bytesOnTheWire: '0',
    segmentCount: 1024,
    segmentsCompleted: 0,
    currentSegmentIndex: 0,
    framesEmitted: 0,
    manifestFramesEmitted: 0,
    sourceSymbolsEmitted: 0,
    repairSymbolsEmitted: 0,
    recoverySymbolsEmitted: 0,
    recovering: false,
    complete: false,
    resumeFromSegment: 0,
    ...overrides,
  };
}

describe('64-bit size handling', () => {
  it('parses a decimal wire string without going through a float', () => {
    // The exact reason the boundary sends strings. 2^53 + 1 is the first
    // integer a double cannot represent, and `Number()` would round it.
    const beyondSafe = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    expect(parseByteCount(beyondSafe)).toBe(9007199254740992n);
    expect(parseByteCount(beyondSafe) - 9007199254740991n).toBe(1n);
  });

  it('treats anything that is not a decimal count as zero rather than throwing', () => {
    // Display code on the far side of a validated boundary. A throw inside a
    // 500 ms progress poll would take the transfer screen down with it.
    expect(parseByteCount('12.5')).toBe(0n);
    expect(parseByteCount('-1')).toBe(0n);
    expect(parseByteCount('1e9')).toBe(0n);
    expect(parseByteCount('')).toBe(0n);
    expect(parseByteCount(undefined)).toBe(0n);
  });

  /*
   * The boundaries `formatFileSize` in `app-model.ts` used to pin, carried over
   * to the formatter that replaced it. That one divided by 1024 and stopped at
   * MiB; these are the same values through `bigint`, plus the units it could
   * never reach.
   */
  it('labels sizes with the binary units its divisor actually produces', () => {
    expect(formatBytes(512n)).toBe('512 bytes');
    expect(formatBytes(1023n)).toBe('1023 bytes');
    expect(formatBytes(1024n)).toBe('1.00 KiB');
    expect(formatBytes(1536n)).toBe('1.50 KiB');
    expect(formatBytes(2n * 1024n * 1024n)).toBe('2.00 MiB');
  });

  it('keeps going past the units a 32 MiB ceiling never needed', () => {
    expect(formatBytes(4n * GIB)).toBe('4.00 GiB');
    expect(formatBytes(1024n * GIB)).toBe('1.00 TiB');
    expect(formatBytes(1024n * 1024n * GIB)).toBe('1.00 PiB');
    // 2^63, which no double could carry to this function at all.
    expect(formatBytes(9223372036854775808n)).toBe('8.00 EiB');
  });

  it('says byte rather than bytes for one', () => {
    expect(formatBytes(1n)).toBe('1 byte');
    expect(formatBytes(0n)).toBe('0 bytes');
    expect(formatBytes(-5n)).toBe('0 bytes');
  });

  it('formats a wire string end to end', () => {
    expect(formatByteString((3n * GIB).toString())).toBe('3.00 GiB');
    expect(formatByteString('nonsense')).toBe('0 bytes');
  });

  it('takes a ratio of two 64-bit counts without overflowing either', () => {
    expect(ratioOf(2n * GIB, 4n * GIB)).toBeCloseTo(0.5, 5);
    expect(ratioOf(0n, 4n * GIB)).toBe(0);
    expect(ratioOf(4n * GIB, 0n)).toBe(0);
    // Past the end clamps rather than reporting more than a whole file.
    expect(ratioOf(5n * GIB, 4n * GIB)).toBe(1);
    const huge = 9223372036854775808n;
    expect(ratioOf(huge / 4n, huge)).toBeCloseTo(0.25, 5);
  });
});

describe('display formatting', () => {
  it('keeps a decimal below one percent, so a large transfer is not stuck at zero', () => {
    expect(formatPercent(0.0004)).toBe('0.0%');
    expect(formatPercent(0.004)).toBe('0.4%');
    expect(formatPercent(0.05)).toBe('5%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
    // Never over 100, whatever arithmetic upstream produced.
    expect(formatPercent(1.4)).toBe('100%');
  });

  it('scales duration to the magnitude a large transfer actually reaches', () => {
    expect(formatDuration(4_000)).toBe('4s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_725_000)).toBe('1h 02m');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('shows a dash rather than a zero rate before anything is measured', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('—');
    expect(formatRate(8232)).toBe('8.04 KiB/s');
  });
});

describe('ETA estimator', () => {
  const RATE = 8_000; // bytes per second
  const STEP = 500;

  function steady(samples: number, estimator = new EtaEstimator()) {
    for (let index = 0; index < samples; index += 1) {
      const atMs = index * STEP;
      estimator.observe(atMs, BigInt(Math.round((RATE * atMs) / 1000)));
    }
    return estimator;
  }

  it('reports nothing at all until it has a window', () => {
    const estimator = steady(MIN_RATE_SAMPLES - 1);
    const reading = estimator.read(4n * GIB);
    expect(reading.bytesPerSecond).toBeNull();
    expect(reading.etaSeconds).toBeNull();
    expect(reading.withheld).toBe('TOO_FEW_SAMPLES');
  });

  it('reports a measured rate before it will report a remaining time', () => {
    const estimator = steady(MIN_RATE_SAMPLES);
    const reading = estimator.read(4n * GIB);
    expect(reading.bytesPerSecond).toBeCloseTo(RATE, 0);
    // The whole point of the phase's "never immediately" rule: a rate is a
    // measurement and can be shown, an ETA is a prediction and cannot yet.
    expect(reading.etaSeconds).toBeNull();
    expect(reading.withheld).toBe('TOO_FEW_SAMPLES');
  });

  it('withholds a remaining time until the window is long enough', () => {
    // Enough samples, taken too close together to span the minimum window.
    const estimator = new EtaEstimator();
    for (let index = 0; index < MIN_ETA_SAMPLES + 2; index += 1) {
      const atMs = index * 50;
      estimator.observe(atMs, BigInt(Math.round((RATE * atMs) / 1000)));
    }
    const reading = estimator.read(4n * GIB);
    expect(reading.samples).toBeGreaterThanOrEqual(MIN_ETA_SAMPLES);
    expect(reading.etaSeconds).toBeNull();
    expect(reading.withheld).toBe('WINDOW_TOO_SHORT');
  });

  it('offers a remaining time once the window is long, full and steady', () => {
    const needed = Math.max(MIN_ETA_SAMPLES, MIN_ETA_WINDOW_MS / STEP + 1);
    const estimator = steady(needed + 2);
    const total = BigInt(RATE * 100);
    const reading = estimator.read(total);
    expect(reading.withheld).toBeNull();
    expect(reading.etaSeconds).not.toBeNull();
    // 100 seconds of work at the observed rate, minus what has been done.
    const done = (needed + 1) * STEP / 1000;
    expect(reading.etaSeconds!).toBeCloseTo(100 - done, 0);
  });

  it('withholds a remaining time while the rate is still changing', () => {
    // A transfer that was slow and has just sped up sharply. The window rate
    // and the recent rate disagree, which is precisely the moment an ETA would
    // be about to halve while somebody watched it.
    const estimator = new EtaEstimator();
    let bytes = 0;
    const needed = Math.max(MIN_ETA_SAMPLES, MIN_ETA_WINDOW_MS / STEP + 1) + 2;
    for (let index = 0; index < needed; index += 1) {
      const fast = index > needed / 2;
      bytes += fast ? RATE * 4 * (STEP / 1000) : RATE * (STEP / 1000);
      estimator.observe(index * STEP, BigInt(Math.round(bytes)));
    }
    const reading = estimator.read(4n * GIB);
    expect(reading.bytesPerSecond).toBeGreaterThan(0);
    expect(reading.etaSeconds).toBeNull();
    expect(reading.withheld).toBe('RATE_UNSTABLE');
  });

  it('tolerates ordinary jitter without withholding', () => {
    const estimator = new EtaEstimator();
    let bytes = 0;
    const needed = Math.max(MIN_ETA_SAMPLES, MIN_ETA_WINDOW_MS / STEP + 1) + 4;
    for (let index = 0; index < needed; index += 1) {
      // Alternating +-10%, well inside the tolerance, which is what an optical
      // link does even when it is behaving.
      const wobble = index % 2 === 0 ? 1.1 : 0.9;
      bytes += RATE * wobble * (STEP / 1000);
      estimator.observe(index * STEP, BigInt(Math.round(bytes)));
    }
    const reading = estimator.read(BigInt(RATE * 200));
    expect(ETA_STABILITY_TOLERANCE).toBeGreaterThan(0.1);
    expect(reading.withheld).toBeNull();
    expect(reading.etaSeconds).not.toBeNull();
  });

  it('names a stalled transfer rather than dividing by nothing', () => {
    const estimator = new EtaEstimator();
    for (let index = 0; index < MIN_ETA_SAMPLES + 2; index += 1) {
      estimator.observe(index * STEP, 1024n);
    }
    const reading = estimator.read(4n * GIB);
    expect(reading.bytesPerSecond).toBe(0);
    expect(reading.etaSeconds).toBeNull();
    expect(reading.withheld).toBe('NOT_MOVING');
    expect(etaCopy(reading)).toBe('Waiting for frames');
  });

  it('forgets its window on a hold, so the pause is never measured as slowness', () => {
    const estimator = steady(40);
    expect(estimator.read(4n * GIB).bytesPerSecond).toBeGreaterThan(0);
    estimator.reset();
    expect(estimator.read(4n * GIB).withheld).toBe('TOO_FEW_SAMPLES');
  });

  it('ignores a sample that did not move forward in time', () => {
    const estimator = new EtaEstimator();
    estimator.observe(1_000, 100n);
    estimator.observe(500, 999_999n);
    expect(estimator.read(4n * GIB).samples).toBe(1);
  });

  it('trims the window by time, so a long transfer estimates from its recent past', () => {
    const estimator = new EtaEstimator(5_000);
    for (let index = 0; index < 100; index += 1) {
      const atMs = index * STEP;
      estimator.observe(atMs, BigInt(Math.round((RATE * atMs) / 1000)));
    }
    // 5 s of samples at 500 ms is eleven, and the window must not keep fifty
    // seconds of history that a rate change would have to fight its way out of.
    expect(estimator.read(4n * GIB).samples).toBeLessThanOrEqual(12);
  });

  it('says it is measuring rather than showing a placeholder dash', () => {
    const early = new EtaEstimator().read(4n * GIB);
    expect(etaCopy(early)).toBe('Measuring rate…');
    expect(etaCopy({ bytesPerSecond: 1, etaSeconds: 0.5, samples: 20, withheld: null })).toBe('Any moment');
    expect(etaCopy({ bytesPerSecond: 1, etaSeconds: 90, samples: 20, withheld: null })).toBe('About 1m 30s left');
  });
});

describe('compression summary', () => {
  it('reports the transport share when the segments carry compressed bytes', () => {
    const summary = summarizeCompression(metadata({
      compressionMode: V2_COMPRESSION.GZIP,
      compressionRatio: 0.269,
      compressionReason: COMPRESSION_REASON.MEASURED_ABOVE_THRESHOLD,
      transportSizeBytes: (GIB + GIB / 12n).toString(),
    }));
    expect(summary.active).toBe(true);
    expect(summary.ratioText).toBe('27%');
    expect(summary.detail).toContain('27%');
    // The receiver still checks the *original* file's hash, and the copy has to
    // say so or a compressed transfer looks like a different file arriving.
    expect(summary.detail).toContain('hash');
  });

  it('distinguishes a measured refusal from a sampled one', () => {
    const measured = summarizeCompression(metadata({ compressionReason: COMPRESSION_REASON.MEASURED_BELOW_THRESHOLD }));
    const sampled = summarizeCompression(metadata({ compressionReason: COMPRESSION_REASON.BELOW_THRESHOLD }));
    expect(measured.active).toBe(false);
    expect(sampled.active).toBe(false);
    expect(measured.detail).not.toBe(sampled.detail);
    expect(measured.detail).toContain('full measuring pass');
  });

  it('answers every reason the policy can produce', () => {
    for (const reason of Object.values(COMPRESSION_REASON)) {
      const summary = summarizeCompression(metadata({ compressionReason: reason }));
      expect(summary.label.length, reason).toBeGreaterThan(0);
      expect(summary.detail.length, reason).toBeGreaterThan(0);
      expect(summary.active, reason).toBe(false);
    }
  });

  it('never offers a ratio for a transfer that is not compressed', () => {
    expect(summarizeCompression(metadata()).ratioText).toBeNull();
  });
});

describe('transfer readout', () => {
  it('keeps the two sizes apart under compression', () => {
    const readout = readTransfer(progress({
      originalBytesTotal: (4n * GIB).toString(),
      transportBytesTotal: GIB.toString(),
      transportBytesCovered: (GIB / 2n).toString(),
    }));
    expect(readout.originalTotal).toBe(4n * GIB);
    expect(readout.transportTotal).toBe(GIB);
    expect(readout.fraction).toBeCloseTo(0.5, 5);
    // Half the container is half the file, which is the only honest projection
    // available while window records are variable length.
    expect(readout.originalCovered).toBe(2n * GIB);
  });

  it('reports the original size exactly once the container is fully covered', () => {
    const readout = readTransfer(progress({
      originalBytesTotal: '4294967297',
      transportBytesTotal: '1000000007',
      transportBytesCovered: '1000000007',
      complete: true,
    }));
    // Not a rounded projection: a finished transfer must show the real size.
    expect(readout.originalCovered).toBe(4294967297n);
    expect(readout.fraction).toBe(1);
  });

  it('clamps the segment counter to the plan', () => {
    // `currentSegmentIndex` is zero-based and rests on the last segment when the
    // pass finishes, which read as "segment 1025 of 1024".
    expect(readTransfer(progress({ currentSegmentIndex: 1023, segmentCount: 1024 })).segmentPosition).toBe(1024);
    expect(readTransfer(progress({ currentSegmentIndex: 0, segmentCount: 1024 })).segmentPosition).toBe(1);
    expect(readTransfer(progress({ segmentCount: 0 })).segmentPosition).toBe(0);
  });

  it('measures the repair share against payload symbols only', () => {
    const readout = readTransfer(progress({ sourceSymbolsEmitted: 300, repairSymbolsEmitted: 100 }));
    expect(readout.repairFraction).toBeCloseTo(0.25, 5);
    // Manifest frames are not payload and must not dilute the ratio.
    expect(readTransfer(progress({ manifestFramesEmitted: 900 })).repairFraction).toBe(0);
  });

  it('marks a pass that started partway in', () => {
    const readout = readTransfer(progress({ resumeFromSegment: 700 }));
    expect(readout.resumed).toBe(true);
    expect(readout.resumeFromSegment).toBe(700);
    expect(readTransfer(progress()).resumed).toBe(false);
  });

  it('names both sizes in the summary line only when they differ', () => {
    const plain = readTransfer(progress({ transportBytesCovered: (2n * GIB).toString() }));
    expect(progressSummary(plain, false)).toBe('2.00 GiB of 4.00 GiB');
    expect(progressSummary(plain, false)).not.toContain('optical link');

    const compressed = readTransfer(progress({
      transportBytesTotal: GIB.toString(),
      transportBytesCovered: (GIB / 4n).toString(),
    }));
    expect(progressSummary(compressed, true)).toContain('optical link');
    expect(progressSummary(compressed, true)).toContain('1.00 GiB');
  });
});

describe('nominal transfer estimate', () => {
  it('divides the transport size by the profile rate', () => {
    expect(nominalTransferSeconds(BigInt(8_232 * 60), 8_232)).toBeCloseTo(60, 5);
    expect(nominalTransferSeconds(0n, 8_232)).toBe(0);
  });

  it('refuses to estimate against a rate it does not have', () => {
    expect(nominalTransferSeconds(GIB, 0)).toBeNull();
    expect(nominalTransferSeconds(GIB, Number.NaN)).toBeNull();
  });
});

describe('optical rate meter', () => {
  const STEP = 500;

  it('reports nothing until it has a window to average across', () => {
    const meter = new OpticalRateMeter();
    meter.observe(0, 1_000n);
    meter.observe(STEP, 9_000n);
    // Three samples is the minimum: two points make a segment, not a rate.
    expect(meter.read()).toBeNull();
    meter.observe(2 * STEP, 17_000n);
    expect(meter.read()).not.toBeNull();
  });

  it('measures bytes handed to the display, not source coverage', () => {
    // The recovery tail moves `bytesOnTheWire` while coverage stands still.
    // This test is the reason the meter exists: a coverage-derived rate
    // flatlines exactly when the link is busiest.
    const meter = new OpticalRateMeter();
    for (let index = 0; index < 6; index += 1) {
      meter.observe(index * STEP, BigInt(index * 8_000));
    }
    // ~8000 bytes every 500 ms = ~16 KiB/s.
    expect(meter.read()).toBeCloseTo(16_000, -2);
  });

  it('keeps reporting through the recovery tail at the same cadence as the pass', () => {
    const meter = new OpticalRateMeter();
    // First pass ends at 10 s; the tail keeps emitting identical-size frames.
    for (let index = 0; index < 20; index += 1) {
      meter.observe(index * STEP, BigInt((index + 1) * 7_000));
    }
    const duringPass = meter.read();
    for (let index = 20; index < 32; index += 1) {
      meter.observe(index * STEP, BigInt((index + 1) * 7_000));
    }
    const duringRecovery = meter.read();
    expect(duringPass).not.toBeNull();
    expect(duringRecovery).not.toBeNull();
    // Same emission rate in both phases: the tail is the link still working,
    // so its rate must be indistinguishable from the pass's.
    expect(duringRecovery!).toBeCloseTo(duringPass!, -2);
  });

  it('forgets its window on a hold, so paused time is never measured as throughput', () => {
    const meter = new OpticalRateMeter();
    for (let index = 0; index < 8; index += 1) {
      meter.observe(index * STEP, BigInt(index * 10_000));
    }
    expect(meter.read()).toBeGreaterThan(0);
    meter.reset();
    expect(meter.read()).toBeNull();
  });

  it('ignores samples that do not advance monotonic time', () => {
    const meter = new OpticalRateMeter();
    meter.observe(1_000, 500n);
    meter.observe(1_000, 999n);
    meter.observe(900, 999n);
    meter.observe(1_500, 5_000n);
    // Only the advancing pair survives; two samples is still short of a window.
    expect(meter.read()).toBeNull();
    meter.observe(2_000, 9_500n);
    expect(meter.read()).toBeCloseTo(9_000, -2);
  });

  it('trims its window by time rather than by sample count', () => {
    const meter = new OpticalRateMeter(5_000);
    for (let index = 0; index < 100; index += 1) {
      meter.observe(index * STEP, BigInt(index * 8_000));
    }
    // 5 s window at 500 ms steps holds six samples; the reading must come from
    // the recent span only, not history a slowdown would have to fight out of.
    expect(meter.read()).toBeCloseTo(16_000, -2);
  });

  it('answers null while the wire stands still, and formatRate shows the dash', () => {
    const meter = new OpticalRateMeter();
    for (let index = 0; index < 6; index += 1) {
      meter.observe(index * STEP, 50_000n);
    }
    // Nothing moved: no rate is the honest answer, never zero bytes per second.
    expect(meter.read()).toBeNull();
    expect(formatRate(null)).toBe('—');
  });
});

describe('recovery phase telemetry', () => {
  const steadyReading = { bytesPerSecond: 16_000, etaSeconds: 90, samples: 12, withheld: null } as const;
  const stalledReading = { bytesPerSecond: null, etaSeconds: null, samples: 3, withheld: 'NOT_MOVING' } as const;

  it('carries the tail phase and its own counter through the readout', () => {
    const readout = readTransfer(progress({
      recovering: true,
      recoverySymbolsEmitted: 1_248,
      complete: true,
    }));
    expect(readout.recovering).toBe(true);
    expect(readout.recoverySymbolsEmitted).toBe(1_248);
    expect(readTransfer(progress()).recovering).toBe(false);
    expect(readTransfer(progress()).recoverySymbolsEmitted).toBe(0);
  });

  it('never derives recovery from source progress alone', () => {
    // Full coverage with the flag false is a finished PASS, not a finished
    // TRANSFER. The receiver's verification is the only completion, and the
    // sender-side phase must come from the sender's own tail state.
    const readout = readTransfer(progress({
      transportBytesCovered: (4n * GIB).toString(),
      complete: true,
      recovering: false,
    }));
    expect(readout.fraction).toBe(1);
    expect(readout.recovering).toBe(false);
  });

  it('names the wait instead of inventing a remaining time once the tail runs', () => {
    // Even with a perfectly good ETA in hand: during the tail there is no
    // finite denominator left to estimate against.
    const readout = readTransfer(progress({ recovering: true }));
    expect(remainingCopy(readout, steadyReading)).toBe('Awaiting receiver');
  });

  it('lets the screen witness outrank a lagging progress poll', () => {
    // The eyebrow can announce recovery up to one sampling period before the
    // polled progress view catches up. In that window the Remaining cell must
    // already say "Awaiting receiver" — "Waiting for frames" under a recovery
    // banner was the exact contradiction on the reported screen.
    const staleReadout = readTransfer(progress({ recovering: false }));
    expect(remainingCopy(staleReadout, stalledReading, true)).toBe('Awaiting receiver');
    // A null readout (first poll has not landed) defers to the witness too.
    expect(remainingCopy(null, stalledReading, true)).toBe('Awaiting receiver');
    // And without the witness the estimator's own answer stands.
    expect(remainingCopy(staleReadout, stalledReading)).toBe('Waiting for frames');
  });

  it('keeps the estimator answer during the pass, including its refusals', () => {
    const measuring = { bytesPerSecond: null, etaSeconds: null, samples: 1, withheld: 'TOO_FEW_SAMPLES' } as const;
    const readout = readTransfer(progress());
    expect(remainingCopy(readout, measuring)).toBe('Measuring rate…');
    expect(remainingCopy(readout, steadyReading)).toBe('About 1m 30s left');
  });

  it('states the tail in counts, never as a percentage', () => {
    const line = recoveryStatusLine(readTransfer(progress({
      recovering: true,
      recoverySymbolsEmitted: 1248,
    })));
    expect(line).toContain('Source data fully sent');
    expect(line).toContain('1,248');
    expect(line).toContain('Waiting for the receiving device');
    expect(line).not.toMatch(/%/);
  });
});
