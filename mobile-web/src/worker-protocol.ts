/**
 * The wire between the main thread and the receive worker.
 *
 * Three properties are the point, and each one exists because its absence has a
 * specific failure mode:
 *
 * - **Versioned.** A service worker can serve a cached `index.html` against a
 *   freshly fetched worker bundle, or the reverse. Both sides stamp `v` and
 *   refuse anything else, so a mismatched pair fails at the handshake instead
 *   of silently misreading a field.
 * - **Typed and validated on receipt.** `postMessage` delivers whatever the
 *   other side structured-cloned. Every inbound message goes through a guard
 *   before a field is read, so a malformed one is a rejected message rather
 *   than an exception inside an event handler nothing is watching.
 * - **Bounded.** No message carries an unbounded array or an unbounded string.
 *   Counters are numbers, reasons are enumerated codes, and the largest payload
 *   that can cross is a verified file small enough to have been held in memory
 *   - transferred once, at the end, with its ownership handed over rather than
 *   copied. Since Phase 06 the large case does not cross at all: a file written
 *   to OPFS is handed over as a *path*, and the main thread opens it itself.
 *
 * The one thing this module deliberately does not describe is a queue, because
 * there is not one. Capture posts a frame only while fewer than `maxInFlight`
 * are unanswered, and every frame - decoded, refused, or aged out - gets
 * exactly one terminal `frame` event, so a slot can never be leaked.
 * Backpressure is a property of the protocol's shape, not a field inside it.
 */

import { RECEIVER_POLICY } from '../../src/core/receiver-policy';
import { isReceiverSessionFile, isReceiverSessionPath } from './opfs';

/**
 * Bumped whenever a message shape changes in a way the other side would misread.
 *
 * 2: Phase 06. `verified` carries a source descriptor instead of a byte buffer,
 * `open` carries a storage margin, and `frame` can report `pending-storage`.
 *
 * 3: Phase 07. `open` carries a resume flag, `reset` and `close` carry the
 * reason a session ended - which decides whether its bytes survive - and a new
 * `verify-progress` event reports the hash separately from the transfer.
 *
 * 4: Phase 08. `verify-progress` names which of the two verification passes it
 * is reporting, and `progress` carries the transfer's compression: the original
 * size, the optical size, and the mode they differ by.
 *
 * 5: Phase 09. `progress` carries the storage preflight - what this transfer was
 * decided to need, what the browser said was left, and how much that answer is
 * worth. The numbers were already computed; they were discarded before reaching
 * a screen, so a receiver could refuse a transfer for lack of room without ever
 * saying how much room it wanted.
 */
export const RECEIVE_WORKER_PROTOCOL = 5;

/** Longest error text the worker will forward. Keeps one message bounded. */
export const MAX_REASON_CHARS = RECEIVER_POLICY.maxReasonChars;

/* ------------------------------------------------------------ frame results */

/**
 * What happened to one captured frame.
 *
 * `no-code` and `duplicate` are the two common answers and both are cheap:
 * `no-code` means jsQR found nothing, `duplicate` means the decoded bytes
 * matched a fingerprint already seen and were never parsed.
 */
export const FRAME_OUTCOME = {
  NO_CODE: 'no-code',
  DUPLICATE: 'duplicate',
  ACCEPTED: 'accepted',
  MANIFEST: 'manifest',
  /** A v2 data frame arrived before the manifest that describes its session. */
  PENDING_MANIFEST: 'pending-manifest',
  /**
   * The manifest has landed and working storage is still being opened.
   *
   * Storage is chosen from the manifest's declared size and opening it is
   * asynchronous, so there is a window - normally a few milliseconds - in which
   * a session is known but cannot yet accept a byte. Frames in that window are
   * neither accepted nor rejected: the sender repeats everything, so the honest
   * report is that the receiver was not ready, and counting them as rejects
   * would make a healthy start look like a failing one.
   */
  PENDING_STORAGE: 'pending-storage',
  REJECTED: 'rejected',
  /** Decoded, but the frame belonged to a session this receiver is not on. */
  FOREIGN: 'foreign',
  /** Reached the worker too old to be worth decoding, or after its session ended. */
  STALE: 'stale',
} as const;
export type FrameOutcome = (typeof FRAME_OUTCOME)[keyof typeof FRAME_OUTCOME];

/**
 * What the camera resolved, in captured pixels.
 *
 * Phase 04 measured decode success against camera pixels per module and could
 * only sweep it; this is the field that turns it into an observation. The span
 * is the longest edge of jsQR's corner quad, so it is measured over the QR
 * symbol itself - quiet zone excluded, because jsQR's corners sit on the
 * symbol's outer module boundary. `pxPerModule` therefore divides by
 * `modulesPerSide` and NOT by a profile's quiet-zone-inclusive
 * `minCameraSymbolPx`; comparing those two directly is a unit error that would
 * flatter every reading by about 18%.
 */
export interface OpticalObservation {
  qrVersion: number;
  modulesPerSide: number;
  /** Mean of the quad's four edge lengths. The max flatters, the min penalises. */
  symbolSpanPx: number;
  pxPerModule: number;
  /**
   * Shortest edge over longest, so 1.0 is square-on to the display.
   *
   * Carried because without it a low `pxPerModule` has two completely
   * different causes with two different instructions: too far away, or too
   * oblique. Phase 11 has to be able to tell those apart from a log.
   */
  spanSkew: number;
  /** Captured-frame edge the span was measured in, so it can be rescaled later. */
  captureEdgePx: number;
  /** Captured pixels per camera pixel. Below 1 when the ROI was downscaled. */
  captureScale: number;
}

/* ------------------------------------------------------------------ progress */

/** Which protocol the active session is running, or 0 before anything decodes. */
export type ActiveProtocol = 0 | 1 | 2;

/**
 * Everything the UI is allowed to know, as counters.
 *
 * No payload byte appears here and none ever should: the receive worker holds
 * the file and the main thread holds a description of it. `filename` is the
 * single exception, and it is sanitized before it is ever put in this object.
 */
export interface ReceiveProgress {
  protocol: ActiveProtocol;
  sessionActive: boolean;
  complete: boolean;
  filename?: string;
  /** v1 source blocks, or v2 segments. Both are "units recovered of units known". */
  unitsRecovered: number;
  unitsTotal: number;
  framesAccepted: number;
  framesDuplicate: number;
  framesRejected: number;
  framesForeign: number;
  manifestFrames: number;
  /** Bytes handed to the segment store. v2 only; v1 reconstructs at the end. */
  bytesCommitted: number;
  /**
   * Bytes resident in JavaScript memory right now: the decoders, plus whatever
   * the store has not written through.
   *
   * The number the phase's memory gate is written against, which is why it
   * counts residency rather than progress. On the OPFS path it stays flat as
   * `bytesCommitted` climbs, and that divergence is the whole claim.
   */
  heldBytes: number;
  /** Where this session's bytes are going. `none` before a session exists. */
  storageKind: 'none' | 'memory' | 'opfs';
  /** Set once the store has refused a write. The session cannot continue. */
  storagePressure: boolean;
  /**
   * Set when the session itself is dead, not just one frame.
   *
   * A v1 session that meets a conflicting duplicate or a foreign session id
   * fails permanently and then rejects everything after it. Without this the
   * receiver would keep scanning against a session that can never advance,
   * which on screen is indistinguishable from a camera that cannot see the code.
   */
  fault?: string;
  /**
   * Units this session started with, adopted from a checkpoint on the device.
   *
   * Counted inside `unitsRecovered` and reported again here because they are a
   * different claim: one is how much of the file exists, the other is how much
   * of it this run received. A progress bar that opens at 90% has to be able to
   * say "resuming" rather than looking like it skipped most of the transfer.
   */
  unitsAdopted: number;
  /** True when anything was adopted. Derived, and carried so the UI need not derive it. */
  resumed: boolean;
  /**
   * The code a user carries to a desktop to resume this transfer.
   *
   * Present for any live v2 session, not only an interrupted one: the moment
   * to read it off a screen is *after* something has gone wrong, and a token
   * that only appeared then would have to be minted by a receiver that may
   * already have lost its camera.
   */
  resumeToken?: string;
  /**
   * Why data found on the device was not adopted, when a resume was attempted.
   *
   * Not a fault - the transfer proceeds from zero and will succeed - but the
   * difference between "there was nothing to resume" and "what was there
   * belonged to a different file" is the difference between a user waiting
   * patiently and a user wondering why their progress vanished.
   */
  checkpointRejection?: string;
  /**
   * Original bytes this transfer will produce, from the manifest.
   *
   * Reported apart from `bytesCommitted` because for a compressed transfer they
   * measure two different things: what the file weighs, and what has come down
   * the optical link so far. Collapsing them would make a compressed transfer
   * look like it had lost most of the file.
   */
  originalBytes: number;
  /** Bytes the segments carry. Equal to `originalBytes` when uncompressed. */
  transportBytes: number;
  /**
   * `V2_COMPRESSION` mode from the manifest. Zero means the segments are the file.
   *
   * The receiver reports the mode; it never chooses one. A compression decision
   * is the sender's and is made from sampled bytes - see `compression-policy.ts`.
   */
  compressionMode: number;
  /**
   * Room this transfer was decided to need, from the storage preflight.
   *
   * Transport bytes plus the receiver's own safety margin - see
   * `preflightStorage`. Zero before a manifest has been provisioned against,
   * which is why `storageConfidence` carries `none` rather than this field
   * carrying a sentinel.
   */
  storageRequiredBytes: number;
  /**
   * Room the browser said was left, at the moment the decision was made.
   *
   * Meaningful only when `storageConfidence` is `reported`, and even then it is
   * a browser-granted quota rather than a measurement of the device's free
   * space. Zero otherwise.
   */
  storageAvailableBytes: number;
  /**
   * How much the two numbers above are worth.
   *
   * `none` means no preflight has run for this session yet. `unknown` means it
   * ran against a browser with no estimate API, so the transfer was allowed to
   * start and may still run out at the far end - which is deliberate, and which
   * a screen has to be able to phrase differently from a real measurement.
   */
  storageConfidence: 'none' | 'reported' | 'unknown';
}

export function emptyProgress(): ReceiveProgress {
  return {
    protocol: 0,
    sessionActive: false,
    complete: false,
    unitsRecovered: 0,
    unitsTotal: 0,
    framesAccepted: 0,
    framesDuplicate: 0,
    framesRejected: 0,
    framesForeign: 0,
    manifestFrames: 0,
    bytesCommitted: 0,
    heldBytes: 0,
    storageKind: 'none',
    storagePressure: false,
    unitsAdopted: 0,
    resumed: false,
    originalBytes: 0,
    transportBytes: 0,
    compressionMode: 0,
    storageRequiredBytes: 0,
    storageAvailableBytes: 0,
    storageConfidence: 'none',
  };
}

/* ------------------------------------------------------------------ requests */

export interface WorkerLimits {
  /** Refuses a capture larger than this before jsQR allocates for it. */
  maxDecodePixels: number;
  /** Frame fingerprints remembered. Bounds dedupe memory, never correctness. */
  dedupeCapacity: number;
  /** v2 decoders alive at once. Bounds decoder memory against the segment size. */
  maxActiveSegments: number;
  /**
   * Bytes the in-memory segment store may hold before it refuses a write.
   *
   * Since Phase 06 this bounds only the fallback used where OPFS is absent. A
   * transfer larger than it is refused at the manifest on such a browser rather
   * than allowed to start and fail.
   */
  segmentBudgetBytes: number;
  /**
   * Free storage required on top of the transfer, as a fraction of its size.
   *
   * Receiver policy, like every other field here. A margin exists because the
   * browser's reported quota is not a measurement of the device's free space
   * and can shrink under pressure while a transfer is running.
   */
  storageMarginRatio: number;
}

/**
 * Why a session is ending, which decides whether its working data survives.
 *
 * Carried on the wire because the main thread is the only side that knows: the
 * worker sees a `reset` and cannot tell a user tapping Cancel from a tab being
 * backgrounded, and those two want opposite answers. Mirrors `SessionEndReason`
 * in the pipeline, and is validated against this list on receipt.
 */
export const SESSION_END_REASON = ['cancelled', 'failed', 'interrupted', 'completed'] as const;
export type SessionEndReasonWire = (typeof SESSION_END_REASON)[number];

const SESSION_END_REASONS: ReadonlySet<string> = new Set<string>(SESSION_END_REASON);

export type ReceiveWorkerRequest =
  | {
      v: number;
      type: 'open';
      epoch: number;
      limits: WorkerLimits;
      /**
       * Adopt working data left by an earlier run of the same transfer.
       *
       * A capability the main thread grants per session rather than a mode the
       * worker decides for itself, because whether a resume is wanted is a
       * property of what the user just did.
       */
      resume?: boolean;
    }
  | {
      v: number;
      type: 'frame';
      epoch: number;
      frameId: number;
      capturedAt: number;
      width: number;
      height: number;
      captureScale: number;
      /** RGBA bytes, transferred. Present when the worker cannot take bitmaps. */
      pixels?: ArrayBuffer;
      /** Transferred instead of pixels when both sides support it. */
      bitmap?: ImageBitmap;
    }
  | { v: number; type: 'verify'; epoch: number }
  | { v: number; type: 'reset'; epoch: number; reason?: SessionEndReasonWire }
  | { v: number; type: 'close'; epoch: number; reason?: SessionEndReasonWire };

export type ReceiveWorkerRequestType = ReceiveWorkerRequest['type'];

/* -------------------------------------------------------------------- events */

/**
 * Where the main thread reads a verified file from.
 *
 * `bytes` is transferred and the worker no longer holds it afterwards; it is
 * used for v1, which reconstructs in memory, and for a small v2 transfer that
 * fell back to the in-memory store. `opfs` carries no payload at all - just the
 * path of a file the worker has already closed its handle on - which is what
 * makes exporting a file larger than the device's memory possible.
 *
 * The path is validated on receipt against the exact shape this receiver
 * writes. A path is an instruction to open a file, and this one arrives over
 * `postMessage`.
 */
export type VerifiedSource =
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'opfs'; path: string[]; file: string };

export type ReceiveWorkerEvent =
  | { v: number; type: 'ready'; acceptsBitmap: boolean }
  | {
      v: number;
      type: 'frame';
      epoch: number;
      frameId: number;
      outcome: FrameOutcome;
      decodeMs: number;
      pipelineMs: number;
      /** Set on `rejected`; an enumerated protocol code, never free text. */
      reason?: string;
      observed?: OpticalObservation;
      /** Running total of frames the worker dropped from its pending slot. */
      staleDropped: number;
    }
  | { v: number; type: 'progress'; epoch: number; progress: ReceiveProgress }
  /**
   * How far the final SHA-256 has got.
   *
   * A separate event rather than a field on `progress`, because it measures a
   * different thing over a different period: transfer progress is finished and
   * frozen while this one moves, and a screen that showed only the first would
   * look hung for the nine seconds a gigabyte takes to hash. Emitted about
   * sixty times per gigabyte - at the hash's yield boundaries - so it costs
   * nothing next to the work it describes.
   */
  | {
      v: number;
      type: 'verify-progress';
      epoch: number;
      bytesHashed: number;
      bytesTotal: number;
      /** Which pass this is. A compressed transfer runs decompressing, then hashing. */
      phase: 'decompressing' | 'hashing';
    }
  | {
      v: number;
      type: 'verified';
      epoch: number;
      filename: string;
      mimeType: string;
      /** Verified byte length, from the store rather than from the manifest. */
      size: number;
      sha256: ArrayBuffer;
      source: VerifiedSource;
    }
  | { v: number; type: 'failed'; epoch: number; code: string; message: string }
  /** The worker cannot continue at all. The client tears it down and rebuilds. */
  | { v: number; type: 'fatal'; epoch: number; code: string };

export type ReceiveWorkerEventType = ReceiveWorkerEvent['type'];

/* -------------------------------------------------------------------- guards */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const REQUEST_TYPES: ReadonlySet<string> = new Set<ReceiveWorkerRequestType>([
  'open',
  'frame',
  'verify',
  'reset',
  'close',
]);

const EVENT_TYPES: ReadonlySet<string> = new Set<ReceiveWorkerEventType>([
  'ready',
  'frame',
  'progress',
  'verify-progress',
  'verified',
  'failed',
  'fatal',
]);

/**
 * Accepts a message only if this build wrote it.
 *
 * The version check is first and is not a formality: an installed PWA can hold
 * a cached document from one release against a worker from another, and every
 * field below is read positionally by both sides.
 */
export function isReceiveWorkerRequest(value: unknown): value is ReceiveWorkerRequest {
  if (!isRecord(value)) return false;
  if (value.v !== RECEIVE_WORKER_PROTOCOL) return false;
  if (typeof value.type !== 'string' || !REQUEST_TYPES.has(value.type)) return false;
  if (!isCount(value.epoch)) return false;

  if (value.type === 'open') {
    const limits = value.limits;
    return (
      isRecord(limits)
      && isCount(limits.maxDecodePixels)
      && isCount(limits.dedupeCapacity)
      && isCount(limits.maxActiveSegments)
      && isCount(limits.segmentBudgetBytes)
      && isCount(limits.storageMarginRatio)
      && (value.resume === undefined || typeof value.resume === 'boolean')
    );
  }

  if (value.type === 'reset' || value.type === 'close') {
    // An unknown reason is refused rather than defaulted. Guessing here would
    // mean guessing whether to delete a user's partial transfer.
    return value.reason === undefined
      || (typeof value.reason === 'string' && SESSION_END_REASONS.has(value.reason));
  }

  if (value.type === 'frame') {
    if (!isCount(value.frameId) || !isCount(value.capturedAt)) return false;
    if (!isCount(value.width) || !isCount(value.height)) return false;
    if (typeof value.captureScale !== 'number' || !Number.isFinite(value.captureScale)) return false;
    const hasPixels = value.pixels instanceof ArrayBuffer;
    // `ImageBitmap` is not a global in a Node test runner, so the presence of a
    // non-pixel payload is what is checked rather than its constructor.
    const hasBitmap = value.pixels === undefined && isRecord(value.bitmap);
    return hasPixels || hasBitmap;
  }

  return true;
}

export function isReceiveWorkerEvent(value: unknown): value is ReceiveWorkerEvent {
  if (!isRecord(value)) return false;
  if (value.v !== RECEIVE_WORKER_PROTOCOL) return false;
  if (typeof value.type !== 'string' || !EVENT_TYPES.has(value.type)) return false;
  if (value.type !== 'ready' && !isCount(value.epoch)) return false;

  switch (value.type) {
    case 'ready':
      return typeof value.acceptsBitmap === 'boolean';
    case 'frame':
      return isCount(value.frameId)
        && typeof value.outcome === 'string'
        && isCount(value.decodeMs)
        && isCount(value.pipelineMs)
        && isCount(value.staleDropped);
    case 'progress':
      return isRecord(value.progress)
        && isCount(value.progress.unitsTotal)
        // Validated on receipt like every other field that reaches a screen. A
        // storage summary is the one thing on the receive screen that tells
        // someone whether to go and delete photos, so a malformed one must be
        // rejected rather than rendered.
        && isCount(value.progress.storageRequiredBytes)
        && isCount(value.progress.storageAvailableBytes)
        && (value.progress.storageConfidence === 'none'
          || value.progress.storageConfidence === 'reported'
          || value.progress.storageConfidence === 'unknown');
    case 'verify-progress':
      return isCount(value.bytesHashed)
        && isCount(value.bytesTotal)
        && (value.phase === 'decompressing' || value.phase === 'hashing');
    case 'verified':
      return typeof value.filename === 'string'
        && typeof value.mimeType === 'string'
        && isCount(value.size)
        && value.sha256 instanceof ArrayBuffer
        && isVerifiedSource(value.source);
    case 'failed':
      return typeof value.code === 'string' && typeof value.message === 'string';
    case 'fatal':
      return typeof value.code === 'string';
    default:
      return false;
  }
}

/**
 * Accepts only the source shapes this receiver writes.
 *
 * The OPFS branch checks the path itself rather than trusting it, because the
 * main thread turns it straight into an `open`. `isReceiverSessionPath` admits
 * exactly `deqr/sessions/<8 hex>-<8 hex>`, and `isReceiverSessionFile` admits
 * exactly the two payload files a session can be exported from - so a message
 * that named any other directory or any other file, however it got onto the
 * port, opens nothing.
 *
 * The file check is a closed set rather than a single name because a
 * compressed transfer exports `original.part` and an uncompressed one exports
 * `data.part`. Naming only the second - which is what this guard did until
 * Phase 10 - silently discarded the `verified` message of every compressed
 * OPFS transfer, leaving the receive screen waiting for a file that had
 * already been produced and hashed.
 */
function isVerifiedSource(value: unknown): value is VerifiedSource {
  if (!isRecord(value)) return false;
  if (value.kind === 'bytes') return value.bytes instanceof ArrayBuffer;
  if (value.kind !== 'opfs') return false;
  return (
    Array.isArray(value.path)
    && value.path.every((part) => typeof part === 'string')
    && isReceiverSessionPath(value.path as string[])
    && isReceiverSessionFile(value.file)
  );
}

/** Trims worker-authored error text to the bound this protocol promises. */
export function boundReason(message: string): string {
  return message.length <= MAX_REASON_CHARS ? message : `${message.slice(0, MAX_REASON_CHARS - 3)}...`;
}
