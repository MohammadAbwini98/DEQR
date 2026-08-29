/**
 * Sender diagnostics collector — Phase 01 §2 + §4.
 *
 * Aggregates SchedulerStats + StreamingProgressView polling into
 * SenderCounters and TimelineSample stream. Opt-in via diagnostics mode;
 * when disabled the collector is not instantiated and overhead is zero.
 */

import type { SchedulerStats } from './qr-frame-scheduler';
import type { StreamingProgressView } from '../shared/types';
import type { SenderCounters, TimelineSample } from '../shared/diagnostics-schema';
import { DiagnosticsTimelineSampler } from '../shared/diagnostics-timeline';
import { LatencyReservoir } from '../shared/latency-reservoir';

export class SenderDiagnosticsCollector {
  private readonly timeline = new DiagnosticsTimelineSampler(500);
  private readonly genReservoir = new LatencyReservoir();
  private readonly rasterReservoir = new LatencyReservoir();
  private startedAt: number | null = null;
  private lastStats: SchedulerStats | null = null;
  private lastProgress: StreamingProgressView | null = null;

  start(atMs: number): void {
    this.startedAt = atMs;
    this.timeline.start(atMs);
    this.genReservoir.reset();
    this.rasterReservoir.reset();
  }

  /** Feed latest scheduler stats (called from 500ms poll). */
  recordScheduler(stats: SchedulerStats, atMs: number): void {
    this.lastStats = stats;
    // Scheduler already tracks generation/raster reservoirs; mirror into collector for external access
    // We keep our own reservoirs for synthetic bench paths where scheduler not used
    // If stats carries reservoirs, use them directly in snapshot rather than duplicating
  }

  /** Feed streaming progress (framesEmitted, etc.). */
  recordProgress(progress: StreamingProgressView): void {
    this.lastProgress = progress;
  }

  /** Direct record for synthetic bench harness where scheduler not involved. */
  recordGenerationMs(ms: number): void { this.genReservoir.record(ms); }
  recordRasterMs(ms: number): void { this.rasterReservoir.record(ms); }

  sampleTimeline(atMs: number, extra: { captureFps?: number; decodeFps?: number; uniqueSymbols?: number; solvedBlocks?: number; usefulBytes?: number; workerUtil?: number } = {}): void {
    if (this.startedAt === null) this.startedAt = atMs;
    const stats = this.lastStats;
    const prog = this.lastProgress;
    this.timeline.sample(atMs, {
      captureFps: extra.captureFps ?? 0,
      decodeFps: extra.decodeFps ?? 0,
      uniqueSymbols: extra.uniqueSymbols ?? (prog ? (prog.sourceSymbolsEmitted + prog.repairSymbolsEmitted) : 0), // placeholder for synthetic
      solvedBlocks: extra.solvedBlocks ?? 0,
      usefulBytesRecovered: extra.usefulBytes ?? (prog ? Number(BigInt(prog.transportBytesCovered)) : 0),
      workerUtilization: extra.workerUtil ?? (stats ? Math.min(1, stats.queueDepth / 2) : 0),
      queueDepth: stats?.queueDepth ?? 0,
      cumulativeFullScans: extra.uniqueSymbols ?? 0,
    });
  }

  snapshot(): { counters: SenderCounters; timeline: TimelineSample[] } {
    const stats = this.lastStats;
    const genP50 = stats?.generationP50Ms ?? this.genReservoir.p50();
    const genP95 = stats?.generationP95Ms ?? this.genReservoir.p95();
    const rasP50 = stats?.rasterizationP50Ms ?? this.rasterReservoir.p50();
    const rasP95 = stats?.rasterizationP95Ms ?? this.rasterReservoir.p95();
    const counters: SenderCounters = {
      framesGenerated: stats?.framesRequested ?? 0,
      symbolsPresented: stats?.framesPainted ?? 0,
      presentationStalls: stats?.starvedWakeups ?? 0,
      queueUnderruns: stats?.queueUnderruns ?? stats?.starvedWakeups ?? 0,
      generationTimeP50Ms: genP50,
      generationTimeP95Ms: genP95,
      rasterizationTimeP50Ms: rasP50,
      rasterizationTimeP95Ms: rasP95,
      actualPresentationRateFps: stats?.effectiveFps ?? 0,
      totalPaintMs: stats?.totalPaintMs ?? 0,
      maxPaintMs: stats?.maxPaintMs ?? 0,
      paintFailures: stats?.paintFailures ?? 0,
      overruns: stats?.overruns ?? 0,
    };
    return { counters, timeline: this.timeline.snapshot() };
  }

  reset(): void {
    this.timeline.reset();
    this.genReservoir.reset();
    this.rasterReservoir.reset();
    this.startedAt = null;
    this.lastStats = null;
    this.lastProgress = null;
  }
}
