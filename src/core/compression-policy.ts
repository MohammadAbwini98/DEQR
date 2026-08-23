/**
 * Whether to compress a transfer, decided from bytes and nothing else.
 *
 * Phase 00 established the fact this module exists to enforce: a file's
 * extension tells you nothing about its entropy. A `.txt` holding base64 of a
 * JPEG is incompressible; a `.zip` holding one stored (uncompressed) member is
 * not. Deciding transport from the name is therefore not a shortcut, it is a
 * wrong answer that happens to be right often enough to hide.
 *
 * So the decision function below **cannot** see a filename. There is no
 * parameter for one, no MIME type, and no path - which makes the program rule
 * (".txt, .pdf, .zip, .xlsx, .exe and random binary follow the same raw
 * transport path") a property of the type signature rather than a promise in a
 * comment. `tests/core/compression-policy.test.ts` asserts exactly that.
 *
 * ## The two decisions, and why there are two
 *
 * A sample of three bounded windows is cheap - a quarter of a megabyte each,
 * read during preflight, gzipped and thrown away. It is also only a sample, and
 * a file whose first, middle and last quarter-megabyte are text can still be
 * mostly video.
 *
 * So the sample decides whether it is worth **trying**, and the full sizing
 * pass - which the sender runs fused into the SHA-256 pass it already had to
 * make - decides whether to **use** it. Both go through the same threshold and
 * the same module. A sample that guesses wrong therefore costs preflight time
 * and can never cost transport correctness: `MEASURED_BELOW_THRESHOLD` is a
 * real outcome and the sender falls back to sending the original bytes.
 *
 * ## Why the threshold is not zero
 *
 * Compression that saves 1% is not free. It costs a second full pass over the
 * file on the sender, a decompression pass and a second file's worth of space
 * on the receiver, and it makes a corrupt transport stream a decompression
 * failure rather than a hash failure. Below a threshold, the honest thing is to
 * send the bytes. The plan asks for ~8-10%; the default here is 10% and it is
 * configurable, which is what lets a benchmark move it rather than an argument.
 */

import { V2_MIN_GZIP_MEMBER_BYTES, V2_WINDOW_LENGTH_PREFIX_BYTES } from './protocol-v2.js';

/* ---------------------------------------------------------------- framing */

/**
 * Bytes DEQR adds per compressed window, on top of the deflate stream.
 *
 * Four for the length prefix that makes each window independently delimited on
 * the receiver, plus a gzip member's own 10-byte header and 8-byte trailer.
 * At the 1 MiB default window this is 0.002% of the window - but at the 64 KiB
 * minimum it is 0.03%, and a threshold that ignored it would be reporting a
 * gain the wire never sees.
 *
 * Both terms come from `protocol-v2.ts` rather than being restated here: the
 * container's shape is the protocol's to define, and a prediction made against
 * a stale copy of it would be a prediction about a wire format that does not
 * exist. It is a floor, so the real framing is a byte or two larger per window
 * - which the measured sizing pass replaces before anything is transmitted.
 */
export const WINDOW_FRAMING_BYTES = V2_WINDOW_LENGTH_PREFIX_BYTES + V2_MIN_GZIP_MEMBER_BYTES;

/* ------------------------------------------------------------- thresholds */

/**
 * Minimum fraction of the original bytes compression must remove to be used.
 *
 * Read as: a predicted transport size of 0.90 x original sits exactly on the
 * threshold and is accepted; 0.91 is refused. The Phase 08 report carries the
 * measurement behind the value.
 */
export const DEFAULT_COMPRESSION_THRESHOLD = 0.1;

/**
 * Below this, compression is not attempted at all.
 *
 * Not a performance guard - it is that a gain expressed as a percentage of a
 * few kilobytes is noise, and one QR symbol already carries about a kilobyte.
 * A file this small is a handful of frames either way.
 */
export const MIN_COMPRESSIBLE_BYTES = 64 * 1024;

/* ------------------------------------------------------------------ model */

export const COMPRESSION_REASON = {
  /** Compression was switched off by configuration. */
  DISABLED: 'DISABLED',
  /** Nothing was sampled, so there is no evidence to act on. */
  NO_SAMPLE: 'NO_SAMPLE',
  /** The file is too small for the decision to be worth making. */
  TOO_SMALL: 'TOO_SMALL',
  /** Sampled gain is below the threshold. Incompressible bytes land here. */
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
  /** Sampled gain clears the threshold. Worth a full sizing pass. */
  ABOVE_THRESHOLD: 'ABOVE_THRESHOLD',
  /** The whole-file measurement disagreed with the sample. Send original bytes. */
  MEASURED_BELOW_THRESHOLD: 'MEASURED_BELOW_THRESHOLD',
  /** The whole-file measurement confirmed the sample. Send compressed bytes. */
  MEASURED_ABOVE_THRESHOLD: 'MEASURED_ABOVE_THRESHOLD',
} as const;
export type CompressionReason = (typeof COMPRESSION_REASON)[keyof typeof COMPRESSION_REASON];

export interface CompressibilitySample {
  /** Original bytes fed to the sampler across all of its windows. */
  inputBytes: number;
  /** Compressed bytes it produced, framing excluded. */
  outputBytes: number;
  /** Wall-clock cost of the sampling, for the CPU side of the record. */
  elapsedMs: number;
}

export interface CompressionDecision {
  compress: boolean;
  reason: CompressionReason;
  /** Compressed over original across the sampled windows, framing excluded. */
  sampledRatio: number;
  /** The same ratio with this transfer's per-window framing added back. */
  predictedRatio: number;
  /** `1 - predictedRatio`. Negative when compression would expand the file. */
  predictedGain: number;
  threshold: number;
}

export interface CompressionPolicyOptions {
  /** Minimum gain, as a fraction of the original size. Default 0.10. */
  threshold?: number;
  /** Original bytes per independently compressed window. */
  windowBytes: number;
  /** Set false to refuse compression whatever the bytes say. */
  enabled?: boolean;
  /** Files below this are never compressed. Default 64 KiB. */
  minimumBytes?: number;
}

/* -------------------------------------------------------------- functions */

/**
 * The largest a single window's compressed record can legitimately be.
 *
 * zlib's own `compressBound`: deflate can *expand* incompressible input, by
 * about one part in four thousand, and a window of random bytes does exactly
 * that. Adding the gzip member's 18 bytes and DEQR's 4-byte prefix gives the
 * ceiling a receiver checks a declared record length against **before it
 * allocates anything** - which is the difference between refusing a hostile
 * length and trying to honour it.
 */
export function maxCompressedWindowBytes(windowBytes: number): number {
  const compressBound = windowBytes
    + (windowBytes >> 12)
    + (windowBytes >> 14)
    + (windowBytes >> 25)
    + 13;
  return compressBound + V2_MIN_GZIP_MEMBER_BYTES + V2_WINDOW_LENGTH_PREFIX_BYTES;
}

/** Independently compressed windows an original size is divided into. */
export function windowCountFor(originalSize: number, windowBytes: number): number {
  if (!Number.isFinite(originalSize) || originalSize <= 0) return 0;
  if (!Number.isInteger(windowBytes) || windowBytes <= 0) return 0;
  return Math.ceil(originalSize / windowBytes);
}

/** Bytes the window container adds to a transfer of this size. */
export function framingOverheadBytes(originalSize: number, windowBytes: number): number {
  return windowCountFor(originalSize, windowBytes) * WINDOW_FRAMING_BYTES;
}

/**
 * What the transport stream is expected to weigh at a given compression ratio.
 *
 * Deliberately a prediction and not a promise: it is what the *decision* is
 * made against, and the sender replaces it with the measured total before a
 * manifest is written. Nothing downstream ever sees this number.
 */
export function predictedTransportSize(
  originalSize: number,
  sampledRatio: number,
  windowBytes: number,
): number {
  const payload = Math.ceil(originalSize * sampledRatio);
  return payload + framingOverheadBytes(originalSize, windowBytes);
}

/**
 * The whole decision, from a bounded sample and a size.
 *
 * Note what is absent from the parameters: a name, an extension, a MIME type, a
 * path. That absence is the phase's central rule, expressed where it cannot be
 * forgotten.
 */
export function decideCompression(
  originalSize: number,
  sample: CompressibilitySample,
  options: CompressionPolicyOptions,
): CompressionDecision {
  const threshold = normalizeThreshold(options.threshold);
  const minimumBytes = options.minimumBytes ?? MIN_COMPRESSIBLE_BYTES;
  const inert = { sampledRatio: 1, predictedRatio: 1, predictedGain: 0, threshold };

  if (options.enabled === false) {
    return { ...inert, compress: false, reason: COMPRESSION_REASON.DISABLED };
  }
  if (!Number.isFinite(originalSize) || originalSize < minimumBytes) {
    return { ...inert, compress: false, reason: COMPRESSION_REASON.TOO_SMALL };
  }
  if (!(sample.inputBytes > 0) || !(sample.outputBytes >= 0)) {
    return { ...inert, compress: false, reason: COMPRESSION_REASON.NO_SAMPLE };
  }

  const sampledRatio = sample.outputBytes / sample.inputBytes;
  const predicted = predictedTransportSize(originalSize, sampledRatio, options.windowBytes);
  const predictedRatio = predicted / originalSize;
  const predictedGain = 1 - predictedRatio;
  const compress = predictedGain >= threshold;

  return {
    compress,
    reason: compress ? COMPRESSION_REASON.ABOVE_THRESHOLD : COMPRESSION_REASON.BELOW_THRESHOLD,
    sampledRatio,
    predictedRatio,
    predictedGain,
    threshold,
  };
}

/**
 * The same threshold applied to the measured whole-file total.
 *
 * The sample can be wrong in both directions and this is where that is caught.
 * It takes the real transport size, framing included, because by the time it is
 * called the sender has counted every byte it would put on the wire.
 */
export function confirmCompression(
  originalSize: number,
  measuredTransportSize: number,
  options: Pick<CompressionPolicyOptions, 'threshold'> = {},
): CompressionDecision {
  const threshold = normalizeThreshold(options.threshold);
  const predictedRatio = originalSize > 0 ? measuredTransportSize / originalSize : 1;
  const predictedGain = 1 - predictedRatio;
  const compress = predictedGain >= threshold;
  return {
    compress,
    reason: compress
      ? COMPRESSION_REASON.MEASURED_ABOVE_THRESHOLD
      : COMPRESSION_REASON.MEASURED_BELOW_THRESHOLD,
    sampledRatio: predictedRatio,
    predictedRatio,
    predictedGain,
    threshold,
  };
}

function normalizeThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_COMPRESSION_THRESHOLD;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
