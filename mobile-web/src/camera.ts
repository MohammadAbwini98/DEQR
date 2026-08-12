import { RawQrDecoder } from './decoder';

const SCAN_INTERVAL_MS = 90;
const MAX_ROI_EDGE = 720;
const MIN_ROI_EDGE = 96;

export interface CameraMetrics {
  capturedFrames: number;
  decodedFrames: number;
  cameraAverageMs: number;
  decodeAverageMs: number;
  roiEdge: number;
}

/**
 * Keeps capture bounded to a centre QR region and schedules at most one
 * transferable ImageData decode at a time. It deliberately never logs pixels,
 * QR bytes, filenames, or decoder exceptions.
 */
export class CameraController {
  private stream?: MediaStream;
  private timeout?: number;
  private videoFrameHandle?: number;
  private inFlight = false;
  private generation = 0;
  private readonly decoder = new RawQrDecoder();
  private context?: CanvasRenderingContext2D;
  private canvasWidth = 0;
  private canvasHeight = 0;
  private nextCaptureAt = 0;
  private metrics = { capturedFrames: 0, decodedFrames: 0, cameraMs: 0, decodeMs: 0, roiEdge: 0 };
  private lastMetricReportAt = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly onBytes: (bytes: Uint8Array) => void,
    private readonly onError: (message: string) => void,
    private readonly onMetrics?: (metrics: CameraMetrics) => void,
  ) {}

  async start(): Promise<boolean> {
    this.stop();
    const generation = ++this.generation;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (generation !== this.generation || document.hidden) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = undefined;
        return false;
      }

      this.video.srcObject = this.stream;
      await this.video.play();
      if (generation !== this.generation || document.hidden) {
        this.stop();
        return false;
      }

      this.nextCaptureAt = performance.now();
      this.schedule(generation);
      return true;
    } catch (error) {
      if (generation === this.generation) {
        // `video.play()` can fail after getUserMedia has already granted a
        // stream. Stop it before reporting the failed start to the UI.
        this.stop();
        const name = error instanceof DOMException ? error.name : 'UnknownError';
        this.onError(name === 'NotAllowedError'
          ? 'CAMERA_PERMISSION_DENIED'
          : name === 'NotFoundError'
            ? 'CAMERA_UNAVAILABLE'
            : 'CAMERA_STREAM_FAILED');
      }
      throw error;
    }
  }

  stop(): void {
    this.generation++;
    if (this.timeout !== undefined) window.clearTimeout(this.timeout);
    this.timeout = undefined;
    if (this.videoFrameHandle !== undefined && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.videoFrameHandle);
    }
    this.videoFrameHandle = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
    this.inFlight = false;
  }

  dispose(): void {
    this.stop();
    this.decoder.dispose();
    this.context = undefined;
  }

  private schedule(generation: number): void {
    if (generation !== this.generation || !this.stream || document.hidden) return;
    const video = this.video;
    if (typeof video.requestVideoFrameCallback === 'function') {
      this.videoFrameHandle = video.requestVideoFrameCallback((now) => {
        this.videoFrameHandle = undefined;
        this.onVideoFrame(generation, now);
      });
      return;
    }

    this.timeout = window.setTimeout(() => this.onVideoFrame(generation, performance.now()), SCAN_INTERVAL_MS);
  }

  private onVideoFrame(generation: number, now: number): void {
    if (generation !== this.generation || !this.stream || document.hidden) return;
    const waitMs = this.nextCaptureAt - now;
    if (waitMs > 1) {
      this.timeout = window.setTimeout(() => this.schedule(generation), waitMs);
      return;
    }

    void this.capture(generation).finally(() => {
      this.nextCaptureAt = performance.now() + SCAN_INTERVAL_MS;
      this.schedule(generation);
    });
  }

  private async capture(generation: number): Promise<void> {
    if (this.inFlight || generation !== this.generation || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (!sourceWidth || !sourceHeight) return;

    const sourceEdge = Math.floor(Math.min(sourceWidth, sourceHeight) * 0.86);
    const roiEdge = Math.min(MAX_ROI_EDGE, sourceEdge);
    if (roiEdge < MIN_ROI_EDGE) return;

    const sourceX = Math.floor((sourceWidth - sourceEdge) / 2);
    const sourceY = Math.floor((sourceHeight - sourceEdge) / 2);
    const context = this.getContext(roiEdge);
    if (!context) return;

    this.inFlight = true;
    const cameraStartedAt = performance.now();
    try {
      context.drawImage(this.video, sourceX, sourceY, sourceEdge, sourceEdge, 0, 0, roiEdge, roiEdge);
      const image = context.getImageData(0, 0, roiEdge, roiEdge);
      const cameraElapsed = performance.now() - cameraStartedAt;
      const result = await this.decoder.decode(image);
      if (generation !== this.generation) return;

      this.metrics.capturedFrames++;
      this.metrics.cameraMs += cameraElapsed;
      this.metrics.decodeMs += result.elapsedMs;
      this.metrics.roiEdge = roiEdge;
      if (result.bytes) {
        this.metrics.decodedFrames++;
        this.onBytes(result.bytes);
      }
      this.reportMetrics();
    } finally {
      this.inFlight = false;
    }
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

  private reportMetrics(): void {
    const now = performance.now();
    if (!this.onMetrics || now - this.lastMetricReportAt < 500) return;
    this.lastMetricReportAt = now;
    const captured = Math.max(1, this.metrics.capturedFrames);
    this.onMetrics({
      capturedFrames: this.metrics.capturedFrames,
      decodedFrames: this.metrics.decodedFrames,
      cameraAverageMs: this.metrics.cameraMs / captured,
      decodeAverageMs: this.metrics.decodeMs / captured,
      roiEdge: this.metrics.roiEdge,
    });
  }
}
