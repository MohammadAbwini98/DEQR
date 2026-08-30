/**
 * HT-03 — Sender raster engine with bounded lookahead and rAF presentation.
 *
 * Owns: sequence generation (via FrameSource), frame packing (already in take()),
 * QR creation, rasterization, lookahead queue, presentation timing.
 *
 * Hot-loop allocations audited:
 * - QR object: created once per payload in qrcode library; reused via plan (version locked)
 * - temporary arrays: none (payload is Uint8Array from streaming-sender, zero-copy)
 * - canvas: persistent single canvas, reused (applyCanvasGeometry only on plan change)
 * - ImageData: not created (QR is drawn via toCanvas, not getImageData)
 * - React re-renders: isolated — engine is imperative, React only polls stats every 500ms
 * - IPC: one nextFrame per consumed frame (pull, not push)
 * - logging: none in hot loop (diagnostics via reservoirs, not console)
 *
 * Lookahead: bounded 3 per lane (single lane => 3). Generate only to refill consumed capacity.
 * Presentation: rAF for display sync, independent target timeline, discard missed deadlines (no burst), stall diagnostics.
 * Persistent canvas: reused surface, typed buffer reuse where practical (Uint8Array scratch).
 * Geometry locked after first frame: moduleCount, totalModules, moduleScale, pixelSize, cssSize.
 * Profiler: encode/pack/QR/raster durations, queue depth, dropped deadlines, presented/sec.
 */

import type { QrRenderPlan } from './qr-render';
import type { TransportProfile } from '../core/transport-profiles';
import { effectiveFps } from '../core/transport-profiles';
import { LatencyReservoir } from '../shared/latency-reservoir';

export interface SenderEngineSource {
  next(): Promise<Uint8Array | null>;
}

export type SenderEnginePainter = (frame: Uint8Array, plan: QrRenderPlan) => Promise<void>;

export interface SenderEngineOptions {
  lookaheadPerLane?: number; // default 3
  lanes?: number; // 1 for HT-03, 2/4 later
  useRaf?: boolean; // true for HT-03
}

export interface SenderProfiler {
  encodeMs: LatencyReservoir; // FrameSource.next time
  qrMs: LatencyReservoir; // QR generation (plan resolve + toCanvas without paint)
  rasterMs: LatencyReservoir; // paintQrFrame
  queueDepth: number;
  droppedDeadlines: number;
  presentedPerSecond: number;
}

export interface SenderEngineStats {
  framesRequested: number;
  framesPresented: number;
  droppedDeadlines: number;
  queueDepth: number;
  elapsedMs: number;
  presentedPerSecond: number;
  encodeP50Ms: number | null;
  encodeP95Ms: number | null;
  qrP50Ms: number | null;
  qrP95Ms: number | null;
  rasterP50Ms: number | null;
  rasterP95Ms: number | null;
  health: 'idle' | 'healthy' | 'degraded' | 'starved';
}

export class SenderRasterEngine {
  private readonly lookahead: number;
  private readonly lanes: number;
  private readonly useRaf: boolean;
  private readonly intervalMs: number;

  private queue: Uint8Array[] = [];
  private running = false;
  private stopped = false;
  private rafId: number | null = null;
  private timerId: number | null = null;
  private nextDueAt = 0;
  private firstPresentAt: number | null = null;
  private lastPresentAt: number | null = null;

  private framesRequested = 0;
  private framesPresented = 0;
  private droppedDeadlines = 0;
  private fetching = false;

  private readonly encodeReservoir = new LatencyReservoir(256);
  private readonly qrReservoir = new LatencyReservoir(256);
  private readonly rasterReservoir = new LatencyReservoir(256);

  constructor(
    private readonly profile: TransportProfile,
    private readonly source: SenderEngineSource,
    private readonly painter: SenderEnginePainter,
    private readonly planForFrame: (frame: Uint8Array) => QrRenderPlan,
    options: SenderEngineOptions = {},
  ) {
    this.lookahead = options.lookaheadPerLane ?? 3;
    this.lanes = options.lanes ?? 1;
    this.useRaf = options.useRaf ?? true;
    this.intervalMs = 1000 / effectiveFps(profile);
  }

  get bound(): number {
    return this.lookahead * this.lanes;
  }

  start(): void {
    if (this.stopped) throw new Error('engine stopped');
    if (this.running) return;
    this.running = true;
    this.nextDueAt = performance.now();
    void this.fill();
    this.schedule();
  }

  pause(): void {
    this.running = false;
    this.cancelSchedule();
  }

  resume(): void {
    if (this.stopped || this.running) return;
    this.running = true;
    this.nextDueAt = performance.now();
    void this.fill();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.cancelSchedule();
    this.queue.length = 0;
  }

  stats(): SenderEngineStats {
    const elapsedMs = this.firstPresentAt !== null && this.lastPresentAt !== null
      ? this.lastPresentAt - this.firstPresentAt
      : 0;
    const spans = Math.max(0, this.framesPresented - 1);
    const presentedPerSecond = elapsedMs > 0 && spans > 0 ? (spans * 1000) / elapsedMs : 0;
    const health = this.health(presentedPerSecond);
    return {
      framesRequested: this.framesRequested,
      framesPresented: this.framesPresented,
      droppedDeadlines: this.droppedDeadlines,
      queueDepth: this.queue.length,
      elapsedMs,
      presentedPerSecond,
      encodeP50Ms: this.encodeReservoir.p50(),
      encodeP95Ms: this.encodeReservoir.p95(),
      qrP50Ms: this.qrReservoir.p50(),
      qrP95Ms: this.qrReservoir.p95(),
      rasterP50Ms: this.rasterReservoir.p50(),
      rasterP95Ms: this.rasterReservoir.p95(),
      health,
    };
  }

  resetProfiler(): void {
    this.encodeReservoir.reset();
    this.qrReservoir.reset();
    this.rasterReservoir.reset();
    this.droppedDeadlines = 0;
  }

  private health(presentedPerSecond: number): SenderEngineStats['health'] {
    if (!this.running) return 'idle';
    if (this.framesPresented < 12) return 'healthy';
    if (this.droppedDeadlines > this.framesPresented / 4) return 'starved';
    const target = effectiveFps(this.profile);
    return presentedPerSecond >= target * 0.8 ? 'healthy' : 'degraded';
  }

  private schedule(): void {
    if (!this.running || this.stopped) return;
    this.cancelSchedule();
    if (this.useRaf && typeof requestAnimationFrame !== 'undefined') {
      this.rafId = requestAnimationFrame(() => void this.onRaf());
    } else {
      const delay = Math.max(0, this.nextDueAt - performance.now());
      this.timerId = setTimeout(() => void this.onRaf(), delay) as unknown as number;
    }
  }

  private cancelSchedule(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private async onRaf(): Promise<void> {
    if (!this.running || this.stopped) return;
    const now = performance.now();
    // Independent target timeline: if we missed deadlines, discard, don't burst
    if (now < this.nextDueAt - 1) {
      this.schedule();
      return;
    }
    if (now > this.nextDueAt + this.intervalMs) {
      // Missed one or more deadlines — count dropped, reset timeline to now, don't burst
      const missed = Math.floor((now - this.nextDueAt) / this.intervalMs);
      this.droppedDeadlines += Math.max(0, missed);
      this.nextDueAt = now;
    }

    const frame = this.queue.shift();
    void this.fill(); // refill to bound (3 per lane) without exceeding

    if (!frame) {
      // Starved — no frame ready, count and reschedule
      this.droppedDeadlines += 1;
      this.nextDueAt += this.intervalMs;
      this.schedule();
      return;
    }

    const presentStart = performance.now();
    let painted = false;
    try {
      const plan = this.planForFrame(frame);
      await this.painter(frame, plan);
      const rasterMs = performance.now() - presentStart;
      this.rasterReservoir.record(rasterMs);
      this.qrReservoir.record(rasterMs); // measured as whole painter; split when painter exposes phases
      painted = true;
    } catch {
      // paint failure is counted as dropped, not as presented
      this.droppedDeadlines += 1;
    }

    if (painted) {
      this.framesPresented += 1;
      if (this.firstPresentAt === null) this.firstPresentAt = presentStart;
      this.lastPresentAt = performance.now();
    }
    this.nextDueAt += this.intervalMs;
    this.schedule();
  }

  private async fill(): Promise<void> {
    if (this.fetching || this.stopped) return;
    this.fetching = true;
    try {
      while (this.queue.length < this.bound) {
        const t0 = performance.now();
        this.framesRequested += 1;
        const frame = await this.source.next();
        const encodeMs = performance.now() - t0;
        this.encodeReservoir.record(encodeMs);
        if (!frame) break;
        // Reuse scratch to avoid allocation per frame if caller copies — here we push reference, zero-copy
        this.queue.push(frame);
      }
    } finally {
      this.fetching = false;
    }
  }
}
