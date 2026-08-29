/**
 * HT-11 — Adaptive transfer profiles (Reliable/Balanced/Fast) with capability inputs.
 *
 * Extends transport-profiles with grid count, worker recommendation, and capability-based selection.
 * One-way channel: no receiver→sender feedback; selection is manual or sender-side capability based,
 * receiver can advise locally ("Move closer", "Use Balanced", "Use Reliable").
 */

import { TRANSPORT_PROFILES, type TransportProfile } from './transport-profiles';
import type { GridCount } from '../renderer/multiplexer';

export interface AdaptiveProfile extends TransportProfile {
  gridCount: GridCount;
  targetPerCodeFps: number;
  minPhysicalModuleSizeCssPx: number;
  workerRecommendation: number; // 2..4
  cameraExpectation: { minFps: number; decodeFps: number };
}

export const ADAPTIVE_PROFILES: Record<string, AdaptiveProfile> = {
  Reliable: {
    ...TRANSPORT_PROFILES.find(p => p.name === 'Reliable')!,
    gridCount: 1,
    targetPerCodeFps: 24,
    minPhysicalModuleSizeCssPx: 5,
    workerRecommendation: 2,
    cameraExpectation: { minFps: 15, decodeFps: 19 },
  },
  Balanced: {
    ...TRANSPORT_PROFILES.find(p => p.name === 'Balanced')!,
    gridCount: 2,
    targetPerCodeFps: 30,
    minPhysicalModuleSizeCssPx: 4,
    workerRecommendation: 3,
    cameraExpectation: { minFps: 20, decodeFps: 18 },
  },
  Fast: {
    ...TRANSPORT_PROFILES.find(p => p.name === 'Turbo')!,
    gridCount: 4,
    targetPerCodeFps: 55,
    minPhysicalModuleSizeCssPx: 3,
    workerRecommendation: 4,
    cameraExpectation: { minFps: 30, decodeFps: 14 },
    // name stays 'Turbo' per TransportProfile type; Fast is the adaptive alias for 4-code
  },
};

export interface SenderCapabilities {
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  refreshRateHz?: number;
  qrGenerationMsP95: number | null;
}

export interface ReceiverCapabilities {
  actualCameraFps: number | null;
  decoderThroughputFps: number | null;
  trackedStability: number | null; // 0..1
}

export function recommendProfile(
  sender: SenderCapabilities,
  receiver?: ReceiverCapabilities,
): { profile: AdaptiveProfile; reason: string; fallback?: AdaptiveProfile } {
  const canFit4 = sender.viewportWidth >= 800 && sender.viewportHeight >= 600 && sender.devicePixelRatio >= 1.5;
  const canGenFast = sender.qrGenerationMsP95 === null || sender.qrGenerationMsP95 < 15;
  if (canFit4 && canGenFast && (!receiver || (receiver.actualCameraFps ?? 0) >= 28)) {
    return { profile: ADAPTIVE_PROFILES.Fast, reason: 'Display and generation support Fast (4-code), camera ≥28 fps' , fallback: ADAPTIVE_PROFILES.Balanced };
  }
  if (sender.viewportWidth >= 600 && (!receiver || (receiver.actualCameraFps ?? 0) >= 18)) {
    return { profile: ADAPTIVE_PROFILES.Balanced, reason: 'Balanced (2-code) fits viewport and camera', fallback: ADAPTIVE_PROFILES.Reliable };
  }
  return { profile: ADAPTIVE_PROFILES.Reliable, reason: 'Reliable (1-code) — safe fallback for small viewport or low camera FPS' };
}

export function fallbackAdvice(observation: { decodeRate: number; trackedCount: number; expected: number }): string {
  if (observation.decodeRate < observation.expected * 0.5) return 'Move closer';
  if (observation.trackedCount < observation.expected) return 'Use Balanced';
  return 'Use Reliable';
}
