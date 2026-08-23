/**
 * DEQR v2 optical frame protocol.
 *
 * v1 (`src/core/protocol.ts`) carries the source-block count in a 16-bit field
 * against a fixed 512-byte block, which caps a whole transfer at 33,553,920
 * bytes and cannot be widened from inside — see
 * `.ai-team/reports/performance/PHASE-00-AUDIT.md`. v2 replaces that model
 * rather than stretching it: a one-time session manifest carries the expensive
 * metadata, and compact data frames carry a segment index and a symbol
 * identity, so decoder state is bounded by a segment instead of by the file.
 *
 * Design rules this module holds to:
 *
 * - **Binary and big-endian throughout.** No JSON, no Base64, no
 *   platform-native struct layout on any optical path.
 * - **64-bit sizes are `bigint`.** File sizes and byte offsets are never
 *   converted to `number` except through `toSafeNumber`, which refuses above
 *   `Number.MAX_SAFE_INTEGER` instead of silently rounding.
 * - **Nothing is allocated or sliced from an untrusted length before that
 *   length has been checked** against both the declared frame and the buffer
 *   actually received.
 * - **The parser never throws.** Every malformed input becomes a typed
 *   failure, which is what makes the parser fuzzable. The serializer does
 *   throw, because feeding it an invalid model is a defect on our side.
 * - **v1 is never reinterpreted as v2.** A v1 frame is detected and reported as
 *   such, so a version mix-up cannot present as corruption.
 * - **No `Buffer` and no Node built-ins**, so the Electron sender and the iOS
 *   PWA receiver share one codec instead of maintaining two that drift.
 *
 * The CRC-32 in every frame exists for fast rejection of damaged optical reads.
 * SHA-256 over the reconstructed original file remains the sole authority on
 * file identity.
 */

import { crc32 } from './crc32.js';
import { sanitizeFilename } from './filename-sanitizer.js';

/* ------------------------------------------------------------------ identity */

/** `'D'` — first magic byte. A v1 frame starts with 0x01, so the two never collide. */
export const V2_MAGIC_0 = 0x44;
/** `'2'` — second magic byte. */
export const V2_MAGIC_1 = 0x32;
export const V2_PROTOCOL_VERSION = 2;

export const V2_FRAME_TYPE = {
  MANIFEST: 0x01,
  SOURCE: 0x02,
  REPAIR: 0x03,
} as const;
export type V2FrameType = (typeof V2_FRAME_TYPE)[keyof typeof V2_FRAME_TYPE];

export const V2_COMPRESSION = {
  NONE: 0x00,
  GZIP: 0x01,
} as const;
export type V2CompressionMode = (typeof V2_COMPRESSION)[keyof typeof V2_COMPRESSION];

/**
 * The GZIP transport container, and why it is a container rather than a stream.
 *
 * In `GZIP` mode the transport stream is not one gzip stream over the file. It
 * is a sequence of **window records**, one per fixed-size run of original
 * bytes:
 *
 * ```text
 * record[j] := u32BE compressedLength || gzip member of window j
 * window j  := original bytes [j * windowBytes, min((j+1) * windowBytes, originalSize))
 * ```
 *
 * Three properties come out of that shape, and each one is load-bearing:
 *
 * - **Every member is delimited before it is decoded.** The receiver reads a
 *   length, hands exactly that many bytes to one decompressor, and requires
 *   exactly the window's original length back. A decompression bomb has
 *   nowhere to expand into: the bound is a manifest-derived constant, not a
 *   number taken from the stream.
 * - **The sender can seek.** Resuming at segment 4,000 means recompressing one
 *   window, not the four gigabytes before it, because windows do not share a
 *   deflate history.
 * - **No dependence on multi-member gzip.** Concatenated gzip members are legal
 *   and widely supported, but "widely" is not a contract, and a receiver that
 *   guessed wrong about a browser's `DecompressionStream` would find out on a
 *   user's phone. Explicit lengths remove the question.
 *
 * `compressionParam` carries log2 of `windowBytes`, so the window is a power of
 * two between 64 KiB and 64 MiB. The lower bound keeps per-window framing under
 * a thousandth of the payload; the upper bound keeps the receiver's
 * decompression buffer bounded by something a phone can hold.
 */
export const V2_COMPRESSION_WINDOW = {
  minLog2: 16,
  maxLog2: 26,
  /** 1 MiB. Large enough that framing vanishes, small enough to reseek cheaply. */
  defaultLog2: 20,
} as const;

/** `u32BE` length prefix in front of every gzip member. */
export const V2_WINDOW_LENGTH_PREFIX_BYTES = 4;

/**
 * Smallest possible gzip member: a 10-byte header and an 8-byte trailer.
 *
 * Used only as a lower bound when checking that a declared `transportSize`
 * could physically hold the number of windows the manifest implies. A floor,
 * never an estimate.
 */
export const V2_MIN_GZIP_MEMBER_BYTES = 18;


export const V2_FEC_PROFILE = {
  /** Systematic-first LT with the robust soliton distribution v1 already ships. */
  LT_SYSTEMATIC_ROBUST_SOLITON_V1: 0x01,
} as const;
export type V2FecProfile = (typeof V2_FEC_PROFILE)[keyof typeof V2_FEC_PROFILE];

/**
 * Flag words split into an advisory half and a critical half.
 *
 * A receiver that meets an unknown **advisory** bit ignores it and carries on;
 * that is what lets a later revision add optional behaviour without breaking
 * this one. An unknown **critical** bit means the frame cannot be understood
 * and is rejected. Both halves are zero in this revision.
 */
export const V2_FLAG_ADVISORY_MASK = 0x00ff;
export const V2_FLAG_CRITICAL_MASK = 0xff00;

/* -------------------------------------------------------------------- limits */

export const V2_LIMITS = {
  /** Sanitized UTF-8 filename. At least one byte: an unnamed transfer is not useful. */
  minFilenameBytes: 1,
  maxFilenameBytes: 1_024,
  /** Advisory only. A receiver must never let it influence handling. */
  maxMimeBytes: 255,
  /**
   * Source-symbol payload size. The upper bound is the practical byte-mode
   * capacity of a single QR symbol; Phase 04 picks the operating value from
   * measured throughput rather than from this ceiling.
   */
  minSymbolSizeBytes: 32,
  maxSymbolSizeBytes: 4_096,
  /** Segment size bounds the decoder's working set, so it is bounded here too. */
  minSegmentSizeBytes: 64 * 1024,
  maxSegmentSizeBytes: 64 * 1024 * 1024,
  /** `segmentIndex` and `segmentCount` are u32. */
  maxSegmentCount: 0xffff_ffff,
  /** `symbolId` and `sourceSymbolCount` are u32. */
  maxSymbolsPerSegment: 0xffff_ffff,
  /** `originalSize` and `transportSize` are u64. */
  maxFileBytes: (1n << 64n) - 1n,
} as const;

/** Byte offsets of the manifest frame. Big-endian throughout. */
export const V2_MANIFEST_LAYOUT = {
  magic0: 0,
  magic1: 1,
  version: 2,
  frameType: 3,
  featureFlags: 4,
  sessionId: 6,
  fileId: 10,
  originalSize: 14,
  transportSize: 22,
  segmentSizeBytes: 30,
  symbolSizeBytes: 34,
  segmentCount: 36,
  fecProfileId: 40,
  compressionMode: 41,
  compressionParam: 42,
  transportProfileId: 43,
  sha256: 44,
  filenameLength: 76,
  filename: 78,
  /** Fixed bytes before the variable-length filename. */
  fixedPrefixBytes: 78,
  /** Fixed bytes outside the two variable-length fields, CRC included. */
  fixedTotalBytes: 84,
} as const;

/** Byte offsets of a source or repair data frame. Big-endian throughout. */
export const V2_DATA_LAYOUT = {
  magic0: 0,
  magic1: 1,
  version: 2,
  frameType: 3,
  sessionId: 4,
  fileId: 8,
  segmentIndex: 12,
  symbolId: 16,
  sourceSymbolCount: 20,
  payloadLength: 24,
  frameFlags: 26,
  payload: 28,
  headerBytes: 28,
  crcBytes: 4,
  /** Header plus CRC; add the payload length for the whole frame. */
  overheadBytes: 32,
} as const;

/* --------------------------------------------------------------------- model */

export interface DeqrV2Manifest {
  /** Advisory bits 0-7, critical bits 8-15. Zero in this revision. */
  featureFlags: number;
  sessionId: number;
  fileId: number;
  /** Size of the original file, before any compression. */
  originalSize: bigint;
  /** Bytes actually placed into segments. Equal to `originalSize` when uncompressed. */
  transportSize: bigint;
  segmentSizeBytes: number;
  symbolSizeBytes: number;
  segmentCount: number;
  fecProfileId: number;
  compressionMode: number;
  /** Profile-defined. Must be 0 when `compressionMode` is NONE. */
  compressionParam: number;
  /**
   * Which named optical transport profile the sender is using.
   *
   * **Advisory in both directions.** Nothing about decoding reads it:
   * `symbolSizeBytes`, `segmentSizeBytes` and `fecProfileId` already carry
   * everything a receiver needs, and this only says which named combination of
   * them the sender picked. It exists so a receiver can report the profile, and
   * so a benchmark can be attributed to one.
   *
   * `0` means unspecified, which is what every manifest written before Phase 04
   * says. An unrecognised value is reported as unknown and never rejected - see
   * `PROTOCOL-V2.md` section 4.4.
   */
  transportProfileId: number;
  /** 32 bytes, over the original file. */
  sha256: Uint8Array;
  filename: string;
  /** Advisory. May be empty. */
  mimeType: string;
}

export interface DeqrV2DataFrame {
  frameType: typeof V2_FRAME_TYPE.SOURCE | typeof V2_FRAME_TYPE.REPAIR;
  sessionId: number;
  fileId: number;
  segmentIndex: number;
  /**
   * For a SOURCE frame, the source-symbol index within the segment, always
   * below `sourceSymbolCount`. For a REPAIR frame, the generator seed, always
   * at or above `sourceSymbolCount` — the same systematic-first numbering v1
   * uses, so a symbol's role is readable from its identity alone.
   */
  symbolId: number;
  /** Source symbols in this segment. Repeated per frame so a receiver can
   * resynchronise and validate against the manifest without one in hand. */
  sourceSymbolCount: number;
  /** Advisory bits 0-7, critical bits 8-15. Zero in this revision. */
  frameFlags: number;
  payload: Uint8Array;
}

export type DeqrV2Frame =
  | { kind: 'manifest'; manifest: DeqrV2Manifest }
  | { kind: 'data'; frame: DeqrV2DataFrame };

/* --------------------------------------------------------------------- errors */

export type V2ErrorCode =
  | 'FRAME_TOO_SHORT'
  | 'TRAILING_BYTES'
  | 'BAD_MAGIC'
  | 'V1_FRAME'
  | 'UNSUPPORTED_VERSION'
  | 'UNKNOWN_FRAME_TYPE'
  | 'FRAME_TYPE_MISMATCH'
  | 'CRC_MISMATCH'
  | 'FIELD_OUT_OF_RANGE'
  | 'INCONSISTENT_MANIFEST'
  | 'UNSUPPORTED_CRITICAL_FEATURE'
  | 'UNSUPPORTED_COMPRESSION'
  | 'UNSUPPORTED_FEC_PROFILE'
  | 'INVALID_UTF8'
  | 'INVALID_FILENAME'
  | 'SESSION_MISMATCH'
  | 'SEGMENT_OUT_OF_RANGE'
  | 'SYMBOL_OUT_OF_RANGE'
  | 'PRECISION_LOSS';

export class DeqrV2Error extends Error {
  constructor(public readonly code: V2ErrorCode, message: string) {
    super(message);
    this.name = 'DeqrV2Error';
  }
}

export type V2Result<T> = { ok: true; value: T } | { ok: false; error: DeqrV2Error };

function fail(code: V2ErrorCode, message: string): { ok: false; error: DeqrV2Error } {
  return { ok: false, error: new DeqrV2Error(code, message) };
}

function reject(code: V2ErrorCode, message: string): never {
  throw new DeqrV2Error(code, message);
}

/* ------------------------------------------------------------ 64-bit safety */

/** True when a `bigint` can become a `number` without losing a unit. */
export function isSafeSize(value: bigint): boolean {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

/**
 * Converts a 64-bit value to `number`, refusing rather than rounding.
 *
 * Every place a size or offset crosses into `number` goes through here. A file
 * larger than 9 PiB is not a size DEQR expects, but silently losing the low
 * bits of an offset is the kind of defect that only shows up as a corrupted
 * transfer hours later.
 */
export function toSafeNumber(value: bigint, field: string): number {
  if (!isSafeSize(value)) {
    reject('PRECISION_LOSS', `${field} (${value}) cannot be represented as a JavaScript number without loss`);
  }
  return Number(value);
}

/* ---------------------------------------------------------------- utf-8 i/o */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Uint8Array, field: string): V2Result<string> {
  try {
    return { ok: true, value: utf8Decoder.decode(bytes) };
  } catch {
    return fail('INVALID_UTF8', `${field} is not valid UTF-8`);
  }
}

/* ---------------------------------------------------------------- segmenting */

export interface SegmentPlan {
  transportSize: bigint;
  segmentSizeBytes: number;
  symbolSizeBytes: number;
  segmentCount: number;
  /** Source symbols in every segment except possibly the last. */
  symbolsPerFullSegment: number;
  /** Transport bytes in the final segment; equals `segmentSizeBytes` when it divides evenly. */
  lastSegmentBytes: number;
  /** Source symbols in the final segment. */
  symbolsInLastSegment: number;
}

/**
 * Derives the segmentation a manifest describes.
 *
 * `segmentSizeBytes` must be a whole number of symbols. Requiring that keeps
 * every full segment's symbol count identical and its byte ranges exact, which
 * removes a class of off-by-one the v1 padding rules invited.
 *
 * Throws on an invalid plan: this is the sender's own configuration, not
 * untrusted input.
 */
export function planSegmentation(input: {
  transportSize: bigint;
  segmentSizeBytes: number;
  symbolSizeBytes: number;
}): SegmentPlan {
  const { transportSize, segmentSizeBytes, symbolSizeBytes } = input;

  if (typeof transportSize !== 'bigint' || transportSize < 1n || transportSize > V2_LIMITS.maxFileBytes) {
    reject('FIELD_OUT_OF_RANGE', `transportSize must be a bigint in 1..2^64-1, received ${transportSize}`);
  }
  if (!Number.isInteger(symbolSizeBytes)
    || symbolSizeBytes < V2_LIMITS.minSymbolSizeBytes
    || symbolSizeBytes > V2_LIMITS.maxSymbolSizeBytes) {
    reject('FIELD_OUT_OF_RANGE', `symbolSizeBytes must be an integer in ${V2_LIMITS.minSymbolSizeBytes}..${V2_LIMITS.maxSymbolSizeBytes}`);
  }
  if (!Number.isInteger(segmentSizeBytes)
    || segmentSizeBytes < V2_LIMITS.minSegmentSizeBytes
    || segmentSizeBytes > V2_LIMITS.maxSegmentSizeBytes) {
    reject('FIELD_OUT_OF_RANGE', `segmentSizeBytes must be an integer in ${V2_LIMITS.minSegmentSizeBytes}..${V2_LIMITS.maxSegmentSizeBytes}`);
  }
  if (segmentSizeBytes % symbolSizeBytes !== 0) {
    reject('FIELD_OUT_OF_RANGE', `segmentSizeBytes (${segmentSizeBytes}) must be a whole number of ${symbolSizeBytes}-byte symbols`);
  }

  const segmentSize = BigInt(segmentSizeBytes);
  const segmentCountBig = (transportSize + segmentSize - 1n) / segmentSize;
  if (segmentCountBig > BigInt(V2_LIMITS.maxSegmentCount)) {
    reject('FIELD_OUT_OF_RANGE', `transportSize ${transportSize} needs ${segmentCountBig} segments, above the u32 limit`);
  }
  const segmentCount = Number(segmentCountBig);

  const lastSegmentBytes = Number(transportSize - segmentSize * (segmentCountBig - 1n));
  const symbolsPerFullSegment = segmentSizeBytes / symbolSizeBytes;
  const symbolsInLastSegment = Math.ceil(lastSegmentBytes / symbolSizeBytes);

  if (symbolsPerFullSegment > V2_LIMITS.maxSymbolsPerSegment) {
    reject('FIELD_OUT_OF_RANGE', `a segment would hold ${symbolsPerFullSegment} symbols, above the u32 limit`);
  }

  return {
    transportSize,
    segmentSizeBytes,
    symbolSizeBytes,
    segmentCount,
    symbolsPerFullSegment,
    lastSegmentBytes,
    symbolsInLastSegment,
  };
}

/** Source-symbol count for one segment. */
export function sourceSymbolCountForSegment(plan: SegmentPlan, segmentIndex: number): number {
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= plan.segmentCount) {
    reject('SEGMENT_OUT_OF_RANGE', `segmentIndex ${segmentIndex} is outside 0..${plan.segmentCount - 1}`);
  }
  return segmentIndex === plan.segmentCount - 1 ? plan.symbolsInLastSegment : plan.symbolsPerFullSegment;
}

/**
 * Absolute transport-stream byte range of one segment.
 *
 * This is the "logical file offset" a data frame does not carry. Deriving it
 * from the manifest costs nothing and keeps eight bytes out of every QR symbol.
 */
export function segmentByteRange(plan: SegmentPlan, segmentIndex: number): { start: bigint; end: bigint } {
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= plan.segmentCount) {
    reject('SEGMENT_OUT_OF_RANGE', `segmentIndex ${segmentIndex} is outside 0..${plan.segmentCount - 1}`);
  }
  const start = BigInt(plan.segmentSizeBytes) * BigInt(segmentIndex);
  const end = segmentIndex === plan.segmentCount - 1
    ? plan.transportSize
    : start + BigInt(plan.segmentSizeBytes);
  return { start, end };
}

/** Absolute transport-stream byte range of one source symbol. */
export function symbolByteRange(
  plan: SegmentPlan,
  segmentIndex: number,
  symbolId: number,
): { start: bigint; end: bigint } {
  const symbolCount = sourceSymbolCountForSegment(plan, segmentIndex);
  if (!Number.isInteger(symbolId) || symbolId < 0 || symbolId >= symbolCount) {
    reject('SYMBOL_OUT_OF_RANGE', `symbolId ${symbolId} is outside 0..${symbolCount - 1} for segment ${segmentIndex}`);
  }
  const segment = segmentByteRange(plan, segmentIndex);
  const start = segment.start + BigInt(plan.symbolSizeBytes) * BigInt(symbolId);
  const end = start + BigInt(plan.symbolSizeBytes);
  return { start, end: end > segment.end ? segment.end : end };
}

/** The segmentation a parsed manifest describes. */
export function segmentPlanFromManifest(manifest: DeqrV2Manifest): SegmentPlan {
  return planSegmentation({
    transportSize: manifest.transportSize,
    segmentSizeBytes: manifest.segmentSizeBytes,
    symbolSizeBytes: manifest.symbolSizeBytes,
  });
}

/* ------------------------------------------------------ compression windows */

/** How the original bytes of a compressed transfer are divided into windows. */
export interface CompressionWindowPlan {
  windowBytes: number;
  windowCount: number;
  /** Original bytes in the final window; equals `windowBytes` when it divides evenly. */
  lastWindowBytes: number;
}

/** Window size a `compressionParam` describes. Throws on an out-of-range value. */
export function compressionWindowBytes(compressionParam: number): number {
  if (!Number.isInteger(compressionParam)
    || compressionParam < V2_COMPRESSION_WINDOW.minLog2
    || compressionParam > V2_COMPRESSION_WINDOW.maxLog2) {
    reject(
      'FIELD_OUT_OF_RANGE',
      `compressionParam must be a window exponent in ${V2_COMPRESSION_WINDOW.minLog2}..${V2_COMPRESSION_WINDOW.maxLog2}, received ${compressionParam}`,
    );
  }
  return 2 ** compressionParam;
}

/**
 * Divides an original size into compression windows.
 *
 * Derived from `originalSize`, never from `transportSize`: the windows describe
 * the file, and what each of them weighs on the wire is exactly the thing that
 * is not known until it has been compressed.
 */
export function planCompressionWindows(input: {
  originalSize: bigint;
  compressionParam: number;
}): CompressionWindowPlan {
  const windowBytes = compressionWindowBytes(input.compressionParam);
  const { originalSize } = input;
  if (typeof originalSize !== 'bigint' || originalSize < 1n || originalSize > V2_LIMITS.maxFileBytes) {
    reject('FIELD_OUT_OF_RANGE', `originalSize must be a bigint in 1..2^64-1, received ${originalSize}`);
  }

  const window = BigInt(windowBytes);
  const windowCountBig = (originalSize + window - 1n) / window;
  if (windowCountBig > BigInt(V2_LIMITS.maxSegmentCount)) {
    reject('FIELD_OUT_OF_RANGE', `originalSize ${originalSize} needs ${windowCountBig} windows, above the u32 limit`);
  }
  return {
    windowBytes,
    windowCount: Number(windowCountBig),
    lastWindowBytes: Number(originalSize - window * (windowCountBig - 1n)),
  };
}

/** The window plan a manifest describes, or null when it carries original bytes. */
export function windowPlanFromManifest(manifest: DeqrV2Manifest): CompressionWindowPlan | null {
  if (manifest.compressionMode === V2_COMPRESSION.NONE) return null;
  return planCompressionWindows({
    originalSize: manifest.originalSize,
    compressionParam: manifest.compressionParam,
  });
}

/**
 * Every rule that ties the four compression fields together, in one place.
 *
 * The serializer throws on what this returns and the parser fails on it, so a
 * manifest DEQR will not read is also a manifest DEQR cannot write. Keeping the
 * rules in one function is what makes that true by construction rather than by
 * two lists someone has to remember to update together.
 *
 * Returns null when the four fields are consistent.
 */
function compressionInconsistency(input: {
  compressionMode: number;
  compressionParam: number;
  originalSize: bigint;
  transportSize: bigint;
}): { code: V2ErrorCode; message: string } | null {
  const { compressionMode, compressionParam, originalSize, transportSize } = input;

  if (compressionMode !== V2_COMPRESSION.NONE && compressionMode !== V2_COMPRESSION.GZIP) {
    return { code: 'UNSUPPORTED_COMPRESSION', message: `compressionMode ${compressionMode} is not supported` };
  }
  if (!Number.isInteger(compressionParam) || compressionParam < 0 || compressionParam > 0xff) {
    return { code: 'FIELD_OUT_OF_RANGE', message: `compressionParam must be a u8, received ${compressionParam}` };
  }

  if (compressionMode === V2_COMPRESSION.NONE) {
    if (transportSize !== originalSize) {
      return { code: 'INCONSISTENT_MANIFEST', message: 'transportSize must equal originalSize when the payload is not compressed' };
    }
    if (compressionParam !== 0) {
      return { code: 'INCONSISTENT_MANIFEST', message: 'compressionParam must be 0 when compressionMode is NONE' };
    }
    return null;
  }

  // A compressed transfer that is larger than the file it carries is either a
  // sender that ignored its own threshold or an attempt to make a receiver
  // reserve more than the transfer needs. Neither is something to accept: the
  // policy in `compression-policy.ts` never produces one.
  if (transportSize > originalSize) {
    return { code: 'INCONSISTENT_MANIFEST', message: 'transportSize must not exceed originalSize when the payload is compressed' };
  }

  let windows: CompressionWindowPlan;
  try {
    windows = planCompressionWindows({ originalSize, compressionParam });
  } catch (error) {
    return error instanceof DeqrV2Error
      ? { code: error.code, message: error.message }
      : { code: 'INCONSISTENT_MANIFEST', message: 'compression window plan is not self-consistent' };
  }

  // The floor a container of this many windows physically has. It catches a
  // manifest whose transportSize could not hold even empty members, which is
  // the shape a "reserve nothing, expand forever" bomb would need.
  const floor = BigInt(windows.windowCount) * BigInt(V2_WINDOW_LENGTH_PREFIX_BYTES + V2_MIN_GZIP_MEMBER_BYTES);
  if (transportSize < floor) {
    return {
      code: 'INCONSISTENT_MANIFEST',
      message: `transportSize ${transportSize} is below the ${floor} bytes ${windows.windowCount} window records need`,
    };
  }
  return null;
}

/** Original byte range one compression window covers. */
export function windowOriginalRange(
  plan: CompressionWindowPlan,
  windowIndex: number,
): { start: bigint; end: bigint } {
  if (!Number.isInteger(windowIndex) || windowIndex < 0 || windowIndex >= plan.windowCount) {
    reject('SEGMENT_OUT_OF_RANGE', `windowIndex ${windowIndex} is outside 0..${plan.windowCount - 1}`);
  }
  const start = BigInt(plan.windowBytes) * BigInt(windowIndex);
  const length = windowIndex === plan.windowCount - 1 ? plan.lastWindowBytes : plan.windowBytes;
  return { start, end: start + BigInt(length) };
}

/* ---------------------------------------------------------------- detection */

/**
 * Which DEQR protocol a byte string claims to be, from its first bytes alone.
 *
 * Cheap and total: it reads at most three bytes and never allocates. A v1 frame
 * opens with a 0x01 version byte and v2 opens with `'D' '2'`, so the two are
 * distinguishable before any parsing. Returning `null` for anything else is
 * what keeps a stray QR code from being reported as a corrupted DEQR frame.
 */
export function detectProtocolVersion(bytes: Uint8Array): 1 | 2 | null {
  if (bytes.length >= 3 && bytes[0] === V2_MAGIC_0 && bytes[1] === V2_MAGIC_1) {
    return bytes[2] === V2_PROTOCOL_VERSION ? 2 : null;
  }
  // v1 has no magic. Its header is exactly 20 bytes with version 1 at byte 0,
  // so length and version together are the whole of the v1 signature.
  if (bytes.length >= 20 && bytes[0] === 1) return 1;
  return null;
}

/* -------------------------------------------------------------- serializing */

function assertU32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    reject('FIELD_OUT_OF_RANGE', `${field} must be a u32, received ${value}`);
  }
}

function assertU8(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    reject('FIELD_OUT_OF_RANGE', `${field} must be a u8, received ${value}`);
  }
}

function assertFlags(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    reject('FIELD_OUT_OF_RANGE', `${field} must be a u16, received ${value}`);
  }
}

/**
 * Serializes a session manifest.
 *
 * The manifest is sent repeatedly through a transfer, not once, because a
 * receiver can start scanning at any moment. It is the only frame that carries
 * the filename, the digest, and the segmentation, so nothing else has to.
 */
export function serializeManifestFrame(manifest: DeqrV2Manifest): Uint8Array {
  assertFlags(manifest.featureFlags, 'featureFlags');
  if ((manifest.featureFlags & V2_FLAG_CRITICAL_MASK) !== 0) {
    reject('UNSUPPORTED_CRITICAL_FEATURE', 'no critical feature bits are defined in this revision');
  }
  assertU32(manifest.sessionId, 'sessionId');
  assertU32(manifest.fileId, 'fileId');

  if (manifest.sha256.length !== 32) {
    reject('FIELD_OUT_OF_RANGE', `sha256 must be 32 bytes, received ${manifest.sha256.length}`);
  }
  if (manifest.originalSize < 1n || manifest.originalSize > V2_LIMITS.maxFileBytes) {
    reject('FIELD_OUT_OF_RANGE', `originalSize must be in 1..2^64-1, received ${manifest.originalSize}`);
  }
  const compression = compressionInconsistency(manifest);
  if (compression) reject(compression.code, compression.message);
  if (manifest.fecProfileId !== V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1) {
    reject('UNSUPPORTED_FEC_PROFILE', `unknown fecProfileId ${manifest.fecProfileId}`);
  }

  // Throws if the caller's segmentation is not self-consistent, and gives the
  // authoritative segmentCount rather than trusting the one passed in.
  const plan = planSegmentation({
    transportSize: manifest.transportSize,
    segmentSizeBytes: manifest.segmentSizeBytes,
    symbolSizeBytes: manifest.symbolSizeBytes,
  });
  if (manifest.segmentCount !== plan.segmentCount) {
    reject('INCONSISTENT_MANIFEST', `segmentCount ${manifest.segmentCount} does not match the ${plan.segmentCount} the segmentation implies`);
  }

  const safeName = sanitizeFilename(manifest.filename);
  const filenameBytes = utf8Encoder.encode(safeName);
  if (filenameBytes.length < V2_LIMITS.minFilenameBytes || filenameBytes.length > V2_LIMITS.maxFilenameBytes) {
    reject('INVALID_FILENAME', `filename must encode to ${V2_LIMITS.minFilenameBytes}..${V2_LIMITS.maxFilenameBytes} UTF-8 bytes, received ${filenameBytes.length}`);
  }
  const mimeBytes = utf8Encoder.encode(manifest.mimeType);
  if (mimeBytes.length > V2_LIMITS.maxMimeBytes) {
    reject('FIELD_OUT_OF_RANGE', `mimeType must encode to at most ${V2_LIMITS.maxMimeBytes} UTF-8 bytes, received ${mimeBytes.length}`);
  }

  const total = V2_MANIFEST_LAYOUT.fixedTotalBytes + filenameBytes.length + mimeBytes.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  bytes[V2_MANIFEST_LAYOUT.magic0] = V2_MAGIC_0;
  bytes[V2_MANIFEST_LAYOUT.magic1] = V2_MAGIC_1;
  bytes[V2_MANIFEST_LAYOUT.version] = V2_PROTOCOL_VERSION;
  bytes[V2_MANIFEST_LAYOUT.frameType] = V2_FRAME_TYPE.MANIFEST;
  view.setUint16(V2_MANIFEST_LAYOUT.featureFlags, manifest.featureFlags);
  view.setUint32(V2_MANIFEST_LAYOUT.sessionId, manifest.sessionId);
  view.setUint32(V2_MANIFEST_LAYOUT.fileId, manifest.fileId);
  view.setBigUint64(V2_MANIFEST_LAYOUT.originalSize, manifest.originalSize);
  view.setBigUint64(V2_MANIFEST_LAYOUT.transportSize, manifest.transportSize);
  view.setUint32(V2_MANIFEST_LAYOUT.segmentSizeBytes, manifest.segmentSizeBytes);
  view.setUint16(V2_MANIFEST_LAYOUT.symbolSizeBytes, manifest.symbolSizeBytes);
  view.setUint32(V2_MANIFEST_LAYOUT.segmentCount, manifest.segmentCount);
  bytes[V2_MANIFEST_LAYOUT.fecProfileId] = manifest.fecProfileId;
  bytes[V2_MANIFEST_LAYOUT.compressionMode] = manifest.compressionMode;
  bytes[V2_MANIFEST_LAYOUT.compressionParam] = manifest.compressionParam;
  assertU8(manifest.transportProfileId, 'transportProfileId');
  bytes[V2_MANIFEST_LAYOUT.transportProfileId] = manifest.transportProfileId;
  bytes.set(manifest.sha256, V2_MANIFEST_LAYOUT.sha256);
  view.setUint16(V2_MANIFEST_LAYOUT.filenameLength, filenameBytes.length);
  bytes.set(filenameBytes, V2_MANIFEST_LAYOUT.filename);

  const mimeLengthOffset = V2_MANIFEST_LAYOUT.filename + filenameBytes.length;
  view.setUint16(mimeLengthOffset, mimeBytes.length);
  bytes.set(mimeBytes, mimeLengthOffset + 2);

  const crcOffset = total - 4;
  view.setUint32(crcOffset, crc32(bytes, 0, crcOffset));
  return bytes;
}

/** Serializes one source or repair data frame. */
export function serializeDataFrame(frame: DeqrV2DataFrame): Uint8Array {
  if (frame.frameType !== V2_FRAME_TYPE.SOURCE && frame.frameType !== V2_FRAME_TYPE.REPAIR) {
    reject('UNKNOWN_FRAME_TYPE', `frameType ${frame.frameType} is not a data frame`);
  }
  assertFlags(frame.frameFlags, 'frameFlags');
  if ((frame.frameFlags & V2_FLAG_CRITICAL_MASK) !== 0) {
    reject('UNSUPPORTED_CRITICAL_FEATURE', 'no critical frame flags are defined in this revision');
  }
  assertU32(frame.sessionId, 'sessionId');
  assertU32(frame.fileId, 'fileId');
  assertU32(frame.segmentIndex, 'segmentIndex');
  assertU32(frame.symbolId, 'symbolId');
  assertU32(frame.sourceSymbolCount, 'sourceSymbolCount');

  if (frame.sourceSymbolCount < 1) {
    reject('FIELD_OUT_OF_RANGE', 'sourceSymbolCount must be at least 1');
  }
  if (frame.frameType === V2_FRAME_TYPE.SOURCE && frame.symbolId >= frame.sourceSymbolCount) {
    reject('SYMBOL_OUT_OF_RANGE', `source symbolId ${frame.symbolId} must be below sourceSymbolCount ${frame.sourceSymbolCount}`);
  }
  if (frame.frameType === V2_FRAME_TYPE.REPAIR && frame.symbolId < frame.sourceSymbolCount) {
    reject('SYMBOL_OUT_OF_RANGE', `repair symbolId ${frame.symbolId} must be at or above sourceSymbolCount ${frame.sourceSymbolCount}`);
  }
  if (frame.payload.length < 1 || frame.payload.length > V2_LIMITS.maxSymbolSizeBytes) {
    reject('FIELD_OUT_OF_RANGE', `payload must be 1..${V2_LIMITS.maxSymbolSizeBytes} bytes, received ${frame.payload.length}`);
  }

  const total = V2_DATA_LAYOUT.overheadBytes + frame.payload.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  bytes[V2_DATA_LAYOUT.magic0] = V2_MAGIC_0;
  bytes[V2_DATA_LAYOUT.magic1] = V2_MAGIC_1;
  bytes[V2_DATA_LAYOUT.version] = V2_PROTOCOL_VERSION;
  bytes[V2_DATA_LAYOUT.frameType] = frame.frameType;
  view.setUint32(V2_DATA_LAYOUT.sessionId, frame.sessionId);
  view.setUint32(V2_DATA_LAYOUT.fileId, frame.fileId);
  view.setUint32(V2_DATA_LAYOUT.segmentIndex, frame.segmentIndex);
  view.setUint32(V2_DATA_LAYOUT.symbolId, frame.symbolId);
  view.setUint32(V2_DATA_LAYOUT.sourceSymbolCount, frame.sourceSymbolCount);
  view.setUint16(V2_DATA_LAYOUT.payloadLength, frame.payload.length);
  view.setUint16(V2_DATA_LAYOUT.frameFlags, frame.frameFlags);
  bytes.set(frame.payload, V2_DATA_LAYOUT.payload);

  const crcOffset = total - 4;
  view.setUint32(crcOffset, crc32(bytes, 0, crcOffset));
  return bytes;
}

/* ------------------------------------------------------------------ parsing */

/**
 * Validates the shared four-byte prefix.
 *
 * Every rejection here is a distinct code so a receiver can tell "this is a v1
 * frame", "this is not DEQR at all", and "this is DEQR from a newer build"
 * apart. Collapsing them into one error is how a version mismatch ends up
 * reported to a user as data corruption.
 */
function readPrefix(bytes: Uint8Array): V2Result<number> {
  if (bytes.length < 4) return fail('FRAME_TOO_SHORT', `frame is ${bytes.length} bytes, below the 4-byte prefix`);
  if (bytes[0] === 1 && bytes.length >= 20) {
    return fail('V1_FRAME', 'frame is DEQR v1; it must be handled by the v1 reader, never reinterpreted as v2');
  }
  if (bytes[0] !== V2_MAGIC_0 || bytes[1] !== V2_MAGIC_1) {
    return fail('BAD_MAGIC', 'frame does not carry the DEQR v2 magic');
  }
  if (bytes[2] !== V2_PROTOCOL_VERSION) {
    return fail('UNSUPPORTED_VERSION', `protocol version ${bytes[2]} is not supported by this build`);
  }
  const frameType = bytes[3];
  if (frameType !== V2_FRAME_TYPE.MANIFEST
    && frameType !== V2_FRAME_TYPE.SOURCE
    && frameType !== V2_FRAME_TYPE.REPAIR) {
    return fail('UNKNOWN_FRAME_TYPE', `frame type ${frameType} is not defined in this revision`);
  }
  return { ok: true, value: frameType };
}

function checkCrc(bytes: Uint8Array): V2Result<true> {
  const crcOffset = bytes.length - 4;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(crcOffset);
  const actual = crc32(bytes, 0, crcOffset);
  if (declared !== actual) {
    return fail('CRC_MISMATCH', 'frame CRC-32 does not match its contents');
  }
  return { ok: true, value: true };
}

/** Parses a session manifest. Never throws; malformed input becomes a typed failure. */
export function parseManifestFrame(bytes: Uint8Array): V2Result<DeqrV2Manifest> {
  const prefix = readPrefix(bytes);
  if (!prefix.ok) return prefix;
  if (prefix.value !== V2_FRAME_TYPE.MANIFEST) {
    return fail('FRAME_TYPE_MISMATCH', `expected a manifest frame, received type ${prefix.value}`);
  }
  // Enough for every fixed field and the filename length, before anything is read.
  if (bytes.length < V2_MANIFEST_LAYOUT.fixedTotalBytes + V2_LIMITS.minFilenameBytes) {
    return fail('FRAME_TOO_SHORT', `manifest is ${bytes.length} bytes, below the minimum`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const filenameLength = view.getUint16(V2_MANIFEST_LAYOUT.filenameLength);
  if (filenameLength < V2_LIMITS.minFilenameBytes || filenameLength > V2_LIMITS.maxFilenameBytes) {
    return fail('FIELD_OUT_OF_RANGE', `filenameLength ${filenameLength} is outside ${V2_LIMITS.minFilenameBytes}..${V2_LIMITS.maxFilenameBytes}`);
  }
  // The mime length field must exist before it is read.
  const mimeLengthOffset = V2_MANIFEST_LAYOUT.filename + filenameLength;
  if (bytes.length < mimeLengthOffset + 2 + 4) {
    return fail('FRAME_TOO_SHORT', 'manifest is truncated inside the filename or the mime length');
  }
  const mimeLength = view.getUint16(mimeLengthOffset);
  if (mimeLength > V2_LIMITS.maxMimeBytes) {
    return fail('FIELD_OUT_OF_RANGE', `mimeLength ${mimeLength} is above ${V2_LIMITS.maxMimeBytes}`);
  }

  const expectedLength = V2_MANIFEST_LAYOUT.fixedTotalBytes + filenameLength + mimeLength;
  if (bytes.length < expectedLength) {
    return fail('FRAME_TOO_SHORT', `manifest declares ${expectedLength} bytes but carries ${bytes.length}`);
  }
  if (bytes.length > expectedLength) {
    return fail('TRAILING_BYTES', `manifest declares ${expectedLength} bytes and carries ${bytes.length}`);
  }

  const crc = checkCrc(bytes);
  if (!crc.ok) return crc;

  const featureFlags = view.getUint16(V2_MANIFEST_LAYOUT.featureFlags);
  if ((featureFlags & V2_FLAG_CRITICAL_MASK) !== 0) {
    return fail('UNSUPPORTED_CRITICAL_FEATURE', `manifest requires critical features 0x${(featureFlags & V2_FLAG_CRITICAL_MASK).toString(16)} that this build does not implement`);
  }
  // Deliberately not validated against the known profile ids. The field is
  // advisory, the frame CRC already covers it, and rejecting an unrecognised
  // value would make every future profile a breaking change for this build.
  const transportProfileId = bytes[V2_MANIFEST_LAYOUT.transportProfileId];

  const originalSize = view.getBigUint64(V2_MANIFEST_LAYOUT.originalSize);
  const transportSize = view.getBigUint64(V2_MANIFEST_LAYOUT.transportSize);
  if (originalSize < 1n) return fail('FIELD_OUT_OF_RANGE', 'originalSize must be at least 1');
  if (transportSize < 1n) return fail('FIELD_OUT_OF_RANGE', 'transportSize must be at least 1');

  const compressionMode = bytes[V2_MANIFEST_LAYOUT.compressionMode];
  const compressionParam = bytes[V2_MANIFEST_LAYOUT.compressionParam];
  const compression = compressionInconsistency({
    compressionMode,
    compressionParam,
    originalSize,
    transportSize,
  });
  if (compression) return fail(compression.code, compression.message);

  const fecProfileId = bytes[V2_MANIFEST_LAYOUT.fecProfileId];
  if (fecProfileId !== V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1) {
    return fail('UNSUPPORTED_FEC_PROFILE', `fecProfileId ${fecProfileId} is not supported`);
  }

  const segmentSizeBytes = view.getUint32(V2_MANIFEST_LAYOUT.segmentSizeBytes);
  const symbolSizeBytes = view.getUint16(V2_MANIFEST_LAYOUT.symbolSizeBytes);
  const segmentCount = view.getUint32(V2_MANIFEST_LAYOUT.segmentCount);

  // Segmentation is re-derived and compared rather than trusted. A transmitted
  // segmentCount that disagrees with the sizes is the single most useful thing
  // to catch here: everything downstream indexes off it.
  let plan: SegmentPlan;
  try {
    plan = planSegmentation({ transportSize, segmentSizeBytes, symbolSizeBytes });
  } catch (error) {
    return error instanceof DeqrV2Error
      ? { ok: false, error }
      : fail('INCONSISTENT_MANIFEST', 'manifest segmentation is not self-consistent');
  }
  if (plan.segmentCount !== segmentCount) {
    return fail('INCONSISTENT_MANIFEST', `segmentCount ${segmentCount} does not match the ${plan.segmentCount} the sizes imply`);
  }

  const filenameText = decodeUtf8(bytes.subarray(V2_MANIFEST_LAYOUT.filename, mimeLengthOffset), 'filename');
  if (!filenameText.ok) return filenameText;
  const filename = sanitizeFilename(filenameText.value);
  if (!filename) return fail('INVALID_FILENAME', 'filename is empty after sanitization');

  const mimeStart = mimeLengthOffset + 2;
  const mimeText = decodeUtf8(bytes.subarray(mimeStart, mimeStart + mimeLength), 'mimeType');
  if (!mimeText.ok) return mimeText;

  return {
    ok: true,
    value: {
      featureFlags,
      sessionId: view.getUint32(V2_MANIFEST_LAYOUT.sessionId),
      fileId: view.getUint32(V2_MANIFEST_LAYOUT.fileId),
      originalSize,
      transportSize,
      segmentSizeBytes,
      symbolSizeBytes,
      segmentCount,
      fecProfileId,
      compressionMode,
      compressionParam,
      transportProfileId,
      sha256: bytes.slice(V2_MANIFEST_LAYOUT.sha256, V2_MANIFEST_LAYOUT.sha256 + 32),
      filename,
      mimeType: mimeText.value,
    },
  };
}

/** Parses one source or repair data frame. Never throws. */
export function parseDataFrame(bytes: Uint8Array): V2Result<DeqrV2DataFrame> {
  const prefix = readPrefix(bytes);
  if (!prefix.ok) return prefix;
  if (prefix.value !== V2_FRAME_TYPE.SOURCE && prefix.value !== V2_FRAME_TYPE.REPAIR) {
    return fail('FRAME_TYPE_MISMATCH', `expected a data frame, received type ${prefix.value}`);
  }
  if (bytes.length < V2_DATA_LAYOUT.overheadBytes + 1) {
    return fail('FRAME_TOO_SHORT', `data frame is ${bytes.length} bytes, below the minimum`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const payloadLength = view.getUint16(V2_DATA_LAYOUT.payloadLength);
  if (payloadLength < 1 || payloadLength > V2_LIMITS.maxSymbolSizeBytes) {
    return fail('FIELD_OUT_OF_RANGE', `payloadLength ${payloadLength} is outside 1..${V2_LIMITS.maxSymbolSizeBytes}`);
  }
  const expectedLength = V2_DATA_LAYOUT.overheadBytes + payloadLength;
  if (bytes.length < expectedLength) {
    return fail('FRAME_TOO_SHORT', `frame declares ${payloadLength} payload bytes but carries ${bytes.length - V2_DATA_LAYOUT.overheadBytes}`);
  }
  if (bytes.length > expectedLength) {
    return fail('TRAILING_BYTES', `frame declares ${expectedLength} bytes and carries ${bytes.length}`);
  }

  const crc = checkCrc(bytes);
  if (!crc.ok) return crc;

  const frameFlags = view.getUint16(V2_DATA_LAYOUT.frameFlags);
  if ((frameFlags & V2_FLAG_CRITICAL_MASK) !== 0) {
    return fail('UNSUPPORTED_CRITICAL_FEATURE', `frame requires critical flags 0x${(frameFlags & V2_FLAG_CRITICAL_MASK).toString(16)} that this build does not implement`);
  }

  const sourceSymbolCount = view.getUint32(V2_DATA_LAYOUT.sourceSymbolCount);
  if (sourceSymbolCount < 1) {
    return fail('FIELD_OUT_OF_RANGE', 'sourceSymbolCount must be at least 1');
  }
  const symbolId = view.getUint32(V2_DATA_LAYOUT.symbolId);
  const frameType = prefix.value;
  if (frameType === V2_FRAME_TYPE.SOURCE && symbolId >= sourceSymbolCount) {
    return fail('SYMBOL_OUT_OF_RANGE', `source symbolId ${symbolId} is not below sourceSymbolCount ${sourceSymbolCount}`);
  }
  if (frameType === V2_FRAME_TYPE.REPAIR && symbolId < sourceSymbolCount) {
    return fail('SYMBOL_OUT_OF_RANGE', `repair symbolId ${symbolId} is below sourceSymbolCount ${sourceSymbolCount}`);
  }

  return {
    ok: true,
    value: {
      frameType,
      sessionId: view.getUint32(V2_DATA_LAYOUT.sessionId),
      fileId: view.getUint32(V2_DATA_LAYOUT.fileId),
      segmentIndex: view.getUint32(V2_DATA_LAYOUT.segmentIndex),
      symbolId,
      sourceSymbolCount,
      frameFlags,
      payload: bytes.slice(V2_DATA_LAYOUT.payload, V2_DATA_LAYOUT.payload + payloadLength),
    },
  };
}

/** Parses any v2 frame, dispatching on its declared type. Never throws. */
export function parseFrame(bytes: Uint8Array): V2Result<DeqrV2Frame> {
  const prefix = readPrefix(bytes);
  if (!prefix.ok) return prefix;
  if (prefix.value === V2_FRAME_TYPE.MANIFEST) {
    const manifest = parseManifestFrame(bytes);
    return manifest.ok ? { ok: true, value: { kind: 'manifest', manifest: manifest.value } } : manifest;
  }
  const frame = parseDataFrame(bytes);
  return frame.ok ? { ok: true, value: { kind: 'data', frame: frame.value } } : frame;
}

/**
 * Checks a parsed data frame against the manifest it claims to belong to.
 *
 * Parsing proves a frame is well formed. This proves it belongs here — which is
 * a separate question, and the one that matters when two transfers are visible
 * to the same camera.
 */
export function validateDataFrameAgainstManifest(
  frame: DeqrV2DataFrame,
  manifest: DeqrV2Manifest,
  plan: SegmentPlan = segmentPlanFromManifest(manifest),
): V2Result<true> {
  if (frame.sessionId !== manifest.sessionId) {
    return fail('SESSION_MISMATCH', `frame session ${frame.sessionId} does not match manifest session ${manifest.sessionId}`);
  }
  if (frame.fileId !== manifest.fileId) {
    return fail('SESSION_MISMATCH', `frame file ${frame.fileId} does not match manifest file ${manifest.fileId}`);
  }
  if (frame.segmentIndex >= manifest.segmentCount) {
    return fail('SEGMENT_OUT_OF_RANGE', `segmentIndex ${frame.segmentIndex} is outside 0..${manifest.segmentCount - 1}`);
  }

  const expectedSymbols = sourceSymbolCountForSegment(plan, frame.segmentIndex);
  if (frame.sourceSymbolCount !== expectedSymbols) {
    return fail('INCONSISTENT_MANIFEST', `frame declares ${frame.sourceSymbolCount} source symbols for segment ${frame.segmentIndex}; the manifest implies ${expectedSymbols}`);
  }

  // Every symbol carries a full-size payload. The final symbol of the final
  // segment is zero-padded up to the symbol size rather than shortened, because
  // XOR-based repair requires every symbol in a segment to be the same length.
  if (frame.payload.length !== manifest.symbolSizeBytes) {
    return fail('FIELD_OUT_OF_RANGE', `payload is ${frame.payload.length} bytes; the manifest declares ${manifest.symbolSizeBytes}-byte symbols`);
  }

  return { ok: true, value: true };
}
