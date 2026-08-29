/**
 * Shared LatencyReservoir — fixed-size sliding window for p50/p95.
 * Used by sender scheduler (generation/raster) and receiver metrics.
 */

const DEFAULT_CAPACITY = 256;

export class LatencyReservoir {
  private readonly samples: Float64Array;
  private readonly scratch: Float64Array;
  private head = 0;
  private filled = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
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

  quantile(fraction: number): number | null {
    if (this.filled === 0) return null;
    const view = this.scratch.subarray(0, this.filled);
    view.set(this.samples.subarray(0, this.filled));
    view.sort();
    const rank = Math.min(this.filled - 1, Math.max(0, Math.ceil(fraction * this.filled) - 1));
    return view[rank];
  }

  p50(): number | null { return this.quantile(0.5); }
  p95(): number | null { return this.quantile(0.95); }

  reset(): void {
    this.samples.fill(0);
    this.head = 0;
    this.filled = 0;
  }
}
