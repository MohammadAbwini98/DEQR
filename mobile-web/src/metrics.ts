/**
 * Receiver instrumentation, sized so that measuring costs less than what it measures.
 *
 * Phase 04 could only say what the *display* was doing. Everything on the
 * capture side of the link - how many frames the camera actually got, how many
 * of those decoded, how many carried something new, how long a decode took at
 * the tail rather than on average - was unmeasurable because the pipeline that
 * would produce it did not exist. This module is the other half of that
 * telemetry, and the fields are the ones Phase 04's physical test matrix asks
 * for by name.
 *
 * Three constraints shaped it:
 *
 * - **Bounded.** A ten-minute transfer at 15 FPS is nine thousand frames.
 *   Nothing here keeps a per-frame record: rates come from a small ring of
 *   time buckets and percentiles from a fixed reservoir of the most recent
 *   samples.
 * - **Allocation-free on the hot path.** `record` writes into typed arrays it
 *   already owns. A metrics system that allocates per frame becomes a source
 *   of the GC pauses it is there to detect.
 * - **Honest about what a browser will not tell it.** `longtask` is a
 *   PerformanceObserver entry type Safari does not implement. `LongTaskMonitor`
 *   reports `supported: false` there rather than reporting zero, because zero
 *   long tasks and no long-task reporting are very different claims and this
 *   phase's gate is partly about the first one.
 */

/* ---------------------------------------------------------------- rate window */

const DEFAULT_BUCKET_MS = 250;
const DEFAULT_BUCKETS = 8;

/**
 * Events per second over a short sliding window.
 *
 * A ring of fixed-width buckets rather than a timestamp list, so the memory is
 * constant and a burst cannot grow it. Buckets older than the window are zeroed
 * on write instead of being swept, which keeps the cost at one modulo and one
 * add per event.
 */
export class RateWindow {
  private readonly counts: Float64Array;
  private readonly stamps: Float64Array;

  constructor(
    private readonly bucketMs: number = DEFAULT_BUCKET_MS,
    buckets: number = DEFAULT_BUCKETS,
  ) {
    this.counts = new Float64Array(buckets);
    this.stamps = new Float64Array(buckets).fill(-Infinity);
  }

  record(at: number, count = 1): void {
    const index = Math.floor(at / this.bucketMs);
    const slot = ((index % this.counts.length) + this.counts.length) % this.counts.length;
    if (this.stamps[slot] !== index) {
      this.stamps[slot] = index;
      this.counts[slot] = 0;
    }
    this.counts[slot] += count;
  }

  /** Rate over the whole window as of `at`. Excludes buckets that have expired. */
  perSecond(at: number): number {
    const newest = Math.floor(at / this.bucketMs);
    const oldest = newest - this.counts.length + 1;
    let total = 0;
    for (let slot = 0; slot < this.counts.length; slot += 1) {
      if (this.stamps[slot] >= oldest && this.stamps[slot] <= newest) total += this.counts[slot];
    }
    return (total * 1000) / (this.bucketMs * this.counts.length);
  }

  reset(): void {
    this.counts.fill(0);
    this.stamps.fill(-Infinity);
  }
}

/* ------------------------------------------------------------------ quantiles */

const DEFAULT_RESERVOIR = 256;

/**
 * p50 and p95 over the most recent N samples.
 *
 * A sliding reservoir, not a full history: the interesting question during a
 * transfer is what decode latency looks like *now*, under the current framing
 * and lighting, and an average dragged down by the first thirty seconds of
 * someone aiming the phone answers a question nobody asked.
 *
 * Sorting 256 numbers on read is a few microseconds and happens once per UI
 * update, not once per frame.
 */
export class LatencyReservoir {
  private readonly samples: Float64Array;
  private readonly scratch: Float64Array;
  private head = 0;
  private filled = 0;

  constructor(capacity: number = DEFAULT_RESERVOIR) {
    this.samples = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  get size(): number {
    return this.filled;
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples[this.head] = ms;
    this.head = (this.head + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled += 1;
  }

  /** Nearest-rank quantile. `null` until something has been recorded. */
  quantile(fraction: number): number | null {
    if (this.filled === 0) return null;
    const view = this.scratch.subarray(0, this.filled);
    view.set(this.samples.subarray(0, this.filled));
    view.sort();
    const rank = Math.min(this.filled - 1, Math.max(0, Math.ceil(fraction * this.filled) - 1));
    return view[rank];
  }

  p50(): number | null {
    return this.quantile(0.5);
  }

  p95(): number | null {
    return this.quantile(0.95);
  }

  reset(): void {
    this.samples.fill(0);
    this.head = 0;
    this.filled = 0;
  }
}

/* ----------------------------------------------------------------- long tasks */

export interface LongTaskReport {
  /** False where the browser has no `longtask` entry type. Safari, today. */
  supported: boolean;
  count: number;
  totalMs: number;
  longestMs: number;
}

interface ObserverLike {
  observe(options: { entryTypes: string[] }): void;
  disconnect(): void;
}

interface ObserverConstructor {
  new (callback: (list: { getEntries(): Array<{ duration: number }> }) => void): ObserverLike;
  supportedEntryTypes?: readonly string[];
}

/**
 * Counts main-thread blocks over 50 ms, where the browser reports them.
 *
 * This is the direct measurement behind the phase's "main-thread long tasks are
 * materially reduced" gate. It is deliberately not the *only* evidence for it,
 * because the one browser that matters most here does not implement the API -
 * so the gate also rests on a measurement of the work that was moved, which is
 * the same number expressed as something every runtime can count.
 */
export class LongTaskMonitor {
  private observer: ObserverLike | undefined;
  private count = 0;
  private totalMs = 0;
  private longestMs = 0;

  constructor(private readonly ctor: ObserverConstructor | undefined = globalObserver()) {}

  get supported(): boolean {
    const types = this.ctor?.supportedEntryTypes;
    return Boolean(this.ctor) && (types === undefined || types.includes('longtask'));
  }

  start(): void {
    if (this.observer || !this.supported || !this.ctor) return;
    try {
      const observer = new this.ctor((list) => {
        for (const entry of list.getEntries()) {
          this.count += 1;
          this.totalMs += entry.duration;
          if (entry.duration > this.longestMs) this.longestMs = entry.duration;
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      this.observer = observer;
    } catch {
      // Some engines advertise the type and then throw on observe. Reporting
      // unsupported is the truthful outcome; throwing here would take the
      // camera down for a diagnostic.
      this.observer = undefined;
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  reset(): void {
    this.count = 0;
    this.totalMs = 0;
    this.longestMs = 0;
  }

  report(): LongTaskReport {
    return {
      supported: this.supported,
      count: this.count,
      totalMs: this.totalMs,
      longestMs: this.longestMs,
    };
  }
}

function globalObserver(): ObserverConstructor | undefined {
  const candidate = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
  return typeof candidate === 'function' ? (candidate as ObserverConstructor) : undefined;
}

/* ------------------------------------------------------------------ telemetry */

/** One reading of the whole capture pipeline. Counters and rates, never payload. */
export interface ReceiverTelemetry {
  /** Frames the capture loop actually read pixels for. */
  captureAttemptsPerSecond: number;
  /** Frames that yielded a QR payload of any kind. */
  decodedPerSecond: number;
  /** Frames that advanced the transfer. */
  uniquePerSecond: number;
  /** Duplicates over decoded frames, in 0..1. */
  duplicateRatio: number;
  decodeP50Ms: number | null;
  decodeP95Ms: number | null;
  pipelineP50Ms: number | null;
  pipelineP95Ms: number | null;
  /** Frames posted to the worker and not yet answered. Never above `maxInFlight`. */
  inFlight: number;
  maxInFlight: number;
  /** Captures the loop declined to take because the worker was saturated. */
  skippedBusy: number;
  /** Captures the worker refused to decode because they had aged out. */
  droppedStale: number;
  capturedFrames: number;
  decodedFrames: number;
  /** Times the watchdog restarted a scan loop the video never woke. */
  stalledRecoveries: number;
  longTasks: LongTaskReport;
  /** Newest camera-density reading, or `null` before anything decoded. */
  optical: OpticalReading | null;
  /** Whether pixels reach the worker without a main-thread readback. */
  zeroCopyCapture: boolean;
}

export interface OpticalReading {
  qrVersion: number;
  modulesPerSide: number;
  symbolSpanPx: number;
  pxPerModule: number;
  spanSkew: number;
}

/**
 * Aggregates the receiver's counters into one object per UI update.
 *
 * Owned by the client rather than by the camera or the worker, because the
 * numbers only mean something together: a high capture rate with a low decode
 * rate is a framing problem, and the same capture rate with a high skip count
 * is a saturation problem, and neither half says which on its own.
 */
export class TelemetryCollector {
  readonly decodeLatency = new LatencyReservoir();
  readonly pipelineLatency = new LatencyReservoir();
  private readonly captures = new RateWindow();
  private readonly decodes = new RateWindow();
  private readonly uniques = new RateWindow();
  private readonly longTasks = new LongTaskMonitor();

  private capturedFrames = 0;
  private decodedFrames = 0;
  private duplicateFrames = 0;
  private skippedBusy = 0;
  private droppedStale = 0;
  private stalledRecoveries = 0;
  private optical: OpticalReading | null = null;

  startLongTaskMonitor(): void {
    this.longTasks.start();
  }

  stopLongTaskMonitor(): void {
    this.longTasks.stop();
  }

  recordCapture(at: number): void {
    this.capturedFrames += 1;
    this.captures.record(at);
  }

  recordSkippedBusy(): void {
    this.skippedBusy += 1;
  }

  recordStalledRecovery(): void {
    this.stalledRecoveries += 1;
  }

  recordDecoded(at: number, decodeMs: number, pipelineMs: number, unique: boolean, duplicate: boolean): void {
    this.decodedFrames += 1;
    this.decodes.record(at);
    this.decodeLatency.record(decodeMs);
    this.pipelineLatency.record(pipelineMs);
    if (unique) this.uniques.record(at);
    if (duplicate) this.duplicateFrames += 1;
  }

  /** A frame the worker declined to decode. Not a decode, so no latency sample. */
  recordStale(total: number): void {
    this.droppedStale = total;
  }

  recordOptical(reading: OpticalReading): void {
    this.optical = reading;
  }

  snapshot(at: number, inFlight: number, maxInFlight: number, zeroCopyCapture: boolean): ReceiverTelemetry {
    return {
      captureAttemptsPerSecond: this.captures.perSecond(at),
      decodedPerSecond: this.decodes.perSecond(at),
      uniquePerSecond: this.uniques.perSecond(at),
      duplicateRatio: this.decodedFrames ? this.duplicateFrames / this.decodedFrames : 0,
      decodeP50Ms: this.decodeLatency.p50(),
      decodeP95Ms: this.decodeLatency.p95(),
      pipelineP50Ms: this.pipelineLatency.p50(),
      pipelineP95Ms: this.pipelineLatency.p95(),
      inFlight,
      maxInFlight,
      skippedBusy: this.skippedBusy,
      droppedStale: this.droppedStale,
      capturedFrames: this.capturedFrames,
      decodedFrames: this.decodedFrames,
      stalledRecoveries: this.stalledRecoveries,
      longTasks: this.longTasks.report(),
      optical: this.optical,
      zeroCopyCapture,
    };
  }

  reset(): void {
    this.decodeLatency.reset();
    this.pipelineLatency.reset();
    this.captures.reset();
    this.decodes.reset();
    this.uniques.reset();
    this.longTasks.reset();
    this.capturedFrames = 0;
    this.decodedFrames = 0;
    this.duplicateFrames = 0;
    this.skippedBusy = 0;
    this.droppedStale = 0;
    this.stalledRecoveries = 0;
    this.optical = null;
  }
}
