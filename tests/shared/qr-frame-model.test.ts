import { describe, it, expect } from 'vitest';
import { CANDIDATE_FRAME_SIZES, evaluateFrameSize, evaluateCandidateSizes, checkVersionStability, maxFrameBytesForVersion } from '../../src/core/qr-frame-model';
import { QR_BYTE_CAPACITY } from '../../src/core/qr-capacity';
import { V2_DATA_LAYOUT } from '../../src/core/protocol-v2';

describe('qr-frame-model', () => {
  it('evaluates candidate frame sizes 500/1000/1465/1850/2330/2953', () => {
    const evals = evaluateCandidateSizes('L');
    expect(evals.map(e => e.frameBytes)).toEqual([...CANDIDATE_FRAME_SIZES]);
    for (const e of evals) {
      expect(e.overheadBytes).toBe(V2_DATA_LAYOUT.overheadBytes);
      expect(e.payloadBytes).toBe(e.frameBytes - V2_DATA_LAYOUT.overheadBytes);
      if (e.frameBytes === 2953) {
        expect(e.feasible).toBe(true);
        expect(e.requiredVersion).toBe(40);
        expect(e.capacityAtVersion).toBe(2953);
      }
    }
  });

  it('exact capacity boundaries', () => {
    // At L, V10 capacity 271, so 271 feasible, 272 needs V11
    const at271 = evaluateFrameSize(271, 'L');
    expect(at271.feasible).toBe(true);
    expect(at271.requiredVersion).toBe(10);
    expect(at271.marginBytes).toBe(0);
    const at272 = evaluateFrameSize(272, 'L');
    expect(at272.requiredVersion).toBe(11);
    const over = evaluateFrameSize(2954, 'L');
    expect(over.feasible).toBe(false);
    expect(over.requiredVersion).toBeNull();
  });

  it('header + payload fit', () => {
    // Payload 686 (Balanced) +32 overhead =718 fits V18 L 718 exactly
    const e = evaluateFrameSize(718, 'L');
    expect(e.feasible).toBe(true);
    expect(e.requiredVersion).toBe(18);
    expect(e.payloadBytes).toBe(686);
    expect(e.maxFountainBlockLength).toBe(686);
    // One byte more needs next version
    const e2 = evaluateFrameSize(719, 'L');
    expect(e2.requiredVersion).toBe(19);
  });

  it('version stability check', () => {
    const stable = checkVersionStability(718, 718, 'L');
    expect(stable.stable).toBe(true);
    expect(stable.version).toBe(18);
    const unstable = checkVersionStability(271, 272, 'L');
    expect(unstable.stable).toBe(false);
    expect(unstable.version).toBe(11);
  });

  it('ECC L vs M capacity ordering', () => {
    for (let v = 10; v <= 24; v++) {
      const capL = QR_BYTE_CAPACITY[v]['L'];
      const capM = QR_BYTE_CAPACITY[v]['M'];
      expect(capL).toBeGreaterThan(capM);
    }
  });

  it('maxFrameBytesForVersion', () => {
    expect(maxFrameBytesForVersion(18, 'L')).toBe(718);
    expect(maxFrameBytesForVersion(40, 'L')).toBe(2953);
    expect(maxFrameBytesForVersion(41, 'L')).toBeNull();
  });

  it('exposes max fountain block length', () => {
    const e = evaluateFrameSize(500, 'L');
    expect(e.maxFountainBlockLength).toBe(468); // 500-32
  });
});
