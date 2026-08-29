/**
 * HT-02 — QR frame-size model.
 *
 * Evaluates candidate total frame sizes against exact byte-mode capacity
 * (including DEQR header overhead) and reports required version, feasibility,
 * and max fountain block length.
 *
 * Byte mode, ECC L/M/Q/H, versions 1..40, overhead aware, no AGPL.
 */

import { QR_BYTE_CAPACITY, QrEccLevel, QR_QUIET_ZONE_MODULES, qrModuleCount } from './qr-capacity';
import { V2_DATA_LAYOUT } from './protocol-v2';

export const CANDIDATE_FRAME_SIZES = [500, 1000, 1465, 1850, 2330, 2953] as const;

export interface FrameSizeEvaluation {
  frameBytes: number;
  payloadBytes: number; // frameBytes - overhead
  overheadBytes: number;
  feasible: boolean;
  requiredVersion: number | null;
  eccLevel: QrEccLevel;
  capacityAtVersion: number | null;
  marginBytes: number | null; // capacity - frameBytes, null if not feasible
  maxFountainBlockLength: number; // payloadBytes when feasible, else 0
}

export function evaluateFrameSize(frameBytes: number, eccLevel: QrEccLevel): FrameSizeEvaluation {
  const overhead = V2_DATA_LAYOUT.overheadBytes; // 32
  const payloadBytes = Math.max(0, frameBytes - overhead);
  let requiredVersion: number | null = null;
  let capacityAtVersion: number | null = null;
  for (let v = 1; v <= 40; v++) {
    const cap = QR_BYTE_CAPACITY[v]?.[eccLevel];
    if (cap !== undefined && cap >= frameBytes) {
      requiredVersion = v;
      capacityAtVersion = cap;
      break;
    }
  }
  const feasible = requiredVersion !== null;
  return {
    frameBytes,
    payloadBytes,
    overheadBytes: overhead,
    feasible,
    requiredVersion,
    eccLevel,
    capacityAtVersion,
    marginBytes: feasible && capacityAtVersion !== null ? capacityAtVersion - frameBytes : null,
    maxFountainBlockLength: feasible ? payloadBytes : 0,
  };
}

export function evaluateCandidateSizes(eccLevel: QrEccLevel): FrameSizeEvaluation[] {
  return CANDIDATE_FRAME_SIZES.map(sz => evaluateFrameSize(sz, eccLevel));
}

export interface QrVersionStabilityCheck {
  frameBytes: number;
  eccLevel: QrEccLevel;
  version: number;
  stable: boolean;
  error?: string;
}

/**
 * Lock version for a stream after first successful generation.
 * All subsequent frames must use identical matrix geometry.
 */
export function checkVersionStability(firstFrameBytes: number, nextFrameBytes: number, eccLevel: QrEccLevel): QrVersionStabilityCheck {
  const first = evaluateFrameSize(firstFrameBytes, eccLevel);
  const next = evaluateFrameSize(nextFrameBytes, eccLevel);
  if (!first.feasible) return { frameBytes: nextFrameBytes, eccLevel, version: -1, stable: false, error: `first frame ${firstFrameBytes} not feasible at ${eccLevel}` };
  if (!next.feasible) return { frameBytes: nextFrameBytes, eccLevel, version: first.requiredVersion!, stable: false, error: `next frame ${nextFrameBytes} not feasible at ${eccLevel}` };
  return {
    frameBytes: nextFrameBytes,
    eccLevel,
    version: next.requiredVersion!,
    stable: first.requiredVersion === next.requiredVersion,
  };
}

export function quietZoneModulesForEvaluation(modules: number = QR_QUIET_ZONE_MODULES): number {
  return modules; // 4 standard, evaluation point; lower requires physical validation
}

export function maxFrameBytesForVersion(version: number, eccLevel: QrEccLevel): number | null {
  return QR_BYTE_CAPACITY[version]?.[eccLevel] ?? null;
}
