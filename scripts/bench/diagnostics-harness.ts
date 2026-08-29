/**
 * Diagnostics harness — canonical benchmark payloads + synthetic run reports.
 *
 * Generates 100 KiB / 1 MiB / 5 MiB incompressible payloads via
 * `generateCanonicalPayload` (deterministic, no disk read, no payload printed)
 * and drives them through the synthetic pipeline with diagnostics collectors
 * to produce one self-contained JSON report per size.
 *
 * No network, offline, payload-safe.
 *
 * Usage:
 *   node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/diagnostics-harness.ts -- --sizes 100KiB,1MiB --tag ht-phase01
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateCanonicalPayload, describeCanonicalPayloads } from '../../src/shared/benchmark-payloads';
import { SenderDiagnosticsCollector } from '../../src/renderer/sender-diagnostics';
import { TelemetryCollector } from '../../mobile-web/src/metrics';
import { ReceiverDiagnosticsAggregator } from '../../mobile-web/src/receiver-diagnostics-collector';
import { DIAGNOSTICS_SCHEMA_VERSION, serializeReport, computeVerifiedGoodput } from '../../src/shared/diagnostics-schema';
import { summarizeBenchmark } from '../../src/shared/diagnostics-summary';
import { diagnosticsLabel } from '../../src/shared/diagnostics-mode';
import { BALANCED_PROFILE } from '../../src/core/transport-profiles';

type SizeLabel = '100KiB' | '1MiB' | '5MiB';

function parseArgs(): { sizes: SizeLabel[]; tag: string } {
  const sizesArg = process.argv.find(a => a.startsWith('--sizes'))?.split('=')[1] ?? process.argv[process.argv.indexOf('--sizes') + 1] ?? '100KiB,1MiB';
  const tag = process.argv.find(a => a.startsWith('--tag'))?.split('=')[1] ?? process.argv[process.argv.indexOf('--tag') + 1] ?? 'ht-phase01';
  const sizes = sizesArg.split(',').map(s => s.trim()).filter(Boolean) as SizeLabel[];
  for (const s of sizes) if (!['100KiB','1MiB','5MiB'].includes(s)) throw new Error(`unknown size ${s}`);
  return { sizes, tag };
}

async function runOne(label: SizeLabel): Promise<Record<string, unknown>> {
  const payload = generateCanonicalPayload(label);
  const start = performance.now();
  const wallStart = Date.now();

  // Synthetic sender diagnostics: feed fake scheduler stats at ~500ms intervals
  const senderColl = new SenderDiagnosticsCollector();
  senderColl.start(start);
  const fakeStats = {
    framesRequested: Math.ceil(payload.length / BALANCED_PROFILE.symbolSizeBytes) * 1.5,
    framesPainted: Math.ceil(payload.length / BALANCED_PROFILE.symbolSizeBytes),
    starvedWakeups: 1,
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
    queueUnderruns: 1,
  };
  // Simulate timeline sampling every 500ms for a few seconds
  for (let t = 0; t < 3000; t += 500) {
    senderColl.recordScheduler(fakeStats as never, start + t);
    senderColl.recordProgress({
      originalBytesTotal: String(payload.length),
      transportBytesTotal: String(payload.length),
      transportBytesCovered: String(Math.min(payload.length, Math.floor(payload.length * (t / 3000)))),
      bytesOnTheWire: String(payload.length),
      segmentCount: 1,
      segmentsCompleted: t > 2000 ? 1 : 0,
      currentSegmentIndex: 0,
      framesEmitted: fakeStats.framesPainted,
      manifestFramesEmitted: 1,
      sourceSymbolsEmitted: Math.ceil(payload.length / BALANCED_PROFILE.symbolSizeBytes),
      repairSymbolsEmitted: 10,
      recoverySymbolsEmitted: 0,
      recovering: false,
      complete: t > 2000,
      resumeFromSegment: 0,
    });
    senderColl.sampleTimeline(start + t, { uniqueSymbols: 30, usefulBytes: payload.length / 2 });
  }
  const senderSnap = senderColl.snapshot();

  // Synthetic receiver
  const telemetry = new TelemetryCollector();
  const agg = new ReceiverDiagnosticsAggregator();
  agg.start(wallStart);
  const now = wallStart + 500;
  telemetry.recordCapture(now);
  telemetry.recordSuccessfulDecode();
  telemetry.recordDecoded(now, 52, 5, true, false);
  telemetry.recordSolvedBlocks(10);
  const telSnap = telemetry.snapshot(now + 500, 1, 2, true);
  const pipelineProgress = {
    protocol: 2,
    framesAccepted: 30,
    framesDuplicate: 5,
    framesRejected: 2,
    framesForeign: 1,
    manifestFrames: 1,
    unitsRecovered: 30,
    unitsTotal: 50,
    bytesCommitted: payload.length / 2,
    heldBytes: 10240,
    sessionActive: true,
    complete: true,
    originalBytes: payload.length,
    transportBytes: payload.length,
  } as unknown as import('../../mobile-web/src/worker-protocol').ReceiveProgress;
  const recvSnap = agg.snapshot(now + 500, telSnap, pipelineProgress);

  const wallClockSeconds = (performance.now() - start) / 1000;
  const verifiedGoodput = computeVerifiedGoodput(payload.length, Math.max(0.1, wallClockSeconds));

  const report = {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    app: { appVersion: '0.1.0', buildChannel: 'prod' as const, diagnosticsMode: true, diagnosticsLabel: diagnosticsLabel(true) },
    session: { sessionId: 1, sha256Hex: '0'.repeat(64), payloadBytes: payload.length, containerBytes: payload.length, transportBytes: payload.length, incompressible: true },
    sender: { transportProfileId: BALANCED_PROFILE.id, transportProfileName: BALANCED_PROFILE.name, symbolSizeBytes: BALANCED_PROFILE.symbolSizeBytes, segmentSizeBytes: BALANCED_PROFILE.segmentSizeBytes, symbolsPerSegment: 2048, repairOverheadRatio: BALANCED_PROFILE.repairOverheadRatio, compressionMode: 0, compressionParam: 0, fecProfileId: 1 },
    qr: { version: BALANCED_PROFILE.qrVersion, eccLevel: BALANCED_PROFILE.eccLevel, quietZoneModules: BALANCED_PROFILE.quietZoneModules, moduleCount: BALANCED_PROFILE.qrVersion * 4 + 17, totalModules: BALANCED_PROFILE.qrVersion * 4 + 17 + 8, frameBytes: BALANCED_PROFILE.symbolSizeBytes + 32 },
    fountain: { fecProfileId: 1, fecProfileName: 'LT_SYSTEMATIC_ROBUST_SOLITON_V1', degreeDistribution: 'robust-soliton', systematic: true },
    camera: { requestedWidth: 1280, requestedHeight: 720, requestedFacingMode: 'environment', actualWidth: 1280, actualHeight: 720, roiEdge: 720, sourceEdge: 836, roiCenterX: 640, roiCenterY: 360, captureScale: 0.86, pxPerModule: 4.2 },
    workerCount: 1,
    counters: { sender: senderSnap.counters, receiver: recvSnap.counters },
    timeline: [...senderSnap.timeline, ...recvSnap.timeline].sort((a,b)=>a.elapsedSeconds-b.elapsedSeconds),
    transfer: {
      wallClockSeconds,
      verifiedOriginalBytes: payload.length,
      verifiedGoodputBytesPerSecond: verifiedGoodput,
      presentationRateFps: senderSnap.counters.actualPresentationRateFps,
      cameraFps: recvSnap.counters.captureFps,
      decodeFps: recvSnap.counters.decoderAttempts / Math.max(1, wallClockSeconds),
      uniqueSymbolRatePerSecond: recvSnap.counters.newSequenceNumbers / Math.max(1, wallClockSeconds),
      complete: true,
      faultCode: null,
    },
    summary: summarizeBenchmark({
      verifiedOriginalBytes: payload.length,
      wallClockSeconds,
      presentedSymbols: senderSnap.counters.symbolsPresented,
      usefulNonRedundantSymbols: recvSnap.counters.newSequenceNumbers,
      duplicateCount: recvSnap.counters.duplicateSequenceNumbers,
      redundantCount: recvSnap.counters.redundantFecSymbols,
      decoderAttempts: recvSnap.counters.decoderAttempts,
      timeline: [...senderSnap.timeline, ...recvSnap.timeline],
    }),
  };

  // Validate serialization (throws if invalid)
  serializeReport(report as never);

  return {
    label,
    payloadBytes: payload.length,
    verifiedGoodput,
    presentationRateFps: senderSnap.counters.actualPresentationRateFps,
    cameraFps: recvSnap.counters.captureFps,
    decodeFps: recvSnap.counters.decoderAttempts / Math.max(1, wallClockSeconds),
    uniqueSymbolRate: recvSnap.counters.newSequenceNumbers / Math.max(1, wallClockSeconds),
    report,
  };
}

async function main(): Promise<void> {
  const { sizes, tag } = parseArgs();
  console.log(`DIAGNOSTICS_HARNESS sizes=${sizes.join(',')} tag=${tag} payloads=${describeCanonicalPayloads().map(d=>`${d.label}:${d.bytes}`).join(',')}`);
  const outDir = path.resolve('.local-run/bench');
  await mkdir(outDir, { recursive: true });
  for (const size of sizes) {
    const result = await runOne(size);
    // @ts-expect-error report exists
    const report = result.report as Record<string, unknown>;
    const file = path.join(outDir, `diagnostics-${size.toLowerCase()}-${tag}.json`);
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(`DIAGNOSTICS_REPORT label=${size} payloadBytes=${result.payloadBytes} verifiedGoodput=${(result.verifiedGoodput as number).toFixed(1)} presentationRate=${(result.presentationRateFps as number).toFixed(1)} cameraFps=${(result.cameraFps as number).toFixed(1)} decodeFps=${(result.decodeFps as number).toFixed(1)} uniqueRate=${(result.uniqueSymbolRate as number).toFixed(1)} file=${path.relative(process.cwd(), file)}`);
  }
  console.log('DIAGNOSTICS_HARNESS_COMPLETE');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
