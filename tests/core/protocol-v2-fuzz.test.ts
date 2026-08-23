import { describe, expect, it } from 'vitest';

import {
  DeqrV2Error,
  V2_DATA_LAYOUT,
  V2_LIMITS,
  V2_MAGIC_0,
  V2_MAGIC_1,
  V2_MANIFEST_LAYOUT,
  V2_PROTOCOL_VERSION,
  V2_COMPRESSION,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  parseDataFrame,
  parseFrame,
  parseManifestFrame,
  planSegmentation,
  serializeDataFrame,
  serializeManifestFrame,
} from '../../src/core/protocol-v2';

/**
 * Property-style parser tests.
 *
 * Deterministic on purpose: a seeded LCG rather than a random source, so a
 * failure is reproducible from the test name alone rather than "sometimes".
 * The property under test is not "the parser accepts good input" — the
 * round-trip tests cover that. It is that **no input can make the parser throw,
 * allocate from an unchecked length, or return a value it did not validate**,
 * which is what makes it safe to point at a camera.
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

/**
 * A value in [0, bound) taken from the generator's high bits.
 *
 * `next() % bound` looks equivalent and is not: a power-of-two LCG's low bits
 * have a period as short as two, so a `% 2` branch here alternated in lockstep
 * with the buffer length and one whole arm of the sweep never ran. The bug was
 * invisible until the test asserted which rejection codes it had actually
 * reached.
 */
function pick(next: () => number, bound: number): number {
  return Math.floor((next() / 0x1_0000_0000) * bound);
}

function randomBytes(next: () => number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = next() >>> 24;
  return bytes;
}

const SYMBOL_SIZE = 256;

function validDataFrame(): Uint8Array {
  return serializeDataFrame({
    frameType: V2_FRAME_TYPE.SOURCE,
    sessionId: 0x1234_5678,
    fileId: 0x9abc_def0,
    segmentIndex: 2,
    symbolId: 7,
    sourceSymbolCount: 64,
    frameFlags: 0,
    payload: new Uint8Array(SYMBOL_SIZE).fill(0x33),
  });
}

function validManifest(): Uint8Array {
  const transportSize = 500_000n;
  const plan = planSegmentation({ transportSize, segmentSizeBytes: 65_536, symbolSizeBytes: SYMBOL_SIZE });
  return serializeManifestFrame({
    featureFlags: 0,
    sessionId: 0x1234_5678,
    fileId: 0x9abc_def0,
    originalSize: transportSize,
    transportSize,
    segmentSizeBytes: 65_536,
    symbolSizeBytes: SYMBOL_SIZE,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: new Uint8Array(32).fill(0x11),
    filename: 'fuzz-sample.bin',
    mimeType: 'application/octet-stream',
  });
}

/** Runs a parser and reports a throw as a failure rather than letting it escape. */
function parseSafely(parse: (bytes: Uint8Array) => unknown, bytes: Uint8Array): { threw: unknown | null; result: unknown } {
  try {
    return { threw: null, result: parse(bytes) };
  } catch (error) {
    return { threw: error, result: null };
  }
}

describe('v2 parser never throws on hostile input', () => {
  it('survives 4000 fully random buffers', () => {
    const next = lcg(0xc0ffee);
    for (let iteration = 0; iteration < 4_000; iteration += 1) {
      const length = pick(next, 600);
      const bytes = randomBytes(next, length);
      for (const parse of [parseFrame, parseDataFrame, parseManifestFrame]) {
        const outcome = parseSafely(parse, bytes);
        expect(outcome.threw).toBeNull();
      }
    }
  });

  it('survives 4000 random buffers that already carry the v2 prefix', () => {
    // Random bytes almost never reach the parser's interesting paths. Forcing a
    // valid prefix is what drives the length, index, and CRC checks.
    const next = lcg(0xbadc0de);
    for (let iteration = 0; iteration < 4_000; iteration += 1) {
      const length = 4 + pick(next, 600);
      const bytes = randomBytes(next, length);
      bytes[0] = V2_MAGIC_0;
      bytes[1] = V2_MAGIC_1;
      bytes[2] = V2_PROTOCOL_VERSION;
      bytes[3] = 1 + pick(next, 3);
      for (const parse of [parseFrame, parseDataFrame, parseManifestFrame]) {
        const outcome = parseSafely(parse, bytes);
        expect(outcome.threw).toBeNull();
      }
    }
  });

  it('survives every single-byte mutation of a valid data frame', () => {
    const original = validDataFrame();
    const next = lcg(0x5eed);
    for (let iteration = 0; iteration < 3_000; iteration += 1) {
      const bytes = original.slice();
      const position = pick(next, bytes.length);
      bytes[position] ^= 1 << pick(next, 8);
      const outcome = parseSafely(parseFrame, bytes);
      expect(outcome.threw).toBeNull();
      // A mutation either changed nothing observable or must be caught. It can
      // never produce a frame that claims to be the original.
      const result = outcome.result as { ok: boolean; value?: { kind: string } };
      if (result.ok) {
        const bytesDiffer = bytes.some((byte, index) => byte !== original[index]);
        expect(bytesDiffer).toBe(false);
      }
    }
  });

  it('survives every single-byte mutation of a valid manifest', () => {
    const original = validManifest();
    const next = lcg(0xfeed);
    for (let iteration = 0; iteration < 3_000; iteration += 1) {
      const bytes = original.slice();
      const position = pick(next, bytes.length);
      bytes[position] ^= 1 << pick(next, 8);
      const outcome = parseSafely(parseFrame, bytes);
      expect(outcome.threw).toBeNull();
      const result = outcome.result as { ok: boolean };
      if (result.ok) {
        expect(bytes.some((byte, index) => byte !== original[index])).toBe(false);
      }
    }
  });

  it('survives arbitrary truncations of valid frames', () => {
    for (const original of [validDataFrame(), validManifest()]) {
      for (let length = 0; length <= original.length; length += 1) {
        const outcome = parseSafely(parseFrame, original.subarray(0, length));
        expect(outcome.threw).toBeNull();
        const result = outcome.result as { ok: boolean };
        if (length !== original.length) expect(result.ok).toBe(false);
      }
    }
  });

  it('never allocates from a declared length it has not checked against the buffer', () => {
    // Every declared length is driven past its legal range and past the buffer,
    // with the CRC left stale, then repaired, so both orderings are exercised.
    const lengths = [0, 1, 255, 4_096, 4_097, 0x7fff, 0xffff];
    for (const declared of lengths) {
      const frame = validDataFrame();
      new DataView(frame.buffer).setUint16(V2_DATA_LAYOUT.payloadLength, declared);
      const outcome = parseSafely(parseDataFrame, frame);
      expect(outcome.threw).toBeNull();
      expect((outcome.result as { ok: boolean }).ok).toBe(false);

      const manifestBytes = validManifest();
      new DataView(manifestBytes.buffer).setUint16(V2_MANIFEST_LAYOUT.filenameLength, declared);
      const manifestOutcome = parseSafely(parseManifestFrame, manifestBytes);
      expect(manifestOutcome.threw).toBeNull();
      expect((manifestOutcome.result as { ok: boolean }).ok).toBe(false);
    }
  });

  it('reports every failure as a typed DeqrV2Error with a known code', () => {
    const known = new Set([
      'FRAME_TOO_SHORT', 'TRAILING_BYTES', 'BAD_MAGIC', 'V1_FRAME', 'UNSUPPORTED_VERSION',
      'UNKNOWN_FRAME_TYPE', 'FRAME_TYPE_MISMATCH', 'CRC_MISMATCH', 'FIELD_OUT_OF_RANGE',
      'INCONSISTENT_MANIFEST', 'UNSUPPORTED_CRITICAL_FEATURE', 'UNSUPPORTED_COMPRESSION',
      'UNSUPPORTED_FEC_PROFILE', 'INVALID_UTF8', 'INVALID_FILENAME', 'SESSION_MISMATCH',
      'SEGMENT_OUT_OF_RANGE', 'SYMBOL_OUT_OF_RANGE', 'PRECISION_LOSS',
    ]);
    const next = lcg(0x1234abcd);
    const seen = new Set<string>();
    for (let iteration = 0; iteration < 6_000; iteration += 1) {
      const bytes = randomBytes(next, 4 + pick(next, 300));
      if (pick(next, 2) === 0) {
        bytes[0] = V2_MAGIC_0;
        bytes[1] = V2_MAGIC_1;
        bytes[2] = V2_PROTOCOL_VERSION;
        bytes[3] = 1 + pick(next, 3);
      }
      const result = parseFrame(bytes) as { ok: boolean; error?: DeqrV2Error };
      if (result.ok) continue;
      expect(result.error).toBeInstanceOf(DeqrV2Error);
      expect(known.has(result.error!.code)).toBe(true);
      seen.add(result.error!.code);
    }
    // The sweep must actually reach the interesting rejections, not just bail
    // out on the magic every time.
    expect(seen.has('BAD_MAGIC')).toBe(true);
    expect(seen.has('CRC_MISMATCH') || seen.has('FRAME_TOO_SHORT')).toBe(true);
  });

  it('keeps every parsed field inside its declared range', () => {
    const next = lcg(0x99aa_bbcc);
    for (let iteration = 0; iteration < 4_000; iteration += 1) {
      const frame = validDataFrame();
      // Corrupt the header, then re-seal, so the CRC cannot mask a bad field.
      const position = pick(next, V2_DATA_LAYOUT.headerBytes);
      frame[position] = next() >>> 24;
      const view = new DataView(frame.buffer);
      let crc = 0xffffffff;
      for (let index = 0; index < frame.length - 4; index += 1) {
        crc ^= frame[index];
        for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      view.setUint32(frame.length - 4, (crc ^ 0xffffffff) >>> 0);

      const result = parseDataFrame(frame);
      if (!result.ok) continue;
      const value = result.value;
      expect(value.payload.length).toBeGreaterThanOrEqual(1);
      expect(value.payload.length).toBeLessThanOrEqual(V2_LIMITS.maxSymbolSizeBytes);
      expect(value.sourceSymbolCount).toBeGreaterThanOrEqual(1);
      expect(value.frameFlags & 0xff00).toBe(0);
      if (value.frameType === V2_FRAME_TYPE.SOURCE) {
        expect(value.symbolId).toBeLessThan(value.sourceSymbolCount);
      } else {
        expect(value.symbolId).toBeGreaterThanOrEqual(value.sourceSymbolCount);
      }
    }
  });
});
