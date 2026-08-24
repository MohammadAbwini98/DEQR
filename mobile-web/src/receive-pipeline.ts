/**
 * Everything that happens to a frame after it has been decoded, off the main thread.
 *
 * Before Phase 05, jsQR ran in a worker and *everything else* ran on the main
 * thread: frame parsing, checksum validation, duplicate detection, fountain
 * elimination, the ripple that cascades when a symbol is solved, container
 * parsing, and the SHA-256 of the whole file. All of it inside a React
 * callback, between the camera and a `setState`. At v1's rate that was tolerable.
 * At the rates Phase 04's profiles are built for it is the reason the UI stops
 * answering a Cancel tap.
 *
 * This module is that work, expressed as a plain class with no worker, no DOM,
 * and no React in it - which is the property that lets it be tested directly
 * and run under a synthetic load harness. `receive-worker.ts` is a thin shell
 * that owns a jsQR decode and one of these.
 *
 * ## What it decides
 *
 * - **Both protocols, one pipeline.** `detectProtocolVersion` routes: v1 to the
 *   original `ReceiverSession`, v2 to the `SegmentedReceiver` the sender and
 *   receiver now share. Since Phase 09 the desktop UI emits v2 for every
 *   optical transfer, so v1 is no longer what this receiver is fed - it is
 *   what it must still *accept*. A phone updates independently of the desktop
 *   it scans, so a receiver that dropped v1 would stop reading senders that are
 *   still on the previous release. Removing it is a decision with an
 *   installed-base cost, not a cleanup.
 * - **A malformed frame is a counted reject, not a dead transfer.** v1's
 *   session fails itself on the first frame that will not parse. That is right
 *   for a byte stream and wrong for a camera, where a marginal decode is a
 *   normal event and gets more likely as the frame rate rises. So the pipeline
 *   parses first and only hands the session frames that are already well
 *   formed. Every v1 rule that matters - session isolation, conflicting
 *   duplicates, resource limits - still runs, because the session still sees
 *   every valid frame.
 * - **Verification happens here too**, and since Phase 06 it happens *without
 *   the file*. `crypto.subtle.digest` needs its whole input resident, so a
 *   receiver that never held the file could not have used it. The digest is
 *   computed incrementally over bounded windows read back from the store.
 *
 * ## Storage is chosen, not assumed
 *
 * A v2 session cannot open until it has somewhere to put bytes, and where that
 * is depends on the manifest's declared size - so provisioning is asynchronous
 * and happens between the manifest landing and the session existing. Frames
 * that arrive in that window are reported as `pending-storage`: not accepted,
 * not rejected, because the sender repeats everything and the receiver simply
 * was not ready yet.
 *
 * The pipeline still never learns what kind of store it got. It writes
 * segments, reads bounded windows back to hash them, and asks for an export
 * route at the end.
 *
 * ## Resume is a seeded session, not a second mode
 *
 * Since Phase 07 a v2 session can start partway in. The store is asked to adopt
 * a checkpoint left by an earlier run of the same transfer, and if it does, the
 * committed bitmap it read back is handed straight to `SegmentedReceiver` -
 * which already knows that a committed segment is never rebuilt and that its
 * frames cost one bit test. So there is no resume code path here: there is one
 * path whose progress does not always start at zero.
 *
 * Two things follow, and both are deliberate:
 *
 * - **Adoption is asked for, never assumed.** Treating bytes on a device as
 *   received is a decision with consequences, so it happens when a caller
 *   passes `resume`, not because a directory happened to exist.
 * - **Verification is unchanged.** A resumed transfer is hashed end to end from
 *   the store exactly as a fresh one is, and it is accepted only if that digest
 *   matches the manifest. Nothing about a checkpoint is evidence about bytes.
 */

import {
  DeqrV2Manifest,
  V2_COMPRESSION,
  detectProtocolVersion,
  parseFrame as parseV2Frame,
  segmentPlanFromManifest,
  toSafeNumber,
  windowPlanFromManifest,
  type CompressionWindowPlan,
  type SegmentPlan,
  V2_DATA_LAYOUT,
  V2_FRAME_TYPE,
} from '../../src/core/protocol-v2';
import { RECEIVER_POLICY, manifestPolicyRefusal } from '../../src/core/receiver-policy';
import { RECEIVE_ACCEPT, SegmentedReceiver } from '../../src/core/segmented-receiver';
import { Sha256Stream, sameDigest } from '../../src/core/sha256-stream';
import { BoundedFingerprintSet, DEFAULT_DEDUPE_CAPACITY, frameFingerprint } from './frame-dedupe';
import {
  DeqrProtocolError,
  ReceiverSession,
  isBlockedReceiverExtension,
  parseFrame as parseV1Frame,
  sanitizeFilename,
} from './protocol';
import {
  encodeTargetedResumeToken,
  missingRangesFromBitmap,
} from '../../src/core/resume-token';
import type { CheckpointRejection, RetentionPolicy, StoragePreflight } from './opfs';
import { ReceiverStorage, fixedProvisioner, type StorageProvisioner } from './receiver-storage';
import { canDecompress, inflateWindowContainer } from './inflate-verify';
import {
  DEFAULT_SEGMENT_BUDGET_BYTES,
  STORE_WRITE,
  type ExportSource,
  type OriginalSink,
  type SegmentStore,
  type SegmentStoreKind,
  type StoredSegment,
} from './segment-store';
import {
  FRAME_OUTCOME,
  type ActiveProtocol,
  type FrameOutcome,
  type ReceiveProgress,
  emptyProgress,
} from './worker-protocol';

/** v2 decoders alive at once. Two covers a sender crossing a segment boundary. */
export const DEFAULT_MAX_ACTIVE_SEGMENTS = 2;

/**
 * Window read back from the store per hashing step.
 *
 * 256 KiB is large enough that the per-read overhead disappears against the
 * hash itself and small enough to be irrelevant next to a segment. It is the
 * single largest buffer verification allocates, and it does not grow with the
 * file - which is the property the phase's gate is written against.
 */
export const VERIFY_CHUNK_BYTES = 256 * 1024;

/**
 * Bytes hashed between yields to the event loop.
 *
 * Hashing a gigabyte takes several seconds of solid CPU. The main thread stays
 * responsive throughout - this all runs in the worker - but the *worker* stops
 * reading its port, and the message it would be ignoring is the user's Cancel.
 * Yielding every 16 MiB costs about sixty macrotasks per gigabyte and buys back
 * a cancel that lands within a fraction of a second.
 */
export const VERIFY_YIELD_BYTES = 16 * 1024 * 1024;

/**
 * Why a session ended, which is what decides whether its bytes survive.
 *
 * Phase 06 shipped one retention policy for the whole pipeline, because there
 * was nothing that could use a retained file. Now there is, and the four ways a
 * session ends want three different answers:
 *
 * - `cancelled` - the user stopped it. The partial file goes, immediately.
 *   Leaving half a transfer on a device somebody believes they cancelled would
 *   be a surprise, not a feature.
 * - `failed` - the transfer cannot be finished from where it is. Nothing to
 *   resume, so nothing to keep.
 * - `interrupted` - the tab was backgrounded, the camera was taken, the phone
 *   locked. The user did not choose this and will very likely come back, so the
 *   partial file is kept and the sweep's bounds - 24 hours and three sessions -
 *   decide how long that lasts.
 * - `completed` - already handed to the export route, and deleting it would
 *   race a save the user has started.
 */
export const SESSION_END = {
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  COMPLETED: 'completed',
} as const;
export type SessionEndReason = (typeof SESSION_END)[keyof typeof SESSION_END];

/** The retention policy each ending implies. See `SessionEndReason`. */
export function retentionFor(reason: SessionEndReason): RetentionPolicy {
  return reason === SESSION_END.INTERRUPTED || reason === SESSION_END.COMPLETED ? 'retain' : 'discard';
}

/**
 * Which half of verification is running.
 *
 * A compressed transfer verifies in two passes: the container is expanded into
 * the original file, then that file is hashed. They move at different rates and
 * mean different things, so a bar that silently restarted at zero half way
 * through would read as a stall. An uncompressed transfer only ever reports
 * `hashing`.
 */
export const VERIFY_PHASE = {
  DECOMPRESSING: 'decompressing',
  HASHING: 'hashing',
} as const;
export type VerifyPhase = (typeof VERIFY_PHASE)[keyof typeof VERIFY_PHASE];

/** Where a verification has got to. Reported apart from transfer progress. */
export interface VerifyProgress {
  bytesHashed: number;
  bytesTotal: number;
  phase: VerifyPhase;
}

export interface ReceivePipelineOptions {
  dedupeCapacity?: number;
  maxActiveSegments?: number;
  segmentBudgetBytes?: number;
  storageMarginRatio?: number;
  /** Injected so a test can drive a refusing store, or a bench a synthetic one. */
  store?: SegmentStore;
  /** Chooses and opens working storage. Defaults to OPFS with a memory fallback. */
  storage?: StorageProvisioner;
  /**
   * Retention for a session that ends without a reason being given.
   *
   * `reset(reason)` is the supported way to end one and derives its policy from
   * the reason. This remains for a caller that ends a session without saying
   * why, and it keeps `discard` as the answer in that case.
   */
  retention?: RetentionPolicy;
  /**
   * Wall clock, injected so a stall can be driven deterministically in a test.
   *
   * The same idiom `sweepStaleSessions` uses. Stall detection is a *timing*
   * behaviour, and a timing behaviour that can only be observed by waiting is
   * one nothing will ever assert.
   */
  now?: () => number;
  /**
   * Adopt working data left by an earlier run of the same transfer.
   *
   * Off by default. The manifest decides *which* data is eligible - identity,
   * digest and segmentation must all agree - but whether to look at all is the
   * caller's, because it means treating bytes on a device as received.
   */
  resume?: boolean;
  /**
   * Called as verification reads the store back.
   *
   * Separate from `progress()` on purpose: hashing a gigabyte is nine seconds
   * during which transfer progress is finished and unchanging, and a screen
   * with only one number on it would look frozen at exactly the moment a user
   * is waiting hardest.
   */
  onVerifyProgress?: (progress: VerifyProgress) => void;
  /** Overridden in tests so a long verification does not depend on real timers. */
  yieldToEventLoop?: () => Promise<void>;
}

export interface SubmitResult {
  outcome: FrameOutcome;
  /** Enumerated protocol code on a reject. Never free-form text. */
  reason?: string;
  /** True when this frame was the one that completed the transfer. */
  completed: boolean;
}

export interface VerifiedPayload {
  filename: string;
  mimeType: string;
  /** Verified length, taken from the store rather than from the manifest. */
  size: number;
  sha256: Uint8Array;
  source: ExportSource;
}

export type VerifyResult =
  | { ok: true; value: VerifiedPayload }
  | { ok: false; code: string; message: string };

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A declared size as a number, for reporting only.
 *
 * Returns 0 rather than throwing above `Number.MAX_SAFE_INTEGER`. Nothing here
 * indexes or allocates from these - a session whose sizes cannot be held in a
 * number never opens, and `beginV2Session` is where that is decided.
 */
function safeSize(value: bigint): number {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

/**
 * The whole of what hashing needs: bounded windows, copied out.
 *
 * Narrower than `SegmentStore` because the thing being hashed is not always
 * one. For a compressed transfer the digest runs over the decompressed file in
 * an `OriginalSink`, and both satisfy this.
 */
export interface ByteWindowSource {
  read(offset: number, into: Uint8Array): number;
}

export interface DigestStoreOptions {
  chunkBytes?: number;
  yieldEveryBytes?: number;
  yieldTo?: () => Promise<void>;
  /** Checked after each yield. Returning true abandons the digest. */
  isCancelled?: () => boolean;
  /**
   * Called at each yield with how far the hash has got.
   *
   * At the yield boundary rather than per window, because a caller that posts a
   * message per 256 KiB would send four thousand of them per gigabyte. Sixty
   * per gigabyte is enough to move a bar smoothly and cheap enough to ignore.
   */
  onProgress?: (progress: VerifyProgress) => void;
}

/**
 * SHA-256 over a store's contents, one bounded window at a time.
 *
 * Free-standing rather than a private method because it is the claim the phase
 * is gated on: verification whose allocation is `chunkBytes`, not the file
 * size. A test that drives a gigabyte through this is testing the code the
 * receiver actually runs, which a reimplementation inside the test would not be.
 *
 * Returns null when the store cannot produce the bytes, or when the caller
 * cancelled during a yield. Both are session-ending and neither is a hash
 * failure, so they are kept distinct from a digest that simply does not match.
 */
export async function digestSegmentStore(
  store: ByteWindowSource,
  size: number,
  options: DigestStoreOptions = {},
): Promise<Uint8Array | null> {
  const chunkBytes = options.chunkBytes ?? VERIFY_CHUNK_BYTES;
  const yieldEveryBytes = options.yieldEveryBytes ?? VERIFY_YIELD_BYTES;
  const yieldTo = options.yieldTo ?? defaultYield;
  const isCancelled = options.isCancelled ?? (() => false);

  const buffer = new Uint8Array(chunkBytes);
  const hasher = new Sha256Stream();
  let offset = 0;
  let sinceYield = 0;

  options.onProgress?.({ bytesHashed: 0, bytesTotal: size, phase: VERIFY_PHASE.HASHING });

  while (offset < size) {
    const want = Math.min(buffer.length, size - offset);
    const window = want === buffer.length ? buffer : buffer.subarray(0, want);
    const read = store.read(offset, window);
    if (read <= 0) {
      buffer.fill(0);
      return null;
    }
    hasher.update(buffer.subarray(0, read));
    offset += read;
    sinceYield += read;

    if (sinceYield >= yieldEveryBytes && offset < size) {
      sinceYield = 0;
      await yieldTo();
      if (isCancelled()) {
        buffer.fill(0);
        return null;
      }
      options.onProgress?.({ bytesHashed: offset, bytesTotal: size, phase: VERIFY_PHASE.HASHING });
    }
  }

  buffer.fill(0);
  options.onProgress?.({ bytesHashed: size, bytesTotal: size, phase: VERIFY_PHASE.HASHING });
  return hasher.digest();
}

/**
 * Distinct refusal reasons remembered at once.
 *
 * Comfortably above the number of codes the parsers can produce, so nothing is
 * dropped in practice. It exists because the frames producing these codes come
 * from a camera pointed at an uncontrolled screen, and a bound that is never
 * reached costs nothing.
 */
const MAX_REJECTION_REASONS = 32;

export class ReceivePipeline {
  private readonly dedupe: BoundedFingerprintSet;
  private readonly maxActiveSegments: number;
  private readonly storage: StorageProvisioner;
  private readonly retention: RetentionPolicy;
  private readonly resume: boolean;
  private readonly onVerifyProgress: ((progress: VerifyProgress) => void) | undefined;
  private readonly now: () => number;
  private readonly yieldToEventLoop: () => Promise<void>;

  private store: SegmentStore | undefined;
  private storeKind: SegmentStoreKind | 'none' = 'none';
  private protocol: ActiveProtocol = 0;
  private v1: ReceiverSession | undefined;
  private v2: SegmentedReceiver | undefined;
  private v2Manifest: DeqrV2Manifest | undefined;
  private v2Plan: SegmentPlan | undefined;
  /** Set for a compressed session only. Its presence *is* the compressed flag. */
  private v2Windows: CompressionWindowPlan | null = null;

  /** Set from the manifest until storage answers. Frames wait rather than fail. */
  private provisioning = false;
  /** Fences a provisioning result against the session it was started for. */
  private provisionGeneration = 0;
  /** The provisioning round in flight, so a caller can await the one step that is async. */
  private provisionSettled: Promise<void> = Promise.resolve();
  /** Cleanup started by `reset`, so a test can wait for the device to settle. */
  private cleanup: Promise<void> = Promise.resolve();

  private framesAccepted = 0;
  /**
   * When a frame the transfer had not already seen last arrived.
   *
   * Zero until the first one. The main thread turns this into a stall; the
   * pipeline only records it, because the threshold is a UI policy and the
   * pipeline has no business holding one.
   */
  private lastUniqueFrameAtMs = 0;
  /** Refusals by reason. See `tallyRejection`. */
  private readonly rejectionsByReason = new Map<string, number>();
  /** Accepted frames that carried original bytes rather than repair algebra. */
  private framesSystematic = 0;
  private framesRepair = 0;
  private framesDuplicate = 0;
  private framesRejected = 0;
  private framesForeign = 0;
  private manifestFrames = 0;
  private storagePressure = false;
  private sessionFault: string | undefined;
  private complete = false;
  private released = false;
  /** Segments this session started with, from a checkpoint. Zero for a fresh one. */
  private adoptedSegments = 0;
  /** Why data on the device was not adopted, when a resume was attempted. */
  private checkpointRejection: CheckpointRejection | undefined;
  /**
   * What the storage preflight decided, kept so the UI can show it.
   *
   * Until Phase 09 this was computed and dropped: a receiver could refuse a
   * transfer with `INSUFFICIENT_STORAGE` and had no way to say how much room it
   * had wanted or how much it thought was there, which is the difference
   * between a message someone can act on and a dead end.
   */
  private storagePreflight: StoragePreflight | undefined;

  constructor(options: ReceivePipelineOptions = {}) {
    this.dedupe = new BoundedFingerprintSet(options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY);
    this.maxActiveSegments = options.maxActiveSegments ?? DEFAULT_MAX_ACTIVE_SEGMENTS;
    this.retention = options.retention ?? 'discard';
    this.resume = options.resume === true;
    this.onVerifyProgress = options.onVerifyProgress;
    this.yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
    this.now = options.now ?? (() => Date.now());
    this.storage = options.store
      ? fixedProvisioner(options.store)
      : options.storage
        ?? new ReceiverStorage({
          fallbackBudgetBytes: options.segmentBudgetBytes ?? DEFAULT_SEGMENT_BUDGET_BYTES,
          marginRatio: options.storageMarginRatio,
        });
  }

  /* ------------------------------------------------------------------ input */

  /**
   * Takes one decoded QR payload.
   *
   * Never throws. A camera produces malformed input as a matter of course, and
   * an exception here would surface as a worker error - which tears down the
   * pipeline and the session with it, for what is in fact a single bad frame.
   */
  submit(bytes: Uint8Array): SubmitResult {
    if (this.released) return this.reject('RELEASED');
    if (this.complete) return { outcome: FRAME_OUTCOME.DUPLICATE, completed: false };

    // Length first, before a single byte is walked. No DEQR frame of either
    // protocol can exceed `maxFrameBytes` - v1 tops out at a 20-byte header
    // plus a 2 KiB block, v2 at a 28-byte header plus a 4 KiB symbol - so a
    // longer payload is not a DEQR frame however it is shaped, and fingerprint
    // and parse are both O(n) in something a caller supplied.
    if (bytes.length > RECEIVER_POLICY.maxFrameBytes) return this.reject('FRAME_TOO_LONG');

    // Cheapest possible answer, and the common one. Nothing below this line
    // runs for a frame the receiver has already looked at.
    const fingerprint = frameFingerprint(bytes);
    if (this.dedupe.has(fingerprint)) {
      this.framesDuplicate += 1;
      return { outcome: FRAME_OUTCOME.DUPLICATE, completed: false };
    }

    try {
      const version = detectProtocolVersion(bytes);
      if (version === 2) return this.submitV2(bytes, fingerprint);
      if (version === 1) return this.submitV1(bytes, fingerprint);
      // Not a DEQR frame at all: a shop QR, a URL, a wifi code. Common enough
      // while the user is aiming that it must be counted, not reported.
      this.dedupe.observe(fingerprint);
      return this.reject('NOT_DEQR');
    } catch (error) {
      // A pipeline that throws is a worker that dies. Anything unexpected is
      // downgraded to one rejected frame.
      this.dedupe.observe(fingerprint);
      return this.reject(error instanceof DeqrProtocolError ? error.code : 'FRAME_ERROR');
    }
  }

  private submitV1(bytes: Uint8Array, fingerprint: number): SubmitResult {
    // Parsed here rather than inside the session, so a frame the camera
    // mangled is one rejected frame instead of a failed transfer. See the
    // module note; every other v1 rule still runs inside `receive`.
    const parsed = parseV1Frame(bytes);
    if (!parsed.ok) {
      this.dedupe.observe(fingerprint);
      return this.reject(parsed.error.code);
    }

    this.protocol = 1;
    this.v1 ??= new ReceiverSession();
    const before = this.v1.snapshot();
    const after = this.v1.receive(bytes);
    this.dedupe.observe(fingerprint);

    if (after.state === 'FAILED') {
      this.framesRejected += 1;
      // v1 fails its whole session on a conflicting duplicate or a session id
      // that changes under it, and then rejects everything afterwards. That has
      // to reach the UI as a stopped transfer, not as a scan that goes quiet.
      this.sessionFault = after.error?.code ?? 'REJECTED';
      return { outcome: FRAME_OUTCOME.REJECTED, reason: this.sessionFault, completed: false };
    }
    if (after.foreignFrames > before.foreignFrames) {
      this.framesForeign += 1;
      return { outcome: FRAME_OUTCOME.FOREIGN, completed: false };
    }
    if (after.duplicates > before.duplicates) {
      this.framesDuplicate += 1;
      return { outcome: FRAME_OUTCOME.DUPLICATE, completed: false };
    }

    this.framesAccepted += 1;
    this.lastUniqueFrameAtMs = this.now();
    // v1 signals "every block recovered" by entering VERIFYING on its own.
    const completed = after.state === 'VERIFYING' && before.state !== 'VERIFYING';
    if (completed) this.complete = true;
    return { outcome: FRAME_OUTCOME.ACCEPTED, completed };
  }

  private submitV2(bytes: Uint8Array, fingerprint: number): SubmitResult {
    if (!this.v2) {
      // A session that already died of a storage fault does not get restarted
      // by the next manifest frame; the sender repeats them continuously and
      // retrying would loop on the same refusal.
      if (this.sessionFault) return this.reject(this.sessionFault);

      const parsed = parseV2Frame(bytes);
      if (!parsed.ok) {
        this.dedupe.observe(fingerprint);
        return this.reject(parsed.error.code);
      }
      if (parsed.value.kind !== 'manifest') {
        // Deliberately *not* remembered: this frame is undecodable now and
        // decodable the moment the manifest lands, and the sender repeats it.
        // Fingerprinting it here would make the receiver discard the very
        // symbols it is waiting to be able to use.
        return { outcome: this.provisioning ? FRAME_OUTCOME.PENDING_STORAGE : FRAME_OUTCOME.PENDING_MANIFEST, completed: false };
      }
      if (this.provisioning) {
        // Storage for this manifest is already being opened. Same reasoning:
        // not remembered, because nothing is wrong with the frame.
        return { outcome: FRAME_OUTCOME.PENDING_STORAGE, completed: false };
      }

      const refusal = this.beginV2Session(parsed.value.manifest);
      this.dedupe.observe(fingerprint);
      if (refusal) {
        // Recorded as a session fault and not only as a rejected frame.
        //
        // Every refusal `beginV2Session` can return is a property of the
        // manifest rather than of one optical read - the CRC has already
        // passed, so the fields are the sender's - which means the next
        // manifest frame will be refused identically. Until Phase 10 this was
        // a rejected frame and nothing else, and `progress().fault` is the only
        // route from this pipeline to a screen: a phone pointed at a blocked
        // file type or a transfer this browser cannot decompress went on
        // scanning silently, forever, while the copy written to explain exactly
        // that sat unreachable in `faultCopy`.
        this.sessionFault = refusal;
        return this.reject(refusal);
      }
      this.manifestFrames += 1;
      return { outcome: FRAME_OUTCOME.MANIFEST, completed: false };
    }

    const result = this.v2.acceptFrameBytes(bytes);
    this.dedupe.observe(fingerprint);

    switch (result.status) {
      case RECEIVE_ACCEPT.MANIFEST:
        this.manifestFrames += 1;
        return { outcome: FRAME_OUTCOME.MANIFEST, completed: false };
      case RECEIVE_ACCEPT.DUPLICATE:
      case RECEIVE_ACCEPT.SEGMENT_COMMITTED:
        this.framesDuplicate += 1;
        return { outcome: FRAME_OUTCOME.DUPLICATE, completed: false };
      case RECEIVE_ACCEPT.REJECTED: {
        // A frame from another transfer is a different event from a corrupt
        // one, and a user acts on it differently: aim at the other screen.
        if (result.reason === 'SESSION_MISMATCH') {
          this.framesForeign += 1;
          return { outcome: FRAME_OUTCOME.FOREIGN, completed: false };
        }
        return this.reject(result.reason ?? 'REJECTED');
      }
      default: {
        this.framesAccepted += 1;
        this.lastUniqueFrameAtMs = this.now();
        // Which kind of symbol advanced the segment. Read from the frame's own
        // type byte rather than re-parsed: the accept path has already checked
        // the CRC and the layout, so by here the byte is the sender's. The
        // ratio of the two is how a link's real loss rate becomes visible from
        // the receiving end - a transfer completing almost entirely on repair
        // is one that is barely working, and on a progress bar it looks
        // identical to one sailing through.
        if (bytes[V2_DATA_LAYOUT.frameType] === V2_FRAME_TYPE.SOURCE) this.framesSystematic += 1;
        else this.framesRepair += 1;
        // A store refusal is recorded by the sink, which cannot refuse through
        // its return value, and becomes terminal on the very next frame.
        if (this.sessionFault) return this.reject(this.sessionFault);
        if (result.sessionComplete) this.complete = true;
        return { outcome: FRAME_OUTCOME.ACCEPTED, completed: result.sessionComplete };
      }
    }
  }

  /* ------------------------------------------------------------- v2 session */

  /**
   * Validates a manifest and starts opening storage for it.
   *
   * Returns the code that says why the session will not open, or null when
   * provisioning has begun. The checks here are the ones that can be answered
   * without touching a device, and they run first so that a transfer the
   * receiver was never going to accept costs no storage work at all.
   */
  private beginV2Session(manifest: DeqrV2Manifest): string | null {
    if (manifest.compressionMode !== V2_COMPRESSION.NONE && !canDecompress()) {
      // The segments will carry a GZIP container and this context has no
      // decompressor. There is no back channel to ask the sender to stop, so
      // the refusal happens at the manifest - where it can still be "ask the
      // desktop to send this without compression" rather than a hash failure
      // after an hour of scanning.
      return 'UNSUPPORTED_COMPRESSION';
    }

    let plan: SegmentPlan;
    let windows: CompressionWindowPlan | null;
    try {
      // Throws on a manifest whose declared sizes cannot be held in a JS
      // number. Better here than at the first byte of assembly.
      toSafeNumber(manifest.transportSize, 'transportSize');
      toSafeNumber(manifest.originalSize, 'originalSize');
      plan = segmentPlanFromManifest(manifest);
      // Null for an uncompressed transfer, and the only thing that decides
      // which verification path runs at the end. Derived once, here, from a
      // manifest that has already been through the parser's consistency rules.
      windows = windowPlanFromManifest(manifest);
    } catch {
      return 'INCONSISTENT_MANIFEST';
    }

    // The receiver's own budgets, checked here and not inside the session.
    // Everything above proved the manifest self-consistent; this asks the
    // separate question of whether this build is willing to act on it, and it
    // runs *before* any storage call so a transfer that was never going to be
    // accepted costs no device work and is reported as the refusal it is.
    // Without it, a manifest declaring four billion segments reached
    // `SegmentedReceiver`'s constructor inside the provisioning callback and
    // surfaced as `CHECKPOINT_INCONSISTENT` - a sentence about a checkpoint
    // that had nothing to do with it.
    const refusal = manifestPolicyRefusal({
      segmentCount: manifest.segmentCount,
      segmentSizeBytes: manifest.segmentSizeBytes,
      symbolSizeBytes: manifest.symbolSizeBytes,
      transportSize: manifest.transportSize,
    });
    if (refusal) return refusal;

    const filename = sanitizeFilename(manifest.filename);
    if (isBlockedReceiverExtension(filename)) {
      // Refused at the manifest rather than after the transfer, so the user is
      // not made to scan a file the receiver was never going to hand over.
      return 'FILE_TYPE_BLOCKED';
    }

    this.protocol = 2;
    this.v2Manifest = manifest;
    this.v2Plan = plan;
    this.v2Windows = windows;
    this.provisioning = true;
    const generation = this.provisionGeneration;

    this.provisionSettled = this.storage
      .provision(manifest, plan, filename, { resume: this.resume })
      .then((provision) => this.onProvisioned(generation, provision))
      .catch(() => this.onProvisioned(generation, { ok: false, code: 'STORAGE_OPEN_FAILED' }));
    return null;
  }

  /**
   * Storage answered. Either the session opens now, or it never does.
   *
   * The generation check is not decoration: opening storage is the one
   * asynchronous step in an otherwise synchronous pipeline, so a cancel or a
   * reset can land in the middle of it. Without this, a store opened for an
   * abandoned session would be attached to the next one - and on the OPFS path
   * that means writing one transfer's segments into another transfer's file.
   */
  private onProvisioned(generation: number, provision: Awaited<ReturnType<StorageProvisioner['provision']>>): void {
    if (generation !== this.provisionGeneration || this.released) {
      if (provision.ok) {
        provision.store.release();
        void provision.store.dispose('discard');
      }
      return;
    }

    this.provisioning = false;
    this.storagePreflight = provision.preflight;
    const manifest = this.v2Manifest;
    if (!manifest) return;

    if (!provision.ok) {
      this.sessionFault = provision.code;
      if (provision.code === 'INSUFFICIENT_STORAGE' || provision.code === 'STORAGE_UNAVAILABLE') {
        this.storagePressure = true;
      }
      return;
    }

    this.store = provision.store;
    this.storeKind = provision.kind;
    this.checkpointRejection = provision.rejection;
    this.adoptedSegments = provision.adopted?.segmentsCommitted ?? 0;

    try {
      this.v2 = new SegmentedReceiver(manifest, {
        maxActiveSegments: this.maxActiveSegments,
        // Stated rather than defaulted. `beginV2Session` has already refused a
        // manifest above this bound, so reaching the constructor's own throw
        // would be a defect here - and passing the same policy constant is what
        // makes the two checks provably the same number.
        maxSegmentCount: RECEIVER_POLICY.maxSegmentCount,
        onSegmentComplete: (segment) => this.onSegmentComplete(segment),
        // The bitmap the store read back off the device. `SegmentedReceiver`
        // re-checks its size against this manifest and refuses a mismatch, so a
        // bitmap and a manifest that disagree end the session here rather than
        // producing a transfer that quietly skips real segments.
        adoptedSegments: provision.adopted?.committedBits,
      });
    } catch {
      this.sessionFault = 'CHECKPOINT_INCONSISTENT';
      return;
    }

    // A checkpoint can describe a transfer that received everything and died
    // before it verified. Nothing else would ever set `complete` for it: there
    // are no frames left to arrive that could.
    if (this.v2.isComplete) this.complete = true;
  }

  /**
   * One recovered segment, handed to the store.
   *
   * The sink cannot refuse through its return value, so a refusal is recorded
   * as a session fault and the next `submit` turns it into a terminal
   * rejection. The three refusals are kept distinct on the way out: a full
   * device, a write that disagreed with the manifest, and a broken writer are
   * three different things to tell someone.
   */
  private onSegmentComplete(segment: StoredSegment): void {
    const store = this.store;
    if (!store) {
      segment.bytes.fill(0);
      this.sessionFault = 'STORAGE_WRITE_FAILED';
      return;
    }

    const outcome = store.write(segment);
    if (outcome === STORE_WRITE.OK) return;

    // Ownership did not transfer, so the plaintext copy is ours to clear.
    segment.bytes.fill(0);
    switch (outcome) {
      case STORE_WRITE.FULL:
        this.storagePressure = true;
        this.sessionFault = 'STORAGE_FULL';
        return;
      case STORE_WRITE.INVALID:
        this.sessionFault = 'SEGMENT_OUT_OF_RANGE';
        return;
      default:
        this.sessionFault = 'STORAGE_WRITE_FAILED';
    }
  }

  /* -------------------------------------------------------------- reporting */

  progress(): ReceiveProgress {
    const progress = emptyProgress();
    progress.protocol = this.protocol;
    progress.framesAccepted = this.framesAccepted;
    progress.lastUniqueFrameAtMs = this.lastUniqueFrameAtMs;
    progress.framesSystematic = this.framesSystematic;
    progress.framesRepair = this.framesRepair;
    progress.rejectionsByReason = Object.fromEntries(this.rejectionsByReason);
    progress.framesDuplicate = this.framesDuplicate;
    progress.framesRejected = this.framesRejected;
    progress.framesForeign = this.framesForeign;
    progress.manifestFrames = this.manifestFrames;
    progress.storageKind = this.storeKind;
    progress.storagePressure = this.storagePressure;
    progress.fault = this.sessionFault;
    progress.complete = this.complete;

    if (this.v2Manifest) {
      // Active from the manifest, not from the store: the seconds spent opening
      // storage are part of the session, and a screen that showed nothing
      // happening during them would be lying by omission.
      progress.sessionActive = true;
      progress.filename = sanitizeFilename(this.v2Manifest.filename);
      progress.unitsRecovered = this.v2?.segmentsCommitted ?? 0;
      progress.unitsTotal = this.v2Manifest.segmentCount;
      progress.bytesCommitted = this.store?.bytesCommitted() ?? 0;
      progress.heldBytes = (this.v2?.heldBytes() ?? 0) + (this.store?.residentBytes() ?? 0);
      // Reported apart from `unitsRecovered` because they answer different
      // questions. A bar that starts at 90% needs to be able to say why.
      progress.unitsAdopted = this.adoptedSegments;
      progress.resumed = this.adoptedSegments > 0;
      progress.checkpointRejection = this.checkpointRejection;
      progress.resumeToken = this.resumeToken();
      // Two sizes, never one. For a compressed transfer `bytesCommitted`
      // counts optical bytes and would look like a file that lost most of
      // itself if it were reported as progress towards the original size.
      progress.originalBytes = safeSize(this.v2Manifest.originalSize);
      progress.transportBytes = safeSize(this.v2Manifest.transportSize);
      progress.compressionMode = this.v2Manifest.compressionMode;
      this.reportStorage(progress);
      return progress;
    }

    if (this.v1) {
      const snapshot = this.v1.snapshot();
      progress.sessionActive = snapshot.totalBlocks > 0;
      progress.filename = snapshot.filename;
      progress.unitsRecovered = snapshot.receivedBlocks;
      progress.unitsTotal = snapshot.totalBlocks;
      // v1 holds the whole transfer in its decoder until it reconstructs, so
      // there is no meaningful committed count - only what it is holding.
      progress.heldBytes = snapshot.totalBlocks * 512;
    }
    this.reportStorage(progress);
    return progress;
  }

  /**
   * Copies the storage decision onto a progress view.
   *
   * Flat fields rather than a nested object, matching every other counter here,
   * because the shape crosses a `postMessage` boundary that validates each one
   * on receipt. `confidence` carries the distinction the numbers cannot: a
   * browser that answered, versus one with no estimate API at all - and those
   * two want different sentences on screen.
   */
  private reportStorage(progress: ReceiveProgress): void {
    const preflight = this.storagePreflight;
    if (!preflight) return;
    progress.storageRequiredBytes = preflight.requiredBytes;
    progress.storageAvailableBytes = preflight.availableBytes ?? 0;
    progress.storageConfidence = preflight.confidence;
  }

  /** Bytes this pipeline is holding, for the memory assertion in the tests. */
  heldBytes(): number {
    return this.progress().heldBytes;
  }

  get activeProtocol(): ActiveProtocol {
    return this.protocol;
  }

  get isComplete(): boolean {
    return this.complete;
  }

  get storageKind(): SegmentStoreKind | 'none' {
    return this.storeKind;
  }

  /** True between the manifest landing and storage answering. */
  get isProvisioningStorage(): boolean {
    return this.provisioning;
  }

  /** Segments this session started with, adopted from a checkpoint. */
  get segmentsAdopted(): number {
    return this.adoptedSegments;
  }

  /**
   * The code a user carries to a desktop to resume this transfer.
   *
   * Minted from live state rather than stored, so it is always current: it
   * names the lowest segment nothing has committed, which is the point a sender
   * can restart from without skipping anything the receiver still needs.
   *
   * `undefined` when there is no v2 session to describe, and deliberately
   * *defined* for a session that has everything - a receiver that finished
   * receiving and died before verifying still needs a code, and the token
   * carries `segmentCount` as its resume point to say so.
   */
  resumeToken(): string | undefined {
    const manifest = this.v2Manifest;
    const receiver = this.v2;
    if (!manifest || !receiver) return undefined;
    try {
      // Names the gaps when they fit, and falls back to the restart point when
      // they do not - the encoder decides, because which token is possible is a
      // property of the bitmap rather than a preference.
      //
      // This matters most in exactly the case Phase 13 was opened for. After a
      // completed pass the gaps are scattered rather than a prefix, and a token
      // carrying only the lowest one would send the desktop back to resend
      // almost everything the receiver already holds.
      return encodeTargetedResumeToken({
        sessionId: manifest.sessionId,
        fileId: manifest.fileId,
        segmentCount: manifest.segmentCount,
        resumeFromSegment: receiver.firstMissingSegment(),
        sha256: manifest.sha256,
        missing: missingRangesFromBitmap(receiver.committedBitmap(), manifest.segmentCount),
      });
    } catch {
      // A manifest whose fields cannot be encoded is one this session should
      // never have opened. Offering no token is better than offering a wrong one.
      return undefined;
    }
  }

  /**
   * Resolves once storage for the current manifest has been opened or refused.
   *
   * Opening storage is the one asynchronous step in a pipeline that is
   * otherwise entirely synchronous per frame. A live receiver never waits on it
   * - frames arriving in the window are reported as `pending-storage` and the
   * sender repeats them - but a test that submits a manifest and its data
   * frames in the same turn would otherwise be racing the session into
   * existence.
   */
  async whenStorageReady(): Promise<void> {
    await this.provisionSettled;
  }

  /* ----------------------------------------------------------- verification */

  /**
   * Finishes a completed transfer, hash included.
   *
   * v1 delegates to the session, which already parses the container, checks the
   * declared size, and compares SHA-256 over bytes it is holding.
   *
   * **The v2 path never holds the file.** It reads bounded windows back from
   * the store, feeds them to an incremental SHA-256, and compares the result
   * against the manifest. The largest thing it allocates is one
   * `VERIFY_CHUNK_BYTES` buffer, whether the transfer was four kilobytes or
   * four gigabytes.
   */
  async verify(): Promise<VerifyResult> {
    if (this.released) return { ok: false, code: 'RELEASED', message: 'The receiver was released.' };
    // Storage first. A transfer that filled the store is also incomplete, and
    // reporting it that way would send someone back to re-scan a transfer that
    // will fill the store again.
    if (this.storagePressure) {
      return { ok: false, code: this.sessionFault ?? 'STORAGE_FULL', message: 'The receiver ran out of room for this transfer.' };
    }
    if (this.sessionFault && this.protocol === 2) {
      return { ok: false, code: this.sessionFault, message: 'The transfer was stopped before it could be verified.' };
    }
    if (!this.complete) {
      return { ok: false, code: 'TRANSFER_INCOMPLETE', message: 'Not every unit has been recovered.' };
    }
    return this.protocol === 2 ? this.verifyV2() : this.verifyV1();
  }

  private async verifyV1(): Promise<VerifyResult> {
    if (!this.v1) return { ok: false, code: 'TRANSFER_INCOMPLETE', message: 'No transfer is active.' };
    const snapshot = await this.v1.verify();
    if (snapshot.state === 'COMPLETE' && snapshot.verified) {
      const { filename, mimeType, bytes, sha256 } = snapshot.verified;
      return {
        ok: true,
        value: { filename, mimeType, size: bytes.length, sha256, source: { kind: 'bytes', bytes } },
      };
    }
    return {
      ok: false,
      code: snapshot.error?.code ?? 'TRANSFER_INCOMPLETE',
      message: snapshot.error?.message ?? 'The transfer could not be verified.',
    };
  }

  private async verifyV2(): Promise<VerifyResult> {
    const manifest = this.v2Manifest;
    const store = this.store;
    if (!manifest || !this.v2 || !store) {
      return { ok: false, code: 'TRANSFER_INCOMPLETE', message: 'No transfer is active.' };
    }

    let sink: OriginalSink | null = null;
    try {
      const transportSize = toSafeNumber(manifest.transportSize, 'transportSize');
      const originalSize = toSafeNumber(manifest.originalSize, 'originalSize');
      const windows = this.v2Windows;
      if (windows === null && transportSize !== originalSize) {
        // Only compression makes these differ, and this session has no window
        // plan. Reaching here means the manifest disagrees with itself.
        return { ok: false, code: 'INCONSISTENT_MANIFEST', message: 'Declared sizes disagree.' };
      }

      // Checked against what the store actually accepted rather than against
      // the manifest's claim. A manifest is untrusted input; hashing on its
      // word would read whatever happened to be in the file.
      if (store.segmentsWritten() !== manifest.segmentCount) {
        return { ok: false, code: 'TRANSFER_INCOMPLETE', message: 'The receiver did not retain every segment.' };
      }
      if (store.bytesCommitted() !== transportSize) {
        return { ok: false, code: 'TRANSFER_INCOMPLETE', message: 'Stored length does not match the manifest.' };
      }

      // For an uncompressed transfer the store already holds the file and the
      // hash below is the whole of verification. For a compressed one the store
      // holds a container, and the file has to be written out of it first -
      // into a second place, because a container cannot expand into itself.
      let hashed: ByteWindowSource = store;
      if (windows !== null) {
        sink = store.openOriginalSink ? await store.openOriginalSink(originalSize) : null;
        if (!sink) {
          return { ok: false, code: 'INSUFFICIENT_STORAGE', message: 'There is no room for the decompressed file.' };
        }
        const inflated = await inflateWindowContainer(store, sink, {
          transportSize,
          originalSize,
          windows,
          yieldTo: this.yieldToEventLoop,
          isCancelled: () => this.released || this.store !== store,
          onProgress: (progress) => this.onVerifyProgress?.({
            bytesHashed: progress.bytesWritten,
            bytesTotal: progress.bytesTotal,
            phase: VERIFY_PHASE.DECOMPRESSING,
          }),
        });
        if (!inflated.ok) {
          // The container did not hold the file it said it held. That is as
          // disqualifying as a digest that does not match, and the working data
          // goes for the same reason: nothing can be exported from it, and a
          // resume that adopted it would fail the same way an hour later.
          sink.release();
          sink = null;
          this.discardWorkingData(store);
          return { ok: false, code: inflated.code, message: inflated.message };
        }
        hashed = sink;
      }

      // Read back from the device either way. Hashing what the writer was
      // *given* rather than what it wrote would leave the write itself unchecked.
      const digest = await digestSegmentStore(hashed, originalSize, {
        yieldTo: this.yieldToEventLoop,
        // A cancel can land in one of the yields. Finishing the hash would then
        // hand back a file for a session the user has already abandoned.
        isCancelled: () => this.released || this.store !== store,
        onProgress: this.onVerifyProgress,
      });
      if (!digest) {
        sink?.release();
        sink = null;
        return { ok: false, code: this.released ? 'RELEASED' : 'STORAGE_READ_FAILED', message: 'Stored data could not be read back.' };
      }
      if (!sameDigest(digest, manifest.sha256)) {
        digest.fill(0);
        // Proven wrong, so it is not kept. Two reasons, and the second is the
        // one that matters: no export can be offered from bytes that failed the
        // only check that decides identity, and leaving them on the device
        // would let a later resume adopt them and fail in exactly the same way
        // after scanning the whole transfer again.
        sink?.release();
        sink = null;
        this.discardWorkingData(store);
        return { ok: false, code: 'HASH_MISMATCH', message: 'SHA-256 verification failed.' };
      }

      const filename = sanitizeFilename(manifest.filename);
      if (isBlockedReceiverExtension(filename)) {
        digest.fill(0);
        sink?.release();
        sink = null;
        return { ok: false, code: 'FILE_TYPE_BLOCKED', message: 'File extension is blocked by security policy.' };
      }

      // The store is sealed either way: that is what marks the session verified
      // in its checkpoint and releases the exclusive lock. For a compressed
      // transfer the *export* comes from the sink instead, because the container
      // is not the file anyone asked for.
      const containerRoute = await store.seal();
      const source = sink ? await sink.seal() : containerRoute;
      sink = null;
      return {
        ok: true,
        value: {
          filename,
          // Advisory in both directions, and never used to decide handling.
          mimeType: manifest.mimeType || 'application/octet-stream',
          size: originalSize,
          sha256: digest,
          source,
        },
      };
    } catch (error) {
      sink?.release();
      return {
        ok: false,
        code: 'VERIFICATION_FAILED',
        message: error instanceof Error ? error.message : 'Verification failed.',
      };
    }
  }

  /**
   * Removes a session's working data immediately, whatever the retention policy.
   *
   * For the one case where the policy has nothing to decide: the data has been
   * shown not to be the file it claims to be. Detaching the store here also
   * makes the pipeline's own cancel check fire, so anything still running
   * against it stops rather than finishing against a store nobody owns.
   */
  private discardWorkingData(store: SegmentStore): void {
    if (this.store === store) {
      this.store = undefined;
      this.storeKind = 'none';
    }
    store.release();
    this.cleanup = this.cleanup.then(() => store.dispose('discard')).catch(() => undefined);
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Ends the session and clears every buffer, ready to be used again.
   *
   * The reason is not decoration: it is what decides whether the partial file
   * on the device survives. A cancel deletes it, an interruption keeps it so
   * the user can come back, and the sweep's bounds decide how long "come back"
   * lasts. See `SessionEndReason`.
   *
   * The promise the cleanup starts is retained so `settled` can be awaited - a
   * test that asserts a cancelled session left nothing behind has to be able to
   * wait for the deletion it is asserting about.
   */
  reset(reason?: SessionEndReason): void {
    this.provisionGeneration += 1;
    this.provisioning = false;
    this.v1?.cancel();
    this.v1 = undefined;
    this.v2?.release();
    this.v2 = undefined;
    this.v2Manifest = undefined;
    this.v2Plan = undefined;
    this.v2Windows = null;

    const store = this.store;
    this.store = undefined;
    this.storeKind = 'none';
    if (store) {
      store.release();
      const policy = reason === undefined ? this.retention : retentionFor(reason);
      this.cleanup = this.cleanup.then(() => store.dispose(policy)).catch(() => undefined);
    }

    this.dedupe.clear();
    this.protocol = 0;
    this.framesAccepted = 0;
    this.lastUniqueFrameAtMs = 0;
    this.framesSystematic = 0;
    this.framesRepair = 0;
    this.rejectionsByReason.clear();
    this.framesDuplicate = 0;
    this.framesRejected = 0;
    this.framesForeign = 0;
    this.manifestFrames = 0;
    this.storagePressure = false;
    this.sessionFault = undefined;
    this.complete = false;
    this.released = false;
    this.adoptedSegments = 0;
    this.checkpointRejection = undefined;
    // Cleared with the rest of the session: a storage summary from the previous
    // transfer describes a size this one may not have.
    this.storagePreflight = undefined;
  }

  /**
   * Permanent teardown. A released pipeline refuses everything.
   *
   * Defaults to discarding, because the ordinary caller of `release` is a
   * worker being closed - and a worker that keeps every abandoned transfer's
   * bytes because it might one day be reopened is a device that fills up. A
   * caller ending a session it means to resume passes the reason instead.
   */
  release(reason?: SessionEndReason): void {
    this.reset(reason);
    this.released = true;
  }

  /** Resolves once storage cleanup started by `reset` or `release` has finished. */
  async settled(): Promise<void> {
    await this.cleanup;
  }

  private reject(reason: string): SubmitResult {
    this.framesRejected += 1;
    this.tallyRejection(reason);
    return { outcome: FRAME_OUTCOME.REJECTED, reason, completed: false };
  }

  /**
   * Counts *why* frames are being refused, not just how many.
   *
   * The diagnostic the physical failure needed and did not have. "The transfer
   * did not finish" is the same sentence for four unrelated faults, and the
   * counts tell them apart immediately: mostly `CRC_MISMATCH` is an optical
   * problem — focus, glare, a symbol too small; mostly `SESSION_MISMATCH` is a
   * second sender in the room; mostly `V1_FRAME` is a desktop on the previous
   * release; and *no rejections at all* alongside no progress means frames are
   * not reaching the decoder in the first place.
   *
   * Bounded by construction. The reasons are a closed set from this codebase's
   * own parsers, but the map is capped anyway: the input that produces them is
   * a camera pointed at whatever happens to be on a screen, and "our own enum"
   * is an assumption about code rather than a property of it.
   */
  private tallyRejection(reason: string): void {
    const existing = this.rejectionsByReason.get(reason);
    if (existing !== undefined) {
      this.rejectionsByReason.set(reason, existing + 1);
      return;
    }
    if (this.rejectionsByReason.size >= MAX_REJECTION_REASONS) return;
    this.rejectionsByReason.set(reason, 1);
  }
}
