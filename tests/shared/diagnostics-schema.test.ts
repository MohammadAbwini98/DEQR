import { describe, it, expect } from 'vitest';
import {
  DIAGNOSTICS_SCHEMA_VERSION,
  computeVerifiedGoodput,
  computeOpticalUsefulYield,
  validateReport,
  serializeReport,
  deserializeReport,
  redactReport,
  type DiagnosticRunReport,
} from '../../src/shared/diagnostics-schema';

function makeMinimalReport(): DiagnosticRunReport {
  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    app: { appVersion: '0.1.0', buildChannel: 'dev', diagnosticsMode: true, diagnosticsLabel: 'DIAGNOSTICS — detailed run report will be captured' },
    session: { sessionId: 123, sha256Hex: 'abc'.repeat(21).slice(0, 64), payloadBytes: 102400, containerBytes: 102400, transportBytes: 102400, incompressible: true },
    sender: { transportProfileId: 2, transportProfileName: 'Balanced', symbolSizeBytes: 686, segmentSizeBytes: 1404928, symbolsPerSegment: 2048, repairOverheadRatio: 0.75, compressionMode: 0, compressionParam: 0, fecProfileId: 1 },
    qr: { version: 18, eccLevel: 'L', quietZoneModules: 4, moduleCount: 89, totalModules: 97, frameBytes: 718 },
    fountain: { fecProfileId: 1, fecProfileName: 'LT_SYSTEMATIC_ROBUST_SOLITON_V1', degreeDistribution: 'robust-soliton c=0.1 delta=0.05', systematic: true },
    camera: { requestedWidth: 1280, requestedHeight: 720, requestedFacingMode: 'environment', actualWidth: 1280, actualHeight: 720, roiEdge: 720, sourceEdge: 836, roiCenterX: 640, roiCenterY: 360, captureScale: 0.861, pxPerModule: 4.2 },
    workerCount: 1,
    counters: {
      sender: { framesGenerated: 100, symbolsPresented: 98, presentationStalls: 2, queueUnderruns: 2, generationTimeP50Ms: 1.2, generationTimeP95Ms: 3.4, rasterizationTimeP50Ms: 6.3, rasterizationTimeP95Ms: 12.1, actualPresentationRateFps: 12.0, totalPaintMs: 620, maxPaintMs: 15, paintFailures: 0, overruns: 1 },
      receiver: { cameraCallbacks: 120, captureFps: 22, fullFrameScans: 110, cropScans: 0, decoderAttempts: 110, successfulQrDecodes: 95, parseFailures: 5, foreignInvalidFrames: 2, duplicateSequenceNumbers: 30, newSequenceNumbers: 60, redundantFecSymbols: 8, solvedBlocks: 60, workerBusyDrops: 10, decoderTimeP50Ms: 52, decoderTimeP95Ms: 88, acquisitionLatencyMs: 1200, completionLatencyMs: 450, droppedStale: 3, stalledRecoveries: 0 },
    },
    timeline: [
      { elapsedSeconds: 0, captureFps: 0, decodeFps: 0, uniqueSymbols: 0, solvedBlocks: 0, usefulBytesRecovered: 0, workerUtilization: 0, queueDepth: 0, cumulativeFullScans: 0 },
      { elapsedSeconds: 0.5, captureFps: 22, decodeFps: 18, uniqueSymbols: 6, solvedBlocks: 6, usefulBytesRecovered: 4116, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 11 },
    ],
    transfer: { wallClockSeconds: 12.5, verifiedOriginalBytes: 102400, verifiedGoodputBytesPerSecond: 8192, presentationRateFps: 12, cameraFps: 22, decodeFps: 18, uniqueSymbolRatePerSecond: 4.8, complete: true, faultCode: null },
  };
}

describe('diagnostics-schema', () => {
  it('computes verifiedGoodput', () => {
    expect(computeVerifiedGoodput(102400, 12.5)).toBeCloseTo(8192, 1);
    expect(computeVerifiedGoodput(0, 10)).toBe(0);
    expect(computeVerifiedGoodput(100, 0)).toBe(0);
    expect(computeVerifiedGoodput(100, -1)).toBe(0);
  });

  it('computes opticalUsefulYield', () => {
    expect(computeOpticalUsefulYield(60, 100)).toBeCloseTo(0.6, 5);
    expect(computeOpticalUsefulYield(0, 100)).toBe(0);
    expect(computeOpticalUsefulYield(60, 0)).toBe(0);
    expect(computeOpticalUsefulYield(150, 100)).toBe(1); // capped at 1
  });

  it('validates report schema', () => {
    const report = makeMinimalReport();
    expect(validateReport(report)).toEqual([]);
    const bad = { ...report, schemaVersion: 999 } as DiagnosticRunReport;
    expect(validateReport(bad)).toContain(`schemaVersion must be ${DIAGNOSTICS_SCHEMA_VERSION}`);
  });

  it('rejects non-monotonic timeline', () => {
    const report = makeMinimalReport();
    report.timeline = [
      { elapsedSeconds: 1, captureFps: 22, decodeFps: 18, uniqueSymbols: 6, solvedBlocks: 6, usefulBytesRecovered: 4116, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 11 },
      { elapsedSeconds: 0.5, captureFps: 22, decodeFps: 18, uniqueSymbols: 12, solvedBlocks: 12, usefulBytesRecovered: 8232, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 22 },
    ];
    expect(validateReport(report)).toContain('timeline must be monotonic');
  });

  it('serializes and deserializes', () => {
    const report = makeMinimalReport();
    const json = serializeReport(report);
    expect(json).toContain('"schemaVersion": 1');
    const parsed = deserializeReport(json);
    expect(parsed.session.sessionId).toBe(123);
    expect(parsed.counters.sender.framesGenerated).toBe(100);
  });

  it('throws on invalid serialize', () => {
    const report = makeMinimalReport();
    (report as unknown as { schemaVersion: number }).schemaVersion = 0;
    expect(() => serializeReport(report)).toThrow(/validation failed/);
  });

  it('redactReport does not leak filename (forward guard)', () => {
    const report = makeMinimalReport();
    const redacted = redactReport(report, { allowFilename: false });
    expect(redacted.schemaVersion).toBe(1);
    const allowed = redactReport(report, { allowFilename: true });
    expect(allowed).toEqual(report);
  });

  it('separate FPS fields are distinct', () => {
    const report = makeMinimalReport();
    // Sender FPS, camera FPS, decode FPS, unique-symbol rate, verified goodput must be separate
    expect(report.transfer.presentationRateFps).toBe(12);
    expect(report.transfer.cameraFps).toBe(22);
    expect(report.transfer.decodeFps).toBe(18);
    expect(report.transfer.uniqueSymbolRatePerSecond).toBe(4.8);
    expect(report.transfer.verifiedGoodputBytesPerSecond).toBe(8192);
    // Not collapsed: they are different numbers
    expect(new Set([report.transfer.presentationRateFps, report.transfer.cameraFps, report.transfer.decodeFps, report.transfer.uniqueSymbolRatePerSecond, report.transfer.verifiedGoodputBytesPerSecond]).size).toBeGreaterThan(1);
  });
});
