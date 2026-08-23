/**
 * DEQR v2 optical transport profiles.
 *
 * A profile is every knob that decides how fast a transfer goes, named and
 * versioned so a measurement can be attributed to one and a user can be told
 * which one they are on. The knobs are not independent, which is why they are a
 * profile rather than four settings: QR version fixes how many bytes fit in a
 * frame, ECC level trades some of those bytes for damage tolerance, both change
 * how many camera pixels a module needs, and the resulting decode failure rate
 * decides how much repair overhead the transfer has to carry.
 *
 * Nothing here is chosen from QR capacity alone. `scripts/bench/phase04-qr-profiles.ts`
 * measures decode success against a simulated camera and composes it with Phase
 * 03's measured repair curve into one number - verified payload bytes per
 * second - and the profiles below are read off that surface.
 *
 * **What is still missing is the physical constant.** The benchmark sweeps
 * camera pixels per module; which value a real iPhone achieves at a real
 * distance, in real light, is Phase 11's to certify. Until then `Balanced` is
 * the default because it is the profile that survives the widest range of that
 * unknown, and `Turbo` is opt-in.
 */

import {
  QrEccLevel,
  qrByteCapacity,
  qrModuleCount,
  QR_QUIET_ZONE_MODULES,
} from './qr-capacity.js';
import { V2_DATA_LAYOUT, V2_LIMITS } from './protocol-v2.js';

/* ------------------------------------------------------------ repair curve */

/**
 * Repair overhead a segment needs to close, per frame-loss rate.
 *
 * Measured in Phase 03 by `scripts/bench/phase03-fec.ts`: 99th percentile
 * repair-to-source ratio at which a segment completed, over 1 MiB segments of
 * 512-byte symbols under independent per-frame loss. Full derivation and the
 * reasons behind its shape are in
 * `.ai-team/reports/performance/PHASE-03-SYSTEMATIC-FOUNTAIN-REPORT.md` and
 * `.ai-team/engineering/PROTOCOL-V2.md` section 7.3.
 *
 * The curve is nearly flat between 1% and 20% because what costs is the tail,
 * not the loss: closing the last few symbols needs a repair symbol touching
 * exactly one of them, which is rare however few remain.
 */
export const MEASURED_REPAIR_OVERHEAD: ReadonlyArray<Readonly<{ lossRate: number; repairRatio: number }>> =
  Object.freeze([
    Object.freeze({ lossRate: 0.00, repairRatio: 0.00 }),
    Object.freeze({ lossRate: 0.01, repairRatio: 0.46 }),
    Object.freeze({ lossRate: 0.05, repairRatio: 0.71 }),
    Object.freeze({ lossRate: 0.10, repairRatio: 0.71 }),
    Object.freeze({ lossRate: 0.20, repairRatio: 0.72 }),
    Object.freeze({ lossRate: 0.30, repairRatio: 0.94 }),
  ]);

/** Highest loss rate the repair curve was measured at. */
export const MAX_MEASURED_LOSS_RATE = 0.30;

/**
 * Repair overhead needed at a given frame-loss rate, or `null` above what was measured.
 *
 * Linear between measured points. **Returns `null` rather than extrapolating**
 * above 30% loss: the curve is steepening there, an extrapolation would be a
 * guess wearing a number's clothes, and a profile that needs one is a profile
 * that should not be selected.
 */
export function requiredRepairRatio(lossRate: number): number | null {
  if (!Number.isFinite(lossRate) || lossRate < 0) return null;
  // A loss rate is usually computed as `1 - successRate`, and `1 - 0.7` is
  // 0.30000000000000004. Without the tolerance a measurement that lands exactly
  // on the last point of the curve is reported as beyond it.
  if (lossRate > MAX_MEASURED_LOSS_RATE + 1e-9) return null;
  if (lossRate > MAX_MEASURED_LOSS_RATE) return MEASURED_REPAIR_OVERHEAD[MEASURED_REPAIR_OVERHEAD.length - 1].repairRatio;

  const points = MEASURED_REPAIR_OVERHEAD;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (lossRate <= current.lossRate) {
      const span = current.lossRate - previous.lossRate;
      if (span <= 0) return current.repairRatio;
      const position = (lossRate - previous.lossRate) / span;
      return previous.repairRatio + position * (current.repairRatio - previous.repairRatio);
    }
  }
  return points[points.length - 1].repairRatio;
}

/* ----------------------------------------------------------------- profiles */

export const TRANSPORT_PROFILE_TABLE_VERSION = 1;

/**
 * Profile identifier, carried in the v2 manifest.
 *
 * `0` means a sender that did not declare one, which every manifest written
 * before this phase does. It is advisory in both directions: a receiver reports
 * it and never decodes with it, because everything decoding needs -
 * `symbolSizeBytes`, `segmentSizeBytes`, `fecProfileId` - is already its own
 * manifest field.
 */
export const TRANSPORT_PROFILE_ID = {
  UNSPECIFIED: 0,
  RELIABLE: 1,
  BALANCED: 2,
  TURBO: 3,
  EXPERIMENTAL: 4,
} as const;
export type TransportProfileId = (typeof TRANSPORT_PROFILE_ID)[keyof typeof TRANSPORT_PROFILE_ID];

export interface TransportProfile {
  id: TransportProfileId;
  name: 'Reliable' | 'Balanced' | 'Turbo' | 'Experimental';
  /** One line, written for the person choosing, not for the log. */
  summary: string;

  /* --- optical --- */
  qrVersion: number;
  eccLevel: QrEccLevel;
  quietZoneModules: number;

  /* --- payload --- */
  /** Payload bytes per frame. Frame size is this plus the 32-byte v2 overhead. */
  symbolSizeBytes: number;
  segmentSizeBytes: number;
  /** Source symbols per full segment. Phase 03 measured recovery efficiency against this. */
  symbolsPerSegment: number;

  /* --- scheduling --- */
  targetFps: number;
  /**
   * Floor on how long one frame stays on screen, in milliseconds.
   *
   * Separate from the frame interval because a camera integrates over an
   * exposure: a frame swapped out sooner than the sensor can gather it is a
   * frame nobody reads, however many of them the display counts.
   */
  minFrameHoldMs: number;

  /* --- recovery --- */
  /** Repair symbols per segment, as a fraction of its source-symbol count. */
  repairOverheadRatio: number;
  /** Frame loss this profile's repair budget is sized to absorb. */
  designLossRate: number;

  /* --- camera expectations --- */
  /** Camera pixels per module below which this profile is not expected to decode. */
  minCameraPxPerModule: number;
  /** Camera pixels across the whole symbol at that density, quiet zone included. */
  minCameraSymbolPx: number;

  /* --- status --- */
  /**
   * False until Phase 11 certifies the profile on a physical device.
   *
   * Every profile here is currently false. That is not a formality: no number in
   * this table has been seen by a camera.
   */
  physicallyCertified: boolean;
  /** Whether a user may select it without opting into an uncertified path. */
  productionSelectable: boolean;
}

/** Frame bytes a profile puts on the wire: payload plus v2 header and CRC. */
export function frameBytesFor(profile: TransportProfile): number {
  return profile.symbolSizeBytes + V2_DATA_LAYOUT.overheadBytes;
}

/** Modules per side including both quiet zones. */
export function totalModulesFor(profile: TransportProfile): number {
  return qrModuleCount(profile.qrVersion) + 2 * profile.quietZoneModules;
}

/**
 * Nominal optical payload rate, before any loss.
 *
 * Deliberately *not* the headline number. It is what the display puts out, not
 * what the receiver verifies, and the difference between those two is the whole
 * subject of this phase.
 */
export function nominalBytesPerSecond(profile: TransportProfile): number {
  return profile.symbolSizeBytes * effectiveFps(profile);
}

/** Frames per second the scheduler will actually run at, honouring the hold floor. */
export function effectiveFps(profile: TransportProfile): number {
  return 1000 / Math.max(1000 / profile.targetFps, profile.minFrameHoldMs);
}

/**
 * Verified payload bytes per second this profile expects at a given loss rate.
 *
 * `null` when the loss rate is above what Phase 03 measured, which is the
 * honest answer rather than an extrapolated one.
 */
export function expectedVerifiedBytesPerSecond(profile: TransportProfile, lossRate: number): number | null {
  const repair = requiredRepairRatio(lossRate);
  if (repair === null) return null;
  return (profile.symbolSizeBytes * effectiveFps(profile)) / (1 + repair);
}

export type ProfileViolation = string;

/**
 * Checks a profile against the protocol and against itself.
 *
 * Every one of these has a way of going wrong quietly. A frame one byte over
 * the QR capacity throws at render time, in the middle of a transfer, on one
 * frame in a thousand. A `segmentSizeBytes` that is not a whole number of
 * symbols is rejected by `planSegmentation` when a transfer starts. A symbol
 * count below about a thousand costs recovery efficiency in a way nothing
 * reports. So the table is validated as data, in a test, rather than trusted.
 */
export function validateTransportProfile(profile: TransportProfile): ProfileViolation[] {
  const violations: ProfileViolation[] = [];
  const frameBytes = frameBytesFor(profile);
  const capacity = qrByteCapacity(profile.qrVersion, profile.eccLevel);

  if (capacity === null) {
    violations.push(`version ${profile.qrVersion} at ECC ${profile.eccLevel} is not in the capacity table`);
  } else if (frameBytes > capacity) {
    violations.push(`frame is ${frameBytes} bytes; version ${profile.qrVersion} at ECC ${profile.eccLevel} holds ${capacity}`);
  }

  if (profile.symbolSizeBytes < V2_LIMITS.minSymbolSizeBytes
    || profile.symbolSizeBytes > V2_LIMITS.maxSymbolSizeBytes) {
    violations.push(`symbolSizeBytes ${profile.symbolSizeBytes} is outside the v2 protocol range`);
  }
  if (profile.segmentSizeBytes < V2_LIMITS.minSegmentSizeBytes
    || profile.segmentSizeBytes > V2_LIMITS.maxSegmentSizeBytes) {
    violations.push(`segmentSizeBytes ${profile.segmentSizeBytes} is outside the v2 protocol range`);
  }
  if (profile.segmentSizeBytes % profile.symbolSizeBytes !== 0) {
    violations.push(`segmentSizeBytes ${profile.segmentSizeBytes} is not a whole number of ${profile.symbolSizeBytes}-byte symbols`);
  }
  if (profile.segmentSizeBytes / profile.symbolSizeBytes !== profile.symbolsPerSegment) {
    violations.push(`symbolsPerSegment ${profile.symbolsPerSegment} disagrees with the segment and symbol sizes`);
  }
  // Phase 03 measured recovery efficiency falling away below roughly a thousand
  // symbols: at K=512 a 30% loss needs a repair ratio of 1.55 against 0.94 at
  // K=2048. This is a soft floor with a hard reason.
  if (profile.symbolsPerSegment < 1024) {
    violations.push(`symbolsPerSegment ${profile.symbolsPerSegment} is below 1024, where Phase 03 measured recovery efficiency degrading`);
  }

  if (profile.quietZoneModules < QR_QUIET_ZONE_MODULES) {
    violations.push(`quietZoneModules ${profile.quietZoneModules} is below the specified minimum of ${QR_QUIET_ZONE_MODULES}`);
  }
  if (profile.targetFps <= 0 || profile.targetFps > 120) {
    violations.push(`targetFps ${profile.targetFps} is not a plausible display cadence`);
  }
  if (profile.minFrameHoldMs <= 0) {
    violations.push(`minFrameHoldMs ${profile.minFrameHoldMs} must be positive`);
  }
  if (profile.repairOverheadRatio < 0 || profile.repairOverheadRatio > 4) {
    violations.push(`repairOverheadRatio ${profile.repairOverheadRatio} is outside the sender's accepted range`);
  }

  const needed = requiredRepairRatio(profile.designLossRate);
  if (needed === null) {
    violations.push(`designLossRate ${profile.designLossRate} is above the ${MAX_MEASURED_LOSS_RATE} Phase 03 measured`);
  } else if (profile.repairOverheadRatio < needed) {
    violations.push(
      `repairOverheadRatio ${profile.repairOverheadRatio} is below the ${needed.toFixed(2)} Phase 03 measured for ${profile.designLossRate} loss`,
    );
  }

  const expectedSymbolPx = Math.round(
    (qrModuleCount(profile.qrVersion) + 2 * profile.quietZoneModules) * profile.minCameraPxPerModule,
  );
  if (profile.minCameraSymbolPx !== expectedSymbolPx) {
    violations.push(`minCameraSymbolPx ${profile.minCameraSymbolPx} disagrees with ${profile.minCameraPxPerModule} px per module`);
  }

  if (profile.productionSelectable && profile.name === 'Experimental') {
    violations.push('Experimental must never be production-selectable');
  }

  return violations;
}

/* ------------------------------------------------------------- the profiles */

/**
 * Measured decode success against a simulated camera, at ECC L.
 *
 * Rows are QR versions, columns camera pixels per module, values the fraction
 * of 60 independent frames that decoded byte-exactly. Produced by
 * `scripts/bench/phase04-qr-profiles.ts --mode optical`; the capture model,
 * its simplifications, and what is and is not transferable to a real device are
 * documented there and in the phase report.
 *
 * This is the surface the four profiles are read off. It is kept in the source
 * rather than only in a report because the profile table below is meaningless
 * without it - and because a test asserts each profile sits where its own row
 * says it does.
 *
 * `null` means the symbol at that density does not fit a 720-line capture
 * frame, which is a physical limit rather than a decode failure.
 */
export const MEASURED_DECODE_SUCCESS: Readonly<Record<number, Readonly<Record<string, number | null>>>> =
  Object.freeze({
    10: Object.freeze({ '2.5': 0.883, '3': 0.833, '3.5': 1.000, '4': 0.950, '5': 1.000 }),
    14: Object.freeze({ '2.5': 0.367, '3': 0.617, '3.5': 0.983, '4': 0.850, '5': 1.000 }),
    18: Object.freeze({ '2.5': 0.233, '3': 0.667, '3.5': 0.750, '4': 0.833, '5': 0.983 }),
    20: Object.freeze({ '2.5': 0.267, '3': 0.583, '3.5': 0.600, '4': 0.650, '5': 0.933 }),
    22: Object.freeze({ '2.5': 0.217, '3': 0.617, '3.5': 0.633, '4': 0.767, '5': 0.983 }),
    24: Object.freeze({ '2.5': 0.317, '3': 0.633, '3.5': 0.767, '4': 0.617, '5': 1.000 }),
    28: Object.freeze({ '2.5': 0.067, '3': 0.517, '3.5': 0.633, '4': 0.550, '5': 0.917 }),
    32: Object.freeze({ '2.5': 0.033, '3': 0.417, '3.5': 0.600, '4': 0.667, '5': null }),
    40: Object.freeze({ '2.5': 0.050, '3': 0.383, '3.5': 0.233, '4': null, '5': null }),
  });

/**
 * Source symbols per segment, for every profile.
 *
 * Phase 03 measured recovery efficiency against this count, not against the
 * segment's byte size: 2,048 symbols needed a 0.94 repair ratio to survive 30%
 * loss where 512 symbols needed 1.55, and everything at or above 2,048 was
 * flat. Holding the count fixed and letting the segment's byte size follow the
 * symbol size is therefore the choice that keeps every profile on the good part
 * of that curve.
 */
export const PROFILE_SYMBOLS_PER_SEGMENT = 2048;

function buildProfile(input: {
  id: TransportProfileId;
  name: TransportProfile['name'];
  summary: string;
  qrVersion: number;
  symbolSizeBytes: number;
  targetFps: number;
  minFrameHoldMs: number;
  repairOverheadRatio: number;
  designLossRate: number;
  minCameraPxPerModule: number;
  productionSelectable: boolean;
}): TransportProfile {
  const quietZoneModules = QR_QUIET_ZONE_MODULES;
  const totalModules = qrModuleCount(input.qrVersion) + 2 * quietZoneModules;
  return {
    ...input,
    eccLevel: 'L',
    quietZoneModules,
    segmentSizeBytes: input.symbolSizeBytes * PROFILE_SYMBOLS_PER_SEGMENT,
    symbolsPerSegment: PROFILE_SYMBOLS_PER_SEGMENT,
    minCameraSymbolPx: Math.round(totalModules * input.minCameraPxPerModule),
    // Nothing in this table has been seen by a camera. Phase 11 changes this.
    physicallyCertified: false,
  };
}

/**
 * The four profiles, and why each one is where it is.
 *
 * **Every profile is ECC L.** That is a measurement, not a shortcut. Holding
 * the QR version fixed and walking L to H changed decode success by at most
 * five percentage points, and H was consistently *worse* than L - while costing
 * 58% of the payload at version 20. The failure mode at low sampling density is
 * that the decoder cannot resolve the module grid at all, and error correction
 * does not repair a grid it never read. Capacity spent on ECC buys robustness
 * that the actual failure mode does not consume.
 *
 * **The versions are separated by what they need from the camera, not by
 * capacity.** The dominant variable by a wide margin is camera pixels per
 * module: at 2.5 nearly everything fails, at 5 nearly everything works, and the
 * useful QR version at any given density is entirely determined by it. So each
 * profile declares the density it needs, and the product's job is to tell the
 * user how to supply it.
 *
 * **Cadence is deliberately conservative and is the weakest number here.** The
 * plan asked for 15/20/24/30/45/60 to be benchmarked. Measured jsQR scan time
 * over a 1280x720 frame was 60-93 ms, an 11-17 FPS ceiling, and *the receiver's
 * scan rate is the binding constraint, not the display's refresh*. Targets
 * above that would be arithmetic rather than transport. The real ceiling
 * depends on the capture pipeline Phase 05 has not built yet.
 */
export const RELIABLE_PROFILE: TransportProfile = buildProfile({
  id: TRANSPORT_PROFILE_ID.RELIABLE,
  name: 'Reliable',
  summary: 'Smallest symbol, widest tolerance. The only profile measured to decode at 2.5 camera pixels per module.',
  // Version 10 is not a compromise, it is the finding: at 2.5 px per module it
  // decoded 88% of frames where version 14 managed 37% and version 28 managed 7%.
  qrVersion: 10,
  symbolSizeBytes: 239,
  targetFps: 10,
  minFrameHoldMs: 100,
  // Sized for the worst loss rate Phase 03 measured, because this is the
  // profile someone falls back to when conditions are already bad.
  repairOverheadRatio: 1.0,
  designLossRate: 0.30,
  minCameraPxPerModule: 2.5,
  productionSelectable: true,
});

export const BALANCED_PROFILE: TransportProfile = buildProfile({
  id: TRANSPORT_PROFILE_ID.BALANCED,
  name: 'Balanced',
  summary: 'Production default. Nearly three times the payload of Reliable, and needs a well-framed camera to earn it.',
  // 83% decode at 4 px per module - a 17% loss the 0.75 repair budget absorbs
  // with margin, since Phase 03 measured 0.72 as sufficient for 20%.
  qrVersion: 18,
  symbolSizeBytes: 686,
  targetFps: 12,
  minFrameHoldMs: 83,
  repairOverheadRatio: 0.75,
  designLossRate: 0.20,
  minCameraPxPerModule: 4,
  productionSelectable: true,
});

export const TURBO_PROFILE: TransportProfile = buildProfile({
  id: TRANSPORT_PROFILE_ID.TURBO,
  name: 'Turbo',
  summary: 'Opt-in. Every frame decoded at 5 camera pixels per module, and it needs all five.',
  // 100% at 5 px per module, 62% at 4. The cliff between those two is why this
  // is opt-in rather than automatic: it is fast exactly while it is well framed.
  qrVersion: 24,
  symbolSizeBytes: 1139,
  targetFps: 15,
  minFrameHoldMs: 66,
  repairOverheadRatio: 0.75,
  designLossRate: 0.20,
  minCameraPxPerModule: 5,
  productionSelectable: true,
});

export const EXPERIMENTAL_PROFILE: TransportProfile = buildProfile({
  id: TRANSPORT_PROFILE_ID.EXPERIMENTAL,
  name: 'Experimental',
  summary: 'Not production-certified. Needs a capture resolution above the 720-line baseline this was measured against.',
  // A version-32 symbol at the 5 px per module it would want is 765 px across,
  // which does not fit a 720-line capture frame at all. It is here so the
  // ceiling is a measured object rather than an assumption, and it is
  // deliberately not selectable.
  qrVersion: 32,
  symbolSizeBytes: 1920,
  targetFps: 20,
  minFrameHoldMs: 50,
  repairOverheadRatio: 0.75,
  designLossRate: 0.20,
  minCameraPxPerModule: 5,
  productionSelectable: false,
});

export const TRANSPORT_PROFILES: readonly TransportProfile[] = Object.freeze([
  RELIABLE_PROFILE,
  BALANCED_PROFILE,
  TURBO_PROFILE,
  EXPERIMENTAL_PROFILE,
]);

/**
 * The profile a transfer uses unless somebody chooses otherwise.
 *
 * Balanced, because it sits where the measured surface is least sensitive to
 * the one variable nobody has pinned down. Reliable gives up two thirds of the
 * payload to tolerate a camera that is barely resolving the symbol; Turbo is
 * fastest but falls from 100% to 62% decode between 5 and 4 pixels per module.
 * Balanced holds 83% at 4 and 98% at 5, so being wrong about the real density
 * costs throughput rather than costing the transfer.
 */
export const DEFAULT_TRANSPORT_PROFILE: TransportProfile = BALANCED_PROFILE;

export function transportProfileById(id: number): TransportProfile | null {
  return TRANSPORT_PROFILES.find((profile) => profile.id === id) ?? null;
}

export function transportProfileByName(name: string): TransportProfile | null {
  const wanted = name.trim().toLowerCase();
  return TRANSPORT_PROFILES.find((profile) => profile.name.toLowerCase() === wanted) ?? null;
}

/** Profiles a user may select without opting into an uncertified path. */
export function selectableTransportProfiles(): TransportProfile[] {
  return TRANSPORT_PROFILES.filter((profile) => profile.productionSelectable);
}

/**
 * What a receiver should be told when a profile is not decoding.
 *
 * There is no back channel. The display cannot learn that the camera is
 * struggling, so a profile cannot fail back on its own - the plan's gate allows
 * the alternative, which is to say clearly what went wrong and what to do. This
 * is the machine-readable half of that; the wording belongs to Phase 09.
 */
export interface ProfileDowngrade {
  from: TransportProfile;
  to: TransportProfile;
  reason: string;
}

/**
 * The next profile down, or `null` at the bottom.
 *
 * Ordered by what each needs from the camera, which is the axis that actually
 * fails - not by throughput, which is the axis a user would guess.
 */
export function downgradeFrom(profile: TransportProfile): ProfileDowngrade | null {
  const ladder = selectableTransportProfiles()
    .slice()
    .sort((left, right) => left.minCameraPxPerModule - right.minCameraPxPerModule);
  const position = ladder.findIndex((entry) => entry.id === profile.id);
  if (position <= 0) return null;
  const next = ladder[position - 1];
  return {
    from: profile,
    to: next,
    reason: `${profile.name} needs ${profile.minCameraPxPerModule} camera pixels per module; ${next.name} needs ${next.minCameraPxPerModule}`,
  };
}
