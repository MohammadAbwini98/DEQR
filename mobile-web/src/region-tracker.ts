/**
 * HT-07 — Region tracking stub (SEARCHING → ACQUIRED → TRACKING → DEGRADED → REACQUIRING).
 * HT-07 requires full-frame acquisition, Region model, cropped decode, reacquisition, and Region[] for future multi-code.
 * This stub provides the API and synthetic behavior; real crop decode gated on zxing WASM crop support.
 */

export type RegionState = 'SEARCHING' | 'ACQUIRED' | 'TRACKING' | 'DEGRADED' | 'REACQUIRING';

export interface TrackedRegion {
  id: string;
  corners: { x: number; y: number }[];
  bbox: { x: number; y: number; w: number; h: number };
  lastSuccessAt: number;
  expectedVersion: number;
  lastSequence: number | null;
  health: number; // 0..1
  state: RegionState;
}

export class RegionTracker {
  private regions: TrackedRegion[] = [];
  private fullScans = 0;
  private cropAttempts = 0;
  private cropSuccesses = 0;
  private reacquisitions = 0;
  private zeroRegionMs = 0;
  private lastZeroSince: number | null = null;

  /** Full-frame acquisition: detect QR over full camera frame */
  acquireFullFrame(corners: { x: number; y: number }[], version: number, now: number): TrackedRegion {
    this.fullScans++;
    const region: TrackedRegion = {
      id: `r-${now}-${Math.random().toString(16).slice(2, 6)}`,
      corners,
      bbox: bboxFromCorners(corners),
      lastSuccessAt: now,
      expectedVersion: version,
      lastSequence: null,
      health: 1,
      state: 'ACQUIRED',
    };
    this.regions = [region]; // single for HT-07, Region[] ready for HT-09/10
    if (this.lastZeroSince !== null) this.lastZeroSince = null;
    return region;
  }

  /** Cropped decode: crop padded rectangle around QR, decode only that crop */
  updateTracked(corners: { x: number; y: number }[], now: number): TrackedRegion | null {
    this.cropAttempts++;
    const region = this.regions[0];
    if (!region) return null;
    region.corners = corners;
    region.bbox = bboxFromCorners(corners);
    region.lastSuccessAt = now;
    region.health = Math.min(1, region.health + 0.1);
    region.state = 'TRACKING';
    this.cropSuccesses++;
    return region;
  }

  /** Periodic reacquisition policy */
  tick(now: number): RegionState {
    if (this.regions.length === 0) {
      if (this.lastZeroSince === null) this.lastZeroSince = now;
      this.zeroRegionMs = now - this.lastZeroSince;
      return 'SEARCHING';
    }
    const age = now - this.regions[0].lastSuccessAt;
    if (age > 2000) {
      this.regions[0].state = 'DEGRADED';
      if (age > 4000) {
        this.regions[0].state = 'REACQUIRING';
        this.reacquisitions++;
        this.regions = [];
        this.lastZeroSince = now;
        return 'REACQUIRING';
      }
      return 'DEGRADED';
    }
    return 'TRACKING';
  }

  getDiagnostics() {
    return {
      regionsTracked: this.regions.length,
      fullScans: this.fullScans,
      cropAttempts: this.cropAttempts,
      cropSuccesses: this.cropSuccesses,
      reacquisitions: this.reacquisitions,
      zeroRegionMs: this.zeroRegionMs,
    };
  }

  reset(): void {
    this.regions = [];
    this.fullScans = 0;
    this.cropAttempts = 0;
    this.cropSuccesses = 0;
    this.reacquisitions = 0;
    this.zeroRegionMs = 0;
    this.lastZeroSince = null;
  }
}

function bboxFromCorners(corners: { x: number; y: number }[]): { x: number; y: number; w: number; h: number } {
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 10;
  return { x: Math.max(0, minX - pad), y: Math.max(0, minY - pad), w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}
