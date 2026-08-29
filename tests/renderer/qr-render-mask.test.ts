import { describe, it, expect } from 'vitest';
import { resolveQrRenderPlan, QrPayloadTooLargeError } from '../../src/renderer/qr-render';
import { QR_QUIET_ZONE_MODULES } from '../../src/core/qr-capacity';

describe('qr-render mask and quiet-zone', () => {
  it('pins mask 0..7 deterministically', () => {
    const planAuto = resolveQrRenderPlan({ frameBytes: 500, eccLevel: 'L', budgetCssPx: 480 });
    expect(planAuto.maskPattern).toBeUndefined();
    for (let m = 0; m <= 7; m++) {
      const pinned = resolveQrRenderPlan({ frameBytes: 500, eccLevel: 'L', budgetCssPx: 480, maskPattern: m as 0|1|2|3|4|5|6|7 });
      expect(pinned.maskPattern).toBe(m);
      expect(pinned.version).toBe(planAuto.version); // same version, different mask
    }
  });

  it('rejects invalid mask', () => {
    expect(() => resolveQrRenderPlan({ frameBytes: 500, eccLevel: 'L', budgetCssPx: 480, maskPattern: 8 as never })).toThrow(/maskPattern/);
  });

  it('version stable across same frameBytes', () => {
    const a = resolveQrRenderPlan({ frameBytes: 718, eccLevel: 'L', budgetCssPx: 480 });
    const b = resolveQrRenderPlan({ frameBytes: 718, eccLevel: 'L', budgetCssPx: 400 });
    expect(a.version).toBe(b.version);
    expect(a.version).toBe(18);
  });

  it('throws QrPayloadTooLargeError when frame does not fit', () => {
    expect(() => resolveQrRenderPlan({ frameBytes: 5000, eccLevel: 'L', budgetCssPx: 480 })).toThrow(QrPayloadTooLargeError);
    try {
      resolveQrRenderPlan({ frameBytes: 5000, eccLevel: 'L', budgetCssPx: 480 });
    } catch (e) {
      expect((e as QrPayloadTooLargeError).frameBytes).toBe(5000);
    }
  });

  it('preserves quiet-zone 4 as standard, lower requires validation', () => {
    const standard = resolveQrRenderPlan({ frameBytes: 500, eccLevel: 'L', budgetCssPx: 480, quietZoneModules: 4 });
    expect(standard.geometry.quietZoneModules).toBe(4);
    expect(() => resolveQrRenderPlan({ frameBytes: 500, eccLevel: 'L', budgetCssPx: 480, quietZoneModules: 2 as never })).toThrow(/quietZoneModules.*requires physical validation/);
    expect(QR_QUIET_ZONE_MODULES).toBe(4);
  });

  it('deterministic chosen/pinned mask config', () => {
    const a = resolveQrRenderPlan({ frameBytes: 1000, eccLevel: 'L', budgetCssPx: 480, maskPattern: 3 });
    const b = resolveQrRenderPlan({ frameBytes: 1000, eccLevel: 'L', budgetCssPx: 480, maskPattern: 3 });
    expect(a.maskPattern).toBe(b.maskPattern);
    expect(a.version).toBe(b.version);
    expect(a.geometry.moduleScale).toBe(b.geometry.moduleScale);
  });
});
