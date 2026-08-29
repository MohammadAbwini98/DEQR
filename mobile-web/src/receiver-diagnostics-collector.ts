/**
 * Receiver diagnostics aggregator — Phase 01 §3 + §4.
 *
 * Merges TelemetryCollector + ReceivePipeline progress into ReceiverCounters
 * and drives DiagnosticsTimelineSampler every ~500ms. The report builder then
 * produces a DiagnosticRunReport.
 */

import type { ReceiverCounters, TimelineSample } from '../../src/shared/diagnostics-schema';
import type { ReceiverTelemetry, TelemetryCollector } from './metrics';
import type { ReceiveProgress } from './worker-protocol';
import { DiagnosticsTimelineSampler } from '../../src/shared/diagnostics-timeline';

export class ReceiverDiagnosticsAggregator {
  private readonly timeline = new DiagnosticsTimelineSampler(500);
  private startedAt: number | null = null;

  start(atMs: number): void {
    this.startedAt = atMs;
    this.timeline.start(atMs);
  }

  snapshot(
    atMs: number,
    telemetry: ReceiverTelemetry,
    pipeline: ReceiveProgress,
  ): { counters: ReceiverCounters; timeline: TimelineSample[] } {
    if (this.startedAt === null) this.startedAt = atMs;

    // Map telemetry + pipeline into 16 required counters
    const counters: ReceiverCounters = {
      cameraCallbacks: telemetry.cameraCallbacks,
      captureFps: telemetry.captureFps,
      fullFrameScans: telemetry.fullFrameScans,
      cropScans: telemetry.cropScans,
      decoderAttempts: telemetry.decoderAttempts,
      successfulQrDecodes: telemetry.successfulQrDecodes,
      parseFailures: telemetry.parseFailures,
      foreignInvalidFrames: telemetry.foreignInvalidFrames,
      duplicateSequenceNumbers: telemetry.duplicateSequenceNumbers,
      newSequenceNumbers: telemetry.newSequenceNumbers,
      redundantFecSymbols: telemetry.redundantFecSymbols,
      solvedBlocks: pipeline.unitsRecovered ?? telemetry.solvedBlocks,
      workerBusyDrops: telemetry.workerBusyDrops,
      decoderTimeP50Ms: telemetry.decodeP50Ms,
      decoderTimeP95Ms: telemetry.decodeP95Ms,
      acquisitionLatencyMs: telemetry.acquisitionLatencyMs,
      completionLatencyMs: telemetry.completionLatencyMs,
      droppedStale: telemetry.droppedStale,
      stalledRecoveries: telemetry.stalledRecoveries,
    };

    // Timeline sample: every call is a ~500ms tick
    this.timeline.sample(atMs, {
      captureFps: telemetry.captureFps,
      decodeFps: telemetry.decodedPerSecond,
      uniqueSymbols: telemetry.newSequenceNumbers,
      solvedBlocks: counters.solvedBlocks,
      usefulBytesRecovered: pipeline.bytesCommitted ?? 0,
      workerUtilization: telemetry.inFlight / Math.max(1, telemetry.maxInFlight),
      queueDepth: telemetry.inFlight,
      cumulativeFullScans: telemetry.fullFrameScans,
    });

    return { counters, timeline: this.timeline.snapshot() };
  }

  reset(): void {
    this.timeline.reset();
    this.startedAt = null;
  }
}
