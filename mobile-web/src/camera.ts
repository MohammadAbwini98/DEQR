/**
 * Camera lifecycle and frame scheduling. Main thread, and nothing else.
 *
 * The camera stays here on purpose: `getUserMedia`, a `<video>` element and its
 * lifecycle events are main-thread APIs, and iOS is strict about the stream
 * being started from a user gesture. What moved off is everything that used to
 * follow a capture - QR decode, protocol parsing, duplicate detection, fountain
 * recovery, SHA-256 - which now lives behind `CaptureTarget`.
 *
 * ## The one rule that makes sustained scanning bounded
 *
 * **Ask before spending anything.** Every iteration calls `target.canAccept()`
 * first, and a `false` re-arms the loop without touching a pixel. No
 * `drawImage`, no `getImageData`, no `createImageBitmap`, no post. The plan's
 * requirement is to "drop stale camera frames before expensive decode when
 * downstream is saturated"; declining to *create* the frame is the strongest
 * form of that, and it is why a decoder running at half the capture rate costs
 * nothing but skipped captures.
 *
 * ## Two capture paths
 *
 * `createImageBitmap` on the video element, transferred to the worker, does the
 * pixel work off the main thread entirely. Where it or `OffscreenCanvas` is
 * missing, the loop falls back to the canvas readback the receiver used before
 * - `drawImage` plus `getImageData`, roughly 2 MB copied on the main thread per
 * frame. The fallback is chosen from a feature probe and from what the worker
 * says it can take, never from a user-agent string, and one failure of the
 * bitmap path retires it for the session rather than retrying it every frame.
 *
 * ## What was kept
 *
 * The generation counter, the `requestVideoFrameCallback` watchdog, and the
 * hidden-document handling are unchanged in substance and are load-bearing.
 * They are the fixes for a scan loop that could die silently while the preview
 * went on claiming an active camera, and for a backgrounded app that consumed
 * its last wake-up and never resumed. Both had real bug numbers.
 */

import type { TelemetryCollector } from './metrics';
import type { CapturedFrame } from './receiver-client';

const MAX_ROI_EDGE = 720;
const MIN_ROI_EDGE = 96;

/**
 * How long the loop waits on `requestVideoFrameCallback` before driving itself.
 *
 * Long enough not to pre-empt a healthy camera at any sane frame rate, short
 * enough that a stall costs a fraction of a second rather than the session.
 */
const PRESENT_WATCHDOG_MS = 500;

/** How long the loop waits when the pipeline is saturated. */
const BACKPRESSURE_RETRY_MS = 12;

export type CameraErrorCode =
  | 'CAMERA_PERMISSION_DENIED'
  | 'CAMERA_UNAVAILABLE'
  | 'CAMERA_BUSY'
  | 'CAMERA_STREAM_FAILED'
  | 'CAMERA_INTERRUPTED';

/** What the camera hands frames to. `ReceiverClient` satisfies this structurally. */
export interface CaptureTarget {
  canAccept(): boolean;
  submit(frame: CapturedFrame): boolean;
  supportsBitmapTransfer: boolean;
}

/**
 * The single live camera in this document.
 *
 * "Prevent duplicate active MediaStreams" cannot be a per-instance rule,
 * because the way it goes wrong is two instances: a React effect that runs
 * twice, or a retry that builds a second controller before the first has let
 * go. iOS answers the second `getUserMedia` by taking the stream away from the
 * first, which surfaces as a preview that freezes for no visible reason.
 */
let liveCamera: CameraController | null = null;

/** Only for tests, which need to know the module has actually let go. */
export function activeCameraCount(): number {
  return liveCamera ? 1 : 0;
}

export class CameraController {
  private stream?: MediaStream;
  private timeout?: number;
  private videoFrameHandle?: number;
  private generation = 0;
  private context?: CanvasRenderingContext2D;
  private canvasWidth = 0;
  private canvasHeight = 0;
  private frameId = 0;
  /** Retired for the session after one failure, rather than retried per frame. */
  private bitmapCaptureUsable = true;
  private actualSettings: { width: number | null; height: number | null; frameRate: number | null; facingMode: string | null } | null = null;

  getActualSettings(): { width: number | null; height: number | null; frameRate: number | null; facingMode: string | null } | null {
    return this.actualSettings;
  }

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly target: CaptureTarget,
    private readonly onError: (code: CameraErrorCode) => void,
    private readonly telemetry?: TelemetryCollector,
  ) {}

  /**
   * Opens the camera. Must be called from a user gesture on iOS.
   *
   * Resolves `false` when the start was abandoned before it finished - a
   * cancel, a second start, or the app being backgrounded mid-prompt - which is
   * a different outcome from a failure and must not be reported as one.
   */
  async start(): Promise<boolean> {
    this.stop();
    if (liveCamera && liveCamera !== this) liveCamera.stop();
    liveCamera = this;

    const generation = ++this.generation;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
          // Fallback chain: exact 60 where supported, otherwise ideal 60, then lower
        },
      });
      // Record actual track settings for diagnostics (HT-05)
      try {
        const track = this.stream.getVideoTracks()[0];
        const settings = track.getSettings() as MediaTrackSettings & { frameRate?: number };
        // Store for diagnostics; actual FPS is reported via telemetry, not requested
        (this as unknown as { actualSettings: unknown }).actualSettings = {
          width: settings.width ?? null,
          height: settings.height ?? null,
          frameRate: settings.frameRate ?? null,
          facingMode: settings.facingMode ?? null,
        };
      } catch {}
      if (generation !== this.generation || document.hidden) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = undefined;
        return false;
      }

      // A track that ends under us - another app taking the camera, a call
      // arriving, the hardware being reclaimed - otherwise looks exactly like a
      // camera pointed at nothing.
      this.watchTracks(this.stream, generation);

      this.video.srcObject = this.stream;
      await this.video.play();
      if (generation !== this.generation || document.hidden) {
        this.stop();
        return false;
      }

      this.schedule(generation);
      return true;
    } catch (error) {
      if (generation === this.generation) {
        // `video.play()` can fail after `getUserMedia` has already granted a
        // stream. Stop it before reporting the failed start to the UI.
        this.stop();
        this.onError(cameraErrorCode(error));
      }
      throw error;
    }
  }

  stop(): void {
    this.generation++;
    this.clearPending();
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
    if (liveCamera === this) liveCamera = null;
  }

  dispose(): void {
    this.stop();
    this.context = undefined;
  }

  /** Drops whichever wake-ups are armed, so only one can ever drive a step. */
  private clearPending(): void {
    if (this.timeout !== undefined) window.clearTimeout(this.timeout);
    this.timeout = undefined;
    if (this.videoFrameHandle !== undefined && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.videoFrameHandle);
    }
    this.videoFrameHandle = undefined;
  }

  private watchTracks(stream: MediaStream, generation: number): void {
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (generation !== this.generation) return;
        this.stop();
        this.onError('CAMERA_INTERRUPTED');
      };
    }
  }

  /**
   * Arms the next step.
   *
   * `requestVideoFrameCallback` fires only when the element actually presents a
   * frame, so on its own it is not a loop: if the camera never starts
   * presenting, or the stream stalls after a lifecycle transition, it simply
   * never fires and scanning stops for good with the preview still claiming to
   * be active. It is therefore always paired with a timer, and the first of the
   * two to fire cancels the other.
   */
  private schedule(generation: number): void {
    if (generation !== this.generation || !this.stream) return;
    this.clearPending();

    const video = this.video;
    const step = (now: number, recovered: boolean) => {
      this.clearPending();
      if (recovered) this.telemetry?.recordStalledRecovery();
      this.onVideoFrame(generation, now);
    };

    if (typeof video.requestVideoFrameCallback === 'function') {
      this.videoFrameHandle = video.requestVideoFrameCallback((now) => step(now, false));
      this.timeout = window.setTimeout(() => step(performance.now(), true), PRESENT_WATCHDOG_MS);
      return;
    }

    this.timeout = window.setTimeout(() => step(performance.now(), false), BACKPRESSURE_RETRY_MS);
  }

  private onVideoFrame(generation: number, now: number): void {
    if (generation !== this.generation || !this.stream) return;

    // Backgrounded: do not read pixels, but keep a wake-up armed. Returning
    // early without one is what left the loop unable to resume.
    if (document.hidden) {
      this.timeout = window.setTimeout(() => this.schedule(generation), BACKPRESSURE_RETRY_MS);
      return;
    }

    // Backpressure via canAccept — no 40 ms throttle. Every rVFC is an opportunity;
    // worker saturation (maxInFlight) sets the real rate, not a timer.
    if (!this.target.canAccept()) {
      this.telemetry?.recordSkippedBusy();
      this.timeout = window.setTimeout(() => this.schedule(generation), BACKPRESSURE_RETRY_MS);
      return;
    }

    // A single unreadable frame must not end the session. Every capture API
    // here can throw on a stream that is mid-teardown, and without this the
    // rejection escapes unhandled while the loop carries on.
    void this.capture(generation)
      .catch(() => undefined)
      .finally(() => {
        this.schedule(generation);
      });
  }

  private async capture(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const region = this.region();
    if (!region) return;

    const startedAt = performance.now();
    const frame = this.bitmapCaptureUsable && this.target.supportsBitmapTransfer
      ? await this.captureBitmap(region)
      : this.capturePixels(region);
    if (!frame) return;

    if (generation !== this.generation || !this.target.submit(frame)) {
      // Either the session ended while the bitmap was being made, or the target
      // filled up in the meantime. Release rather than leak: an ImageBitmap
      // holds GPU memory until it is closed.
      releaseFrame(frame);
      return;
    }
    this.telemetry?.recordCapture(startedAt);
  }

  /** The centre square of the video, and how much it is scaled by. */
  private region(): { sourceX: number; sourceY: number; sourceEdge: number; roiEdge: number } | null {
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (!sourceWidth || !sourceHeight) return null;

    const sourceEdge = Math.floor(Math.min(sourceWidth, sourceHeight) * 0.86);
    const roiEdge = Math.min(MAX_ROI_EDGE, sourceEdge);
    if (roiEdge < MIN_ROI_EDGE) return null;

    return {
      sourceX: Math.floor((sourceWidth - sourceEdge) / 2),
      sourceY: Math.floor((sourceHeight - sourceEdge) / 2),
      sourceEdge,
      roiEdge,
    };
  }

  private async captureBitmap(
    region: { sourceX: number; sourceY: number; sourceEdge: number; roiEdge: number },
  ): Promise<CapturedFrame | null> {
    try {
      const bitmap = await createImageBitmap(
        this.video,
        region.sourceX,
        region.sourceY,
        region.sourceEdge,
        region.sourceEdge,
        { resizeWidth: region.roiEdge, resizeHeight: region.roiEdge, resizeQuality: 'medium' },
      );
      return {
        frameId: ++this.frameId,
        // Wall clock, because the worker compares it against its own and
        // `performance.now()` does not share an origin across that boundary.
        capturedAt: Date.now(),
        width: region.roiEdge,
        height: region.roiEdge,
        captureScale: region.roiEdge / region.sourceEdge,
        bitmap,
      };
    } catch {
      // Safari has shipped `createImageBitmap` with and without the cropping
      // and resizing overloads. One rejection is enough to know this build does
      // not have it; retrying per frame would cost a promise and a throw at the
      // camera's rate for the whole session.
      this.bitmapCaptureUsable = false;
      return null;
    }
  }

  private capturePixels(
    region: { sourceX: number; sourceY: number; sourceEdge: number; roiEdge: number },
  ): CapturedFrame | null {
    const context = this.getContext(region.roiEdge);
    if (!context) return null;

    context.drawImage(
      this.video,
      region.sourceX,
      region.sourceY,
      region.sourceEdge,
      region.sourceEdge,
      0,
      0,
      region.roiEdge,
      region.roiEdge,
    );
    const image = context.getImageData(0, 0, region.roiEdge, region.roiEdge);
    return {
      frameId: ++this.frameId,
      capturedAt: Date.now(),
      width: region.roiEdge,
      height: region.roiEdge,
      captureScale: region.roiEdge / region.sourceEdge,
      // The ImageData is not reused after this call, so its backing buffer is
      // transferred rather than cloned.
      pixels: image.data.buffer as ArrayBuffer,
    };
  }

  private getContext(edge: number): CanvasRenderingContext2D | null {
    if (this.canvasWidth !== edge || this.canvasHeight !== edge) {
      this.canvas.width = edge;
      this.canvas.height = edge;
      this.canvasWidth = edge;
      this.canvasHeight = edge;
      this.context = undefined;
    }
    this.context ??= this.canvas.getContext('2d', { willReadFrequently: true }) ?? undefined;
    return this.context ?? null;
  }
}

function releaseFrame(frame: CapturedFrame): void {
  const bitmap = frame.bitmap as { close?: () => void } | undefined;
  if (bitmap && typeof bitmap.close === 'function') bitmap.close();
}

/**
 * Maps a `getUserMedia` rejection onto something a user can act on.
 *
 * `NotReadableError` is the one worth separating: it means the camera exists
 * and is permitted but another app has it, and telling that person to check
 * their permissions sends them somewhere nothing is wrong.
 */
function cameraErrorCode(error: unknown): CameraErrorCode {
  const name = error instanceof DOMException ? error.name : 'UnknownError';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'CAMERA_PERMISSION_DENIED';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'CAMERA_UNAVAILABLE';
    case 'NotReadableError':
    case 'AbortError':
      return 'CAMERA_BUSY';
    default:
      return 'CAMERA_STREAM_FAILED';
  }
}
