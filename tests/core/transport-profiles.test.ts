import { describe, expect, it } from 'vitest';

import { qrByteCapacity } from '../../src/core/qr-capacity';
import { V2_DATA_LAYOUT, V2_LIMITS } from '../../src/core/protocol-v2';
import {
  BALANCED_PROFILE,
  DEFAULT_TRANSPORT_PROFILE,
  EXPERIMENTAL_PROFILE,
  MAX_MEASURED_LOSS_RATE,
  MEASURED_DECODE_SUCCESS,
  MEASURED_REPAIR_OVERHEAD,
  PROFILE_SYMBOLS_PER_SEGMENT,
  RELIABLE_PROFILE,
  TRANSPORT_PROFILES,
  TRANSPORT_PROFILE_ID,
  TURBO_PROFILE,
  downgradeFrom,
  effectiveFps,
  expectedVerifiedBytesPerSecond,
  frameBytesFor,
  nominalBytesPerSecond,
  requiredRepairRatio,
  selectableTransportProfiles,
  transportProfileById,
  transportProfileByName,
  validateTransportProfile,
} from '../../src/core/transport-profiles';

describe('every profile is internally consistent', () => {
  it.each(TRANSPORT_PROFILES.map((profile) => [profile.name, profile] as const))(
    '%s passes its own validator',
    (_name, profile) => {
      expect(validateTransportProfile(profile)).toEqual([]);
    },
  );

  it.each(TRANSPORT_PROFILES.map((profile) => [profile.name, profile] as const))(
    '%s fills its QR capacity exactly and does not exceed it',
    (_name, profile) => {
      const capacity = qrByteCapacity(profile.qrVersion, profile.eccLevel)!;
      // Exactly, not merely within: a profile that leaves capacity unused is
      // paying for module size it is not spending.
      expect(frameBytesFor(profile)).toBe(capacity);
      expect(profile.symbolSizeBytes).toBe(capacity - V2_DATA_LAYOUT.overheadBytes);
    },
  );

  it.each(TRANSPORT_PROFILES.map((profile) => [profile.name, profile] as const))(
    '%s stays inside the v2 protocol limits',
    (_name, profile) => {
      expect(profile.symbolSizeBytes).toBeGreaterThanOrEqual(V2_LIMITS.minSymbolSizeBytes);
      expect(profile.symbolSizeBytes).toBeLessThanOrEqual(V2_LIMITS.maxSymbolSizeBytes);
      expect(profile.segmentSizeBytes).toBeGreaterThanOrEqual(V2_LIMITS.minSegmentSizeBytes);
      expect(profile.segmentSizeBytes).toBeLessThanOrEqual(V2_LIMITS.maxSegmentSizeBytes);
      expect(profile.segmentSizeBytes % profile.symbolSizeBytes).toBe(0);
    },
  );

  it('keeps every segment on the good part of the Phase 03 recovery curve', () => {
    // Phase 03 measured 2,048 symbols needing a 0.94 repair ratio at 30% loss
    // where 512 symbols needed 1.55. Holding the count fixed is what keeps a
    // large-symbol profile from quietly becoming a less recoverable one.
    for (const profile of TRANSPORT_PROFILES) {
      expect(profile.symbolsPerSegment).toBe(PROFILE_SYMBOLS_PER_SEGMENT);
      expect(profile.segmentSizeBytes / profile.symbolSizeBytes).toBe(PROFILE_SYMBOLS_PER_SEGMENT);
    }
  });

  it('carries a repair budget at least as large as the loss it claims to absorb', () => {
    for (const profile of TRANSPORT_PROFILES) {
      const needed = requiredRepairRatio(profile.designLossRate);
      expect(needed, `${profile.name} design loss is within what Phase 03 measured`).not.toBeNull();
      expect(profile.repairOverheadRatio).toBeGreaterThanOrEqual(needed!);
    }
  });

  it('has unique ids and names, none of them the unspecified one', () => {
    const ids = TRANSPORT_PROFILES.map((profile) => profile.id);
    const names = TRANSPORT_PROFILES.map((profile) => profile.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(ids).not.toContain(TRANSPORT_PROFILE_ID.UNSPECIFIED);
    for (const id of ids) expect(id).toBeLessThanOrEqual(0xff);
  });
});

describe('the profiles sit where the measurement put them', () => {
  it.each([
    ['Reliable', RELIABLE_PROFILE],
    ['Balanced', BALANCED_PROFILE],
    ['Turbo', TURBO_PROFILE],
  ] as const)('%s decodes at the density it declares, within its design loss', (_name, profile) => {
    const row = MEASURED_DECODE_SUCCESS[profile.qrVersion];
    expect(row, `version ${profile.qrVersion} was measured`).toBeDefined();
    const success = row[String(profile.minCameraPxPerModule)];
    expect(success, 'measured at the declared density').not.toBeNull();
    // The claim a profile makes is that at its declared sampling density the
    // loss it sees is inside the loss its repair budget was sized for.
    expect(1 - (success as number)).toBeLessThanOrEqual(profile.designLossRate);
  });

  it('marks Experimental as needing more than the measured baseline could give it', () => {
    // A version-32 symbol at 5 px per module is 765 px across and does not fit
    // the 720-line capture frame the sweep assumed. That is the reason it is
    // Experimental, and it is a measured fact rather than caution.
    expect(MEASURED_DECODE_SUCCESS[EXPERIMENTAL_PROFILE.qrVersion]['5']).toBeNull();
    expect(EXPERIMENTAL_PROFILE.minCameraSymbolPx).toBeGreaterThan(720);
    expect(EXPERIMENTAL_PROFILE.productionSelectable).toBe(false);
    expect(selectableTransportProfiles()).not.toContain(EXPERIMENTAL_PROFILE);
  });

  it('is ECC L throughout, because ECC did not buy what capacity cost', () => {
    // Measured: holding the version fixed and walking L to H moved decode
    // success by at most five points, and H was worse than L, while costing 58%
    // of the payload at version 20.
    for (const profile of TRANSPORT_PROFILES) expect(profile.eccLevel).toBe('L');
  });

  it('orders throughput the way the names imply', () => {
    expect(nominalBytesPerSecond(RELIABLE_PROFILE)).toBeLessThan(nominalBytesPerSecond(BALANCED_PROFILE));
    expect(nominalBytesPerSecond(BALANCED_PROFILE)).toBeLessThan(nominalBytesPerSecond(TURBO_PROFILE));
    // And demands more of the camera in the same order, which is the trade.
    expect(RELIABLE_PROFILE.minCameraPxPerModule).toBeLessThan(BALANCED_PROFILE.minCameraPxPerModule);
    expect(BALANCED_PROFILE.minCameraPxPerModule).toBeLessThan(TURBO_PROFILE.minCameraPxPerModule);
  });

  it('defaults to Balanced and keeps it production-selectable', () => {
    expect(DEFAULT_TRANSPORT_PROFILE).toBe(BALANCED_PROFILE);
    expect(DEFAULT_TRANSPORT_PROFILE.productionSelectable).toBe(true);
  });

  it('certifies nothing, because no number here has been seen by a camera', () => {
    for (const profile of TRANSPORT_PROFILES) expect(profile.physicallyCertified).toBe(false);
  });
});

describe('cadence is scheduled honestly', () => {
  it('lets the frame-hold floor win when it disagrees with the target', () => {
    // A profile asking for 60 FPS with a 25 ms hold is asking for 40, and the
    // effective rate is the one that gets scheduled.
    const held = { ...TURBO_PROFILE, targetFps: 60, minFrameHoldMs: 25 };
    expect(effectiveFps(held)).toBe(40);
    for (const profile of TRANSPORT_PROFILES) {
      expect(effectiveFps(profile)).toBeLessThanOrEqual(profile.targetFps + 1e-9);
    }
  });
});

describe('the repair curve refuses to be extrapolated', () => {
  it('reproduces every measured point exactly', () => {
    for (const { lossRate, repairRatio } of MEASURED_REPAIR_OVERHEAD) {
      expect(requiredRepairRatio(lossRate)).toBeCloseTo(repairRatio, 10);
    }
  });

  it('interpolates between them and never below zero', () => {
    const midpoint = requiredRepairRatio(0.03)!;
    expect(midpoint).toBeGreaterThan(0.46);
    expect(midpoint).toBeLessThan(0.71);
    expect(requiredRepairRatio(0)).toBe(0);
  });

  it('tolerates the float error a loss rate is normally computed with', () => {
    // A loss rate arrives as `1 - successRate`, and `1 - 0.7` is
    // 0.30000000000000004. Without a tolerance, a measurement landing exactly on
    // the last point of the curve is reported as beyond it - which showed up as
    // a benchmark cell calling a usable combination unusable.
    expect(requiredRepairRatio(1 - 0.7)).toBeCloseTo(0.94, 6);
    expect(expectedVerifiedBytesPerSecond(BALANCED_PROFILE, 1 - 0.7)).not.toBeNull();
  });

  it('returns null above what was measured, rather than a guess', () => {
    expect(requiredRepairRatio(MAX_MEASURED_LOSS_RATE)).toBeCloseTo(0.94, 6);
    expect(requiredRepairRatio(0.31)).toBeNull();
    expect(requiredRepairRatio(0.9)).toBeNull();
    expect(requiredRepairRatio(-0.1)).toBeNull();
    expect(requiredRepairRatio(Number.NaN)).toBeNull();
  });

  it('reports a profile as unusable rather than slow when loss is off the curve', () => {
    expect(expectedVerifiedBytesPerSecond(BALANCED_PROFILE, 0.5)).toBeNull();
    const at20 = expectedVerifiedBytesPerSecond(BALANCED_PROFILE, 0.2)!;
    const at0 = expectedVerifiedBytesPerSecond(BALANCED_PROFILE, 0)!;
    expect(at20).toBeLessThan(at0);
    expect(at0).toBeCloseTo(BALANCED_PROFILE.symbolSizeBytes * effectiveFps(BALANCED_PROFILE), 6);
  });
});

describe('the validator catches the ways a profile goes quietly wrong', () => {
  it('rejects a frame one byte over its QR capacity', () => {
    const overfull = { ...BALANCED_PROFILE, symbolSizeBytes: BALANCED_PROFILE.symbolSizeBytes + 1 };
    expect(validateTransportProfile(overfull).join(' ')).toMatch(/holds/);
  });

  it('rejects a segment that is not a whole number of symbols', () => {
    const ragged = { ...BALANCED_PROFILE, segmentSizeBytes: BALANCED_PROFILE.segmentSizeBytes + 1 };
    expect(validateTransportProfile(ragged).join(' ')).toMatch(/whole number/);
  });

  it('rejects a symbol count below where recovery efficiency falls away', () => {
    const thin = {
      ...BALANCED_PROFILE,
      symbolsPerSegment: 512,
      segmentSizeBytes: BALANCED_PROFILE.symbolSizeBytes * 512,
    };
    expect(validateTransportProfile(thin).join(' ')).toMatch(/below 1024/);
  });

  it('rejects a repair budget smaller than the loss it claims to absorb', () => {
    const underfunded = { ...BALANCED_PROFILE, repairOverheadRatio: 0.1 };
    expect(validateTransportProfile(underfunded).join(' ')).toMatch(/below the/);
  });

  it('rejects a design loss rate off the measured curve', () => {
    const optimistic = { ...BALANCED_PROFILE, designLossRate: 0.5 };
    expect(validateTransportProfile(optimistic).join(' ')).toMatch(/above the/);
  });

  it('rejects a quiet zone below the specification', () => {
    const cramped = { ...BALANCED_PROFILE, quietZoneModules: 2, minCameraSymbolPx: 0 };
    expect(validateTransportProfile(cramped).join(' ')).toMatch(/quiet/i);
  });

  it('refuses to let Experimental become production-selectable', () => {
    const promoted = { ...EXPERIMENTAL_PROFILE, productionSelectable: true };
    expect(validateTransportProfile(promoted).join(' ')).toMatch(/never be production-selectable/);
  });
});

describe('lookup and downgrade', () => {
  it('finds profiles by id and by name, and nothing by a wrong one', () => {
    expect(transportProfileById(TRANSPORT_PROFILE_ID.TURBO)).toBe(TURBO_PROFILE);
    expect(transportProfileById(TRANSPORT_PROFILE_ID.UNSPECIFIED)).toBeNull();
    expect(transportProfileById(0xff)).toBeNull();
    expect(transportProfileByName('balanced')).toBe(BALANCED_PROFILE);
    expect(transportProfileByName('  Turbo ')).toBe(TURBO_PROFILE);
    expect(transportProfileByName('supersonic')).toBeNull();
  });

  it('steps down the ladder by what the camera has to supply, not by speed', () => {
    // There is no back channel, so nothing downgrades itself. This is the
    // machine-readable half of telling a user what to do instead.
    const fromTurbo = downgradeFrom(TURBO_PROFILE)!;
    expect(fromTurbo.to).toBe(BALANCED_PROFILE);
    expect(fromTurbo.reason).toMatch(/camera pixels per module/);

    expect(downgradeFrom(BALANCED_PROFILE)!.to).toBe(RELIABLE_PROFILE);
    expect(downgradeFrom(RELIABLE_PROFILE)).toBeNull();
  });
});
