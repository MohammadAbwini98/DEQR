import { describe, it, expect } from 'vitest';
import { TelemetryCollector } from '../src/metrics';
import { ReceiverDiagnosticsAggregator } from '../src/receiver-diagnostics-collector';
import type { ReceiveProgress } from '../src/worker-protocol';

function makeProgress(overrides: Partial<ReceiveProgress> = {}): ReceiveProgress {
  return {
    protocol: 2,
    framesAccepted: 30,
    lastUniqueFrameAtMs: Date.now(),
    framesSystematic: 20,
    framesRepair: 10,
    rejectionsByReason: {},
    framesDuplicate: 5,
    framesRejected: 2,
    framesForeign: 1,
    manifestFrames: 1,
    storageKind: 'opfs',
    storagePressure: false,
    fault: undefined,
    complete: false,
    sessionActive: true,
    filename: 'test.bin',
    unitsRecovered: 30,
    unitsTotal: 50,
    bytesCommitted: 20480,
    heldBytes: 10240,
    unitsAdopted: 0,
    resumed: false,
    checkpointRejection: undefined,
    resumeToken: undefined,
    originalBytes: 102400,
    transportBytes: 102400,
    compressionMode: 0,
    storageRequiredBytes: 0,
    storageAvailableBytes: 0,
    storageConfidence: 'reported',
    ...overrides,
  } as unknown as ReceiveProgress;
}

describe('receiver-diagnostics-aggregator', () => {
  it('aggregates extended receiver counters and timeline', () => {
    const telemetry = new TelemetryCollector();
    const agg = new ReceiverDiagnosticsAggregator();
    const start = 1000;
    agg.start(start);
    telemetry.recordCapture(start);
    telemetry.recordSuccessfulDecode();
    telemetry.recordDecoded(start, 50, 5, true, false);
    telemetry.recordSolvedBlocks(5);

    const telSnap = telemetry.snapshot(start + 500, 1, 2, true);
    const prog = makeProgress();
    const { counters, timeline } = agg.snapshot(start + 500, telSnap, prog);

    expect(counters.cameraCallbacks).toBe(1);
    expect(counters.newSequenceNumbers).toBe(1);
    expect(counters.solvedBlocks).toBe(30); // from pipeline unitsRecovered
    expect(counters.decoderTimeP50Ms).toBe(50);
    expect(timeline.length).toBe(1);
    expect(timeline[0]).toHaveProperty('elapsedSeconds');
    expect(timeline[0]).toHaveProperty('captureFps');
    expect(timeline[0]).toHaveProperty('decodeFps');
  });

  it('timeline samples every ~500ms', () => {
    const telemetry = new TelemetryCollector();
    const agg = new ReceiverDiagnosticsAggregator();
    agg.start(0);
    const prog = makeProgress();
    const snap = telemetry.snapshot(0, 0, 2, true);
    agg.snapshot(0, snap, prog);
    agg.snapshot(100, snap, prog); // too close, skipped
    expect(agg.snapshot(100, snap, prog).timeline.length).toBe(1);
    agg.snapshot(600, snap, prog); // far enough
    expect(agg.snapshot(600, snap, prog).timeline.length).toBe(2);
  });
});
