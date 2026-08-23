import { describe, expect, it } from 'vitest';

import { crc32 } from '../../src/core/crc32';
import { serializeFrameHeader } from '../../src/core/protocol';
import {
  DeqrV2DataFrame,
  DeqrV2Error,
  DeqrV2Manifest,
  V2_COMPRESSION,
  V2_COMPRESSION_WINDOW,
  V2_DATA_LAYOUT,
  V2_FEC_PROFILE,
  V2_FLAG_CRITICAL_MASK,
  V2_FRAME_TYPE,
  V2_LIMITS,
  V2_MAGIC_0,
  V2_MAGIC_1,
  V2_MANIFEST_LAYOUT,
  V2_PROTOCOL_VERSION,
  detectProtocolVersion,
  isSafeSize,
  parseDataFrame,
  parseFrame,
  parseManifestFrame,
  planSegmentation,
  segmentByteRange,
  segmentPlanFromManifest,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
  symbolByteRange,
  toSafeNumber,
  validateDataFrameAgainstManifest,
} from '../../src/core/protocol-v2';

const SESSION_ID = 0x5eed_1234;
const FILE_ID = 0x0a0b_0c0d;
const SYMBOL_SIZE = 1_024;
const SEGMENT_SIZE = 1024 * 1024;

function digest(fill = 0xab): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function manifest(overrides: Partial<DeqrV2Manifest> = {}): DeqrV2Manifest {
  const transportSize = overrides.transportSize ?? 3_000_000n;
  const segmentSizeBytes = overrides.segmentSizeBytes ?? SEGMENT_SIZE;
  const symbolSizeBytes = overrides.symbolSizeBytes ?? SYMBOL_SIZE;
  const derived = planSegmentation({ transportSize, segmentSizeBytes, symbolSizeBytes });
  return {
    featureFlags: 0,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    originalSize: transportSize,
    transportSize,
    segmentSizeBytes,
    symbolSizeBytes,
    segmentCount: derived.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: digest(),
    filename: 'sample.bin',
    mimeType: 'application/octet-stream',
    ...overrides,
  };
}

function dataFrame(overrides: Partial<DeqrV2DataFrame> = {}): DeqrV2DataFrame {
  return {
    frameType: V2_FRAME_TYPE.SOURCE,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    segmentIndex: 0,
    symbolId: 0,
    sourceSymbolCount: 1_024,
    frameFlags: 0,
    payload: new Uint8Array(SYMBOL_SIZE).fill(0x5a),
    ...overrides,
  };
}

/** Re-seals a mutated frame so a rejection is provably about the mutation. */
function reseal(bytes: Uint8Array): Uint8Array {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(bytes.length - 4, crc32(bytes, 0, bytes.length - 4));
  return bytes;
}

function expectRejection<T>(result: { ok: boolean; error?: DeqrV2Error }, code: string): void {
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe(code);
}

describe('CRC-32/ISO-HDLC', () => {
  it('matches the published check value', () => {
    // The standard check vector for CRC-32/ISO-HDLC.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf4_3926);
  });

  it('is empty-safe and range-clamped', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes, 0, 999)).toBe(0xcbf4_3926);
    expect(crc32(bytes, -5, 9)).toBe(0xcbf4_3926);
  });
});

describe('DEQR v2 manifest round trip', () => {
  it('round-trips every field and is byte-deterministic', () => {
    const model = manifest();
    const first = serializeManifestFrame(model);
    const second = serializeManifestFrame(model);
    expect(Array.from(second)).toEqual(Array.from(first));

    const parsed = parseManifestFrame(first);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ...model, sha256: model.sha256 });
  });

  it('carries the v2 prefix', () => {
    const bytes = serializeManifestFrame(manifest());
    expect(bytes[V2_MANIFEST_LAYOUT.magic0]).toBe(V2_MAGIC_0);
    expect(bytes[V2_MANIFEST_LAYOUT.magic1]).toBe(V2_MAGIC_1);
    expect(bytes[V2_MANIFEST_LAYOUT.version]).toBe(V2_PROTOCOL_VERSION);
    expect(bytes[V2_MANIFEST_LAYOUT.frameType]).toBe(V2_FRAME_TYPE.MANIFEST);
  });

  it('round-trips a multi-byte UTF-8 filename and an empty MIME type', () => {
    const model = manifest({ filename: 'ünïcode-ファイル.bin', mimeType: '' });
    const parsed = parseManifestFrame(serializeManifestFrame(model));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filename).toBe('ünïcode-ファイル.bin');
    expect(parsed.value.mimeType).toBe('');
  });

  it('sanitizes a hostile filename on the way out and again on the way in', () => {
    const parsed = parseManifestFrame(serializeManifestFrame(manifest({ filename: '../../etc/passwd' })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filename).toBe('passwd');
  });

  it('keeps originalSize and transportSize independent under compression', () => {
    const model = manifest({
      originalSize: 12_345_678n,
      transportSize: 3_000_000n,
      compressionMode: V2_COMPRESSION.GZIP,
      // Phase 08 gave this byte a meaning: log2 of the compression window.
      compressionParam: V2_COMPRESSION_WINDOW.defaultLog2,
      transportProfileId: 0,
    });
    const parsed = parseManifestFrame(serializeManifestFrame(model));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.originalSize).toBe(12_345_678n);
    expect(parsed.value.transportSize).toBe(3_000_000n);
  });
});

describe('DEQR v2 data frame round trip', () => {
  it('round-trips a source frame and is byte-deterministic', () => {
    const model = dataFrame();
    const first = serializeDataFrame(model);
    expect(Array.from(serializeDataFrame(model))).toEqual(Array.from(first));
    expect(first.length).toBe(V2_DATA_LAYOUT.overheadBytes + SYMBOL_SIZE);

    const parsed = parseDataFrame(first);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(model);
  });

  it('round-trips a repair frame whose id continues past the source range', () => {
    const model = dataFrame({ frameType: V2_FRAME_TYPE.REPAIR, symbolId: 5_000 });
    const parsed = parseDataFrame(serializeDataFrame(model));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frameType).toBe(V2_FRAME_TYPE.REPAIR);
    expect(parsed.value.symbolId).toBe(5_000);
  });

  it('copies the payload rather than aliasing the received buffer', () => {
    const bytes = serializeDataFrame(dataFrame());
    const parsed = parseDataFrame(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    bytes[V2_DATA_LAYOUT.payload] ^= 0xff;
    expect(parsed.value.payload[0]).toBe(0x5a);
  });

  it('parses correctly from a non-zero byteOffset view', () => {
    const frame = serializeDataFrame(dataFrame());
    const backing = new Uint8Array(frame.length + 7);
    backing.set(frame, 7);
    const view = backing.subarray(7);
    const parsed = parseDataFrame(view);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.symbolId).toBe(0);
  });

  it('dispatches through parseFrame', () => {
    const asManifest = parseFrame(serializeManifestFrame(manifest()));
    expect(asManifest.ok && asManifest.value.kind).toBe('manifest');
    const asData = parseFrame(serializeDataFrame(dataFrame()));
    expect(asData.ok && asData.value.kind).toBe('data');
  });
});

describe('version detection keeps v1 and v2 unambiguous', () => {
  it('classifies a real v1 frame as v1', () => {
    const v1 = new Uint8Array(serializeFrameHeader({
      protocolVersion: 1,
      sessionId: 7,
      segmentNumber: 0,
      sequenceNumber: 3,
      blockCount: 10,
      blockSize: 512,
      totalPayloadLength: 5_000,
    }));
    expect(detectProtocolVersion(v1)).toBe(1);
  });

  it('classifies v2 manifest and data frames as v2', () => {
    expect(detectProtocolVersion(serializeManifestFrame(manifest()))).toBe(2);
    expect(detectProtocolVersion(serializeDataFrame(dataFrame()))).toBe(2);
  });

  it('classifies unrelated bytes as neither', () => {
    expect(detectProtocolVersion(new Uint8Array([0x99, 0x88, 0x77, 0x66]))).toBeNull();
    expect(detectProtocolVersion(new Uint8Array(0))).toBeNull();
    // v2 magic with a version this build does not implement is not "v2 we can read".
    expect(detectProtocolVersion(new Uint8Array([V2_MAGIC_0, V2_MAGIC_1, 9]))).toBeNull();
  });

  it('refuses to reinterpret a v1 frame as v2, and says so specifically', () => {
    const v1 = new Uint8Array(48);
    v1[0] = 1;
    expectRejection(parseFrame(v1), 'V1_FRAME');
    expectRejection(parseDataFrame(v1), 'V1_FRAME');
    expectRejection(parseManifestFrame(v1), 'V1_FRAME');
  });
});

describe('parser bounds and malformed input', () => {
  it('rejects a short buffer before reading any field', () => {
    expectRejection(parseFrame(new Uint8Array(3)), 'FRAME_TOO_SHORT');
    expectRejection(parseDataFrame(new Uint8Array([V2_MAGIC_0, V2_MAGIC_1, 2, V2_FRAME_TYPE.SOURCE])), 'FRAME_TOO_SHORT');
  });

  it('rejects bad magic, unsupported version, and unknown frame type', () => {
    const base = serializeDataFrame(dataFrame());
    const badMagic = base.slice(); badMagic[0] = 0x58;
    expectRejection(parseFrame(badMagic), 'BAD_MAGIC');

    const badVersion = base.slice(); badVersion[V2_DATA_LAYOUT.version] = 3;
    expectRejection(parseFrame(badVersion), 'UNSUPPORTED_VERSION');

    const badType = base.slice(); badType[V2_DATA_LAYOUT.frameType] = 0x7f;
    expectRejection(parseFrame(badType), 'UNKNOWN_FRAME_TYPE');
  });

  it('rejects a single flipped payload bit', () => {
    const bytes = serializeDataFrame(dataFrame());
    bytes[V2_DATA_LAYOUT.payload + 17] ^= 0x01;
    expectRejection(parseDataFrame(bytes), 'CRC_MISMATCH');
  });

  it('rejects truncation and trailing bytes', () => {
    const frame = serializeDataFrame(dataFrame());
    expectRejection(parseDataFrame(frame.slice(0, frame.length - 1)), 'FRAME_TOO_SHORT');

    const padded = new Uint8Array(frame.length + 1);
    padded.set(frame);
    expectRejection(parseDataFrame(padded), 'TRAILING_BYTES');

    const manifestBytes = serializeManifestFrame(manifest());
    expectRejection(parseManifestFrame(manifestBytes.slice(0, 40)), 'FRAME_TOO_SHORT');
    const paddedManifest = new Uint8Array(manifestBytes.length + 2);
    paddedManifest.set(manifestBytes);
    expectRejection(parseManifestFrame(paddedManifest), 'TRAILING_BYTES');
  });

  it('refuses an impossible declared payload length without allocating it', () => {
    const bytes = reseal((() => {
      const frame = serializeDataFrame(dataFrame());
      new DataView(frame.buffer).setUint16(V2_DATA_LAYOUT.payloadLength, 0xffff);
      return frame;
    })());
    expectRejection(parseDataFrame(bytes), 'FIELD_OUT_OF_RANGE');
  });

  it('refuses a declared payload length that is legal but longer than the buffer', () => {
    const bytes = reseal((() => {
      const frame = serializeDataFrame(dataFrame());
      new DataView(frame.buffer).setUint16(V2_DATA_LAYOUT.payloadLength, V2_LIMITS.maxSymbolSizeBytes);
      return frame;
    })());
    expectRejection(parseDataFrame(bytes), 'FRAME_TOO_SHORT');
  });

  it('refuses a filename length that runs past the buffer', () => {
    const bytes = reseal((() => {
      const frame = serializeManifestFrame(manifest());
      new DataView(frame.buffer).setUint16(V2_MANIFEST_LAYOUT.filenameLength, V2_LIMITS.maxFilenameBytes);
      return frame;
    })());
    expectRejection(parseManifestFrame(bytes), 'FRAME_TOO_SHORT');
  });

  it('refuses a zero-length filename', () => {
    const bytes = reseal((() => {
      const frame = serializeManifestFrame(manifest());
      new DataView(frame.buffer).setUint16(V2_MANIFEST_LAYOUT.filenameLength, 0);
      return frame;
    })());
    expectRejection(parseManifestFrame(bytes), 'FIELD_OUT_OF_RANGE');
  });

  it('refuses invalid UTF-8 in the filename', () => {
    const bytes = reseal((() => {
      const frame = serializeManifestFrame(manifest({ filename: 'abcdefgh.bin' }));
      frame[V2_MANIFEST_LAYOUT.filename] = 0xff;
      frame[V2_MANIFEST_LAYOUT.filename + 1] = 0xfe;
      return frame;
    })());
    expectRejection(parseManifestFrame(bytes), 'INVALID_UTF8');
  });

  it('reports a transport profile id rather than rejecting it', () => {
    // Byte 43 was reserved-and-must-be-zero until Phase 04 spent it on the
    // transport profile id. The field is advisory - nothing about decoding
    // reads it - so an unrecognised value is reported, not refused. Refusing
    // would make every future profile a breaking change for this build.
    for (const declared of [0, 1, 2, 3, 4, 0x5a, 0xff]) {
      const bytes = reseal((() => {
        const frame = serializeManifestFrame(manifest());
        frame[V2_MANIFEST_LAYOUT.transportProfileId] = declared;
        return frame;
      })());
      const parsed = parseManifestFrame(bytes);
      expect(parsed.ok, `profile id ${declared}`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.transportProfileId).toBe(declared);
    }
  });

  it('refuses a profile id the serializer cannot express', () => {
    expect(() => serializeManifestFrame({ ...manifest(), transportProfileId: 256 })).toThrow(/u8/);
    expect(() => serializeManifestFrame({ ...manifest(), transportProfileId: -1 })).toThrow(/u8/);
  });

  it('refuses an unknown compression mode and an unknown FEC profile', () => {
    const badCompression = reseal((() => {
      const frame = serializeManifestFrame(manifest());
      frame[V2_MANIFEST_LAYOUT.compressionMode] = 0x40;
      return frame;
    })());
    expectRejection(parseManifestFrame(badCompression), 'UNSUPPORTED_COMPRESSION');

    const badProfile = reseal((() => {
      const frame = serializeManifestFrame(manifest());
      frame[V2_MANIFEST_LAYOUT.fecProfileId] = 0x40;
      return frame;
    })());
    expectRejection(parseManifestFrame(badProfile), 'UNSUPPORTED_FEC_PROFILE');
  });

  it('refuses a manifest whose segmentCount disagrees with its sizes', () => {
    const bytes = reseal((() => {
      const frame = serializeManifestFrame(manifest());
      new DataView(frame.buffer).setUint32(V2_MANIFEST_LAYOUT.segmentCount, 9_999);
      return frame;
    })());
    expectRejection(parseManifestFrame(bytes), 'INCONSISTENT_MANIFEST');
  });

  it('refuses a segment size that is not a whole number of symbols', () => {
    const bytes = reseal((() => {
      const frame = serializeManifestFrame(manifest());
      new DataView(frame.buffer).setUint16(V2_MANIFEST_LAYOUT.symbolSizeBytes, 1_000);
      return frame;
    })());
    expectRejection(parseManifestFrame(bytes), 'FIELD_OUT_OF_RANGE');
  });

  it('refuses a source symbol id at or above its own source-symbol count', () => {
    const bytes = reseal((() => {
      const frame = serializeDataFrame(dataFrame());
      new DataView(frame.buffer).setUint32(V2_DATA_LAYOUT.symbolId, 1_024);
      return frame;
    })());
    expectRejection(parseDataFrame(bytes), 'SYMBOL_OUT_OF_RANGE');
  });

  it('refuses a repair symbol id below the source-symbol count', () => {
    const bytes = reseal((() => {
      const frame = serializeDataFrame(dataFrame({ frameType: V2_FRAME_TYPE.REPAIR, symbolId: 2_000 }));
      new DataView(frame.buffer).setUint32(V2_DATA_LAYOUT.symbolId, 3);
      return frame;
    })());
    expectRejection(parseDataFrame(bytes), 'SYMBOL_OUT_OF_RANGE');
  });
});

describe('forward compatibility', () => {
  it('ignores unknown advisory flags', () => {
    const bytes = reseal((() => {
      const frame = serializeDataFrame(dataFrame());
      new DataView(frame.buffer).setUint16(V2_DATA_LAYOUT.frameFlags, 0x00f3);
      return frame;
    })());
    const parsed = parseDataFrame(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frameFlags).toBe(0x00f3);
  });

  it('rejects unknown critical flags on frames and manifests', () => {
    const frameBytes = reseal((() => {
      const frame = serializeDataFrame(dataFrame());
      new DataView(frame.buffer).setUint16(V2_DATA_LAYOUT.frameFlags, V2_FLAG_CRITICAL_MASK & 0x0100);
      return frame;
    })());
    expectRejection(parseDataFrame(frameBytes), 'UNSUPPORTED_CRITICAL_FEATURE');

    const manifestBytes = reseal((() => {
      const frame = serializeManifestFrame(manifest());
      new DataView(frame.buffer).setUint16(V2_MANIFEST_LAYOUT.featureFlags, 0x8000);
      return frame;
    })());
    expectRejection(parseManifestFrame(manifestBytes), 'UNSUPPORTED_CRITICAL_FEATURE');
  });

  it('accepts an advisory feature bit in a manifest', () => {
    const parsed = parseManifestFrame(serializeManifestFrame(manifest({ featureFlags: 0x0002 })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.featureFlags).toBe(0x0002);
  });
});

describe('serializer refuses to emit an invalid model', () => {
  it('rejects a wrong-size digest', () => {
    expect(() => serializeManifestFrame(manifest({ sha256: new Uint8Array(31) })))
      .toThrow(DeqrV2Error);
  });

  it('rejects a segmentCount that does not match the sizes', () => {
    expect(() => serializeManifestFrame(manifest({ segmentCount: 2 })))
      .toThrow(/segmentCount/);
  });

  it('rejects a compression parameter on an uncompressed transfer', () => {
    expect(() => serializeManifestFrame(manifest({ compressionParam: 6 })))
      .toThrow(/compressionParam/);
  });

  it('rejects a transportSize that differs from originalSize when uncompressed', () => {
    expect(() => serializeManifestFrame(manifest({ originalSize: 99n })))
      .toThrow(/transportSize/);
  });

  it('rejects a source symbol id outside its declared count', () => {
    expect(() => serializeDataFrame(dataFrame({ symbolId: 1_024 })))
      .toThrow(/symbolId/);
  });

  it('rejects an empty and an oversized payload', () => {
    expect(() => serializeDataFrame(dataFrame({ payload: new Uint8Array(0) }))).toThrow(/payload/);
    expect(() => serializeDataFrame(dataFrame({ payload: new Uint8Array(V2_LIMITS.maxSymbolSizeBytes + 1) })))
      .toThrow(/payload/);
  });

  it('rejects a critical feature bit it does not implement', () => {
    expect(() => serializeManifestFrame(manifest({ featureFlags: 0x0100 })))
      .toThrow(/critical/);
  });
});

describe('segmentation is bounded and 64-bit exact', () => {
  it('derives counts and ranges for a partial final segment', () => {
    const plan = planSegmentation({ transportSize: 200_000n, segmentSizeBytes: 65_536, symbolSizeBytes: 4_096 });
    expect(plan.segmentCount).toBe(4);
    expect(plan.symbolsPerFullSegment).toBe(16);
    expect(plan.lastSegmentBytes).toBe(200_000 - 3 * 65_536);
    expect(plan.symbolsInLastSegment).toBe(1);

    expect(sourceSymbolCountForSegment(plan, 0)).toBe(16);
    expect(sourceSymbolCountForSegment(plan, 3)).toBe(1);

    expect(segmentByteRange(plan, 0)).toEqual({ start: 0n, end: 65_536n });
    expect(segmentByteRange(plan, 3)).toEqual({ start: 196_608n, end: 200_000n });
    expect(symbolByteRange(plan, 3, 0)).toEqual({ start: 196_608n, end: 200_000n });
    expect(symbolByteRange(plan, 0, 1)).toEqual({ start: 4_096n, end: 8_192n });
  });

  it('refuses out-of-range segment and symbol indices', () => {
    const plan = planSegmentation({ transportSize: 200_000n, segmentSizeBytes: 65_536, symbolSizeBytes: 4_096 });
    expect(() => segmentByteRange(plan, 4)).toThrow(/segmentIndex/);
    expect(() => symbolByteRange(plan, 3, 1)).toThrow(/symbolId/);
  });

  it('refuses a segment size outside its bounds or misaligned to the symbol size', () => {
    expect(() => planSegmentation({ transportSize: 1_000n, segmentSizeBytes: 1_024, symbolSizeBytes: 512 }))
      .toThrow(/segmentSizeBytes/);
    expect(() => planSegmentation({ transportSize: 1_000n, segmentSizeBytes: 65_536, symbolSizeBytes: 1_000 }))
      .toThrow(/whole number/);
  });

  it('keeps decoder state proportional to a segment, never to the file', () => {
    const small = planSegmentation({ transportSize: 5n * 1024n * 1024n, segmentSizeBytes: 4 * 1024 * 1024, symbolSizeBytes: 1_024 });
    const huge = planSegmentation({ transportSize: 5n * 1024n * 1024n * 1024n * 1024n, segmentSizeBytes: 4 * 1024 * 1024, symbolSizeBytes: 1_024 });
    // The per-segment working set is identical: only the number of segments moves.
    expect(huge.symbolsPerFullSegment).toBe(small.symbolsPerFullSegment);
    expect(huge.symbolsPerFullSegment).toBe(4_096);
    expect(huge.segmentCount).toBeGreaterThan(small.segmentCount);
  });
});

describe('multi-gigabyte files without allocating them', () => {
  it('represents a 5 GiB file end to end', () => {
    const fiveGib = 5n * 1024n * 1024n * 1024n;
    const model = manifest({
      transportSize: fiveGib,
      originalSize: fiveGib,
      segmentSizeBytes: 4 * 1024 * 1024,
      symbolSizeBytes: 1_024,
      filename: 'five-gibibytes.bin',
    });
    const bytes = serializeManifestFrame(model);
    // The whole description of a 5 GiB transfer fits in one small QR payload.
    expect(bytes.length).toBeLessThan(200);

    const parsed = parseManifestFrame(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.originalSize).toBe(fiveGib);
    expect(parsed.value.segmentCount).toBe(1_280);
  });

  it('represents sizes and offsets above Number.MAX_SAFE_INTEGER without loss', () => {
    // 2^57, which is 144 petabytes and a thousand times past the point where a
    // JavaScript number stops counting in units. It was 2^63 until Phase 08:
    // a compressed transfer is divided into windows, the window count is a u32,
    // and at the largest legal window (64 MiB) that caps `originalSize` at
    // 2^58. The ceiling is documented in `PROTOCOL-V2.md` and asserted below.
    const huge = 2n ** 57n + 12_345n;
    expect(isSafeSize(huge)).toBe(false);

    const model = manifest({
      transportSize: 268_435_456_000_000n,
      originalSize: huge,
      compressionMode: V2_COMPRESSION.GZIP,
      compressionParam: V2_COMPRESSION_WINDOW.maxLog2,
      transportProfileId: 0,
      segmentSizeBytes: 64 * 1024 * 1024,
      symbolSizeBytes: 2_048,
    });
    const parsed = parseManifestFrame(serializeManifestFrame(model));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Exact, not approximately equal. A number round trip would have lost the 12,345.
    expect(parsed.value.originalSize).toBe(huge);
    expect(parsed.value.originalSize > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('computes an offset beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const segmentSizeBytes = 64 * 1024 * 1024;
    const segmentCount = 4_000_000_000n;
    const transportSize = BigInt(segmentSizeBytes) * segmentCount;
    const plan = planSegmentation({ transportSize, segmentSizeBytes, symbolSizeBytes: 2_048 });
    expect(plan.segmentCount).toBe(4_000_000_000);

    const range = segmentByteRange(plan, 3_999_999_999);
    expect(range.start).toBe(BigInt(segmentSizeBytes) * 3_999_999_999n);
    expect(range.start > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(range.end).toBe(transportSize);
  });

  it('refuses to convert an unsafe size to a number instead of rounding it', () => {
    expect(() => toSafeNumber(2n ** 60n, 'originalSize')).toThrow(DeqrV2Error);
    expect(() => toSafeNumber(2n ** 60n, 'originalSize')).toThrow(/PRECISION|number without loss/);
    expect(toSafeNumber(1_048_576n, 'segmentSize')).toBe(1_048_576);
  });

  it('refuses a transfer that would need more segments than the field can index', () => {
    expect(() => planSegmentation({
      transportSize: (1n << 60n),
      segmentSizeBytes: 64 * 1024,
      symbolSizeBytes: 1_024,
    })).toThrow(/segments/);
  });
});

describe('frames are attributable to the transfer that owns them', () => {
  const model = manifest({ transportSize: 200_000n, originalSize: 200_000n, segmentSizeBytes: 65_536, symbolSizeBytes: 4_096 });
  const plan = segmentPlanFromManifest(model);

  function symbol(overrides: Partial<DeqrV2DataFrame> = {}): DeqrV2DataFrame {
    const segmentIndex = overrides.segmentIndex ?? 0;
    // A frame claiming a segment the manifest does not describe is exactly the
    // case under test, so the count cannot be derived from the plan for it.
    const inRange = segmentIndex < plan.segmentCount;
    return dataFrame({
      segmentIndex,
      symbolId: 0,
      sourceSymbolCount: inRange ? sourceSymbolCountForSegment(plan, segmentIndex) : plan.symbolsPerFullSegment,
      payload: new Uint8Array(4_096).fill(1),
      ...overrides,
    });
  }

  it('accepts a frame that matches its manifest', () => {
    expect(validateDataFrameAgainstManifest(symbol(), model, plan).ok).toBe(true);
    expect(validateDataFrameAgainstManifest(symbol({ segmentIndex: 3 }), model, plan).ok).toBe(true);
  });

  it('rejects a frame from another session or another file', () => {
    expectRejection(validateDataFrameAgainstManifest(symbol({ sessionId: 42 }), model, plan), 'SESSION_MISMATCH');
    expectRejection(validateDataFrameAgainstManifest(symbol({ fileId: 42 }), model, plan), 'SESSION_MISMATCH');
  });

  it('rejects a segment index the manifest does not describe', () => {
    expectRejection(validateDataFrameAgainstManifest(symbol({ segmentIndex: 4 }), model, plan), 'SEGMENT_OUT_OF_RANGE');
  });

  it('rejects a source-symbol count the manifest contradicts', () => {
    expectRejection(
      validateDataFrameAgainstManifest(symbol({ segmentIndex: 3, sourceSymbolCount: 16 }), model, plan),
      'INCONSISTENT_MANIFEST',
    );
  });

  it('rejects a payload that is not the declared symbol size', () => {
    expectRejection(
      validateDataFrameAgainstManifest(symbol({ payload: new Uint8Array(512) }), model, plan),
      'FIELD_OUT_OF_RANGE',
    );
  });
});
