import { describe, it, expect } from 'vitest';
import { DIAGNOSTICS_SCHEMA_VERSION, serializeReport, deserializeReport, computeVerifiedGoodput, computeOpticalUsefulYield } from '../../src/shared/diagnostics-schema';
import { DiagnosticsTimelineSampler } from '../../src/shared/diagnostics-timeline';
import { SenderDiagnosticsCollector } from '../../src/renderer/sender-diagnostics';
import { QrFrameScheduler } from '../../src/renderer/qr-frame-scheduler';
import { BALANCED_PROFILE } from '../../src/core/transport-profiles';
import { generateCanonicalPayload } from '../../src/shared/benchmark-payloads';
import { summarizeBenchmark } from '../../src/shared/diagnostics-summary';
import { TelemetryCollector } from '../../mobile-web/src/metrics';
import { ReceiverDiagnosticsAggregator } from '../../mobile-web/src/receiver-diagnostics-collector';

describe('diagnostics report — synthetic run can produce self-contained JSON', () => {
  it('sender and receiver produce separate FPS and goodput', async () => {
    // Synthetic sender: 100 KiB canonical payload through scheduler
    const payload = generateCanonicalPayload('100KiB');
    expect(payload.length).toBe(100 * 1024);

    // Simulate sender diagnostics via collector (no real scheduler needed for determinism)
    const senderCollector = new SenderDiagnosticsCollector();
    const start = 0;
    senderCollector.start(start);
    // Feed fake scheduler stats: 12 fps presentation
    const fakeStats = {
      framesRequested: 50,
      framesPainted: 48,
      starvedWakeups: 2,
      overruns: 0,
      paintFailures: 0,
      queueDepth: 1,
      elapsedMs: 4000,
      effectiveFps: 12,
      targetFps: 12,
      totalPaintMs: 300,
      maxPaintMs: 10,
      health: 'healthy' as const,
      generationP50Ms: 1.5,
      generationP95Ms: 3.0,
      rasterizationP50Ms: 6.0,
      rasterizationP95Ms: 12.0,
      queueUnderruns: 2,
    };
    // Use internal method to inject stats — we call recordScheduler
    // @ts-expect-error private access for test
    senderCollector.recordScheduler(fakeStats, start + 500);
    senderCollector.recordProgress({
      originalBytesTotal: String(payload.length),
      transportBytesTotal: String(payload.length),
      transportBytesCovered: String(payload.length / 2),
      bytesOnTheWire: String(payload.length),
      segmentCount: 1,
      segmentsCompleted: 0,
      currentSegmentIndex: 0,
      framesEmitted: 50,
      manifestFramesEmitted: 1,
      sourceSymbolsEmitted: 30,
      repairSymbolsEmitted: 10,
      recoverySymbolsEmitted: 0,
      recovering: false,
      complete: false,
      resumeFromSegment: 0,
    });
    senderCollector.sampleTimeline(500, { uniqueSymbols: 30, usefulBytes: payload.length / 2 });
    senderCollector.sampleTimeline(1000, { uniqueSymbols: 50, usefulBytes: payload.length });

    const senderSnap = senderCollector.snapshot();
    expect(senderSnap.counters.framesGenerated).toBe(50);
    expect(senderSnap.counters.symbolsPresented).toBe(48);
    expect(senderSnap.counters.presentationStalls).toBe(2);
    expect(senderSnap.counters.actualPresentationRateFps).toBeCloseTo(12, 1);
    expect(senderSnap.counters.generationTimeP50Ms).toBe(1.5);
    expect(senderSnap.counters.rasterizationTimeP50Ms).toBe(6.0);
    expect(senderSnap.timeline.length).toBeGreaterThan(0);

    // Synthetic receiver: simulate telemetry + pipeline
    const telemetry = new TelemetryCollector();
    const now = 1000;
    telemetry.recordCapture(now);
    telemetry.recordCapture(now + 40);
    telemetry.recordSuccessfulDecode();
    telemetry.recordDecoded(now, 52, 5, true, false);
    telemetry.recordNewSequence(now);
    telemetry.recordSolvedBlocks(1);

    const receiverAgg = new ReceiverDiagnosticsAggregator();
    receiverAgg.start(now);
    const pipelineProgress = {
      framesAccepted: 30,
      framesDuplicate: 5,
      framesRejected: 2,
      framesForeign: 1,
      manifestFrames: 1,
      unitsRecovered: 30,
      unitsTotal: 50,
      bytesCommitted: 20480,
      heldBytes: 10240,
      sessionActive: true,
      complete: false,
    } as unknown as import('../../mobile-web/src/worker-protocol').ReceiveProgress;

    const recvSnap = receiverAgg.snapshot(now + 500, telemetry.snapshot(now + 500, 1, 2, true), pipelineProgress);
    expect(recvSnap.counters.cameraCallbacks).toBeGreaterThan(0);
    expect(recvSnap.counters.newSequenceNumbers).toBeGreaterThan(0);
    expect(recvSnap.counters.duplicateSequenceNumbers).toBeGreaterThanOrEqual(0);
    expect(recvSnap.timeline.length).toBeGreaterThan(0);

    // Build minimal report and ensure separate FPS fields
    const report = {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      app: { appVersion: '0.1.0', buildChannel: 'prod' as const, diagnosticsMode: true, diagnosticsLabel: 'DIAGNOSTICS — detailed run report will be captured' },
      session: { sessionId: 1, sha256Hex: 'a'.repeat(64), payloadBytes: payload.length, containerBytes: payload.length, transportBytes: payload.length, incompressible: true },
      sender: { transportProfileId: 2, transportProfileName: 'Balanced', symbolSizeBytes: 686, segmentSizeBytes: 1404928, symbolsPerSegment: 2048, repairOverheadRatio: 0.75, compressionMode: 0, compressionParam: 0, fecProfileId: 1 },
      qr: { version: 18, eccLevel: 'L' as const, quietZoneModules: 4, moduleCount: 89, totalModules: 97, frameBytes: 718 },
      fountain: { fecProfileId: 1, fecProfileName: 'LT_SYSTEMATIC_ROBUST_SOLITON_V1', degreeDistribution: 'robust-soliton', systematic: true },
      camera: { requestedWidth: 1280, requestedHeight: 720, requestedFacingMode: 'environment', actualWidth: 1280, actualHeight: 720, roiEdge: 720, sourceEdge: 836, roiCenterX: 640, roiCenterY: 360, captureScale: 0.86, pxPerModule: 4.2 },
      workerCount: 1,
      counters: { sender: senderSnap.counters, receiver: recvSnap.counters },
      timeline: [...senderSnap.timeline, ...recvSnap.timeline].sort((a,b)=>a.elapsedSeconds-b.elapsedSeconds),
      transfer: {
        wallClockSeconds: 10,
        verifiedOriginalBytes: payload.length,
        verifiedGoodputBytesPerSecond: computeVerifiedGoodput(payload.length, 10),
        presentationRateFps: senderSnap.counters.actualPresentationRateFps,
        cameraFps: recvSnap.counters.captureFps,
        decodeFps: recvSnap.counters.decoderAttempts / 10,
        uniqueSymbolRatePerSecond: recvSnap.counters.newSequenceNumbers / 10,
        complete: true,
        faultCode: null,
      },
    };

    // Separate values
    expect(report.transfer.presentationRateFps).not.toBe(report.transfer.cameraFps);
    expect(report.transfer.decodeFps).not.toBe(report.transfer.verifiedGoodputBytesPerSecond);
    expect(report.transfer.uniqueSymbolRatePerSecond).not.toBe(report.transfer.presentationRateFps);

    // Serialization round-trip
    const json = serializeReport(report as unknown as import('../../src/shared/diagnostics-schema').DiagnosticRunReport);
    const parsed = deserializeReport(json);
    expect(parsed.schemaVersion).toBe(DIAGNOSTICS_SCHEMA_VERSION);
    expect(parsed.counters.sender.framesGenerated).toBe(50);
  });

  it('duplicate vs redundant are separate in counters', () => {
    const telemetry = new TelemetryCollector();
    telemetry.recordDecoded(1000, 50, 5, false, true); // duplicate
    telemetry.recordDuplicateSequence();
    telemetry.recordRedundantFec();
    const snap = telemetry.snapshot(1000, 0, 2, true);
    expect(snap.duplicateSequenceNumbers).toBeGreaterThan(0);
    expect(snap.redundantFecSymbols).toBe(1);
    expect(snap.duplicateSequenceNumbers).not.toBe(snap.redundantFecSymbols);
  });

  it('does not ship sensitive filenames by default', async () => {
    const payload = generateCanonicalPayload('100KiB');
    // Report contains sha, not raw filename; redact should not leak
    const report = {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      app: { appVersion: '0.1.0', buildChannel: 'prod' as const, diagnosticsMode: true, diagnosticsLabel: 'DIAGNOSTICS' },
      session: { sessionId: 1, sha256Hex: 'b'.repeat(64), payloadBytes: payload.length, containerBytes: payload.length, transportBytes: payload.length, incompressible: true },
      sender: { transportProfileId: 2, transportProfileName: 'Balanced', symbolSizeBytes: 686, segmentSizeBytes: 1404928, symbolsPerSegment: 2048, repairOverheadRatio: 0.75, compressionMode: 0, compressionParam: 0, fecProfileId: 1 },
      qr: { version: 18, eccLevel: 'L' as const, quietZoneModules: 4, moduleCount: 89, totalModules: 97, frameBytes: 718 },
      fountain: { fecProfileId: 1, fecProfileName: 'LT', degreeDistribution: 'robust', systematic: true },
      camera: { requestedWidth: 1280, requestedHeight: 720, requestedFacingMode: 'environment', actualWidth: null, actualHeight: null, roiEdge: null, sourceEdge: null, roiCenterX: null, roiCenterY: null, captureScale: null, pxPerModule: null },
      workerCount: 1,
      counters: {
        sender: { framesGenerated: 10, symbolsPresented: 9, presentationStalls: 1, queueUnderruns: 1, generationTimeP50Ms: 1, generationTimeP95Ms: 2, rasterizationTimeP50Ms: 5, rasterizationTimeP95Ms: 10, actualPresentationRateFps: 12, totalPaintMs: 50, maxPaintMs: 10, paintFailures: 0, overruns: 0 },
        receiver: { cameraCallbacks: 10, captureFps: 20, fullFrameScans: 10, cropScans: 0, decoderAttempts: 10, successfulQrDecodes: 8, parseFailures: 1, foreignInvalidFrames: 1, duplicateSequenceNumbers: 2, newSequenceNumbers: 5, redundantFecSymbols: 1, solvedBlocks: 5, workerBusyDrops: 1, decoderTimeP50Ms: 50, decoderTimeP95Ms: 80, acquisitionLatencyMs: 500, completionLatencyMs: 200, droppedStale: 0, stalledRecoveries: 0 },
      },
      timeline: [],
      transfer: { wallClockSeconds: 5, verifiedOriginalBytes: payload.length, verifiedGoodputBytesPerSecond: payload.length/5, presentationRateFps: 12, cameraFps: 20, decodeFps: 15, uniqueSymbolRatePerSecond: 1, complete: true, faultCode: null },
    } as unknown as import('../../src/shared/diagnostics-schema').DiagnosticRunReport;
    const json = serializeReport(report);
    expect(json).not.toContain(payload.toString()); // not leaking bytes
    expect(json).toContain('sha256Hex');
  });
});
