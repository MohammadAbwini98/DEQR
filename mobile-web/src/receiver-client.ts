/**
 * The main thread's half of the receive pipeline, and the place the queue bound lives.
 *
 * ## The bound
 *
 * `canAccept()` is false while `maxInFlight` frames are unanswered, and the
 * capture loop asks before it reads a single pixel. That is the whole
 * backpressure mechanism, and it holds for a reason worth stating: **every
 * frame posted receives exactly one terminal event**, including the ones the
 * worker refuses for being stale or for belonging to an ended session. A frame
 * that could be dropped silently would leak a slot, and enough leaked slots
 * would wedge capture permanently - a queue bound that quietly becomes a
 * deadlock is worse than no bound at all. The worker is written to honour that
 * contract and a test holds it there.
 *
 * `maxInFlight` is 2: one frame being decoded, one already posted so the worker
 * never idles between them. Three would buy nothing - decode is 60-90 ms and
 * capture is single-digit milliseconds, so the second slot is already enough to
 * keep the decoder saturated - and would put another 2 MB pixel buffer in
 * flight for it.
 *
 * ## What it does when the worker dies
 *
 * Rebuilds it, once, and tells the caller. A dedicated worker can be killed by
 * iOS under memory pressure, and the failure looks identical to a scanner that
 * simply stopped answering: the camera keeps running, frames keep going out,
 * nothing comes back. So `onerror` and a `fatal` message both tear the worker
 * down, release every in-flight slot, and raise a fault the state machine turns
 * into a stopped camera and an explicit message - never a silent stall.
 */

import { RECEIVER_POLICY } from '../../src/core/receiver-policy';
import type { TelemetryCollector } from './metrics';
import {
  FRAME_OUTCOME,
  RECEIVE_WORKER_PROTOCOL,
  emptyProgress,
  isReceiveWorkerEvent,
  type ReceiveProgress,
  type ReceiveWorkerEvent,
  type ReceiveWorkerRequest,
  type SessionEndReasonWire,
  type VerifiedSource,
  type WorkerLimits,
} from './worker-protocol';

/**
 * One decoded and verified transfer, ready for the share sheet.
 *
 * Carries a *route to* the bytes rather than the bytes, because since Phase 06
 * the large case never has them in memory: a transfer written to OPFS arrives
 * here as a path the export step opens for itself. `bytes` remains the route
 * for v1 and for a small transfer that fell back to the in-memory store.
 */
export interface VerifiedTransfer {
  filename: string;
  mimeType: string;
  size: number;
  sha256: Uint8Array;
  source: VerifiedSource;
}

/** A captured frame on its way to the worker. Ownership of the payload moves with it. */
export interface CapturedFrame {
  frameId: number;
  /** `Date.now()`, not `performance.now()` - see the worker's clock note. */
  capturedAt: number;
  width: number;
  height: number;
  captureScale: number;
  pixels?: ArrayBuffer;
  bitmap?: ImageBitmap;
}

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

export interface ReceiverClientCallbacks {
  onProgress(progress: ReceiveProgress): void;
  onComplete(): void;
  onVerified(file: VerifiedTransfer): void;
  onFailed(code: string, message: string): void;
  /** The scanner itself stopped working. Distinct from a rejected transfer. */
  onFatal(code: string): void;
  /**
   * How far the final hash has got, reported apart from transfer progress.
   *
   * Optional because a caller that does not draw it should not have to write an
   * empty function, and because it fires only between `onComplete` and
   * `onVerified` - a window that is instant for a small file and several
   * seconds for a large one.
   */
  onVerifyProgress?(progress: {
    bytesHashed: number;
    bytesTotal: number;
    /** Which verification pass. A compressed transfer decompresses, then hashes. */
    phase: 'decompressing' | 'hashing';
  }): void;
}

export interface ReceiverClientOptions {
  createWorker?: () => WorkerLike;
  telemetry?: TelemetryCollector;
  maxInFlight?: number;
  limits?: Partial<WorkerLimits>;
  /** In-thread clock for telemetry. Wall-clock stamping is the camera's job. */
  now?: () => number;
}

export const DEFAULT_MAX_IN_FLIGHT = RECEIVER_POLICY.maxFramesInFlight;

/**
 * Receiver-side limits, restated as one object the worker is told at open.
 *
 * `maxDecodePixels` bounds what jsQR will be asked to allocate for,
 * `segmentBudgetBytes` bounds the in-memory store used where OPFS is absent,
 * and `storageMarginRatio` is the free space required on top of a transfer
 * before one is started. All of them are receiver policy, not protocol:
 * camera-originated data must not set the receiver's budgets, which is the same
 * rule v1's `LIMITS` was written under.
 */
export const DEFAULT_WORKER_LIMITS: WorkerLimits = {
  maxDecodePixels: RECEIVER_POLICY.maxDecodePixels,
  dedupeCapacity: RECEIVER_POLICY.dedupeCapacity,
  maxActiveSegments: RECEIVER_POLICY.maxActiveSegments,
  segmentBudgetBytes: RECEIVER_POLICY.fallbackSegmentBudgetBytes,
  storageMarginRatio: RECEIVER_POLICY.storageMarginRatio,
};

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./receive-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export class ReceiverClient {
  readonly maxInFlight: number;

  private readonly createWorker: () => WorkerLike;
  private readonly limits: WorkerLimits;
  private readonly now: () => number;
  private readonly telemetry: TelemetryCollector | undefined;

  private worker: WorkerLike | undefined;
  private epoch = 0;
  private opened = false;
  private inFlight = 0;
  private acceptsBitmap = false;
  private disposed = false;
  private progressState: ReceiveProgress = emptyProgress();

  constructor(
    private readonly callbacks: ReceiverClientCallbacks,
    options: ReceiverClientOptions = {},
  ) {
    this.createWorker = options.createWorker ?? defaultWorkerFactory;
    this.telemetry = options.telemetry;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.limits = { ...DEFAULT_WORKER_LIMITS, ...options.limits };
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    // Built eagerly, not on the first Receive tap, for two reasons. The worker
    // chunk carries jsQR, the v2 codec and the recovery engine; fetching and
    // compiling it is the slowest thing in the start path, and doing it here
    // moves it off the tap. And it is a separate hashed asset, so fetching it
    // while the page loads is what gets it into the service worker's cache -
    // an installed receiver that had never once pressed Receive while online
    // would otherwise find its scanner missing the first time it went offline.
    this.ensureWorker();
  }

  /* ------------------------------------------------------------------ status */

  /** True once the worker has handshaken and can take a transferred bitmap. */
  get supportsBitmapTransfer(): boolean {
    return this.acceptsBitmap;
  }

  get framesInFlight(): number {
    return this.inFlight;
  }

  get progress(): ReceiveProgress {
    return this.progressState;
  }

  /** The gate the capture loop asks before spending anything on a frame. */
  canAccept(): boolean {
    return this.opened && !this.disposed && this.worker !== undefined && this.inFlight < this.maxInFlight;
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Starts a session.
   *
   * The epoch it returns fences everything that follows. A frame, a progress
   * report or a verified file stamped with an older one is discarded on
   * arrival, which is what makes cancelling during a decode safe.
   */
  open(options: { resume?: boolean } = {}): number {
    if (this.disposed) throw new Error('the receiver client has been disposed');
    this.epoch += 1;
    this.inFlight = 0;
    this.progressState = emptyProgress();
    this.ensureWorker();
    this.opened = true;
    this.send({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'open',
      epoch: this.epoch,
      limits: this.limits,
      resume: options.resume === true,
    });
    return this.epoch;
  }

  /**
   * Ends the session, keeping the worker warm for the next one.
   *
   * The reason travels with it because only this side knows one: the worker
   * sees a closed session and cannot tell a user tapping Cancel from a tab
   * being backgrounded. It decides whether the partial file on the device is
   * deleted now or kept for a resume, so it defaults to `cancelled` - the
   * answer that leaves nothing behind - rather than to whichever is convenient.
   */
  close(reason: SessionEndReasonWire = 'cancelled'): void {
    if (!this.opened) return;
    this.opened = false;
    this.epoch += 1;
    this.inFlight = 0;
    this.progressState = emptyProgress();
    this.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'close', epoch: this.epoch, reason });
  }

  /** Asks the worker to finish and hash a completed transfer. */
  verify(): void {
    if (!this.opened) return;
    this.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'verify', epoch: this.epoch });
  }

  /** Permanent teardown. Terminates the worker and refuses everything after. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opened = false;
    this.epoch += 1;
    this.inFlight = 0;
    this.teardownWorker();
  }

  /* ------------------------------------------------------------------ frames */

  /**
   * Hands a captured frame to the worker.
   *
   * Returns false without consuming the frame when the client cannot take it,
   * so the caller can release the buffer it was going to transfer. Callers are
   * expected to check `canAccept()` first; this is the guard that makes the
   * bound hold even if one does not.
   */
  submit(frame: CapturedFrame): boolean {
    if (!this.canAccept()) return false;

    const transfer: Transferable[] = [];
    if (frame.pixels) transfer.push(frame.pixels);
    else if (frame.bitmap) transfer.push(frame.bitmap as unknown as Transferable);
    else return false;

    this.inFlight += 1;
    this.send(
      {
        v: RECEIVE_WORKER_PROTOCOL,
        type: 'frame',
        epoch: this.epoch,
        frameId: frame.frameId,
        capturedAt: frame.capturedAt,
        width: frame.width,
        height: frame.height,
        captureScale: frame.captureScale,
        pixels: frame.pixels,
        bitmap: frame.bitmap,
      },
      transfer,
    );
    return true;
  }

  /* ---------------------------------------------------------------- internals */

  private ensureWorker(): void {
    if (this.worker || this.disposed) return;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<unknown>) => this.onMessage(event.data);
    // A worker that fails to load and one that throws at top level both land
    // here, and both are indistinguishable from a camera that sees nothing.
    worker.onerror = () => this.onWorkerLost('SCANNER_UNAVAILABLE');
    worker.onmessageerror = () => this.onWorkerLost('SCANNER_PROTOCOL_ERROR');
    this.worker = worker;
  }

  private teardownWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.acceptsBitmap = false;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  private onWorkerLost(code: string): void {
    if (this.disposed) return;
    this.teardownWorker();
    // Releasing the slots matters even though the session is over: without it a
    // retry would start with a full in-flight count and capture nothing.
    this.inFlight = 0;
    this.opened = false;
    this.epoch += 1;
    this.callbacks.onFatal(code);
  }

  private send(request: ReceiveWorkerRequest, transfer?: Transferable[]): void {
    const worker = this.worker;
    if (!worker) return;
    try {
      worker.postMessage(request, transfer);
    } catch {
      // A refused post leaves a slot claimed forever otherwise, and the frame's
      // buffer is already detached, so there is nothing to hand back.
      if (request.type === 'frame' && this.inFlight > 0) this.inFlight -= 1;
      this.onWorkerLost('SCANNER_UNAVAILABLE');
    }
  }

  private onMessage(data: unknown): void {
    if (!isReceiveWorkerEvent(data)) return;
    const event = data as ReceiveWorkerEvent;

    if (event.type === 'ready') {
      this.acceptsBitmap = event.acceptsBitmap;
      return;
    }

    // Everything below is session-scoped. An event from a session that has
    // already ended is discarded - except that a frame still has to give its
    // slot back, which `epoch` bumping already did wholesale.
    if (event.type === 'frame') {
      if (this.inFlight > 0) this.inFlight -= 1;
      if (event.epoch !== this.epoch) return;
      this.recordFrame(event);
      return;
    }

    if (event.epoch !== this.epoch) return;

    switch (event.type) {
      case 'progress': {
        this.progressState = event.progress;
        this.callbacks.onProgress(event.progress);
        if (event.progress.complete) this.callbacks.onComplete();
        return;
      }
      case 'verify-progress': {
        this.callbacks.onVerifyProgress?.({
          bytesHashed: event.bytesHashed,
          bytesTotal: event.bytesTotal,
          phase: event.phase,
        });
        return;
      }
      case 'verified': {
        this.callbacks.onVerified({
          filename: event.filename,
          mimeType: event.mimeType,
          size: event.size,
          sha256: new Uint8Array(event.sha256),
          source: event.source,
        });
        return;
      }
      case 'failed': {
        this.callbacks.onFailed(event.code, event.message);
        return;
      }
      case 'fatal': {
        this.onWorkerLost(event.code || 'SCANNER_UNAVAILABLE');
        return;
      }
    }
  }

  private recordFrame(event: Extract<ReceiveWorkerEvent, { type: 'frame' }>): void {
    const telemetry = this.telemetry;
    if (!telemetry) return;

    telemetry.recordStale(event.staleDropped);
    if (event.outcome === FRAME_OUTCOME.STALE) return;
    if (event.observed) {
      telemetry.recordOptical({
        qrVersion: event.observed.qrVersion,
        modulesPerSide: event.observed.modulesPerSide,
        symbolSpanPx: event.observed.symbolSpanPx,
        pxPerModule: event.observed.pxPerModule,
        spanSkew: event.observed.spanSkew,
      });
    }
    if (event.outcome === FRAME_OUTCOME.NO_CODE) return;

    // Successful QR decode for all other outcomes (QR was found)
    telemetry.recordSuccessfulDecode();

    if (event.outcome === FRAME_OUTCOME.DUPLICATE) {
      telemetry.recordDecoded(this.now(), event.decodeMs, event.pipelineMs, false, true);
      return;
    }
    if (event.outcome === FRAME_OUTCOME.REJECTED) {
      telemetry.recordDecoded(this.now(), event.decodeMs, event.pipelineMs, false, false);
      // Distinguish parse vs foreign via reason code if available
      const reason = (event as { reason?: string }).reason ?? '';
      if (reason.includes('SESSION') || reason.includes('FOREIGN') || reason.includes('V1_FRAME')) {
        telemetry.recordForeignInvalid();
      } else {
        telemetry.recordParseFailure();
      }
      return;
    }
    if (event.outcome === FRAME_OUTCOME.FOREIGN) {
      telemetry.recordDecoded(this.now(), event.decodeMs, event.pipelineMs, false, false);
      telemetry.recordForeignInvalid();
      return;
    }

    // ACCEPTED / MANIFEST / PENDING_* are new sequences that advanced or will
    const isNew = event.outcome === FRAME_OUTCOME.ACCEPTED || event.outcome === FRAME_OUTCOME.MANIFEST;
    telemetry.recordDecoded(
      this.now(),
      event.decodeMs,
      event.pipelineMs,
      isNew,
      false,
    );
    if (isNew) {
      // Count solved blocks heuristically: one unique symbol ~ one solved block for systematic
      // The true solved count comes from pipeline progress; this is a fallback for client-side telemetry
      telemetry.recordSolvedBlocks(1);
    }
  }
}
