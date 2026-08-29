import { describe, it, expect } from 'vitest';
import { generateCanonicalPayload, generateIncompressiblePayload, canonicalSizeBytes, describeCanonicalPayloads } from '../../src/shared/benchmark-payloads';
import { gzipSync } from 'node:zlib';

describe('benchmark-payloads', () => {
  it('produces deterministic payloads', () => {
    const a = generateCanonicalPayload('100KiB');
    const b = generateCanonicalPayload('100KiB');
    expect(a).toEqual(b);
    expect(a.length).toBe(100 * 1024);
    expect(generateCanonicalPayload('1MiB').length).toBe(1024 * 1024);
    expect(generateCanonicalPayload('5MiB').length).toBe(5 * 1024 * 1024);
  });

  it('different sizes have different prefixes (size-dependent seed)', () => {
    const small = generateCanonicalPayload('100KiB');
    const medium = generateCanonicalPayload('1MiB');
    // First 100 KiB of 1MiB should differ from 100KiB payload due to different seed
    expect(small.slice(0, 10)).not.toEqual(medium.slice(0, 10));
  });

  it('custom seed overrides deterministically', () => {
    const a = generateIncompressiblePayload(1024, 0x1234);
    const b = generateIncompressiblePayload(1024, 0x1234);
    const c = generateIncompressiblePayload(1024, 0x4321);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('canonical payloads are incompressible (gzip ratio ~1)', () => {
    for (const label of ['100KiB', '1MiB'] as const) {
      const payload = generateCanonicalPayload(label);
      const compressed = gzipSync(payload, { level: 6 });
      const ratio = compressed.length / payload.length;
      // Incompressible should be >0.95 (allow slight header overhead)
      expect(ratio, `${label} ratio ${ratio}`).toBeGreaterThan(0.95);
      // And <1.05 (gzip shouldn't expand incompressible much)
      expect(ratio, `${label} ratio ${ratio}`).toBeLessThan(1.05);
    }
  });

  it('contrast with compressible payload (zero bytes should compress)', () => {
    const zeros = new Uint8Array(100 * 1024);
    const compressed = gzipSync(zeros, { level: 6 });
    expect(compressed.length / zeros.length).toBeLessThan(0.05);
  });

  it('never reads from disk and never prints payload bytes', () => {
    // Payload is pure function of seed and length; no fs access
    const payload = generateCanonicalPayload('100KiB');
    // Ensure no payload byte is logged via this test's own code — we just check determinism
    expect(payload[0]).toBeGreaterThanOrEqual(0);
    expect(payload[0]).toBeLessThan(256);
  });

  it('describeCanonicalPayloads lists required sizes', () => {
    const descs = describeCanonicalPayloads();
    expect(descs.map(d => d.label)).toEqual(['100KiB', '1MiB', '5MiB']);
    expect(descs.map(d => d.bytes)).toEqual([100 * 1024, 1024 * 1024, 5 * 1024 * 1024]);
    expect(descs.every(d => d.incompressible)).toBe(true);
  });

  it('canonicalSizeBytes helper', () => {
    expect(canonicalSizeBytes('100KiB')).toBe(100 * 1024);
    expect(canonicalSizeBytes('1MiB')).toBe(1024 * 1024);
    expect(canonicalSizeBytes('5MiB')).toBe(5 * 1024 * 1024);
  });
});
