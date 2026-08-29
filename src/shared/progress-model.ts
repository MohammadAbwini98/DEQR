/**
 * HT-12 — Accurate progress, goodput, telemetry (receiver-grounded).
 * Tracks separately and builds monotonic bounded progress.
 */

export interface ProgressInputs {
  framesDecoded: number;
  framesNew: number;
  framesDuplicate: number;
  framesRedundant: number;
  sourceBlocksSolved: number;
  sourceBlocksTotal: number;
  verifiedPayloadBytes: number;
  transferElapsedSeconds: number;
  estimatedUsefulFramesNeeded?: number; // K * (1+overhead)
}

export interface ProgressReport {
  progress: number; // 0..1, monotonic, <1 until verified
  verified: boolean;
  usefulRate: number; // innovative payload rate
  finalRate: number | null; // verified bytes / total time when verified
  diagnosticRates: {
    opticalDecodedKBs: number;
    uniqueSymbolRate: number;
    cameraFps: number | null;
    decodeFps: number | null;
  };
}

export class ReceiverProgressModel {
  private lastProgress = 0;
  private startAt: number | null = null;

  start(nowMs: number): void {
    this.startAt = nowMs;
    this.lastProgress = 0;
  }

  update(inputs: ProgressInputs, nowMs: number): ProgressReport {
    if (this.startAt === null) this.startAt = nowMs;
    const elapsed = (nowMs - this.startAt) / 1000;
    // Progress: systematic solved / total, plus innovative repair / expected overhead, clamped <1 until verified
    const systematicPart = inputs.sourceBlocksTotal > 0 ? inputs.sourceBlocksSolved / inputs.sourceBlocksTotal : 0;
    const overhead = inputs.estimatedUsefulFramesNeeded ? (inputs.estimatedUsefulFramesNeeded - inputs.sourceBlocksTotal) / inputs.sourceBlocksTotal : 0.3;
    const innovativePart = inputs.framesNew / Math.max(1, inputs.sourceBlocksTotal * (1 + overhead));
    let progress = Math.min(0.99, Math.max(systematicPart, innovativePart * 0.5 + systematicPart * 0.5));
    // Monotonic
    if (progress < this.lastProgress) progress = this.lastProgress;
    else this.lastProgress = progress;

    const verified = inputs.verifiedPayloadBytes > 0 && inputs.sourceBlocksSolved >= inputs.sourceBlocksTotal;
    if (verified) progress = 1;

    const usefulRate = elapsed > 0 ? inputs.framesNew / elapsed : 0;
    const finalRate = verified && elapsed > 0 ? inputs.verifiedPayloadBytes / elapsed : null;

    return {
      progress,
      verified,
      usefulRate,
      finalRate,
      diagnosticRates: {
        opticalDecodedKBs: elapsed > 0 ? (inputs.framesDecoded * 512) / 1024 / elapsed : 0,
        uniqueSymbolRate: elapsed > 0 ? inputs.framesNew / elapsed : 0,
        cameraFps: null,
        decodeFps: null,
      },
    };
  }

  reset(): void {
    this.lastProgress = 0;
    this.startAt = null;
  }
}
