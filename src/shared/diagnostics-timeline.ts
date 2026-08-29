/**
 * Diagnostics timeline sampler — shared, deterministic.
 *
 * Samples every ~500ms; aggregates rates and cumulative counters into
 * TimelineSample[] per Phase 01 §4. Pure logic, no DOM, no clock dependency
 * beyond injected now().
 */

import type { TimelineSample } from './diagnostics-schema';

export interface TimelineSource {
  captureFps: number;
  decodeFps: number;
  uniqueSymbols: number; // cumulative newSequenceNumbers
  solvedBlocks: number; // cumulative
  usefulBytesRecovered: number; // cumulative bytes
  workerUtilization: number; // 0..1
  queueDepth: number;
  cumulativeFullScans: number;
}

export class DiagnosticsTimelineSampler {
  private readonly samples: TimelineSample[] = [];
  private startedAt: number | null = null;

  constructor(private readonly intervalMs = 500) {}

  start(atMs: number): void {
    this.startedAt = atMs;
    this.samples.length = 0;
  }

  sample(atMs: number, source: TimelineSource): void {
    if (this.startedAt === null) this.startedAt = atMs;
    const elapsedSeconds = (atMs - this.startedAt) / 1000;
    // Enforce ~500ms spacing: skip if too close to last sample (< intervalMs*0.8)
    const last = this.samples[this.samples.length - 1];
    if (last && elapsedSeconds - last.elapsedSeconds < (this.intervalMs * 0.8) / 1000) return;
    this.samples.push({
      elapsedSeconds,
      captureFps: source.captureFps,
      decodeFps: source.decodeFps,
      uniqueSymbols: source.uniqueSymbols,
      solvedBlocks: source.solvedBlocks,
      usefulBytesRecovered: source.usefulBytesRecovered,
      workerUtilization: source.workerUtilization,
      queueDepth: source.queueDepth,
      cumulativeFullScans: source.cumulativeFullScans,
    });
  }

  snapshot(): TimelineSample[] {
    return [...this.samples];
  }

  reset(): void {
    this.samples.length = 0;
    this.startedAt = null;
  }
}
