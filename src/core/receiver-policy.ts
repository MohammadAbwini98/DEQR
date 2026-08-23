/**
 * Every maximum a DEQR receiver enforces, in one place.
 *
 * Phase 10's rule, and the reason this module exists rather than a comment
 * saying the same thing: **a limit that is written down twice is a limit that
 * will disagree with itself.** Before this, the caps a hostile optical stream
 * meets were spread across five modules — the parser's `V2_LIMITS`, the
 * segmented receiver's `DEFAULT_MAX_SEGMENT_COUNT`, the decoder's neighbour
 * budget, the worker client's `DEFAULT_WORKER_LIMITS`, and a bound on the
 * checkpoint that did not exist at all — and a test could only assert against
 * whichever copy it happened to import. Now the parser, the receiver, the
 * worker and the tests read the same numbers, so "the parser and the policy
 * agree" is a property of the imports and not of somebody's diligence.
 *
 * ## Protocol limits and receiver policy are different things
 *
 * `V2_LIMITS` in `protocol-v2.ts` says what the **wire format** can express: a
 * u32 segment count, a u64 file size. Those are field widths and they are not
 * negotiable. What is negotiable — and is a *receiver's own* decision — is how
 * much of that range this build is willing to act on. Honouring a u32 segment
 * count literally means allocating a 512 MB completion bitmap because an
 * untrusted manifest asked for one.
 *
 * So every value below narrows a protocol maximum to something a phone can
 * hold, and each one carries the arithmetic that makes it a bound rather than
 * a guess. Nothing here is derived from a transmitted field.
 *
 * ## The one direction that matters
 *
 * A receiver may refuse anything. It may never *accept* something the protocol
 * cannot express, which is why several values below are computed from
 * `V2_LIMITS` rather than restated: if the wire format ever narrows, these
 * narrow with it and cannot drift above it.
 *
 * Written against no platform API, so the Electron sender, the receive worker
 * and both test suites import the same module.
 */

import {
  V2_COMPRESSION_WINDOW,
  V2_DATA_LAYOUT,
  V2_LIMITS,
  V2_MANIFEST_LAYOUT,
} from './protocol-v2.js';

/** Bytes a base64 encoding of `n` bytes occupies, padding included. */
function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/* ------------------------------------------------------------------ frames */

/** Largest manifest frame the format can produce: fixed fields, filename, mime, CRC. */
const MAX_MANIFEST_FRAME_BYTES =
  V2_MANIFEST_LAYOUT.fixedTotalBytes + V2_LIMITS.maxFilenameBytes + V2_LIMITS.maxMimeBytes;

/** Smallest manifest frame that could carry a one-byte filename. */
const MIN_MANIFEST_FRAME_BYTES = V2_MANIFEST_LAYOUT.fixedTotalBytes + V2_LIMITS.minFilenameBytes;

/** Largest data frame: header, a full symbol, and the CRC. */
const MAX_DATA_FRAME_BYTES = V2_DATA_LAYOUT.overheadBytes + V2_LIMITS.maxSymbolSizeBytes;

/* ------------------------------------------------------------ segmentation */

/**
 * Segments a manifest may declare.
 *
 * 16,777,216 is 16 TiB at 1 MiB segments — at the 5,120 B/s Phase 00 measured,
 * about a century of transfer — and costs a 2 MiB completion bitmap in that
 * pathological case against 128 bytes for a 1 GiB file. The protocol field is a
 * u32; honouring it would mean a 512 MB bitmap taken from an untrusted manifest.
 */
const MAX_SEGMENT_COUNT = 1 << 24;

/**
 * Source symbols one segment may hold.
 *
 * Not a free choice: it is the largest segment divided by the smallest symbol,
 * so a manifest inside `V2_LIMITS` can never imply more. Stated separately
 * because every per-segment work cap in `segment-decoder.ts` is a multiple of
 * it, and a reviewer should be able to read the worst case off one line.
 */
const MAX_SOURCE_SYMBOLS_PER_SEGMENT = V2_LIMITS.maxSegmentSizeBytes / V2_LIMITS.minSymbolSizeBytes;

/* ------------------------------------------------------------- checkpoints */

/** Completion bitmap for the largest admissible segment count: one bit per segment. */
const MAX_COMMITTED_BITMAP_BYTES = Math.ceil(MAX_SEGMENT_COUNT / 8);

/** The same bitmap after base64, which is the form the checkpoint carries. */
const MAX_COMMITTED_BASE64_CHARS = base64Length(MAX_COMMITTED_BITMAP_BYTES);

export const RECEIVER_POLICY = {
  /* ---------------------------------------------------------------- optical */

  /**
   * Longest optical payload worth handing to a parser.
   *
   * A QR symbol cannot carry more than this in any transport profile DEQR
   * defines, so a longer decode is not a DEQR frame however it is shaped.
   */
  maxFrameBytes: Math.max(MAX_MANIFEST_FRAME_BYTES, MAX_DATA_FRAME_BYTES),
  maxManifestFrameBytes: MAX_MANIFEST_FRAME_BYTES,
  minManifestFrameBytes: MIN_MANIFEST_FRAME_BYTES,
  maxDataFrameBytes: MAX_DATA_FRAME_BYTES,
  /** Sanitized UTF-8 filename bytes. Advisory metadata is bounded separately. */
  maxFilenameBytes: V2_LIMITS.maxFilenameBytes,
  maxMimeBytes: V2_LIMITS.maxMimeBytes,
  /** Symbol payload carried by one data frame. */
  maxSymbolSizeBytes: V2_LIMITS.maxSymbolSizeBytes,

  /* ----------------------------------------------------------- segmentation */

  maxSegmentCount: MAX_SEGMENT_COUNT,
  maxSegmentSizeBytes: V2_LIMITS.maxSegmentSizeBytes,
  maxSourceSymbolsPerSegment: MAX_SOURCE_SYMBOLS_PER_SEGMENT,
  /**
   * Transport bytes one session may declare, as a `bigint`.
   *
   * The product of the two caps above — 1 PiB — and the reason a u64
   * `transportSize` cannot be used to make a receiver reserve a nonsense
   * amount of a device. Checked before any storage call is made.
   */
  maxTransportBytes: BigInt(MAX_SEGMENT_COUNT) * BigInt(V2_LIMITS.maxSegmentSizeBytes),
  /**
   * Decoders alive at once.
   *
   * Two covers an in-order sender crossing a segment boundary with frames still
   * in flight. This is the multiplier on every per-segment budget below, so it
   * is the number that turns "bounded per segment" into "bounded, full stop".
   */
  maxActiveSegments: 2,

  /* -------------------------------------------------------------------- fec */

  /**
   * Neighbour references one segment's pending equations may hold, per source
   * symbol.
   *
   * The robust soliton's mean degree lands between 9 and 15 across the segment
   * sizes this program benchmarks, so twelve buys room for a full K equations
   * at the distribution's own mean. Past the cap the decoder keeps rejecting in
   * O(1) and stays correct; only completeness degrades.
   */
  pendingNeighborRefsPerSymbol: 12,
  /** Constant headroom added to the neighbour budget for a very small segment. */
  pendingNeighborRefsFloor: 1_024,
  /**
   * Repair identities remembered for duplicate suppression, per source symbol.
   *
   * Suppression is an optimisation and not a correctness requirement — an
   * untracked duplicate eliminates to degree zero and is discarded as redundant
   * — so when the budget is spent, tracking stops rather than growing.
   */
  trackedRepairIdsPerSymbol: 4,
  trackedRepairIdsFloor: 64,

  /* ------------------------------------------------------------ compression */

  minCompressionWindowLog2: V2_COMPRESSION_WINDOW.minLog2,
  maxCompressionWindowLog2: V2_COMPRESSION_WINDOW.maxLog2,
  /**
   * Bytes one gzip member may expand into: exactly the window the manifest
   * declares, and not a byte more.
   *
   * Stated as a policy constant even though the enforcement lives in
   * `inflate-verify.ts`, because it is the decompression-bomb bound and it
   * should be readable from the policy alone. The buffer *is* the limit: a
   * member that keeps producing is stopped mid-stream with no allocation.
   */
  maxDecompressedWindowBytes: 2 ** V2_COMPRESSION_WINDOW.maxLog2,

  /* ------------------------------------------------------------- checkpoint */

  maxCommittedBitmapBytes: MAX_COMMITTED_BITMAP_BYTES,
  maxCommittedBase64Chars: MAX_COMMITTED_BASE64_CHARS,
  /**
   * Bytes a checkpoint file may occupy before it is refused unread.
   *
   * The bitmap for the largest admissible transfer, plus four kilobytes for
   * every other field. A checkpoint lives in origin-private storage that only
   * this receiver writes — but it is read back, parsed, and *acted on*, and
   * "only we write there" is an assumption about a device rather than a
   * property of the code. Bounding the read is what makes a tampered or
   * corrupted checkpoint cost a rejection instead of an allocation.
   */
  maxCheckpointBytes: MAX_COMMITTED_BASE64_CHARS + 4_096,
  /** Abandoned sessions kept on the device at once, newest first. */
  maxRetainedSessions: 3,
  /** How long an abandoned session's bytes may sit on the device. */
  sessionRetentionMs: 24 * 60 * 60 * 1_000,

  /* ----------------------------------------------------------------- worker */

  /**
   * Pixels jsQR will be asked to allocate for.
   *
   * Receiver policy, not protocol: camera-originated data must never set the
   * receiver's budgets. 720x720 is the largest region of interest the capture
   * loop produces.
   */
  maxDecodePixels: 720 * 720,
  /** RGBA bytes the pixel transport may carry, derived from the pixel cap. */
  maxFramePixelBytes: 720 * 720 * 4,
  /** Frames posted to the worker and not yet answered. The whole queue bound. */
  maxFramesInFlight: 2,
  /** Frame fingerprints remembered. Bounds dedupe memory, never correctness. */
  dedupeCapacity: 4_096,
  /** Longest error text the worker will forward. Keeps one message bounded. */
  maxReasonChars: 200,
  /** Characters accepted in a resume code before it reaches the token parser. */
  maxResumeTokenChars: 128,

  /* ---------------------------------------------------------------- storage */

  /**
   * Bytes the in-memory fallback store may hold: four Turbo-profile segments.
   *
   * Deliberately small. It is not a storage tier — it is the fallback for a
   * browser with no OPFS, where the honest answer to a large transfer is to
   * refuse it at the manifest rather than to grow the tab until the platform
   * kills it.
   */
  fallbackSegmentBudgetBytes: 4 * 2_048 * 1_139,
  /** Free space required on top of a transfer before one is started. */
  storageMarginRatio: 0.15,
} as const;

export type ReceiverPolicy = typeof RECEIVER_POLICY;

/* --------------------------------------------------------------- decisions */

/** Why a manifest is outside what this receiver will act on. */
export type ManifestPolicyRefusal =
  /** More segments than the completion bitmap budget admits. */
  | 'SEGMENT_COUNT_EXCEEDED'
  /** A transport size above the product of the segment caps. */
  | 'TRANSFER_TOO_LARGE'
  /** A segment that would hold more symbols than the per-segment caps assume. */
  | 'SEGMENT_TOO_LARGE';

/**
 * Whether a parsed manifest is inside this receiver's own budgets.
 *
 * Runs *after* the parser has proved the manifest self-consistent and *before*
 * any storage is touched, which is the whole point: a transfer this receiver
 * was never going to accept must cost no device work at all, and must be
 * reported as the refusal it is rather than as a storage failure.
 *
 * Takes the fields rather than the manifest object so the sender, the receiver
 * and a test can all call it without constructing one.
 */
export function manifestPolicyRefusal(input: {
  segmentCount: number;
  segmentSizeBytes: number;
  symbolSizeBytes: number;
  transportSize: bigint;
}): ManifestPolicyRefusal | null {
  if (input.segmentCount > RECEIVER_POLICY.maxSegmentCount) return 'SEGMENT_COUNT_EXCEEDED';
  if (input.transportSize > RECEIVER_POLICY.maxTransportBytes) return 'TRANSFER_TOO_LARGE';
  if (input.segmentSizeBytes > RECEIVER_POLICY.maxSegmentSizeBytes) return 'SEGMENT_TOO_LARGE';
  if (input.segmentSizeBytes / input.symbolSizeBytes > RECEIVER_POLICY.maxSourceSymbolsPerSegment) {
    return 'SEGMENT_TOO_LARGE';
  }
  return null;
}

/**
 * Bytes the decoders may hold at once, for the worst admissible segmentation.
 *
 * Exported because it is the number the memory gate is argued from, and an
 * argument whose arithmetic lives only in a report is one nothing can check.
 * A segment's decoder holds the segment itself, one bit per source symbol, and
 * at most `sourceSymbolCount` equations of one symbol each — so twice the
 * segment, plus the bitmap.
 */
export function worstCaseDecoderBytes(segmentSizeBytes: number, symbolSizeBytes: number): number {
  const symbols = Math.ceil(segmentSizeBytes / symbolSizeBytes);
  const perSegment = segmentSizeBytes + Math.ceil(symbols / 8) + symbols * symbolSizeBytes;
  return perSegment * RECEIVER_POLICY.maxActiveSegments;
}
