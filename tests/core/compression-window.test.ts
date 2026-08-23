import { describe, expect, it } from 'vitest';

import {
  DeqrV2Error,
  DeqrV2Manifest,
  V2_COMPRESSION,
  V2_COMPRESSION_WINDOW,
  V2_FEC_PROFILE,
  V2_LIMITS,
  V2_MANIFEST_LAYOUT,
  V2_MIN_GZIP_MEMBER_BYTES,
  V2_WINDOW_LENGTH_PREFIX_BYTES,
  compressionWindowBytes,
  parseManifestFrame,
  planCompressionWindows,
  planSegmentation,
  serializeManifestFrame,
  windowOriginalRange,
  windowPlanFromManifest,
} from '../../src/core/protocol-v2';
import { crc32 } from '../../src/core/crc32';

const SEGMENT_SIZE = 1024 * 1024;
const SYMBOL_SIZE = 1_024;

function manifest(overrides: Partial<DeqrV2Manifest> = {}): DeqrV2Manifest {
  const transportSize = overrides.transportSize ?? 3_000_000n;
  const derived = planSegmentation({
    transportSize,
    segmentSizeBytes: SEGMENT_SIZE,
    symbolSizeBytes: SYMBOL_SIZE,
  });
  return {
    featureFlags: 0,
    sessionId: 0x5eed_1234,
    fileId: 0x0a0b_0c0d,
    originalSize: 12_000_000n,
    transportSize,
    segmentSizeBytes: SEGMENT_SIZE,
    symbolSizeBytes: SYMBOL_SIZE,
    segmentCount: derived.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.GZIP,
    compressionParam: V2_COMPRESSION_WINDOW.defaultLog2,
    transportProfileId: 0,
    sha256: new Uint8Array(32).fill(0xab),
    filename: 'sample.bin',
    mimeType: 'application/octet-stream',
    ...overrides,
  };
}

/** Re-seals a mutated frame so a rejection is provably about the mutation. */
function reseal(bytes: Uint8Array): Uint8Array {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(bytes.length - 4, crc32(bytes, 0, bytes.length - 4));
  return bytes;
}

describe('compressionParam carries a window exponent', () => {
  it('turns into a power-of-two window across its whole range', () => {
    expect(compressionWindowBytes(V2_COMPRESSION_WINDOW.minLog2)).toBe(64 * 1024);
    expect(compressionWindowBytes(V2_COMPRESSION_WINDOW.defaultLog2)).toBe(1024 * 1024);
    expect(compressionWindowBytes(V2_COMPRESSION_WINDOW.maxLog2)).toBe(64 * 1024 * 1024);
  });

  it('refuses an exponent outside it, rather than computing a window nobody meant', () => {
    for (const bad of [0, 6, 15, 27, 64, 1.5, -1, Number.NaN]) {
      expect(() => compressionWindowBytes(bad)).toThrow(DeqrV2Error);
    }
  });
});

describe('the window plan divides original bytes, never transport bytes', () => {
  it('counts whole windows with a possibly shorter last one', () => {
    const plan = planCompressionWindows({
      originalSize: 3n * 1024n * 1024n + 7n,
      compressionParam: 20,
    });
    expect(plan.windowBytes).toBe(1024 * 1024);
    expect(plan.windowCount).toBe(4);
    expect(plan.lastWindowBytes).toBe(7);
  });

  it('gives an exact original range per window, ending at the file', () => {
    const plan = planCompressionWindows({ originalSize: 2_500_000n, compressionParam: 20 });
    expect(windowOriginalRange(plan, 0)).toEqual({ start: 0n, end: 1_048_576n });
    expect(windowOriginalRange(plan, 2)).toEqual({ start: 2_097_152n, end: 2_500_000n });
    expect(() => windowOriginalRange(plan, 3)).toThrow(DeqrV2Error);
  });

  it('is derived from the manifest, and is null when nothing is compressed', () => {
    expect(windowPlanFromManifest(manifest())?.windowCount).toBe(12);
    const plain = manifest({
      compressionMode: V2_COMPRESSION.NONE,
      compressionParam: 0,
      originalSize: 3_000_000n,
    });
    expect(windowPlanFromManifest(plain)).toBeNull();
  });

  it('refuses an original size that would need more windows than a u32 can index', () => {
    // The ceiling Phase 08 introduces: 2^32 windows at the largest legal window
    // is 2^58 original bytes. Above that a compressed transfer cannot be
    // described, and saying so is better than silently truncating a count.
    const beyond = 2n ** 59n;
    expect(() => planCompressionWindows({
      originalSize: beyond,
      compressionParam: V2_COMPRESSION_WINDOW.maxLog2,
    })).toThrow(DeqrV2Error);
    expect(() => planCompressionWindows({
      originalSize: 2n ** 57n,
      compressionParam: V2_COMPRESSION_WINDOW.maxLog2,
    })).not.toThrow();
  });
});

describe('a compressed manifest is checked the same way in both directions', () => {
  it('round-trips a real one', () => {
    const parsed = parseManifestFrame(serializeManifestFrame(manifest()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.compressionMode).toBe(V2_COMPRESSION.GZIP);
    expect(parsed.value.compressionParam).toBe(V2_COMPRESSION_WINDOW.defaultLog2);
    expect(parsed.value.transportSize).toBeLessThan(parsed.value.originalSize);
  });

  it('refuses a window exponent out of range, writing and reading', () => {
    expect(() => serializeManifestFrame(manifest({ compressionParam: 6 }))).toThrow(DeqrV2Error);

    const bytes = serializeManifestFrame(manifest());
    bytes[V2_MANIFEST_LAYOUT.compressionParam] = 6;
    const parsed = parseManifestFrame(reseal(bytes));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error.code).toBe('FIELD_OUT_OF_RANGE');
  });

  it('refuses a container declared larger than the file it carries', () => {
    // The shape a sender that ignored its own threshold would produce, and the
    // shape an attacker would use to make a receiver reserve an expansion.
    expect(() => serializeManifestFrame(manifest({
      originalSize: 2_000_000n,
      transportSize: 3_000_000n,
    }))).toThrow(DeqrV2Error);

    const bytes = serializeManifestFrame(manifest());
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .setBigUint64(V2_MANIFEST_LAYOUT.originalSize, 2_000_000n);
    const parsed = parseManifestFrame(reseal(bytes));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error.code).toBe('INCONSISTENT_MANIFEST');
  });

  it('refuses a container too small to hold the records its windows need', () => {
    // 12 MiB of original at a 64 KiB window is 184 windows, each of which must
    // carry at least a length prefix and an empty gzip member.
    const windows = planCompressionWindows({
      originalSize: 12_000_000n,
      compressionParam: V2_COMPRESSION_WINDOW.minLog2,
    });
    const floor = BigInt(windows.windowCount) * BigInt(V2_WINDOW_LENGTH_PREFIX_BYTES + V2_MIN_GZIP_MEMBER_BYTES);
    expect(() => serializeManifestFrame(manifest({
      transportSize: floor - 1n,
      compressionParam: V2_COMPRESSION_WINDOW.minLog2,
      segmentSizeBytes: V2_LIMITS.minSegmentSizeBytes,
    }))).toThrow(DeqrV2Error);
  });

  it('still requires the two sizes to agree when nothing is compressed', () => {
    expect(() => serializeManifestFrame(manifest({
      compressionMode: V2_COMPRESSION.NONE,
      compressionParam: 0,
      originalSize: 9_000_000n,
    }))).toThrow(DeqrV2Error);
    expect(() => serializeManifestFrame(manifest({
      compressionMode: V2_COMPRESSION.NONE,
      compressionParam: 20,
      originalSize: 3_000_000n,
    }))).toThrow(DeqrV2Error);
  });
});
