/**
 * Paced, bounded, instrumented QR frame scheduling.
 *
 * The display side of a transfer has three jobs that pull against each other:
 * put frames up at the profile's cadence, never hold more of them than the
 * budget allows, and leave each one on screen long enough for a camera to
 * actually integrate it. A `setInterval` does the first and neither of the
 * others.
 *
 * What this adds over the interval it replaces:
 *
 * - **Frames are pulled, never pushed.** The scheduler asks its source for the
 *   next frame when it is ready to paint one, which is the same backpressure
 *   shape Phase 02 built into the sender. A slow painter slows the encoder
 *   because nothing else drives it.
 * - **A minimum hold.** A frame swapped out sooner than a sensor can gather it
 *   is a frame nobody reads, however many of them the display counts. The
 *   profile's `minFrameHoldMs` is a floor on screen time, and the effective
 *   cadence is derived from it rather than assumed equal to the target.
 * - **Bounded prefetch.** At most `maxPrefetchedFrames` frames exist ahead of
 *   the painter. There is no path here that pre-generates a transfer.
 * - **Instrumented for real.** Painted frames, elapsed wall time and paint
 *   durations are counted, so "effective FPS" is measured rather than assumed
 *   to equal the target. Phase 00 established that nominal FPS is not
 *   throughput; this is where the display stops claiming otherwise.
 * - **No timer outlives its owner.** Every wake-up re-checks liveness before
 *   doing anything, and `stop()` cancels the pending one. `DESKTOP-CRASH-013`
 *   was a main-process interval that kept encoding for a destroyed renderer.
 *
 * The clock is injected so the whole thing is testable without real time. That
 * is not a testing convenience bolted on: a scheduler whose behaviour can only
 * be observed by waiting is a scheduler whose behaviour is never asserted.
 */

import { TransportProfile, effectiveFps } from '../core/transport-profiles';
import { LatencyReservoir } from '../shared/latency-reservoir';

/** Where frames come from. `null` means the pass is finished. */
export interface FrameSource {
  next(): Promise<Uint8Array | null>;
}

/** Paints one frame. May be async; the scheduler waits for it and times it. */
export type FramePainter = (frame: Uint8Array) => void | Promise<void>;

/**
 * Just enough of a clock to be replaceable.
 *
 * `setTimeout` rather than `requestAnimationFrame` because the cadence being
 * scheduled is the transport's, not the compositor's, and they are not the same
 * thing: an rAF-driven loop silently inherits the display's refresh rate and
 * whatever the browser decides to do when the window is not focused.
 */
export interface SchedulerClock {
  now(): number;
  setTimer(delayMs: number, callback: () => void): number;
  clearTimer(handle: number): void;
}

export const systemClock: SchedulerClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer: (delayMs, callback) => setTimeout(callback, delayMs) as unknown as number,
  clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

export type SchedulerHealth = 'idle' | 'healthy' | 'degraded' | 'starved' | 'finished';

export interface SchedulerStats {
  /** Frames asked of the source. */
  framesRequested: number;
  /** Frames actually put on screen. */
  framesPainted: number;
  /** Frames the source could not supply in time. */
  starvedWakeups: number;
  /** Paints that ran longer than the interval they were given. */
  overruns: number;
  /** Paints that threw. The frame is lost; the schedule is not. */
  paintFailures: number;
  /** Frames held ahead of the painter. Never above `maxPrefetchedFrames`. */
  queueDepth: number;
  /** Wall time between the first painted frame and the most recent one. */
  elapsedMs: number;
  /** Painted frames over elapsed wall time. Measured, not the target restated. */
  effectiveFps: number;
  /** Cadence the profile asks for, hold floor included. */
  targetFps: number;
  totalPaintMs: number;
  maxPaintMs: number;
  health: SchedulerHealth;
  /** Generation time (FrameSource.next) p50/p95 — Phase 01 sender diagnostics. */
  generationP50Ms: number | null;
  generationP95Ms: number | null;
  /** Rasterization time (QR encode + paintQrFrame) p50/p95. */
  rasterizationP50Ms: number | null;
  rasterizationP95Ms: number | null;
  /** Alias: rasterization === paint for this phase (encode+paint combined). */
  queueUnderruns: number;
}

export interface SchedulerOptions {
  /**
   * Frames held ahead of the painter.
   *
   * Three per HT-03 (one being painted, two ready) — bounded lookahead per lane.
   */
  maxPrefetchedFrames?: number;
  /**
   * Painted frames to observe before health is judged.
   *
   * Judging a cadence from the first few frames reports every transfer as
   * degraded while the first paint warms up.
   */
  healthWindowFrames?: number;
  /**
   * Fraction of target cadence below which the scheduler reports `degraded`.
   *
   * 0.8 rather than 1.0 because a display that misses one frame in six is still
   * transferring; what matters is telling the difference between that and a
   * profile the machine cannot sustain at all.
   */
  degradedBelowFraction?: number;
  /** Use requestAnimationFrame for display sync when available (HT-03). */
  useRaf?: boolean;
}

export const DEFAULT_SCHEDULER_OPTIONS: Required<SchedulerOptions> = Object.freeze({
  maxPrefetchedFrames: 3, // HT-03: 3 per lane, single lane => 3 (was 2)
  healthWindowFrames: 12,
  degradedBelowFraction: 0.8,
  useRaf: true,
} as Required<SchedulerOptions>);

export class QrFrameScheduler {
  private readonly options: Required<SchedulerOptions>;
  private readonly intervalMs: number;
  private readonly queue: Uint8Array[] = [];

  private running = false;
  private stopped = false;
  private finished = false;
  private timer: number | null = null;
  private rafId: number | null = null;
  private fetching = false;
  private painting = false;

  private firstPaintAt: number | null = null;
  private lastPaintAt: number | null = null;
  private nextDueAt = 0;

  private readonly generationReservoir = new LatencyReservoir();
  private readonly rasterReservoir = new LatencyReservoir();
  private queueUnderruns = 0;

  private readonly counters = {
    framesRequested: 0,
    framesPainted: 0,
    starvedWakeups: 0,
    overruns: 0,
    paintFailures: 0,
    totalPaintMs: 0,
    maxPaintMs: 0,
  };

  constructor(
    public readonly profile: TransportProfile,
    private readonly source: FrameSource,
    private readonly paint: FramePainter,
    private readonly clock: SchedulerClock = systemClock,
    options: SchedulerOptions = {},
  ) {
    this.options = { ...DEFAULT_SCHEDULER_OPTIONS, ...options };
    if (this.options.maxPrefetchedFrames < 1) {
      throw new Error('maxPrefetchedFrames must be at least 1');
    }
    // The hold floor wins over the target cadence when they disagree. A profile
    // asking for 60 FPS with a 25 ms hold is asking for 40, and the honest
    // reading is the one that gets scheduled.
    this.intervalMs = Math.max(1000 / profile.targetFps, profile.minFrameHoldMs);
  }

  /** Cadence actually scheduled, after the hold floor is applied. */
  get scheduledIntervalMs(): number {
    return this.intervalMs;
  }

  get isRunning(): boolean {
    return this.running && !this.stopped;
  }

  start(): void {
    if (this.stopped) throw new Error('a stopped scheduler cannot be restarted');
    if (this.running) return;
    this.running = true;
    this.nextDueAt = this.clock.now();
    void this.fill();
    this.arm(0);
  }

  /** Suspends the cadence without discarding what is queued or counted. */
  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.disarm();
  }

  resume(): void {
    if (this.stopped || this.finished || this.running) return;
    this.running = true;
    this.nextDueAt = this.clock.now();
    void this.fill();
    this.arm(0);
  }

  /**
   * Ends the schedule permanently and drops what it holds.
   *
   * Idempotent, and safe to call from a teardown path that may already have run.
   */
  stop(): void {
    this.stopped = true;
    this.running = false;
    this.disarm();
    this.queue.length = 0;
  }

  stats(): SchedulerStats {
    const elapsedMs = this.firstPaintAt !== null && this.lastPaintAt !== null
      ? this.lastPaintAt - this.firstPaintAt
      : 0;
    // Frames span intervals, not instants: n frames occupy n-1 gaps, and
    // dividing by n understates the cadence by a whole frame on short runs.
    const spans = Math.max(0, this.counters.framesPainted - 1);
    const measuredFps = elapsedMs > 0 && spans > 0 ? (spans * 1000) / elapsedMs : 0;

    return {
      ...this.counters,
      queueDepth: this.queue.length,
      elapsedMs,
      effectiveFps: measuredFps,
      targetFps: effectiveFps(this.profile),
      health: this.health(measuredFps),
      generationP50Ms: this.generationReservoir.p50(),
      generationP95Ms: this.generationReservoir.p95(),
      rasterizationP50Ms: this.rasterReservoir.p50(),
      rasterizationP95Ms: this.rasterReservoir.p95(),
      queueUnderruns: this.queueUnderruns,
    };
  }

  /** Reset diagnostics reservoirs (used when diagnostics reset on hold). */
  resetDiagnostics(): void {
    this.generationReservoir.reset();
    this.rasterReservoir.reset();
    this.queueUnderruns = 0;
  }

  /* ------------------------------------------------------------- internals */

  private health(measuredFps: number): SchedulerHealth {
    if (this.finished) return 'finished';
    if (!this.running) return 'idle';
    if (this.counters.framesPainted < this.options.healthWindowFrames) return 'healthy';
    if (this.counters.starvedWakeups > this.counters.framesPainted / 4) return 'starved';
    const target = effectiveFps(this.profile);
    return measuredFps >= target * this.options.degradedBelowFraction ? 'healthy' : 'degraded';
  }

  private arm(delayMs: number): void {
    if (this.stopped || !this.running) return;
    this.disarm();
    if (this.options.useRaf && typeof requestAnimationFrame !== 'undefined') {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        const now = this.clock.now();
        if (now < this.nextDueAt - 1) {
          // Not yet due — reschedule without consuming a frame (rAF cadence ≠ profile cadence)
          this.arm(Math.max(0, this.nextDueAt - now));
          return;
        }
        void this.tick();
      });
      return;
    }
    this.timer = this.clock.setTimer(Math.max(0, delayMs), () => {
      this.timer = null;
      void this.tick();
    });
  }

  private disarm(): void {
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Tops the queue up to its bound. The only place frames are requested. */
  private async fill(): Promise<void> {
    if (this.fetching || this.stopped || this.finished) return;
    this.fetching = true;
    try {
      while (!this.stopped && !this.finished && this.queue.length < this.options.maxPrefetchedFrames) {
        this.counters.framesRequested += 1;
        const genStart = this.clock.now();
        const frame = await this.source.next();
        const genMs = this.clock.now() - genStart;
        this.generationReservoir.record(genMs);
        if (this.stopped) return;
        if (!frame) {
          this.finished = true;
          return;
        }
        this.queue.push(frame);
      }
    } finally {
      this.fetching = false;
    }
  }

  private async tick(): Promise<void> {
    // Every wake-up re-checks liveness before touching anything. This is the
    // check whose absence turned a shutdown into a crash once already.
    if (this.stopped || !this.running) return;

    // Enforce profile cadence even when driven by rAF (~16.7 ms) vs profile interval (e.g. 83 ms)
    const now = this.clock.now();
    if (now < this.nextDueAt - 1) {
      this.arm(this.delayUntilDue());
      return;
    }

    if (this.painting) {
      // A paint ran past its slot. Re-arm rather than overlapping paints, which
      // would put two frames on screen inside one hold window.
      this.counters.overruns += 1;
      this.arm(this.intervalMs);
      return;
    }

    const frame = this.queue.shift();
    void this.fill();

    if (!frame) {
      if (this.finished && this.queue.length === 0) {
        this.running = false;
        this.disarm();
        return;
      }
      // The source has nothing yet. Come back at the next slot rather than
      // spinning, and record it: a scheduler that is starving is a different
      // fault from one that is slow.
      this.counters.starvedWakeups += 1;
      this.queueUnderruns += 1;
      this.nextDueAt += this.intervalMs;
      this.arm(this.delayUntilDue());
      return;
    }

    this.painting = true;
    const startedAt = this.clock.now();
    let paintOk = false;
    try {
      await this.paint(frame);
      paintOk = true;
    } catch {
      // A frame that fails to paint is lost; the schedule is not. Reporting it
      // is the caller's job, and `paintFailures` is how they find out.
      this.counters.paintFailures += 1;
    } finally {
      this.painting = false;
    }

    const finishedAt = this.clock.now();
    const paintMs = finishedAt - startedAt;
    if (paintOk) {
      this.counters.framesPainted += 1;
      this.counters.totalPaintMs += paintMs;
      this.counters.maxPaintMs = Math.max(this.counters.maxPaintMs, paintMs);
      this.rasterReservoir.record(paintMs);
      if (this.firstPaintAt === null) this.firstPaintAt = startedAt;
      this.lastPaintAt = finishedAt;
    } else {
      // Even on failure, record raster attempt for diagnostics but don't count as presented
      this.rasterReservoir.record(paintMs);
    }
    if (paintMs > this.intervalMs) this.counters.overruns += 1;

    // Absolute deadlines rather than "interval from now", so a slow paint does
    // not permanently shift the cadence later and later.
    this.nextDueAt += this.intervalMs;
    this.arm(this.delayUntilDue());
  }

  /**
   * Time until the next slot, never negative.
   *
   * When the schedule has fallen far behind, the deadline is reset to now
   * rather than firing a burst of catch-up frames. Frames that arrive faster
   * than the hold floor are frames no camera reads, so catching up by rushing
   * would trade a late frame for an unreadable one.
   */
  private delayUntilDue(): number {
    const now = this.clock.now();
    if (this.nextDueAt < now - this.intervalMs) this.nextDueAt = now + this.intervalMs;
    return Math.max(0, this.nextDueAt - now);
  }
}
