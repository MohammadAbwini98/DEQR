/**
 * The receive worker's behaviour, with no worker in it.
 *
 * Split from `receive-worker.ts` - which is twenty lines of `self.onmessage`
 * glue - for one reason: a class that reaches for `self` at import time cannot
 * be tested outside a worker, and the message handling is the part most worth
 * testing. Everything here takes its `postMessage`, its clock, and its
 * staleness threshold as constructor arguments.
 *
 * ## What it is
 *
 * Decode, then everything downstream of decode.
 *
 * The previous worker ran jsQR and nothing else, and handed raw bytes back for
 * the main thread to parse, deduplicate, recover, and hash. This one owns the
 * whole chain, so the only work left on the main thread is the camera, the
 * pixels, and the UI.
 *
 * ## Where the queue bound actually lives
 *
 * Not here. jsQR is synchronous, so a worker cannot be decoding one frame and
 * receiving another: messages are dispatched one at a time between decodes, and
 * any frame the client posts early simply waits in the worker's own message
 * queue - which is unbounded and which this code cannot inspect or trim. A
 * "pending frame slot" inside the worker would be unreachable machinery.
 *
 * The bound is therefore the client's, and it is a real one: capture posts a
 * frame only while fewer than `maxInFlight` are unanswered, and every frame
 * gets exactly one terminal event so a slot is never leaked. See
 * `receiver-client.ts`.
 *
 * What the worker *can* do, and does, is refuse to spend 60-90 ms decoding a
 * photograph of a display that has since moved on. A frame older than
 * `STALE_FRAME_MS` when it reaches the front of the queue is reported as
 * `stale` without being decoded. This is not a theoretical case: iOS
 * deprioritises work in an occluded or backgrounded tab, and a resumed worker
 * can find several hundred milliseconds of captures waiting. Skipping them
 * costs at worst a duplicate - the sender loops - and buys back a whole decode
 * slot immediately, because the freed in-flight slot lets capture post a
 * current frame at once.
 *
 * ## Two ways in for pixels
 *
 * `ImageBitmap` is transferred and drawn into an `OffscreenCanvas` here, which
 * keeps the readback off the main thread completely. Where either API is
 * missing the client falls back to reading pixels on the main thread and
 * transferring the buffer, which is what the receiver did before. The worker
 * advertises which it can take in its `ready` message rather than the client
 * guessing from a user-agent string.
 *
 * ## One clock, deliberately
 *
 * Frame age is measured with `Date.now()` on both sides. `performance.now()` is
 * relative to each context's own time origin, and a dedicated worker's origin
 * is its creation, not the document's - so a `performance.now()` timestamp
 * crossing this boundary would be silently wrong by however long the page had
 * been open. Wall-clock milliseconds are coarse, which a 250 ms threshold does
 * not care about. Durations measured *within* one thread still use
 * `performance.now()`, where it is both valid and precise.
 */

import jsQR from 'jsqr';

import { qrModuleCount } from '../../src/core/qr-capacity';
import { ReceivePipeline, type ReceivePipelineOptions } from './receive-pipeline';
import {
  FRAME_OUTCOME,
  RECEIVE_WORKER_PROTOCOL,
  boundReason,
  type FrameOutcome,
  type OpticalObservation,
  type ReceiveWorkerEvent,
  type ReceiveWorkerRequest,
  type SessionEndReasonWire,
  type VerifiedSource,
  type WorkerLimits,
} from './worker-protocol';

/** Progress is a UI concern; posting one per frame would be the flood it replaces. */
const PROGRESS_INTERVAL_MS = 120;

/**
 * Age past which a captured frame is dropped instead of decoded.
 *
 * 250 ms is between 2.5 and 5 display frames at the Phase 04 profile cadences,
 * so a capture this old shows a symbol the sender has already replaced several
 * times over.
 */
export const STALE_FRAME_MS = 250;

type FrameRequest = Extract<ReceiveWorkerRequest, { type: 'frame' }>;

/** Whether this context can draw a transferred bitmap without the main thread. */
export const OFFSCREEN_CANVAS_AVAILABLE = typeof OffscreenCanvas !== 'undefined';

export class ReceiveWorker {
  private pipeline = new ReceivePipeline();
  private limits: WorkerLimits | undefined;
  private epoch = 0;
  private open = false;
  private staleDropped = 0;

  /** Cleanup owed by sessions this worker has already replaced. */
  private outgoingCleanup: Promise<void> = Promise.resolve();

  private canvas: OffscreenCanvas | undefined;
  private context: OffscreenCanvasRenderingContext2D | undefined;
  private lastProgressAt = -Infinity;
  /** Last reported shape of the session, so a real change beats the throttle. */
  private reported = { active: false, complete: false, faulted: false };

  constructor(
    private readonly post: (event: ReceiveWorkerEvent, transfer?: Transferable[]) => void,
    private readonly staleFrameMs: number = STALE_FRAME_MS,
    private readonly wallClock: () => number = () => Date.now(),
    /**
     * Overrides merged into every pipeline this worker builds.
     *
     * The seam a test or a bench needs and the app never uses. In a browser the
     * pipeline finds OPFS for itself; under Node there is none, so without a
     * way to hand it a substitute the worker's own storage behaviour - a resume
     * flag reaching a store, a session ending with the right retention - could
     * only be asserted against the in-memory fallback, where none of it means
     * anything.
     */
    private readonly pipelineOverrides: Partial<ReceivePipelineOptions> = {},
  ) {}

  handle(request: ReceiveWorkerRequest): void {
    switch (request.type) {
      case 'open':
        return this.onOpen(request.epoch, request.limits, request.resume === true);
      case 'frame':
        return this.onFrame(request);
      case 'verify':
        return void this.onVerify(request.epoch);
      case 'reset':
        return this.onReset(request.epoch, request.reason);
      case 'close':
        return this.onClose(request.reason);
    }
  }

  /* ------------------------------------------------------------------ epochs */

  /**
   * Whether a message still belongs to the session the worker is on.
   *
   * The main thread bumps the epoch whenever it ends a session. Frames posted
   * before that arrive after it, and decoding them would fold a cancelled
   * transfer's symbols into the next one.
   */
  private current(epoch: number): boolean {
    return this.open && epoch === this.epoch;
  }

  private onOpen(epoch: number, limits: WorkerLimits, resume: boolean): void {
    // The outgoing session is released, not reset, and with no reason - so it
    // discards. A new `open` means the previous session is being replaced
    // rather than paused, and keeping its bytes would leave debris a resume
    // will never ask for.
    //
    // Its deletion is asynchronous and the new pipeline's is a separate chain,
    // so the two are in principle unordered. In practice they cannot overlap:
    // `release` closes the store's handle synchronously, here, while the new
    // pipeline touches storage only once a manifest has been decoded from a
    // camera frame - a macrotask and a camera start later. `settled` below
    // waits on both chains so a caller that needs the guarantee can have it.
    const outgoing = this.pipeline;
    outgoing.release();
    this.outgoingCleanup = this.outgoingCleanup
      .then(() => outgoing.settled())
      .catch(() => undefined);
    this.epoch = epoch;
    this.limits = limits;
    this.staleDropped = 0;
    this.lastProgressAt = -Infinity;
    this.reported = { active: false, complete: false, faulted: false };
    this.pipeline = new ReceivePipeline({
      dedupeCapacity: limits.dedupeCapacity,
      maxActiveSegments: limits.maxActiveSegments,
      segmentBudgetBytes: limits.segmentBudgetBytes,
      storageMarginRatio: limits.storageMarginRatio,
      resume,
      // Bound to the epoch at open, so a verification still running for an
      // abandoned session cannot post progress against the current one.
      onVerifyProgress: ({ bytesHashed, bytesTotal, phase }) => {
        if (this.current(epoch)) {
          this.post({ v: RECEIVE_WORKER_PROTOCOL, type: 'verify-progress', epoch, bytesHashed, bytesTotal, phase });
        }
      },
      ...this.pipelineOverrides,
    });
    this.open = true;
    this.postProgress(true);
  }

  private onReset(epoch: number, reason: SessionEndReasonWire | undefined): void {
    if (epoch !== this.epoch) return;
    this.pipeline.reset(reason);
    this.staleDropped = 0;
    this.postProgress(true);
  }

  private onClose(reason: SessionEndReasonWire | undefined): void {
    this.pipeline.release(reason);
    this.open = false;
    this.canvas = undefined;
    this.context = undefined;
  }

  /**
   * Resolves once every session this worker has ended has finished with the
   * device: the current one and any it replaced.
   *
   * Nothing in the app waits for this - a deletion the user is not watching
   * does not need to be awaited. It exists so a test asserting that a cancelled
   * session left nothing behind can wait for the deletion it is asserting about
   * rather than sampling a race.
   */
  async settled(): Promise<void> {
    await this.outgoingCleanup;
    await this.pipeline.settled();
  }

  /* ------------------------------------------------------------------ frames */

  private onFrame(request: FrameRequest): void {
    // Both rejections release the frame and still emit exactly one terminal
    // event, which is what keeps the client's in-flight accounting honest.
    if (!this.current(request.epoch)) {
      releaseFrame(request);
      this.emitFrame(request, FRAME_OUTCOME.STALE, 0, 0);
      return;
    }

    const age = this.wallClock() - request.capturedAt;
    if (age > this.staleFrameMs) {
      this.staleDropped += 1;
      releaseFrame(request);
      this.emitFrame(request, FRAME_OUTCOME.STALE, 0, 0);
      return;
    }

    this.process(request);
  }

  private process(request: FrameRequest): void {
    const decodeStartedAt = elapsed();
    let bytes: Uint8Array | undefined;
    let observed: OpticalObservation | undefined;

    try {
      const image = this.pixelsOf(request);
      if (!image) {
        this.emitFrame(request, FRAME_OUTCOME.NO_CODE, elapsed() - decodeStartedAt, 0);
        return;
      }
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      if (code?.binaryData?.length) {
        bytes = Uint8Array.from(code.binaryData);
        observed = observationOf(code, image.width, request.captureScale);
      }
    } catch {
      // Never echo a decoder exception: it can carry fragments of the payload.
      this.emitFrame(request, FRAME_OUTCOME.NO_CODE, elapsed() - decodeStartedAt, 0);
      return;
    } finally {
      releaseFrame(request);
    }

    const decodeMs = elapsed() - decodeStartedAt;
    if (!bytes) {
      this.emitFrame(request, FRAME_OUTCOME.NO_CODE, decodeMs, 0, undefined, observed);
      return;
    }

    const pipelineStartedAt = elapsed();
    const result = this.pipeline.submit(bytes);
    bytes.fill(0);
    const pipelineMs = elapsed() - pipelineStartedAt;

    this.emitFrame(request, result.outcome, decodeMs, pipelineMs, result.reason, observed);
    this.postProgress(result.completed || this.pipeline.isComplete);
  }

  /** RGBA pixels for one request, from whichever transport it used. */
  private pixelsOf(request: FrameRequest): ImageData | null {
    const maxPixels = this.limits?.maxDecodePixels ?? 0;
    const { width, height } = request;
    if (width < 1 || height < 1 || width * height > maxPixels) return null;

    if (request.pixels) {
      if (request.pixels.byteLength !== width * height * 4) return null;
      return { data: new Uint8ClampedArray(request.pixels), width, height } as ImageData;
    }

    const bitmap = request.bitmap;
    if (!bitmap || !OFFSCREEN_CANVAS_AVAILABLE) return null;
    const context = this.contextFor(width, height);
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  private contextFor(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas = new OffscreenCanvas(width, height);
      this.context = undefined;
    }
    this.context ??= this.canvas.getContext('2d', { willReadFrequently: true }) ?? undefined;
    return this.context ?? null;
  }

  /* ------------------------------------------------------------ verification */

  private async onVerify(epoch: number): Promise<void> {
    if (!this.current(epoch)) return;
    let result;
    try {
      result = await this.pipeline.verify();
    } catch (error) {
      result = {
        ok: false as const,
        code: 'VERIFICATION_FAILED',
        message: error instanceof Error ? error.message : 'Verification failed.',
      };
    }
    // A cancel that landed while the hash was running invalidates the answer,
    // and a verified file for an abandoned session must not be handed over.
    if (!this.current(epoch)) return;

    if (!result.ok) {
      this.post({
        v: RECEIVE_WORKER_PROTOCOL,
        type: 'failed',
        epoch,
        code: result.code,
        message: boundReason(result.message),
      });
      return;
    }

    // Two routes out, and the difference is the phase. A file the receiver
    // held is transferred - ownership moves, nothing is copied. A file written
    // to the device does not cross at all: the worker names it and the main
    // thread opens it, which is what makes a transfer larger than memory
    // exportable.
    const sha256 = toTransferable(result.value.sha256);
    const transfer: Transferable[] = [sha256];
    let source: VerifiedSource;
    if (result.value.source.kind === 'bytes') {
      const bytes = toTransferable(result.value.source.bytes);
      transfer.push(bytes);
      source = { kind: 'bytes', bytes };
    } else {
      source = { kind: 'opfs', path: result.value.source.path, file: result.value.source.file };
    }

    this.post(
      {
        v: RECEIVE_WORKER_PROTOCOL,
        type: 'verified',
        epoch,
        filename: result.value.filename,
        mimeType: result.value.mimeType,
        size: result.value.size,
        sha256,
        source,
      },
      transfer,
    );
    this.postProgress(true);
  }

  /* ---------------------------------------------------------------- emitting */

  private emitFrame(
    request: FrameRequest,
    outcome: FrameOutcome,
    decodeMs: number,
    pipelineMs: number,
    reason?: string,
    observed?: OpticalObservation,
  ): void {
    this.post({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'frame',
      epoch: request.epoch,
      frameId: request.frameId,
      outcome,
      decodeMs,
      pipelineMs,
      reason,
      observed,
      staleDropped: this.staleDropped,
    });
  }

  /**
   * Reports progress, rate-limited except when something structural changed.
   *
   * The throttle is there so a 15 FPS scan does not drive 15 React renders a
   * second. But three transitions are not "progress" - they are the events the
   * state machine is waiting on, and delaying them by up to a frame interval
   * shows a stale screen at the exact moments a user is watching hardest: the
   * first frame of a session landing, the transfer completing, and the session
   * dying. Those bypass the throttle.
   */
  private postProgress(force: boolean): void {
    const progress = this.pipeline.progress();
    const structural = progress.sessionActive !== this.reported.active
      || progress.complete !== this.reported.complete
      || Boolean(progress.fault) !== this.reported.faulted;
    const at = elapsed();
    if (!force && !structural && at - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;

    this.lastProgressAt = at;
    this.reported = {
      active: progress.sessionActive,
      complete: progress.complete,
      faulted: Boolean(progress.fault),
    };
    this.post({ v: RECEIVE_WORKER_PROTOCOL, type: 'progress', epoch: this.epoch, progress });
  }
}

/* ------------------------------------------------------------------ helpers */

/** In-thread duration clock. Never crosses the worker boundary; see the module note. */
function elapsed(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Frees whatever the transport handed over. A bitmap that is not closed leaks GPU memory. */
function releaseFrame(request: FrameRequest): void {
  const bitmap = request.bitmap as { close?: () => void } | undefined;
  if (bitmap && typeof bitmap.close === 'function') bitmap.close();
}

function toTransferable(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

interface Corner {
  x: number;
  y: number;
}

function edge(from: Corner, to: Corner): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/**
 * Turns jsQR's corner quad into the camera density Phase 04 could only sweep.
 *
 * Exported for the tests, which check it against a synthetic quad of known
 * size, because the whole point of the field is that a wrong number here would
 * be indistinguishable from a real reading.
 */
export function observationOf(
  code: { version: number; location: Record<string, Corner> },
  captureEdgePx: number,
  captureScale: number,
): OpticalObservation | undefined {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = code.location;
  if (!topLeftCorner || !topRightCorner || !bottomRightCorner || !bottomLeftCorner) return undefined;

  const edges = [
    edge(topLeftCorner, topRightCorner),
    edge(topRightCorner, bottomRightCorner),
    edge(bottomRightCorner, bottomLeftCorner),
    edge(bottomLeftCorner, topLeftCorner),
  ];
  const longest = Math.max(...edges);
  if (!Number.isFinite(longest) || longest <= 0) return undefined;
  const shortest = Math.min(...edges);
  const symbolSpanPx = edges.reduce((total, value) => total + value, 0) / edges.length;

  let modulesPerSide: number;
  try {
    modulesPerSide = qrModuleCount(code.version);
  } catch {
    // jsQR reported a version outside 1..40. Report no observation rather than
    // a density derived from a module count that does not exist.
    return undefined;
  }

  return {
    qrVersion: code.version,
    modulesPerSide,
    symbolSpanPx,
    // Divided by the symbol's own module count, quiet zone excluded, because
    // jsQR's corners sit on the symbol boundary. See `OpticalObservation`.
    pxPerModule: symbolSpanPx / modulesPerSide,
    spanSkew: shortest / longest,
    captureEdgePx,
    captureScale,
  };
}
