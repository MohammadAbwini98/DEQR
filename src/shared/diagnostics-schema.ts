/**
 * Structured diagnostics run schema for High-Throughput Program Phase 01.
 *
 * One self-contained JSON report per transfer run — synthetic or physical —
 * so every optimization is measured against the same fields. No network
 * dependency; the report is local, exportable, and redactable.
 *
 * KPI definitions (normative):
 *   verifiedGoodput = verifiedOriginalBytes / transferWallClockSeconds
 *   opticalUsefulYield = usefulNonRedundantSymbols / presentedSymbols
 *
 * Sender FPS, camera FPS, decode FPS, unique-symbol rate, verified goodput
 * are separate values by construction — the report forbids collapsing them.
 */

export const DIAGNOSTICS_SCHEMA_VERSION = 1;

// ──────────────────────────────────────────────────────────────────────────────
// Core identifiers
// ──────────────────────────────────────────────────────────────────────────────

export interface AppVersionInfo {
  appVersion: string; // e.g. "0.1.0"
  buildCommit?: string; // git short sha if available
  buildChannel: 'dev' | 'prod';
  diagnosticsMode: boolean;
  diagnosticsLabel: string; // "DIAGNOSTICS — ..." when enabled, else "PRODUCTION"
}

export interface SessionIdentity {
  sessionId: number;
  fileId?: number;
  sha256Hex: string; // hex of original file
  payloadBytes: number; // original file size
  containerBytes: number; // DEQR container / manifest+segments transport size (same when not compressed)
  transportBytes: number; // alias for containerBytes when v2; kept for schema stability
  incompressible: boolean; // true for canonical benchmark payloads
}

// ──────────────────────────────────────────────────────────────────────────────
// Settings
// ──────────────────────────────────────────────────────────────────────────────

export interface SenderSettings {
  transportProfileId: number;
  transportProfileName: string;
  symbolSizeBytes: number;
  segmentSizeBytes: number;
  symbolsPerSegment: number;
  repairOverheadRatio: number;
  compressionMode: number;
  compressionParam: number;
  fecProfileId: number;
}

export interface QrSettings {
  version: number;
  eccLevel: 'L' | 'M' | 'Q' | 'H';
  quietZoneModules: number;
  moduleCount: number;
  totalModules: number;
  moduleScale?: number;
  pixelSize?: number;
  cssSize?: number;
  frameBytes: number; // payload + 32 overhead
}

export interface FountainSettings {
  fecProfileId: number;
  fecProfileName: string;
  degreeDistribution: string; // e.g. "robust-soliton c=0.1 delta=0.05"
  systematic: boolean;
}

export interface CameraActualSettings {
  requestedWidth: number; // ideal 1280
  requestedHeight: number; // ideal 720
  requestedFacingMode: string;
  actualWidth: number | null;
  actualHeight: number | null;
  roiEdge: number | null; // clamped 96..720 center square
  sourceEdge: number | null;
  roiCenterX: number | null;
  roiCenterY: number | null;
  captureScale: number | null; // roiEdge / sourceEdge
  pxPerModule: number | null; // measured from corners
}

// ──────────────────────────────────────────────────────────────────────────────
// Counters — sender (7) and receiver (16 as specified)
// ──────────────────────────────────────────────────────────────────────────────

export interface SenderCounters {
  /** Frames the fountain/segment encoder produced ( Fuchs `nextFrame` / `take` calls that yielded a frame). */
  framesGenerated: number;
  /** Frames the scheduler actually presented on screen (paint succeeded). */
  symbolsPresented: number;
  /** Presentation stalls: scheduler starved (source could not supply in time). */
  presentationStalls: number;
  /** Queue underruns: queue empty at tick (subset of stalls, explicit). */
  queueUnderruns: number;
  /** Generation time reservoir stats (Fountain + take + IPC + queue). */
  generationTimeP50Ms: number | null;
  generationTimeP95Ms: number | null;
  /** Rasterization time reservoir stats (QR encode + canvas paint). */
  rasterizationTimeP50Ms: number | null;
  rasterizationTimeP95Ms: number | null;
  /** Measured presentation rate (symbolsPainted / elapsed). */
  actualPresentationRateFps: number;
  /** Additional fidelity: totalPaintMs / maxPaintMs for diagnostics export. */
  totalPaintMs: number;
  maxPaintMs: number;
  paintFailures: number;
  overruns: number;
}

export interface ReceiverCounters {
  /** Camera callbacks: requestVideoFrameCallback + watchdog invocations that reached onVideoFrame. */
  cameraCallbacks: number;
  /** Capture FPS: captures per second (RateWindow). */
  captureFps: number;
  /** Full-frame scans: full ROI jsQR attempts. */
  fullFrameScans: number;
  /** Crop scans: region-tracked cropped decode attempts (0 until Phase 07, kept for schema). */
  cropScans: number;
  /** Decoder attempts: total jsQR invocations. */
  decoderAttempts: number;
  /** Successful QR decodes: jsQR returned binaryData. */
  successfulQrDecodes: number;
  /** Parse failures: NOT_DEQR / FRAME_TOO_LONG / CRC_MISMATCH before fountain. */
  parseFailures: number;
  /** Foreign/invalid frames: SESSION_MISMATCH / V1_FRAME / foreign session. */
  foreignInvalidFrames: number;
  /** Duplicate sequence numbers: BoundedFingerprintSet hit or SEGMENT_COMMITTED/DUPLICATE. */
  duplicateSequenceNumbers: number;
  /** New sequence numbers: accepted unique frames that advanced transfer. */
  newSequenceNumbers: number;
  /** Redundant FEC symbols: well-formed but no new solved (REDUNDANT). */
  redundantFecSymbols: number;
  /** Solved blocks: source symbols recovered (solved count from SegmentDecoder). */
  solvedBlocks: number;
  /** Worker-busy drops: captures skipped because canAccept()==false (skippedBusy). */
  workerBusyDrops: number;
  /** Decoder time p50/p95 (jsQR). */
  decoderTimeP50Ms: number | null;
  decoderTimeP95Ms: number | null;
  /** Acquisition latency: ms from session open to first newSequenceNumbers >0 (null until acquired). */
  acquisitionLatencyMs: number | null;
  /** Completion latency: ms from last newSequence to verified/complete (null until complete). */
  completionLatencyMs: number | null;
  /** Additional: droppedStale (worker refused aged), stalledRecoveries, longTasks. */
  droppedStale: number;
  stalledRecoveries: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Timeline sample every ~500ms (8 fields as specified + elapsed)
// ──────────────────────────────────────────────────────────────────────────────

export interface TimelineSample {
  elapsedSeconds: number;
  captureFps: number;
  decodeFps: number;
  uniqueSymbols: number; // cumulative newSequenceNumbers at this instant
  solvedBlocks: number; // cumulative solvedBlocks
  usefulBytesRecovered: number; // solvedBlocks * symbolSize (or original bytes)
  workerUtilization: number; // inFlight / maxInFlight 0..1
  queueDepth: number; // scheduler queueDepth at sample time
  cumulativeFullScans: number; // fullFrameScans cumulative
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary tooling output (7 metrics)
// ──────────────────────────────────────────────────────────────────────────────

export interface BenchmarkSummary {
  sustainedGoodputBytesPerSecond: number; // verifiedOriginalBytes / wallClock
  bestOneSecondGoodputBytesPerSecond: number | null; // max over >=1s window
  catchRate: number; // newSequenceNumbers / presentedSymbols 0..1 (same as opticalUsefulYield when no crop)
  usefulOverhead: number; // presentedSymbols / usefulNonRedundantSymbols - 1 (0 = no overhead)
  duplicateRate: number; // duplicates / decoderAttempts
  redundancyRate: number; // redundant / decoderAttempts
  decoderUtilization: number; // decoderAttempts / (wallClock * decodeCeilingFps) or per decodeMs/wallClock
  // Aliases for KPI spec
  verifiedGoodput: number;
  opticalUsefulYield: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Top-level report
// ──────────────────────────────────────────────────────────────────────────────

export interface DiagnosticRunReport {
  schemaVersion: number; // 1
  generatedAt: string; // ISO
  app: AppVersionInfo;
  session: SessionIdentity;
  sender: SenderSettings;
  qr: QrSettings;
  fountain: FountainSettings;
  camera: CameraActualSettings;
  workerCount: number; // 1 dedicated worker, maxInFlight=2
  counters: {
    sender: SenderCounters;
    receiver: ReceiverCounters;
  };
  timeline: TimelineSample[];
  transfer: {
    wallClockSeconds: number;
    verifiedOriginalBytes: number;
    verifiedGoodputBytesPerSecond: number; // KPI: verifiedOriginalBytes / wallClockSeconds
    presentationRateFps: number; // sender actual
    cameraFps: number;
    decodeFps: number;
    uniqueSymbolRatePerSecond: number;
    complete: boolean;
    faultCode?: string | null;
  };
  summary?: BenchmarkSummary; // filled by summarizeReport()
}

// ──────────────────────────────────────────────────────────────────────────────
// KPI helpers (pure, deterministic)
// ──────────────────────────────────────────────────────────────────────────────

export function computeVerifiedGoodput(verifiedOriginalBytes: number, wallClockSeconds: number): number {
  if (!Number.isFinite(verifiedOriginalBytes) || !Number.isFinite(wallClockSeconds)) return 0;
  if (wallClockSeconds <= 0 || verifiedOriginalBytes <= 0) return 0;
  return verifiedOriginalBytes / wallClockSeconds;
}

export function computeOpticalUsefulYield(usefulNonRedundantSymbols: number, presentedSymbols: number): number {
  if (!Number.isFinite(usefulNonRedundantSymbols) || !Number.isFinite(presentedSymbols)) return 0;
  if (presentedSymbols <= 0) return 0;
  if (usefulNonRedundantSymbols <= 0) return 0;
  return Math.min(1, usefulNonRedundantSymbols / presentedSymbols);
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation / serialization
// ──────────────────────────────────────────────────────────────────────────────

export function validateReport(report: DiagnosticRunReport): string[] {
  const errors: string[] = [];
  if (report.schemaVersion !== DIAGNOSTICS_SCHEMA_VERSION) errors.push(`schemaVersion must be ${DIAGNOSTICS_SCHEMA_VERSION}`);
  if (!report.generatedAt || Number.isNaN(Date.parse(report.generatedAt))) errors.push('generatedAt must be ISO date');
  if (!Number.isFinite(report.session.sessionId)) errors.push('sessionId must be finite');
  if (report.session.payloadBytes < 0) errors.push('payloadBytes must be >=0');
  if (!Array.isArray(report.timeline)) errors.push('timeline must be array');
  for (let i = 1; i < report.timeline.length; i++) {
    if (report.timeline[i].elapsedSeconds < report.timeline[i - 1].elapsedSeconds) errors.push('timeline must be monotonic');
  }
  // Counters sanity: duplicates + new + redundant + parseFailures + foreign should not exceed attempts by large margin, but not enforced strictly.
  return errors;
}

export function serializeReport(report: DiagnosticRunReport): string {
  const errors = validateReport(report);
  if (errors.length) throw new Error(`Report validation failed: ${errors.join('; ')}`);
  return JSON.stringify(report, null, 2);
}

export function deserializeReport(json: string): DiagnosticRunReport {
  const parsed = JSON.parse(json) as DiagnosticRunReport;
  const errors = validateReport(parsed);
  if (errors.length) throw new Error(`Deserialized report invalid: ${errors.join('; ')}`);
  return parsed;
}

/**
 * Redact sensitive filename by default.
 * Returns a Report with filename replaced by basename hash prefix, unless opts.allowFilename.
 */
export function redactReport(report: DiagnosticRunReport, opts: { allowFilename?: boolean } = {}): DiagnosticRunReport {
  if (opts.allowFilename) return report;
  // We store filename only inside app diagnosticsLabel, not in payload sha. If session contained a filename field, redact.
  // Current schema stores no raw filename — only sha256Hex — so this is a forward guard.
  const copy = JSON.parse(JSON.stringify(report)) as DiagnosticRunReport;
  return copy;
}
