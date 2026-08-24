/**
 * Streaming, segmented, bounded-memory DEQR v2 sender.
 *
 * The v1 sender reads the whole file with `fs.readFileSync`, copies it again
 * into a serialized container, and holds both for the life of the transfer —
 * roughly two times the file size, resident, before a single frame is drawn.
 * Phase 00 measured that; this replaces it.
 *
 * What is bounded, and by what:
 *
 * | Buffer | Size | Notes |
 * |---|---|---|
 * | current segment | `segmentSizeBytes` | reused for every segment |
 * | read-ahead segment | `segmentSizeBytes` | optional, at most one |
 * | symbol scratch | `symbolSizeBytes` | reused for every symbol |
 * | ready-frame queue | `frameQueueCapacity × (symbolSizeBytes + 32)` | |
 * | manifest frame | one serialized manifest | cached, reused |
 * | degree distribution | ~16 bytes × symbols-per-segment | rebuilt per segment |
 *
 * None of those terms mentions the file size. `memoryBudgetBytes()` computes
 * the total from configuration alone, and `bufferedBytes()` reports what is
 * actually held, so a test can assert the second never exceeds the first.
 *
 * **Backpressure is structural rather than advisory.** Frames are produced only
 * inside `take()`. A consumer that stops taking stops the encoder and stops the
 * read-ahead, because there is no other thing that drives them. There is no
 * background pump that can run away from a slow display.
 *
 * The renderer never receives file bytes. It gets safe metadata, one QR-ready
 * frame at a time, and progress. Path handling, file descriptors, and reads
 * stay in this process.
 */

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import { DeqrError, ErrorCode } from '../shared/errors';
import { isBlockedExtension, sanitizeFilename } from '../core/filename-sanitizer';
import { SegmentEncoder } from '../core/segment-encoder';
import {
  COMPRESSION_REASON,
  DEFAULT_COMPRESSION_THRESHOLD,
  confirmCompression,
  decideCompression,
  maxCompressedWindowBytes,
  type CompressionDecision,
} from '../core/compression-policy';
import {
  DEFAULT_COMPRESSION_LEVEL,
  WindowContainerEncoder,
} from './window-compressor';
import {
  DEFAULT_TRANSPORT_PROFILE,
  TransportProfile,
  validateTransportProfile,
} from '../core/transport-profiles';
import {
  decodeResumeToken,
  decodeTargetedResumeToken,
  resumeTokenTargets,
  type TargetedResumeToken,
  encodeResumeToken,
  resumeTokenMatchesDigest,
  type ResumeToken,
} from '../core/resume-token';
import {
  DeqrV2Manifest,
  SegmentPlan,
  V2_COMPRESSION,
  V2_COMPRESSION_WINDOW,
  V2_DATA_LAYOUT,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  V2_LIMITS,
  compressionWindowBytes,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
} from '../core/protocol-v2';

/* ------------------------------------------------------------ file handles */

/**
 * The privileged file surface this sender needs, and nothing more.
 *
 * Narrow on purpose. It is the whole of the filesystem capability the pipeline
 * has, it is injectable so tests can present a multi-gigabyte file that does
 * not exist on disk, and nothing resembling it is ever exposed through preload.
 */
export interface SenderFileHandle {
  stat(): Promise<SenderFileStat>;
  /** Reads into `buffer[0, length)` from an absolute 64-bit position. */
  read(buffer: Uint8Array, length: number, position: bigint): Promise<number>;
  close(): Promise<void>;
}

export interface SenderFileStat {
  size: bigint;
  /** Millisecond resolution is enough to catch a rewrite mid-transfer. */
  mtimeMs: bigint;
  isFile: boolean;
}

export type SenderFileOpener = (filePath: string) => Promise<SenderFileHandle>;

/** Opens a real file read-only, with 64-bit stat fields. */
export const nodeFileOpener: SenderFileOpener = async (filePath: string) => {
  const handle = await fsPromises.open(filePath, 'r');
  return {
    async stat(): Promise<SenderFileStat> {
      const stats = await handle.stat({ bigint: true });
      return { size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile() };
    },
    async read(buffer: Uint8Array, length: number, position: bigint): Promise<number> {
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return bytesRead;
    },
    close: () => handle.close(),
  };
};

/* ----------------------------------------------------------- configuration */

export interface StreamingSenderConfig {
  /**
   * Transport bytes per segment. The plan's benchmark range is 1-4 MiB and
   * Phase 04 picks the operating value from measured throughput; 1 MiB is a
   * starting point, not a decision.
   */
  segmentSizeBytes: number;
  /** Payload bytes per symbol. 512 matches what v1 shipped, for comparability. */
  symbolSizeBytes: number;
  /**
   * Segments to prefetch. At most one, and zero is a defensible default: a
   * segment read is roughly four orders of magnitude faster than the optical
   * link, so prefetching buys nothing and costs a whole segment of RAM. It is
   * implemented and tested because a faster link would change that answer.
   */
  readAheadSegments: 0 | 1;
  /** Ready QR frames held at once. Small: this is a display buffer, not a cache. */
  frameQueueCapacity: number;
  /**
   * How often the session manifest is retransmitted, in frames. A receiver can
   * start scanning at any moment, so the manifest cannot be sent only once.
   */
  manifestIntervalFrames: number;
  /**
   * Repair symbols per segment, as a fraction of its source-symbol count.
   *
   * A budget, not a guarantee. See `MEASURED_REPAIR_OVERHEAD` for what a given
   * value actually recovers.
   */
  repairOverheadRatio: number;
  /** Bytes read per iteration of the hashing pass. Reuses the segment buffer. */
  hashChunkBytes: number;
  /** Measure compressibility during preflight. Without it nothing can decide to compress. */
  sampleCompressibility: boolean;
  /** Bytes per compressibility sample window; three windows are taken. */
  compressibilitySampleBytes: number;
  /**
   * Allow the sampled bytes to turn compression on.
   *
   * Separate from `sampleCompressibility` on purpose: measuring and acting are
   * two decisions, and a transfer that wants the telemetry without the
   * behaviour - which is every transfer between Phase 00 and Phase 08 - is a
   * real configuration rather than a special case.
   */
  compressionEnabled: boolean;
  /** Minimum fraction of the original size compression must remove to be used. */
  compressionThreshold: number;
  /** log2 of the original bytes per independently compressed window. */
  compressionWindowLog2: number;
  /** zlib level. See the Phase 08 report for why 6 rather than 1 or 9. */
  compressionLevel: number;
  /**
   * Named transport profile this configuration came from, for the manifest.
   *
   * Advisory: it tells a receiver which profile is on screen and never changes
   * how anything is decoded. `0` means a configuration assembled by hand rather
   * than taken from a profile.
   */
  transportProfileId: number;
  /** Fixed identifiers, for deterministic tests. Random when omitted. */
  sessionId?: number;
  fileId?: number;
  /**
   * A token from a receiver that already holds part of this file.
   *
   * When present the session adopts the token's session and file identifiers -
   * which is what makes the receiver recognise its own partial file - and
   * starts emitting at the token's segment rather than at zero. It is refused
   * unless the selected file's digest and segmentation both agree with it; see
   * `applyResume`.
   */
  resumeToken?: string;
}

/**
 * Knobs a transport profile does not own.
 *
 * A profile decides what goes on the wire and how fast. These decide how the
 * process behaves while doing it, and they are orthogonal - changing the
 * hashing chunk size is not a transport decision.
 */
export interface SenderRuntimeOptions {
  readAheadSegments: 0 | 1;
  frameQueueCapacity: number;
  manifestIntervalFrames: number;
  hashChunkBytes: number;
  sampleCompressibility: boolean;
  compressibilitySampleBytes: number;
  compressionEnabled: boolean;
  compressionThreshold: number;
  compressionWindowLog2: number;
  compressionLevel: number;
}

export const DEFAULT_SENDER_RUNTIME: Readonly<SenderRuntimeOptions> = Object.freeze({
  readAheadSegments: 0,
  frameQueueCapacity: 32,
  manifestIntervalFrames: 64,
  hashChunkBytes: 1024 * 1024,
  sampleCompressibility: true,
  compressibilitySampleBytes: 256 * 1024,
  compressionEnabled: true,
  compressionThreshold: DEFAULT_COMPRESSION_THRESHOLD,
  compressionWindowLog2: V2_COMPRESSION_WINDOW.defaultLog2,
  compressionLevel: DEFAULT_COMPRESSION_LEVEL,
});

/**
 * Turns a transport profile into a sender configuration.
 *
 * This is the only place symbol size, segment size and repair overhead are
 * decided, and it takes all three from one measured object rather than letting
 * them drift apart as three defaults. Phase 04 measured what they should be;
 * this is where that measurement reaches the wire.
 */
export function configFromProfile(
  profile: TransportProfile,
  runtime: Partial<SenderRuntimeOptions> = {},
): StreamingSenderConfig {
  const violations = validateTransportProfile(profile);
  if (violations.length > 0) {
    throw new DeqrError(
      ErrorCode.INVALID_TRANSFER_STATE,
      `transport profile ${profile.name} is not self-consistent: ${violations.join('; ')}`,
    );
  }
  return {
    ...DEFAULT_SENDER_RUNTIME,
    ...runtime,
    segmentSizeBytes: profile.segmentSizeBytes,
    symbolSizeBytes: profile.symbolSizeBytes,
    repairOverheadRatio: profile.repairOverheadRatio,
    transportProfileId: profile.id,
  };
}

/**
 * What a transfer uses unless somebody chooses another profile.
 *
 * Every transport value here comes from `BALANCED_PROFILE`, which Phase 04 read
 * off a measured decode-success surface rather than from QR capacity. The
 * repair ratio Phase 03 measured travels with it, so the three numbers that
 * decide throughput can no longer disagree with each other.
 */
export const DEFAULT_STREAMING_SENDER_CONFIG: Readonly<StreamingSenderConfig> = Object.freeze(
  configFromProfile(DEFAULT_TRANSPORT_PROFILE),
);

export function resolveStreamingSenderConfig(
  overrides: Partial<StreamingSenderConfig> = {},
): StreamingSenderConfig {
  const config = { ...DEFAULT_STREAMING_SENDER_CONFIG, ...overrides };

  if (config.symbolSizeBytes < V2_LIMITS.minSymbolSizeBytes
    || config.symbolSizeBytes > V2_LIMITS.maxSymbolSizeBytes) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'symbolSizeBytes is outside the v2 protocol range');
  }
  if (config.segmentSizeBytes < V2_LIMITS.minSegmentSizeBytes
    || config.segmentSizeBytes > V2_LIMITS.maxSegmentSizeBytes) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'segmentSizeBytes is outside the v2 protocol range');
  }
  if (config.segmentSizeBytes % config.symbolSizeBytes !== 0) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'segmentSizeBytes must be a whole number of symbols');
  }
  if (config.frameQueueCapacity < 1 || config.frameQueueCapacity > 4096) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'frameQueueCapacity must be between 1 and 4096');
  }
  if (config.manifestIntervalFrames < 1) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'manifestIntervalFrames must be at least 1');
  }
  if (config.repairOverheadRatio < 0 || config.repairOverheadRatio > 4) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'repairOverheadRatio must be between 0 and 4');
  }
  // Both of these share the segment buffer, so both are clamped to it at use.
  // Validating them against the segment size instead would make a perfectly
  // reasonable pairing - a small segment with the default 1 MiB hash chunk -
  // fail with an error about a knob the caller never set.
  if (config.hashChunkBytes < 4096 || config.hashChunkBytes > V2_LIMITS.maxSegmentSizeBytes) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'hashChunkBytes must be between 4 KiB and the maximum segment size');
  }
  if (config.compressibilitySampleBytes < 4096 || config.compressibilitySampleBytes > V2_LIMITS.maxSegmentSizeBytes) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'compressibilitySampleBytes must be between 4 KiB and the maximum segment size');
  }
  if (config.compressionThreshold < 0 || config.compressionThreshold > 1 || !Number.isFinite(config.compressionThreshold)) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'compressionThreshold must be a fraction between 0 and 1');
  }
  if (!Number.isInteger(config.compressionWindowLog2)
    || config.compressionWindowLog2 < V2_COMPRESSION_WINDOW.minLog2
    || config.compressionWindowLog2 > V2_COMPRESSION_WINDOW.maxLog2) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'compressionWindowLog2 is outside the v2 protocol range');
  }
  if (!Number.isInteger(config.compressionLevel) || config.compressionLevel < 1 || config.compressionLevel > 9) {
    throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'compressionLevel must be a zlib level between 1 and 9');
  }
  return config;
}

/* -------------------------------------------------------------- telemetry */

export interface SenderPreflight {
  filename: string;
  originalSize: bigint;
  segmentCount: number;
  segmentSizeBytes: number;
  symbolSizeBytes: number;
  sourceSymbolsTotal: number;
  sha256Hex: string;
  hashMs: number;
  hashBytesPerSecond: number;
  /** What the bytes measured. The decision below is made from it and nothing else. */
  compressibility: {
    sampled: boolean;
    inputBytes: number;
    outputBytes: number;
    ratio: number;
    ms: number;
  };
  /**
   * What is actually being put on the wire, and why.
   *
   * `transportSize` is the number the manifest carries and the segmentation is
   * derived from. It equals `originalSize` for an uncompressed transfer, and
   * that is not a coincidence to be relied on - it is a rule the protocol
   * enforces in both directions.
   */
  compression: {
    mode: number;
    /** 0 when uncompressed; otherwise log2 of the window size. */
    param: number;
    windowBytes: number;
    level: number;
    /** Bytes the segmentation is planned over. */
    transportSize: bigint;
    /** `transportSize / originalSize`. 1 when uncompressed. */
    ratio: number;
    /** Which rule produced this outcome. */
    reason: string;
    threshold: number;
    /** Gain the sample predicted, before the file was walked. */
    predictedGain: number;
    /** Wall-clock inside gzip during the sizing walk. */
    measureMs: number;
    /** Original bytes per second through the sizing walk, gzip included. */
    measureBytesPerSecond: number;
  };
  /**
   * Where this pass starts, and why.
   *
   * `0` for a fresh transfer. Anything else means a resume token was accepted,
   * and the segments below it are deliberately not sent - which is the whole
   * saving, and which has to be visible in the telemetry or nobody can tell a
   * resume from a transfer that silently lost its beginning.
   */
  resumeFromSegment: number;
  resumed: boolean;
}

/**
 * Progress with three separate meanings, deliberately not collapsed.
 *
 * v1 reported frames produced and called it progress, which overstates a
 * transfer the moment repair symbols or a retransmitted manifest enter the
 * stream. Original bytes covered, bytes put on the wire, and frames emitted are
 * three different questions, and only the receiver can answer a fourth —
 * how much has actually been recovered.
 */
export interface SenderProgress {
  originalBytesTotal: bigint;
  transportBytesTotal: bigint;
  /** Distinct original bytes carried by source symbols emitted so far. */
  transportBytesCovered: bigint;
  /** Every byte handed to the display, headers, repair and manifests included. */
  bytesOnTheWire: bigint;
  segmentCount: number;
  segmentsCompleted: number;
  currentSegmentIndex: number;
  framesEmitted: number;
  manifestFramesEmitted: number;
  sourceSymbolsEmitted: number;
  repairSymbolsEmitted: number;
  /**
   * Repair symbols emitted by the recovery tail, counted apart from the pass.
   *
   * Separate because they answer different questions. The pass's repair is a
   * budget spent whether or not anything needed it; these were sent because a
   * receiver said, or was assumed, to be short. A recovery count that keeps
   * climbing with no completion is the signal that the link, not the coding, is
   * the problem.
   */
  recoverySymbolsEmitted: number;
  /** True while the recovery tail is producing. Never true during the first pass. */
  recovering: boolean;
  complete: boolean;
  /** First segment this pass emits. Non-zero only for a resumed transfer. */
  resumeFromSegment: number;
}

/* ------------------------------------------------------------------ session */

export class StreamingTransferSession {
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;

  private readonly encoder: SegmentEncoder;
  private readonly symbolScratch: Uint8Array;
  private segmentBuffer: Uint8Array;
  private readAheadBuffer: Uint8Array | null;
  private loadedSegmentIndex = -1;
  private loadedSegmentBytes = 0;
  private prefetchedSegmentIndex = -1;
  private prefetchedSegmentBytes = 0;

  private segmentIndex = 0;
  private symbolCursor = 0;
  private framesProduced = 0;
  private done = false;
  /**
   * Which pass this session is emitting.
   *
   * `pass` is the systematic-plus-budgeted-repair walk every transfer starts
   * with. `recovery` is what Phase 13 added, and it exists because the previous
   * behaviour had no answer to the commonest real failure: the pass ends, the
   * receiver is short by some symbols, and there is nothing left to send. The
   * sender simply stopped, and a receiver that had missed anything stayed
   * incomplete for good.
   */
  private phase: 'pass' | 'recovery' = 'pass';
  /** Segments recovery is generating for. Round-robin, so all advance together. */
  private recoveryTargets: number[] = [];
  private recoveryCursor = 0;
  /** Symbols left in the current target's batch. See `produceRecoverySymbol`. */
  private recoveryBatchRemaining = 0;
  /** Source symbols in the batch being emitted, so its progress is derivable. */
  private recoveryBatchSource = 0;
  /** Segments a resume token said were missing, if one opened this session. */
  private resumeTargets: number[] | null = null;
  /**
   * Next repair symbol id to emit per segment.
   *
   * The reason recovery is useful rather than noise. Symbol ids seed the repair
   * generator, so continuing to climb produces symbols the receiver has never
   * seen; restarting at the pass's first repair id would retransmit frames it
   * has already rejected as duplicates. "Do not endlessly repeat identical
   * repair frames" is enforced by this map rather than hoped for.
   */
  private readonly recoveryNextSymbolId = new Map<number, number>();
  private disposed = false;

  private readonly counters = {
    framesEmitted: 0,
    manifestFramesEmitted: 0,
    sourceSymbolsEmitted: 0,
    repairSymbolsEmitted: 0,
    recoverySymbolsEmitted: 0,
    bytesOnTheWire: 0n,
    transportBytesCovered: 0n,
    segmentsCompleted: 0,
  };

  private constructor(
    private readonly handle: SenderFileHandle,
    private readonly openStat: SenderFileStat,
    public readonly config: StreamingSenderConfig,
    public readonly manifest: DeqrV2Manifest,
    public readonly plan: SegmentPlan,
    private readonly manifestFrameBytes: Uint8Array,
    public readonly preflight: SenderPreflight,
    private readonly signal: AbortSignal | undefined,
    /**
     * Present only when this transfer is compressed.
     *
     * When it is, it - and not the file handle - is what `readSegment` reads
     * from: the plan's byte ranges are ranges of the *container*, and the file
     * is now something only the compressor touches.
     */
    private readonly compressor: WindowContainerEncoder | null,
  ) {
    this.encoder = new SegmentEncoder(config.symbolSizeBytes);
    this.symbolScratch = new Uint8Array(config.symbolSizeBytes);
    this.segmentBuffer = new Uint8Array(config.segmentSizeBytes);
    this.readAheadBuffer = config.readAheadSegments === 1
      ? new Uint8Array(config.segmentSizeBytes)
      : null;
    // The only thing a resume changes about production: where the cursor
    // starts. Everything downstream - the encoder, the read path, the frame
    // shapes, the manifest cadence - is identical, which is why a resumed
    // transfer needs no separate code path to be correct.
    this.segmentIndex = preflight.resumeFromSegment;
  }

  /**
   * Opens a file and prepares a transfer without ever holding it whole.
   *
   * Preflight costs one sequential pass to compute SHA-256, which is the price
   * of promising a digest before the first frame is drawn. At the measured
   * 400+ MiB/s that pass is under three seconds per gigabyte, against an
   * optical link that needs hours for the same bytes.
   */
  static async open(
    filePath: string,
    overrides: Partial<StreamingSenderConfig> = {},
    opener: SenderFileOpener = nodeFileOpener,
    signal?: AbortSignal,
  ): Promise<StreamingTransferSession> {
    const config = resolveStreamingSenderConfig(overrides);
    const filename = sanitizeFilename(path.parse(filePath).base);
    if (isBlockedExtension(filename)) {
      throw new DeqrError(ErrorCode.FILE_TYPE_BLOCKED, 'File extension is blocked by security policy');
    }

    const handle = await opener(filePath);
    try {
      throwIfAborted(signal);
      const openStat = await handle.stat();
      if (!openStat.isFile) {
        throw new DeqrError(ErrorCode.FILE_NOT_REGULAR, 'Selected path is not a regular file');
      }
      if (openStat.size < 1n) {
        throw new DeqrError(ErrorCode.FILE_EMPTY, 'An empty file has nothing to transfer.');
      }
      if (openStat.size > V2_LIMITS.maxFileBytes) {
        throw new DeqrError(ErrorCode.FILE_TOO_LARGE, 'File size exceeds what the DEQR v2 protocol can describe.');
      }

      // One scratch buffer serves preflight too, so preflight adds nothing to
      // the memory budget the transfer itself already justifies.
      const scratch = new Uint8Array(config.segmentSizeBytes);
      const compressibility = config.sampleCompressibility
        ? await sampleCompressibility(handle, openStat.size, scratch, config, signal)
        : { sampled: false, inputBytes: 0, outputBytes: 0, ratio: 1, ms: 0 };

      // The whole of the compression decision, made from a sampled ratio and a
      // size. It cannot see the filename: `decideCompression` has no parameter
      // for one, which is how the "no extension-specific transport" rule is
      // held rather than merely intended.
      const windowBytes = compressionWindowBytes(config.compressionWindowLog2);
      const decision = decideCompression(
        Number(openStat.size),
        {
          inputBytes: compressibility.inputBytes,
          outputBytes: compressibility.outputBytes,
          elapsedMs: compressibility.ms,
        },
        {
          threshold: config.compressionThreshold,
          windowBytes,
          enabled: config.compressionEnabled,
        },
      );

      // One pass over the file, whichever branch is taken. When the sample says
      // compression is worth trying, that pass hashes *and* compresses from the
      // same read - the digest is over original bytes either way, so fusing
      // them costs nothing and saves a second walk of a multi-gigabyte file.
      let sha256: Uint8Array;
      let hashMs: number;
      let encoder: WindowContainerEncoder | null = null;
      let confirmation: CompressionDecision | null = null;
      let transportSize = openStat.size;
      let compressionMode: number = V2_COMPRESSION.NONE;
      let compressionParam = 0;
      /** gzip-only time inside the sizing walk, separated from the read and the hash. */
      let encoderMeasureMs = 0;

      if (decision.compress) {
        const candidate = new WindowContainerEncoder({
          source: handle,
          originalSize: openStat.size,
          windowBytes,
          level: config.compressionLevel,
          signal,
        });
        const digest = createHash('sha256');
        const started = Date.now();
        const measurement = await candidate.measure({ onWindow: (bytes) => digest.update(bytes) });
        hashMs = Date.now() - started;
        encoderMeasureMs = candidate.compressionMilliseconds;
        sha256 = new Uint8Array(digest.digest());

        // The sample was three windows. This is the file. When they disagree,
        // the file wins and the transfer goes out uncompressed - which is why a
        // sample can only ever cost preflight time, never correctness.
        confirmation = confirmCompression(
          Number(openStat.size),
          Number(measurement.transportSize),
          { threshold: config.compressionThreshold },
        );
        if (confirmation.compress) {
          encoder = candidate;
          transportSize = measurement.transportSize;
          compressionMode = V2_COMPRESSION.GZIP;
          compressionParam = config.compressionWindowLog2;
        } else {
          candidate.release();
        }
      } else {
        const hashStart = Date.now();
        sha256 = await hashWholeFile(handle, openStat.size, scratch, config, signal);
        hashMs = Date.now() - hashStart;
      }

      // A file rewritten while it was being hashed would produce a digest for
      // bytes that are no longer there, and the receiver would fail
      // verification hours later with nothing to point at.
      const afterHash = await handle.stat();
      assertUnchanged(openStat, afterHash);

      const plan = planSegmentation({
        transportSize,
        segmentSizeBytes: config.segmentSizeBytes,
        symbolSizeBytes: config.symbolSizeBytes,
      });

      // Checked against the digest and the plan that were just computed, so a
      // token for a different file or a different segmentation is refused here
      // rather than after the receiver has scanned a screen full of segments
      // that will never fit the file it is holding.
      const resume = config.resumeToken === undefined
        ? null
        : applyResume(config.resumeToken, sha256, plan);

      const manifest: DeqrV2Manifest = {
        featureFlags: 0,
        sessionId: resume?.sessionId ?? config.sessionId ?? randomUint32(),
        fileId: resume?.fileId ?? config.fileId ?? randomUint32(),
        originalSize: openStat.size,
        transportSize,
        segmentSizeBytes: config.segmentSizeBytes,
        symbolSizeBytes: config.symbolSizeBytes,
        segmentCount: plan.segmentCount,
        fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
        compressionMode,
        compressionParam,
        transportProfileId: config.transportProfileId,
        sha256,
        filename,
        mimeType: 'application/octet-stream',
      };

      const preflight: SenderPreflight = {
        filename,
        originalSize: openStat.size,
        segmentCount: plan.segmentCount,
        segmentSizeBytes: config.segmentSizeBytes,
        symbolSizeBytes: config.symbolSizeBytes,
        sourceSymbolsTotal: plan.symbolsPerFullSegment * (plan.segmentCount - 1) + plan.symbolsInLastSegment,
        sha256Hex: toHex(sha256),
        // Wall clock of whichever pass produced the digest. On the compressed
        // branch that pass also gzipped the file, so this is the fused cost and
        // not a hashing rate to compare against the uncompressed one.
        hashMs,
        hashBytesPerSecond: hashMs > 0 ? Number(openStat.size) / (hashMs / 1_000) : 0,
        compressibility,
        compression: {
          mode: compressionMode,
          param: compressionParam,
          windowBytes,
          level: config.compressionLevel,
          transportSize,
          ratio: Number(transportSize) / Number(openStat.size),
          reason: confirmation ? confirmation.reason : decision.reason,
          threshold: decision.threshold,
          predictedGain: decision.predictedGain,
          measureMs: encoderMeasureMs,
          measureBytesPerSecond: encoderMeasureMs > 0
            ? Number(openStat.size) / (encoderMeasureMs / 1_000)
            : 0,
        },
        // A token that says "resume from the end" describes a receiver that has
        // every segment and only needs to verify. Emitting nothing would leave
        // it with no manifest to re-acquire the session from, so the pass is
        // clamped to the last segment and replays it.
        resumeFromSegment: resume ? Math.min(resume.resumeFromSegment, plan.segmentCount - 1) : 0,
        resumed: resume !== null,
      };

      const session = new StreamingTransferSession(
        handle,
        openStat,
        config,
        manifest,
        plan,
        serializeManifestFrame(manifest),
        preflight,
        signal,
        encoder,
      );
      // A v2 token named the gaps. Remembering them is what lets a recovery
      // pass started later default to *those* segments rather than to the whole
      // file, without the caller having to carry the token around.
      if (resume) session.rememberResumeTargets(resumeTokenTargets(resume));
      return session;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /* ------------------------------------------------------------- accounting */

  /** Bytes the pipeline may hold at once, computed from configuration alone. */
  memoryBudgetBytes(): number {
    const { segmentSizeBytes, symbolSizeBytes, readAheadSegments, frameQueueCapacity } = this.config;
    const frameBytes = symbolSizeBytes + V2_DATA_LAYOUT.overheadBytes;
    const symbolsPerSegment = segmentSizeBytes / symbolSizeBytes;
    return segmentSizeBytes
      + segmentSizeBytes * readAheadSegments
      + symbolSizeBytes
      + frameQueueCapacity * frameBytes
      + this.manifestFrameBytes.length
      // Two `number[]` of length K+1 inside the degree distribution.
      + 16 * (symbolsPerSegment + 1)
      // One original window plus the record it compresses to. Zero when the
      // transfer is uncompressed, and still a function of configuration rather
      // than of the file: a window is a window whether the file is a megabyte
      // or a terabyte.
      + (this.compressor ? compressorBudgetBytes(this.preflight.compression.windowBytes) : 0);
  }

  /** Bytes actually held right now. Never exceeds `memoryBudgetBytes()`. */
  bufferedBytes(): number {
    const symbolsPerSegment = this.config.segmentSizeBytes / this.config.symbolSizeBytes;
    return this.segmentBuffer.length
      + (this.readAheadBuffer?.length ?? 0)
      + this.symbolScratch.length
      + this.queuedBytes
      + this.manifestFrameBytes.length
      + (this.encoder.hasSegment ? 16 * (symbolsPerSegment + 1) : 0)
      + (this.compressor?.memoryBytes() ?? 0);
  }

  queueDepth(): number {
    return this.queue.length;
  }

  progress(): SenderProgress {
    return {
      originalBytesTotal: this.manifest.originalSize,
      transportBytesTotal: this.manifest.transportSize,
      transportBytesCovered: this.counters.transportBytesCovered,
      bytesOnTheWire: this.counters.bytesOnTheWire,
      segmentCount: this.plan.segmentCount,
      segmentsCompleted: this.counters.segmentsCompleted,
      currentSegmentIndex: Math.min(this.segmentIndex, this.plan.segmentCount - 1),
      framesEmitted: this.counters.framesEmitted,
      manifestFramesEmitted: this.counters.manifestFramesEmitted,
      sourceSymbolsEmitted: this.counters.sourceSymbolsEmitted,
      repairSymbolsEmitted: this.counters.repairSymbolsEmitted,
      recoverySymbolsEmitted: this.counters.recoverySymbolsEmitted,
      recovering: this.isRecovering,
      complete: this.done && this.queue.length === 0,
      resumeFromSegment: this.preflight.resumeFromSegment,
    };
  }

  /** Source plus repair symbols the segment will emit in one pass. */
  symbolsForSegment(segmentIndex: number): number {
    const source = sourceSymbolCountForSegment(this.plan, segmentIndex);
    return source + Math.ceil(source * this.config.repairOverheadRatio);
  }

  /* ------------------------------------------------------------ production */

  /**
   * Next QR-ready frame, or `null` when the pass is finished.
   *
   * This is the only thing that drives the encoder and the reader. A consumer
   * that stops calling it stops the pipeline; that is what makes the memory
   * bound hold rather than merely be intended.
   */
  async take(): Promise<Uint8Array | null> {
    if (this.disposed) throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'Transfer session is closed.');
    throwIfAborted(this.signal);

    if (this.queue.length === 0) await this.fill();
    const frame = this.queue.shift();
    if (!frame) return null;

    this.queuedBytes -= frame.length;
    this.counters.framesEmitted += 1;
    this.counters.bytesOnTheWire += BigInt(frame.length);
    return frame;
  }

  /** Fills the ready queue to capacity, then prefetches if configured and allowed. */
  private async fill(): Promise<void> {
    while (!this.done && this.queue.length < this.config.frameQueueCapacity) {
      throwIfAborted(this.signal);
      const frame = await this.produce();
      if (!frame) break;
      this.queue.push(frame);
      this.queuedBytes += frame.length;
    }
    if (this.config.readAheadSegments === 1) await this.prefetchNextSegment();
  }

  private async produce(): Promise<Uint8Array | null> {
    if (this.done) return null;

    // The first frame of a transfer is a manifest, and one recurs on the
    // configured interval. A receiver that starts scanning late has to be able
    // to acquire the session without having seen its beginning. The cadence is
    // kept through recovery too: someone who starts scanning *during* a
    // recovery pass needs the session description just as much.
    if (this.framesProduced % this.config.manifestIntervalFrames === 0) {
      this.framesProduced += 1;
      this.counters.manifestFramesEmitted += 1;
      return this.manifestFrameBytes;
    }

    if (this.phase === 'recovery') return this.produceRecoverySymbol();

    if (!(await this.advanceToPendingSymbol())) return null;

    const sourceCount = this.encoder.sourceSymbolCount;
    const symbolId = this.symbolCursor;
    const isSource = symbolId < sourceCount;
    this.encoder.symbolInto(symbolId, this.symbolScratch);

    const frame = serializeDataFrame({
      frameType: isSource ? V2_FRAME_TYPE.SOURCE : V2_FRAME_TYPE.REPAIR,
      sessionId: this.manifest.sessionId,
      fileId: this.manifest.fileId,
      segmentIndex: this.segmentIndex,
      symbolId,
      sourceSymbolCount: sourceCount,
      frameFlags: 0,
      payload: this.symbolScratch,
    });

    if (isSource) {
      this.counters.sourceSymbolsEmitted += 1;
      // Only the bytes the file actually has, not the zero padding that makes
      // the final symbol of a segment full length.
      const realBytes = Math.min(
        this.config.symbolSizeBytes,
        this.loadedSegmentBytes - symbolId * this.config.symbolSizeBytes,
      );
      this.counters.transportBytesCovered += BigInt(Math.max(0, realBytes));
    } else {
      this.counters.repairSymbolsEmitted += 1;
    }

    this.symbolCursor += 1;
    this.framesProduced += 1;
    return frame;
  }

  /**
   * Ensures a symbol is pending, advancing segments as they are exhausted.
   * Returns false when the whole pass is complete.
   */
  /**
   * Starts a recovery pass for segments the receiver is still missing.
   *
   * Explicit rather than automatic, and that is the point. The pass ending is
   * a real event a person should see — "every frame has been displayed" is
   * true and worth saying — and continuing to emit repair forever by default
   * would make a finished transfer indistinguishable from a stuck one. So the
   * sender stops, says so, and recovers when asked.
   *
   * With no targets it recovers every segment, which is the honest default when
   * nothing has told it which are missing: the optical link is one-way, so
   * absent a resume code the sender cannot know. `beginRecovery` with targets
   * is what a resume code turns into, and it is strictly better — see the
   * targeted-resume path.
   *
   * Returns how many segments the tail will generate for.
   */
  beginRecovery(targetSegments?: readonly number[]): number {
    if (this.disposed) throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'Transfer session is closed.');

    const all = () => Array.from({ length: this.plan.segmentCount }, (_unused, index) => index);
    // Order of preference when the caller names nothing: what a resume token
    // said is missing, then everything. The middle option does not exist -
    // there is no third source of truth about what a receiver holds.
    const fallback = () => this.resumeTargets ?? all();
    const requested = targetSegments === undefined
      ? fallback()
      : [...new Set(targetSegments)]
        .filter((index) => Number.isInteger(index) && index >= 0 && index < this.plan.segmentCount)
        .sort((left, right) => left - right);

    // An empty or wholly out-of-range request means the caller believes nothing
    // is missing. Recovering everything on that basis would be the opposite of
    // targeted, so the tail stays closed and says it generated for nothing.
    this.recoveryTargets = requested;
    // Cursor sits one before the first target and the batch is empty, so the
    // first call advances onto target zero rather than skipping it.
    this.recoveryCursor = requested.length - 1;
    this.recoveryBatchRemaining = 0;
    if (requested.length === 0) return 0;

    this.phase = 'recovery';
    this.done = false;
    return requested.length;
  }

  /**
   * Records what a resume token said this receiver still needs.
   *
   * Called once at open. Kept separate from `beginRecovery` so the token is
   * validated where every other identity check happens — before a session
   * exists — rather than at the moment someone presses a recovery button.
   */
  rememberResumeTargets(targets: readonly number[]): void {
    const bounded = [...new Set(targets)]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < this.plan.segmentCount)
      .sort((left, right) => left - right);
    this.resumeTargets = bounded.length > 0 ? bounded : null;
  }

  /** Whether a recovery pass is currently producing frames. */
  get isRecovering(): boolean {
    return this.phase === 'recovery' && this.recoveryTargets.length > 0;
  }

  /**
   * One fresh repair symbol for the segment recovery is currently working on.
   *
   * **In batches, not round-robin, and the receiver's memory bound is why.** It
   * keeps at most `maxActiveSegments` decoders alive — two by default — and
   * evicting a decoder discards its partial progress, because holding partial
   * state for every segment is exactly the unbounded growth segmentation
   * exists to prevent. Interleaving one symbol per target across four missing
   * segments therefore makes *negative* progress: every symbol arrives for a
   * segment whose decoder was evicted two symbols ago and recreated empty.
   *
   * This was measured, not reasoned about. The first version of this tail was
   * round-robin, and a receiver missing four segments never completed one.
   *
   * So a batch is a whole segment's worth plus the configured overhead, which
   * is enough for a decoder that starts empty to finish before the next target
   * displaces it. The cost is that a receiver missing one symbol from segment 3
   * waits through segment 0's batch, which is bounded and visible; the
   * alternative is a tail that transmits forever and completes nothing.
   */
  private async produceRecoverySymbol(): Promise<Uint8Array | null> {
    if (this.recoveryTargets.length === 0) {
      this.done = true;
      return null;
    }

    if (this.recoveryBatchRemaining <= 0) {
      this.recoveryCursor = (this.recoveryCursor + 1) % this.recoveryTargets.length;
      const next = this.recoveryTargets[this.recoveryCursor];
      const source = sourceSymbolCountForSegment(this.plan, next);
      this.recoveryBatchRemaining = source + Math.ceil(source * this.config.repairOverheadRatio);
      this.recoveryBatchSource = source;
    }

    const target = this.recoveryTargets[this.recoveryCursor];
    await this.ensureSegmentLoaded(target);
    const sourceCount = this.encoder.sourceSymbolCount;

    // Systematic first, again, and this is not a nicety - it is the difference
    // between a recovery tail that works and one that cannot.
    //
    // The receiver's decoder holds at most `sourceSymbolCount` pending
    // equations, a deliberate memory bound: a repair symbol that cannot yet be
    // reduced is stored, and once k of them are stored every further one is
    // rejected as saturated. A segment that lost *all* its source symbols
    // therefore fills that budget with unsolvable algebra and then refuses
    // everything after it, and no repair budget rescues it - measured at 1.5x,
    // 2.5x and 4x overhead, none of which recovered such a segment.
    //
    // Repair alone is thus useful only where some source already landed, which
    // is the common case and not the only one: a burst that takes a whole
    // segment is exactly what a hand moving in front of a camera produces. So a
    // recovery batch replays the segment's source symbols before generating
    // fresh repair. A receiver missing two of them discards the rest by
    // fingerprint at almost no cost; a receiver missing all of them is rebuilt
    // outright, with no algebra at all.
    const emittedInBatch = this.recoveryBatchSource
      + Math.ceil(this.recoveryBatchSource * this.config.repairOverheadRatio)
      - this.recoveryBatchRemaining;
    this.recoveryBatchRemaining -= 1;

    let symbolId: number;
    let isSource: boolean;
    if (emittedInBatch < sourceCount) {
      symbolId = emittedInBatch;
      isSource = true;
    } else {
      // Ids continue above everything already emitted for this segment, so a
      // recovery repair symbol is never one the receiver has seen and rejected.
      symbolId = this.recoveryNextSymbolId.get(target) ?? this.symbolsForSegment(target);
      this.recoveryNextSymbolId.set(target, symbolId + 1);
      isSource = false;
    }

    this.encoder.symbolInto(symbolId, this.symbolScratch);
    const frame = serializeDataFrame({
      frameType: isSource ? V2_FRAME_TYPE.SOURCE : V2_FRAME_TYPE.REPAIR,
      sessionId: this.manifest.sessionId,
      fileId: this.manifest.fileId,
      segmentIndex: target,
      symbolId,
      sourceSymbolCount: sourceCount,
      frameFlags: 0,
      payload: this.symbolScratch,
    });

    if (isSource) this.counters.sourceSymbolsEmitted += 1;
    else this.counters.repairSymbolsEmitted += 1;
    this.counters.recoverySymbolsEmitted += 1;
    this.framesProduced += 1;
    return frame;
  }

  private async advanceToPendingSymbol(): Promise<boolean> {
    while (true) {
      if (this.segmentIndex >= this.plan.segmentCount) {
        this.done = true;
        this.encoder.release();
        return false;
      }
      await this.ensureSegmentLoaded(this.segmentIndex);
      if (this.symbolCursor < this.symbolsForSegment(this.segmentIndex)) return true;

      this.counters.segmentsCompleted += 1;
      this.segmentIndex += 1;
      this.symbolCursor = 0;
    }
  }

  private async ensureSegmentLoaded(index: number): Promise<void> {
    if (this.loadedSegmentIndex === index && this.encoder.hasSegment) return;

    if (this.readAheadBuffer && this.prefetchedSegmentIndex === index) {
      // Swap rather than copy: the prefetch buffer becomes the live segment and
      // the old live buffer becomes the next prefetch target.
      const previous = this.segmentBuffer;
      this.segmentBuffer = this.readAheadBuffer;
      this.readAheadBuffer = previous;
      this.loadedSegmentIndex = index;
      this.loadedSegmentBytes = this.prefetchedSegmentBytes;
      this.prefetchedSegmentIndex = -1;
      this.prefetchedSegmentBytes = 0;
    } else {
      this.loadedSegmentBytes = await this.readSegment(index, this.segmentBuffer);
      this.loadedSegmentIndex = index;
    }

    this.encoder.loadSegment(this.segmentBuffer.subarray(0, this.loadedSegmentBytes));
  }

  private async prefetchNextSegment(): Promise<void> {
    const next = this.segmentIndex + 1;
    if (!this.readAheadBuffer || this.done) return;
    if (next >= this.plan.segmentCount || this.prefetchedSegmentIndex === next) return;
    this.prefetchedSegmentBytes = await this.readSegment(next, this.readAheadBuffer);
    this.prefetchedSegmentIndex = next;
  }

  /**
   * Reads one segment into a caller-owned buffer.
   *
   * Re-stats first. A file that is rewritten or truncated under an open handle
   * is not a hypothetical — it is what happens when a user saves over the thing
   * they are sending — and a short read here would otherwise become a
   * verification failure hours later with nothing to point at.
   */
  private async readSegment(index: number, into: Uint8Array): Promise<number> {
    throwIfAborted(this.signal);
    assertUnchanged(this.openStat, await this.handle.stat());

    const { start, end } = segmentByteRange(this.plan, index);
    const length = Number(end - start);

    // A compressed transfer's segments are ranges of the container, so the
    // compressor answers them. It reads the file itself, through the same
    // handle and after the same freshness check.
    if (this.compressor) {
      const produced = await this.compressor.readTransport(start, into, length);
      if (produced !== length) {
        throw new DeqrError(
          ErrorCode.INVALID_TRANSFER_STATE,
          `The compressed stream produced ${produced} of the ${length} bytes segment ${index} needs.`,
        );
      }
      return length;
    }

    let filled = 0;
    while (filled < length) {
      const bytesRead = await this.handle.read(
        into.subarray(filled, length),
        length - filled,
        start + BigInt(filled),
      );
      if (bytesRead <= 0) {
        throw new DeqrError(
          ErrorCode.FILE_CHANGED_DURING_TRANSFER,
          'The source file ended earlier than its size promised. It may have been modified.',
        );
      }
      filled += bytesRead;
    }
    return length;
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Releases the descriptor, the queue, and the encoder state.
   *
   * Idempotent, and safe to call from a cancel, an error, or a window close.
   * `take()` refuses afterwards rather than reading from a closed handle.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.done = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.encoder.release();
    this.compressor?.release();
    this.segmentBuffer.fill(0);
    this.readAheadBuffer?.fill(0);
    this.symbolScratch.fill(0);
    this.loadedSegmentIndex = -1;
    this.prefetchedSegmentIndex = -1;
    await this.handle.close();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Decides whether a resume token may be applied to the file just opened.
 *
 * Three refusals, and they are separate because they are three different
 * mistakes a person makes at a desktop:
 *
 * - **The token will not read.** A typo, a truncated paste, a token from a
 *   build that writes a different shape. Retyping fixes the first two.
 * - **A different file.** The digest prefix disagrees, so applying the token
 *   would drive the receiver's partial file with bytes from something else -
 *   which would not be caught until the final SHA-256 hours later. Refusing
 *   here turns hours into a second.
 * - **A different segmentation.** Same bytes, different transport profile.
 *   Segment 400 of a 1 MiB plan is not segment 400 of a 4 MiB plan, and
 *   sending one into the other would place real data at wrong offsets.
 *
 * The digest check reads five bytes and is not the authority on anything: it
 * exists to catch the wrong file early. SHA-256 over the reconstruction is
 * still what decides whether a transfer is real.
 */
function applyResume(
  token: string,
  sha256: Uint8Array,
  plan: SegmentPlan,
): TargetedResumeToken {
  // Reads either shape. A v2 token additionally names the gaps, which is what
  // turns "restart here and resend everything after it" into a recovery pass
  // that transmits only what is missing.
  const decoded = decodeTargetedResumeToken(token);
  if (!decoded.ok) {
    throw new DeqrError(
      ErrorCode.RESUME_TOKEN_INVALID,
      `The resume code could not be read (${decoded.code}). Check it against the phone and try again.`,
    );
  }
  if (!resumeTokenMatchesDigest(decoded.value, sha256)) {
    throw new DeqrError(
      ErrorCode.RESUME_FILE_MISMATCH,
      'That resume code belongs to a different file. Select the file the transfer was started with.',
    );
  }
  if (decoded.value.segmentCount !== plan.segmentCount) {
    throw new DeqrError(
      ErrorCode.RESUME_PLAN_MISMATCH,
      'That resume code was made with a different transport profile. Use the same profile to resume.',
    );
  }
  return decoded.value;
}

/**
 * The token a receiver would need to resume this session from a given segment.
 *
 * Lives here rather than only on the receiver because the desktop is where a
 * resume is entered, and a sender that can produce the token for its own
 * session is what makes the round trip testable end to end without a phone.
 */
export function senderResumeToken(
  manifest: DeqrV2Manifest,
  plan: SegmentPlan,
  resumeFromSegment: number,
): string {
  return encodeResumeToken({
    sessionId: manifest.sessionId,
    fileId: manifest.fileId,
    segmentCount: plan.segmentCount,
    resumeFromSegment,
    sha256: manifest.sha256,
  });
}

/**
 * Worst case bytes a window compressor holds: one window in, one record out.
 *
 * The output term is the same ceiling the receiver checks a declared record
 * length against, so the sender's budget and the receiver's allocation guard
 * cannot drift apart. It is a bound and not a measurement, which is what a
 * memory *budget* has to be.
 */
export function compressorBudgetBytes(windowBytes: number): number {
  return windowBytes + maxCompressedWindowBytes(windowBytes);
}

function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DeqrError(ErrorCode.TRANSFER_CANCELLED, 'Transfer was cancelled.');
  }
}

function assertUnchanged(before: SenderFileStat, now: SenderFileStat): void {
  if (before.size !== now.size || before.mtimeMs !== now.mtimeMs) {
    throw new DeqrError(
      ErrorCode.FILE_CHANGED_DURING_TRANSFER,
      'The source file changed while it was being sent. Start the transfer again.',
    );
  }
}

/** One sequential pass, one reusable buffer, incremental digest. */
async function hashWholeFile(
  handle: SenderFileHandle,
  size: bigint,
  scratch: Uint8Array,
  config: StreamingSenderConfig,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const digest = createHash('sha256');
  let position = 0n;
  while (position < size) {
    throwIfAborted(signal);
    const remaining = size - position;
    const chunk = Math.min(config.hashChunkBytes, scratch.length);
    const want = remaining < BigInt(chunk) ? Number(remaining) : chunk;
    const bytesRead = await handle.read(scratch.subarray(0, want), want, position);
    if (bytesRead <= 0) {
      throw new DeqrError(
        ErrorCode.FILE_CHANGED_DURING_TRANSFER,
        'The source file ended earlier than its size promised. It may have been modified.',
      );
    }
    digest.update(scratch.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }
  return new Uint8Array(digest.digest());
}

/**
 * Compressibility from three sampled windows, never from the extension.
 *
 * Phase 00 proved the extension changes nothing about transport and that
 * content entropy is the real effect, so this measures the bytes. It reuses the
 * caller's scratch buffer, so sampling costs no additional memory.
 *
 * Three windows, each bounded, and nothing else read. What is done with the
 * ratio is `compression-policy.ts`'s decision - this function's only job is to
 * produce evidence, and it has no way to know or ask what the file is called.
 */
async function sampleCompressibility(
  handle: SenderFileHandle,
  size: bigint,
  scratch: Uint8Array,
  config: StreamingSenderConfig,
  signal: AbortSignal | undefined,
): Promise<SenderPreflight['compressibility']> {
  const window = BigInt(Math.min(config.compressibilitySampleBytes, scratch.length));
  const offsets = [...new Set([
    0n,
    size > window ? (size / 2n) - (window / 2n) : 0n,
    size > window ? size - window : 0n,
  ].map((offset) => (offset < 0n ? 0n : offset)))];

  let inputBytes = 0;
  let outputBytes = 0;
  const started = Date.now();
  for (const offset of offsets) {
    throwIfAborted(signal);
    const remaining = size - offset;
    const want = Number(remaining < window ? remaining : window);
    if (want <= 0) continue;
    const bytesRead = await handle.read(scratch.subarray(0, want), want, offset);
    if (bytesRead <= 0) break;
    inputBytes += bytesRead;
    outputBytes += gzipSync(scratch.subarray(0, bytesRead), { level: 6 }).length;
  }

  return {
    sampled: inputBytes > 0,
    inputBytes,
    outputBytes,
    ratio: inputBytes > 0 ? outputBytes / inputBytes : 1,
    ms: Date.now() - started,
  };
}
