/**
 * Everything the sender screens compute, with no React and no DOM.
 *
 * The rule this module exists to enforce is that a number on screen is either a
 * measurement or is absent. Three of them used to be neither:
 *
 * - **Size.** 64-bit byte counts cross the IPC boundary as decimal strings
 *   precisely so they cannot be silently coerced into a lossy `number`, and
 *   then the only thing that ever formatted them was `Number(...)`. Everything
 *   here parses to `bigint` and formats from `bigint`, so a 16 EiB claim in a
 *   manifest is displayed wrong-but-honestly rather than rounded into
 *   plausibility.
 * - **Rate.** Frames-per-second is not throughput; Phase 00 established that
 *   and Phase 04 measured the gap. The rate here is original bytes covered over
 *   wall time, taken from a window of samples, and it is absent until there is
 *   a window to take it from.
 * - **ETA.** A remaining-time estimate from two samples of a transfer that has
 *   not reached steady state is a guess wearing a clock. `EtaEstimator`
 *   withholds one until the window is long enough *and* the recent half of it
 *   agrees with the whole - which is what "never immediately" has to mean if it
 *   is going to mean anything testable.
 */

import { COMPRESSION_REASON } from '../core/compression-policy';
import { V2_COMPRESSION } from '../core/protocol-v2';
import type { StreamingProgressView, StreamingTransferMetadata } from '../shared/types';

/* ----------------------------------------------------------------- numbers */

/**
 * Reads one of the decimal strings the main process sends for a 64-bit size.
 *
 * Returns 0 rather than throwing for anything malformed: this is display code
 * on the far side of a boundary that already validated, and a renderer that
 * throws inside a progress poll takes the transfer screen down with it.
 */
export function parseByteCount(text: string | undefined): bigint {
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

const BYTE_UNITS = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const;

/**
 * Binary units, formatted from `bigint` without ever building a `number` from
 * the whole value.
 *
 * The unit is chosen by repeated division on the integer, and only the final
 * mantissa - always under 1024 - is turned into a float. `formatFileSize` in
 * `app-model.ts` does the same job for `number` inputs and stops at MiB, which
 * was correct for a 32 MiB ceiling and is not correct for a 4 GiB transfer.
 */
export function formatBytes(value: bigint): string {
  if (value < 0n) return '0 bytes';
  if (value < 1024n) return `${value} ${value === 1n ? 'byte' : 'bytes'}`;

  let unit = 0;
  let scaled = value;
  while (scaled >= 1024n * 1024n && unit < BYTE_UNITS.length - 2) {
    scaled /= 1024n;
    unit += 1;
  }
  // One more division, in floating point, so the fraction survives.
  const mantissa = Number(scaled) / 1024;
  unit += 1;
  return `${mantissa.toFixed(mantissa >= 100 ? 0 : mantissa >= 10 ? 1 : 2)} ${BYTE_UNITS[unit]}`;
}

/** Convenience for the many places holding the wire representation. */
export function formatByteString(text: string | undefined): string {
  return formatBytes(parseByteCount(text));
}

/**
 * A ratio of two 64-bit counts as a `number`, without overflowing either.
 *
 * Scales by a thousand in integer arithmetic first, so the division happens on
 * values that fit a double even when the operands do not.
 */
export function ratioOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  if (part >= whole) return 1;
  return Number((part * 100000n) / whole) / 100000;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const percent = Math.min(100, ratio * 100);
  // Below one percent a large transfer would read 0% for minutes. One decimal
  // there, none above, so the number changes at a rate a person can follow.
  return percent < 1 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(BigInt(Math.round(bytesPerSecond)))}/s`;
}

/* --------------------------------------------------------------------- ETA */

export interface RateSample {
  atMs: number;
  bytes: bigint;
}

export interface RateReading {
  /** Original bytes per second across the whole window. Null until measurable. */
  bytesPerSecond: number | null;
  /**
   * Seconds remaining, or null while the estimate is not yet trustworthy.
   *
   * Null is the honest answer for the first several seconds of every transfer
   * and this module will keep returning it rather than show a number that is
   * about to halve.
   */
  etaSeconds: number | null;
  /** How many samples the window currently holds. Diagnostic, and asserted. */
  samples: number;
  /** Why an ETA is being withheld, when one is. */
  withheld: 'TOO_FEW_SAMPLES' | 'WINDOW_TOO_SHORT' | 'RATE_UNSTABLE' | 'NOT_MOVING' | null;
}

/**
 * Samples required before a rate is reported at all.
 *
 * At the 500 ms poll the transfer screen uses, four samples is 1.5 seconds of
 * observation - long enough that the first frame's encode cost is no longer the
 * whole measurement.
 */
export const MIN_RATE_SAMPLES = 4;

/** Samples required before a *remaining time* is reported. */
export const MIN_ETA_SAMPLES = 10;

/** Wall time the window must span before an ETA is offered. */
export const MIN_ETA_WINDOW_MS = 6_000;

/**
 * How far the recent half of the window may drift from the whole before the
 * estimate is withheld.
 *
 * 0.35 is deliberately loose. The purpose is not to detect small variation - an
 * optical link jitters by construction - but to refuse an ETA while the rate is
 * still an order of magnitude away from where it will settle, which is exactly
 * the first few seconds of a transfer and any moment after a long hold.
 */
export const ETA_STABILITY_TOLERANCE = 0.35;

/**
 * A bounded window of progress samples, and the estimates derived from it.
 *
 * The window is trimmed by *time* rather than by count, so the estimate a
 * one-hour transfer shows is about its last half-minute rather than its whole
 * history - a transfer that started slowly and sped up should not keep paying
 * for the slow part.
 */
export class EtaEstimator {
  private readonly samples: RateSample[] = [];

  constructor(
    private readonly windowMs = 30_000,
    private readonly minSamples = MIN_RATE_SAMPLES,
    private readonly minEtaSamples = MIN_ETA_SAMPLES,
    private readonly minEtaWindowMs = MIN_ETA_WINDOW_MS,
    private readonly tolerance = ETA_STABILITY_TOLERANCE,
  ) {}

  /** Discards the window. Called on a hold, so the pause is not measured as slowness. */
  reset(): void {
    this.samples.length = 0;
  }

  observe(atMs: number, bytes: bigint): void {
    const last = this.samples[this.samples.length - 1];
    // A repeated poll that saw no movement is still a sample - it is how a
    // stalled transfer becomes visible - but time must not run backwards.
    if (last && atMs <= last.atMs) return;
    this.samples.push({ atMs, bytes });
    const cutoff = atMs - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].atMs < cutoff) this.samples.shift();
  }

  read(totalBytes: bigint): RateReading {
    const count = this.samples.length;
    if (count < this.minSamples) {
      return { bytesPerSecond: null, etaSeconds: null, samples: count, withheld: 'TOO_FEW_SAMPLES' };
    }

    const first = this.samples[0];
    const last = this.samples[count - 1];
    const spanMs = last.atMs - first.atMs;
    const moved = last.bytes - first.bytes;
    if (spanMs <= 0 || moved <= 0n) {
      return { bytesPerSecond: 0, etaSeconds: null, samples: count, withheld: 'NOT_MOVING' };
    }

    const bytesPerSecond = (Number(moved) * 1000) / spanMs;
    const remaining = totalBytes - last.bytes;

    if (count < this.minEtaSamples) {
      return { bytesPerSecond, etaSeconds: null, samples: count, withheld: 'TOO_FEW_SAMPLES' };
    }
    if (spanMs < this.minEtaWindowMs) {
      return { bytesPerSecond, etaSeconds: null, samples: count, withheld: 'WINDOW_TOO_SHORT' };
    }

    // The recent half, compared against the whole. Two readings of the same
    // window that disagree mean the transfer has not settled, and an ETA from
    // an unsettled rate is the number that halves while someone watches it.
    const midpoint = this.samples[Math.floor(count / 2)];
    const recentSpanMs = last.atMs - midpoint.atMs;
    const recentMoved = last.bytes - midpoint.bytes;
    if (recentSpanMs <= 0) {
      return { bytesPerSecond, etaSeconds: null, samples: count, withheld: 'RATE_UNSTABLE' };
    }
    const recentRate = (Number(recentMoved) * 1000) / recentSpanMs;
    const drift = Math.abs(recentRate - bytesPerSecond) / bytesPerSecond;
    if (!Number.isFinite(drift) || drift > this.tolerance) {
      return { bytesPerSecond, etaSeconds: null, samples: count, withheld: 'RATE_UNSTABLE' };
    }

    if (remaining <= 0n) {
      return { bytesPerSecond, etaSeconds: 0, samples: count, withheld: null };
    }
    // The recent rate, not the window rate: it is the one the remaining bytes
    // will actually be sent at, and the stability check above is what earns the
    // right to trust it.
    return {
      bytesPerSecond,
      etaSeconds: Number(remaining) / recentRate,
      samples: count,
      withheld: null,
    };
  }
}

/* ---------------------------------------------------- optical throughput */

/**
 * Bytes per second actually handed to the display, over a short moving window.
 *
 * `EtaEstimator` measures *source coverage*, which is the right denominator
 * for a remaining-time estimate — and exactly the wrong signal once the first
 * pass is over. The recovery tail keeps putting fresh frames on screen while
 * coverage stands still, so a rate derived from coverage flatlines to "—" at
 * the precise moment the transfer is most active.
 *
 * This meter samples `bytesOnTheWire` instead — every byte handed to the
 * display, headers and repair and recovery frames included — so it keeps
 * climbing for as long as symbols are being emitted, whatever phase is
 * producing them. It reports `null` until it has a window, and a hold resets
 * it, so paused time is never measured as throughput.
 */
export class OpticalRateMeter {
  private readonly samples: RateSample[] = [];

  constructor(
    /** How much wall time one reading spans. Shorter than the ETA window on purpose. */
    private readonly windowMs = 10_000,
    private readonly minSamples = 3,
  ) {}

  /** Discards the window. Called on a hold beside `EtaEstimator.reset()`. */
  reset(): void {
    this.samples.length = 0;
  }

  observe(atMs: number, wireBytes: bigint): void {
    const last = this.samples[this.samples.length - 1];
    if (last && atMs <= last.atMs) return;
    this.samples.push({ atMs, bytes: wireBytes });
    const cutoff = atMs - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].atMs < cutoff) this.samples.shift();
  }

  /** Mean bytes per second across the window, or null until there is one. */
  read(): number | null {
    if (this.samples.length < this.minSamples) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const spanMs = last.atMs - first.atMs;
    if (spanMs <= 0) return null;
    const moved = last.bytes - first.bytes;
    if (moved <= 0n) return null;
    return (Number(moved) * 1000) / spanMs;
  }
}

/* ------------------------------------------------------- recovery wording */

/**
 * The Remaining cell, aware of which phase the sender is in.
 *
 * During the pass this is the estimator's own honest answer, including its
 * refusal to guess early. During the recovery tail there is no finite
 * denominator left to estimate against — the tail ends when the receiver says
 * so, and the sender cannot hear it — so any number here would be invented.
 * Naming the wait is the only truthful entry.
 *
 * `tailActive` is the screen's own phase witness, which can lead the polled
 * progress view by up to one sampling period. It wins whenever it is set:
 * a Remaining cell that said "Waiting for frames" under an eyebrow announcing
 * recovery frames was exactly the contradiction this module exists to prevent,
 * and the two witnesses must never be allowed to disagree on it.
 */
export function remainingCopy(readout: TransferReadout | null, reading: RateReading, tailActive?: boolean): string {
  if (tailActive || readout?.recovering) return 'Awaiting receiver';
  return etaCopy(reading);
}

/**
 * One line that says what the recovery tail is doing, in counts not claims.
 *
 * Deliberately no percentage anywhere in it: the source set is fully emitted,
 * the tail is open-ended by design, and a single overall percent would have to
 * be fabricated against a denominator nobody has. The receiver's verification
 * remains the only completion this screen may point at, and it says whose it is.
 */
export function recoveryStatusLine(readout: TransferReadout): string {
  return `Source data fully sent · Recovery frames sent: ${readout.recoverySymbolsEmitted.toLocaleString()} · Waiting for the receiving device to verify`;
}

/* --------------------------------------------------------------- preflight */

export interface CompressionSummary {
  /** True when the segments carry compressed bytes. */
  active: boolean;
  /** Short label for the file card. */
  label: string;
  /** One sentence explaining the decision in the user's terms. */
  detail: string;
  /** `transportSize / originalSize`, as a percentage string, when compressed. */
  ratioText: string | null;
}

/**
 * Turns a compression decision into something a person can act on.
 *
 * The reason codes are the sender's own policy vocabulary and every one of them
 * is answered here, because the interesting case is not the successful one: a
 * user watching a 4 GiB video transfer at its full size wants to know that the
 * receiver is not going to be waiting an extra hour for nothing, and
 * `BELOW_THRESHOLD` is the sentence that says so.
 */
export function summarizeCompression(metadata: StreamingTransferMetadata): CompressionSummary {
  const compressed = metadata.compressionMode === V2_COMPRESSION.GZIP;
  const ratioText = compressed && metadata.compressionRatio > 0
    ? formatPercent(metadata.compressionRatio)
    : null;

  if (compressed) {
    return {
      active: true,
      label: 'Compressed for transfer',
      detail: ratioText
        ? `The optical stream carries ${ratioText} of the original size, so it finishes sooner. The receiver expands it and checks the original file's hash.`
        : 'The optical stream carries compressed bytes. The receiver expands them and checks the original file’s hash.',
      ratioText,
    };
  }

  switch (metadata.compressionReason) {
    case COMPRESSION_REASON.MEASURED_BELOW_THRESHOLD:
      return {
        active: false,
        label: 'Sent uncompressed',
        detail: 'A full measuring pass found the saving too small to be worth it. The file is sent as it is.',
        ratioText: null,
      };
    case COMPRESSION_REASON.BELOW_THRESHOLD:
      return {
        active: false,
        label: 'Sent uncompressed',
        detail: 'These bytes do not compress usefully, so nothing is gained by trying. The file is sent as it is.',
        ratioText: null,
      };
    case COMPRESSION_REASON.TOO_SMALL:
      return {
        active: false,
        label: 'Sent uncompressed',
        detail: 'The file is small enough that compressing it would not shorten the transfer.',
        ratioText: null,
      };
    case COMPRESSION_REASON.DISABLED:
      return {
        active: false,
        label: 'Compression off',
        detail: 'Compression is switched off for this transfer. The file is sent as it is.',
        ratioText: null,
      };
    default:
      return {
        active: false,
        label: 'Sent uncompressed',
        detail: 'The file is sent exactly as it is on disk.',
        ratioText: null,
      };
  }
}

/**
 * The estimated time the optical link needs for this transfer, before it starts.
 *
 * A *nominal* figure and labelled as one wherever it is drawn. It divides the
 * transport size by the profile's nominal byte rate and knows nothing about the
 * receiver, the lighting, or how steady the phone is - which is why the live
 * screen replaces it with a measured rate as soon as one exists.
 */
export function nominalTransferSeconds(
  transportSizeBytes: bigint,
  nominalBytesPerSecond: number,
): number | null {
  if (!Number.isFinite(nominalBytesPerSecond) || nominalBytesPerSecond <= 0) return null;
  if (transportSizeBytes <= 0n) return 0;
  return Number(transportSizeBytes) / nominalBytesPerSecond;
}

/* ---------------------------------------------------------------- progress */

export interface TransferReadout {
  /** Original bytes the receiver will end up with. */
  originalTotal: bigint;
  /** Original bytes this pass has covered. */
  originalCovered: bigint;
  /** Bytes the segments carry. Differs from the original only under compression. */
  transportTotal: bigint;
  transportCovered: bigint;
  /** Everything actually put on the wire, repair symbols included. */
  wireBytes: bigint;
  /** Fraction of the transport stream covered, 0..1. */
  fraction: number;
  /** One-based segment position, for `x of y`. */
  segmentPosition: number;
  segmentCount: number;
  /** Repair symbols as a fraction of all payload symbols emitted. */
  repairFraction: number;
  complete: boolean;
  /**
   * True while the recovery tail is producing.
   *
   * This is the sender-side phase, not a receiver fact: it means every source
   * frame has been shown at least once and fresh symbols are still going up.
   * It is what entitles the screen to stop calling the operation a percentage
   * and start calling it a wait.
   */
  recovering: boolean;
  /** Recovery-tail symbols emitted so far, counted apart from the pass. */
  recoverySymbolsEmitted: number;
  /** True when this pass began partway into the file. */
  resumed: boolean;
  /** Segments the resume skipped. Zero for a fresh transfer. */
  resumeFromSegment: number;
}

/**
 * Reads a progress view into the numbers the screens draw.
 *
 * `originalCovered` is derived from the transport fraction rather than reported
 * directly, and that is a real approximation worth naming: under compression
 * the sender knows how much of the *container* it has emitted, not which
 * original byte that lands on, because the window records are variable length.
 * The two agree exactly when nothing is compressed, and the segment counter -
 * which is exact in both modes - is what the screen leads with.
 */
export function readTransfer(progress: StreamingProgressView): TransferReadout {
  const originalTotal = parseByteCount(progress.originalBytesTotal);
  const transportTotal = parseByteCount(progress.transportBytesTotal);
  const transportCovered = parseByteCount(progress.transportBytesCovered);
  const fraction = ratioOf(transportCovered, transportTotal);

  const originalCovered = transportTotal === transportCovered
    ? originalTotal
    : transportTotal > 0n
      ? (originalTotal * transportCovered) / transportTotal
      : 0n;

  const payloadSymbols = progress.sourceSymbolsEmitted + progress.repairSymbolsEmitted;

  return {
    originalTotal,
    originalCovered,
    transportTotal,
    transportCovered,
    wireBytes: parseByteCount(progress.bytesOnTheWire),
    fraction,
    // `currentSegmentIndex` is zero-based and stays at the last segment once the
    // pass finishes, so the displayed position is clamped rather than allowed to
    // read "segment 41 of 40".
    segmentPosition: progress.segmentCount === 0
      ? 0
      : Math.min(progress.segmentCount, progress.currentSegmentIndex + 1),
    segmentCount: progress.segmentCount,
    repairFraction: payloadSymbols > 0 ? progress.repairSymbolsEmitted / payloadSymbols : 0,
    complete: progress.complete,
    recovering: progress.recovering,
    recoverySymbolsEmitted: progress.recoverySymbolsEmitted,
    resumed: progress.resumeFromSegment > 0,
    resumeFromSegment: progress.resumeFromSegment,
  };
}

/**
 * The one line of copy under the progress bar.
 *
 * Deliberately not a percentage repeated in words. The percentage is already on
 * screen; what it does not say is which of the two sizes is moving, and under
 * compression those differ by a factor of four.
 */
export function progressSummary(readout: TransferReadout, compressed: boolean): string {
  const original = `${formatBytes(readout.originalCovered)} of ${formatBytes(readout.originalTotal)}`;
  if (!compressed) return original;
  return `${original} · ${formatBytes(readout.transportCovered)} of ${formatBytes(readout.transportTotal)} on the optical link`;
}

/**
 * Remaining-time copy, including the case where there is no estimate yet.
 *
 * The waiting text is not a placeholder dash. Several minutes of a long
 * transfer are spent here, and "Measuring" is the difference between a screen
 * that is working and a screen that looks broken.
 */
export function etaCopy(reading: RateReading): string {
  if (reading.etaSeconds !== null) {
    return reading.etaSeconds <= 1 ? 'Any moment' : `About ${formatDuration(reading.etaSeconds * 1000)} left`;
  }
  return reading.withheld === 'NOT_MOVING' ? 'Waiting for frames' : 'Measuring rate…';
}
