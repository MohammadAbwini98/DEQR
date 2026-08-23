import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';

import {
  QR_ALL_VERSIONS,
  QR_BYTE_CAPACITY,
  QR_ECC_LEVELS,
  QR_QUIET_ZONE_MODULES,
  QrEccLevel,
  cameraPixelsForSymbol,
  planQrGeometry,
  qrByteCapacity,
  qrModuleCount,
  smallestVersionFor,
} from '../../src/core/qr-capacity';

/** Whether the shipping encoder accepts this many byte-mode bytes at this version. */
function encoderAccepts(byteCount: number, version: number, ecc: QrEccLevel): boolean {
  try {
    QRCode.create([{ data: Buffer.alloc(byteCount), mode: 'byte' }], { errorCorrectionLevel: ecc, version });
    return true;
  } catch {
    return false;
  }
}

describe('the capacity table is the encoder, not a textbook', () => {
  /**
   * Two probes per cell rather than a binary search: the tabulated capacity must
   * be accepted and one more byte must be refused. That pins the exact boundary,
   * and it is the assertion that fails the day `qrcode` is upgraded and its
   * limits move underneath a profile definition.
   */
  it.each(QR_ECC_LEVELS)('agrees with the shipping encoder at every version, ECC %s', (ecc) => {
    for (const version of QR_ALL_VERSIONS) {
      const capacity = qrByteCapacity(version, ecc);
      expect(capacity, `version ${version} ECC ${ecc} is tabulated`).not.toBeNull();
      if (capacity === null) continue;

      expect(encoderAccepts(capacity, version, ecc), `v${version} ${ecc} accepts ${capacity}`).toBe(true);
      expect(encoderAccepts(capacity + 1, version, ecc), `v${version} ${ecc} refuses ${capacity + 1}`).toBe(false);
    }
  });

  it('covers all forty versions with all four levels', () => {
    expect(QR_ALL_VERSIONS).toHaveLength(40);
    expect(QR_ALL_VERSIONS[0]).toBe(1);
    expect(QR_ALL_VERSIONS[39]).toBe(40);
    for (const version of QR_ALL_VERSIONS) {
      for (const ecc of QR_ECC_LEVELS) expect(qrByteCapacity(version, ecc)).toBeGreaterThan(0);
    }
  });

  it('increases with version and decreases with error correction', () => {
    for (const ecc of QR_ECC_LEVELS) {
      for (let index = 1; index < QR_ALL_VERSIONS.length; index += 1) {
        const lower = qrByteCapacity(QR_ALL_VERSIONS[index - 1], ecc)!;
        const higher = qrByteCapacity(QR_ALL_VERSIONS[index], ecc)!;
        expect(higher).toBeGreaterThan(lower);
      }
    }
    for (const version of QR_ALL_VERSIONS) {
      const [l, m, q, h] = QR_ECC_LEVELS.map((ecc) => qrByteCapacity(version, ecc)!);
      expect(l).toBeGreaterThan(m);
      expect(m).toBeGreaterThan(q);
      expect(q).toBeGreaterThan(h);
    }
  });

  it('picks the smallest version that holds a payload, exactly', () => {
    // Exact rather than rounded up to a sampled version: rounding up costs
    // module size, and module size is the axis this whole phase turns on.
    expect(smallestVersionFor(17, 'L')).toBe(1);
    expect(smallestVersionFor(18, 'L')).toBe(2);
    expect(smallestVersionFor(2953, 'L')).toBe(40);
    expect(smallestVersionFor(2954, 'L')).toBeNull();

    for (const version of QR_ALL_VERSIONS) {
      const capacity = qrByteCapacity(version, 'M')!;
      expect(smallestVersionFor(capacity, 'M')).toBe(version);
    }
  });

  it('states the module count the specification does', () => {
    expect(qrModuleCount(1)).toBe(21);
    expect(qrModuleCount(10)).toBe(57);
    expect(qrModuleCount(40)).toBe(177);
    expect(() => qrModuleCount(0)).toThrow();
    expect(() => qrModuleCount(41)).toThrow();
    expect(() => qrModuleCount(10.5)).toThrow();
  });
});

describe('geometry keeps modules on whole pixels', () => {
  it('floors the scale to an integer and sizes the canvas by multiplication', () => {
    // The defect this replaces: 400 px across 97 modules is 4.12 device pixels
    // each, so most modules get four and roughly one in eight gets five.
    const geometry = planQrGeometry({ version: 18, budgetCssPx: 400 });
    expect(geometry.totalModules).toBe(97);
    expect(geometry.moduleScale).toBe(4);
    expect(Number.isInteger(geometry.moduleScale)).toBe(true);
    expect(geometry.pixelSize).toBe(97 * 4);
    expect(geometry.pixelSize).toBeLessThanOrEqual(400);
  });

  it('never exceeds its budget and never lands on a fractional module', () => {
    for (const version of QR_ALL_VERSIONS) {
      for (const budget of [200, 320, 400, 480, 640, 1024]) {
        const totalModules = qrModuleCount(version) + 2 * QR_QUIET_ZONE_MODULES;
        if (budget < totalModules) {
          expect(() => planQrGeometry({ version, budgetCssPx: budget })).toThrow();
          continue;
        }
        const geometry = planQrGeometry({ version, budgetCssPx: budget });
        expect(geometry.pixelSize).toBeLessThanOrEqual(budget);
        expect(geometry.pixelSize % geometry.totalModules).toBe(0);
        expect(geometry.pixelSize / geometry.totalModules).toBe(geometry.moduleScale);
      }
    }
  });

  it('presents at the size it drew, so the browser resamples nothing', () => {
    for (const ratio of [1, 1.25, 1.5, 2, 3]) {
      const geometry = planQrGeometry({ version: 18, budgetCssPx: 400, devicePixelRatio: ratio });
      // More device pixels means more pixels per module, not a bigger box.
      expect(geometry.cssSize).toBeLessThanOrEqual(400);
      expect(geometry.cssSize * ratio).toBeCloseTo(geometry.pixelSize, 6);
      expect(geometry.moduleScale).toBe(Math.floor((400 * ratio) / geometry.totalModules));
    }
  });

  it('refuses rather than drawing a symbol with sub-pixel modules', () => {
    // Version 40 is 185 modules with its quiet zone. 100 CSS pixels cannot give
    // each one a whole pixel, and quietly drawing it anyway is the failure this
    // guards against.
    expect(() => planQrGeometry({ version: 40, budgetCssPx: 100 })).toThrow(/whole pixel/);
    expect(() => planQrGeometry({ version: 10, budgetCssPx: 0 })).toThrow();
    expect(() => planQrGeometry({ version: 10, budgetCssPx: 400, devicePixelRatio: 0 })).toThrow();
  });

  it('will not accept a quiet zone below the specified minimum', () => {
    expect(() => planQrGeometry({ version: 10, budgetCssPx: 400, quietZoneModules: 3 })).toThrow(/quiet/i);
    expect(planQrGeometry({ version: 10, budgetCssPx: 400, quietZoneModules: 4 }).quietZoneModules).toBe(4);
  });

  it('says how many camera pixels a symbol occupies at a sampling density', () => {
    // The useful form of "will this fit in the frame": version 32 at 3 px per
    // module needs 459 camera pixels across, quiet zone included.
    expect(cameraPixelsForSymbol(32, 3)).toBe(459);
    expect(cameraPixelsForSymbol(10, 2.5)).toBe(162.5);
    expect(cameraPixelsForSymbol(40, 4)).toBe(740);
  });
});
