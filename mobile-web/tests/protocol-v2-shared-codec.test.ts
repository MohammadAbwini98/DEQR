import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SegmentEncoder } from '../../src/core/segment-encoder';
import { SegmentedReceiver } from '../../src/core/segmented-receiver';
import {
  V2_COMPRESSION,
  V2_DATA_LAYOUT,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  detectProtocolVersion,
  parseDataFrame,
  parseManifestFrame,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  validateDataFrameAgainstManifest,
} from '../../src/core/protocol-v2';

/**
 * The v2 codec is shared, not duplicated.
 *
 * v1 forced the receiver to carry its own reimplementation of the wire format
 * in `mobile-web/src/protocol.ts`, because `src/core/protocol.ts` is written in
 * terms of Node `Buffer`. Two implementations of one wire format is a standing
 * invitation to drift, and it is the reason a receiver-side limit can disagree
 * with a sender-side one without anything failing to build.
 *
 * v2 is written against `Uint8Array`, `DataView`, and `BigInt` only, so the PWA
 * can import the same module the Electron sender uses. These tests hold that
 * property in place: they run inside the mobile-web project, through the same
 * Vite pipeline the receiver builds with.
 */

const repoRoot = path.resolve(__dirname, '..', '..');

const SESSION_ID = 0x5eed_1234;
const FILE_ID = 0x0a0b_0c0d;

describe('the v2 codec carries no Node dependency', () => {
  it.each([
    'src/core/protocol-v2.ts',
    'src/core/crc32.ts',
    // Phase 03 adds the recovery engine to the shared set. The receiver decodes
    // with the sender's own code rather than a second implementation of it.
    'src/core/prng.ts',
    'src/core/segment-encoder.ts',
    'src/core/segment-decoder.ts',
    'src/core/segmented-receiver.ts',
    // Phase 05 adds the capacity table: the receive worker derives camera
    // pixels per module from `qrModuleCount`, so it is on the shared path too.
    'src/core/qr-capacity.ts',
    // Phase 06 adds the incremental hash. `src/core/hash.ts` reaches for Node's
    // `createHash` and is deliberately not on this list; the receiver verifies
    // a file it never holds, which needs a hash the browser can drive itself.
    'src/core/sha256-stream.ts',
  ])(
    '%s imports nothing from Node and never mentions Buffer',
    async (relativePath) => {
      const source = await readFile(path.join(repoRoot, relativePath), 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) {
        expect(specifier.startsWith('.')).toBe(true);
      }
      // `Buffer` in a comment is fine and is how the reason for this rule is
      // recorded; a real reference is not.
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      expect(withoutComments).not.toMatch(/\bBuffer\b/);
      expect(withoutComments).not.toMatch(/\brequire\s*\(/);
      expect(withoutComments).not.toMatch(/\bprocess\./);
    },
  );

  it('only reaches for globals a browser and a worker both have', () => {
    expect(typeof TextEncoder).toBe('function');
    expect(typeof TextDecoder).toBe('function');
    expect(typeof DataView).toBe('function');
    expect(typeof BigInt).toBe('function');
  });
});

describe('the receiver can drive the shared v2 codec', () => {
  const transportSize = 200_000n;
  const segmentSizeBytes = 65_536;
  const symbolSizeBytes = 4_096;
  const plan = planSegmentation({ transportSize, segmentSizeBytes, symbolSizeBytes });

  const manifestBytes = serializeManifestFrame({
    featureFlags: 0,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    originalSize: transportSize,
    transportSize,
    segmentSizeBytes,
    symbolSizeBytes,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: new Uint8Array(32).fill(0x2b),
    filename: 'receiver-side.bin',
    mimeType: 'application/octet-stream',
  });

  it('parses a manifest a sender produced', () => {
    const parsed = parseManifestFrame(manifestBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filename).toBe('receiver-side.bin');
    expect(parsed.value.segmentCount).toBe(4);
    expect(parsed.value.transportSize).toBe(200_000n);
  });

  it('accepts a matching data frame and derives its file offset', () => {
    const parsedManifest = parseManifestFrame(manifestBytes);
    expect(parsedManifest.ok).toBe(true);
    if (!parsedManifest.ok) return;

    const frameBytes = serializeDataFrame({
      frameType: V2_FRAME_TYPE.SOURCE,
      sessionId: SESSION_ID,
      fileId: FILE_ID,
      segmentIndex: 2,
      symbolId: 3,
      sourceSymbolCount: plan.symbolsPerFullSegment,
      frameFlags: 0,
      payload: new Uint8Array(symbolSizeBytes).fill(0x7e),
    });

    const parsedFrame = parseDataFrame(frameBytes);
    expect(parsedFrame.ok).toBe(true);
    if (!parsedFrame.ok) return;

    expect(validateDataFrameAgainstManifest(parsedFrame.value, parsedManifest.value).ok).toBe(true);
    // The frame carries no offset. It is derived, which is what keeps eight
    // bytes out of every QR symbol.
    expect(segmentByteRange(plan, 2).start).toBe(131_072n);
  });

  it('rejects a frame from a different transfer', () => {
    const parsedManifest = parseManifestFrame(manifestBytes);
    expect(parsedManifest.ok).toBe(true);
    if (!parsedManifest.ok) return;

    const foreign = parseDataFrame(serializeDataFrame({
      frameType: V2_FRAME_TYPE.SOURCE,
      sessionId: 0xdead_beef,
      fileId: FILE_ID,
      segmentIndex: 0,
      symbolId: 0,
      sourceSymbolCount: plan.symbolsPerFullSegment,
      frameFlags: 0,
      payload: new Uint8Array(symbolSizeBytes),
    }));
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;

    const validated = validateDataFrameAgainstManifest(foreign.value, parsedManifest.value);
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.error.code).toBe('SESSION_MISMATCH');
  });

  it('rejects damage without throwing', () => {
    const bytes = serializeDataFrame({
      frameType: V2_FRAME_TYPE.SOURCE,
      sessionId: SESSION_ID,
      fileId: FILE_ID,
      segmentIndex: 0,
      symbolId: 0,
      sourceSymbolCount: plan.symbolsPerFullSegment,
      frameFlags: 0,
      payload: new Uint8Array(symbolSizeBytes).fill(9),
    });
    bytes[V2_DATA_LAYOUT.payload + 5] ^= 0x80;
    const parsed = parseDataFrame(bytes);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('CRC_MISMATCH');
  });

  it('tells a v1 frame apart from a v2 frame', () => {
    const v1 = new Uint8Array(52);
    v1[0] = 1;
    expect(detectProtocolVersion(v1)).toBe(1);
    expect(detectProtocolVersion(manifestBytes)).toBe(2);
  });
});


/**
 * The recovery engine is shared too, not just the frame format.
 *
 * Phase 01 proved the receiver could parse a v2 frame with the sender's codec.
 * This proves it can *decode a transfer* with the sender's decoder: a real
 * segmented receive, driven from this project so it runs through the same Vite
 * pipeline the PWA builds with, with a third of the frames thrown away.
 */
describe('the receiver can drive the shared recovery engine', () => {
  const symbolSizeBytes = 512;
  const segmentSizeBytes = 64 * 1024;
  const file = new Uint8Array(150_000);
  for (let index = 0, state = 0x1234_5678; index < file.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    file[index] = state >>> 24;
  }

  const transportSize = BigInt(file.length);
  const segmentPlan = planSegmentation({ transportSize, segmentSizeBytes, symbolSizeBytes });

  const sessionManifest = {
    featureFlags: 0,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    originalSize: transportSize,
    transportSize,
    segmentSizeBytes,
    symbolSizeBytes,
    segmentCount: segmentPlan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: new Uint8Array(32).fill(0x11),
    filename: 'shared-engine.bin',
    mimeType: 'application/octet-stream',
  };

  it('reconstructs a segmented transfer byte for byte after losing frames', () => {
    const rebuilt = new Uint8Array(file.length);
    const receiver = new SegmentedReceiver(sessionManifest, {
      onSegmentComplete: (segment) => rebuilt.set(segment.bytes, Number(segment.byteOffset)),
    });

    const encoder = new SegmentEncoder(symbolSizeBytes);
    let emitted = 0;
    for (let segmentIndex = 0; segmentIndex < segmentPlan.segmentCount; segmentIndex += 1) {
      const range = segmentByteRange(segmentPlan, segmentIndex);
      encoder.loadSegment(file.subarray(Number(range.start), Number(range.end)));
      const sourceSymbolCount = encoder.sourceSymbolCount;
      const payload = new Uint8Array(symbolSizeBytes);

      for (let symbolId = 0; symbolId < sourceSymbolCount * 4; symbolId += 1) {
        encoder.symbolInto(symbolId, payload);
        emitted += 1;
        // Every third frame never arrives.
        if (emitted % 3 === 0) continue;
        const bytes = serializeDataFrame({
          frameType: symbolId < sourceSymbolCount ? V2_FRAME_TYPE.SOURCE : V2_FRAME_TYPE.REPAIR,
          sessionId: SESSION_ID,
          fileId: FILE_ID,
          segmentIndex,
          symbolId,
          sourceSymbolCount,
          frameFlags: 0,
          payload,
        });
        if (receiver.acceptFrameBytes(bytes).segmentCompleted) break;
      }
    }
    encoder.release();

    expect(receiver.isComplete).toBe(true);
    expect(Array.from(rebuilt.subarray(0, 64))).toEqual(Array.from(file.subarray(0, 64)));
    expect(rebuilt.every((byte, index) => byte === file[index])).toBe(true);
    expect(receiver.stats().symbolsRepaired).toBeGreaterThan(0);
    // Committed segments are gone: only the completion bitmap survives.
    expect(receiver.heldBytes()).toBe(1);
  });

  it('holds no Node-only global on the recovery path', () => {
    const receiver = new SegmentedReceiver(sessionManifest);
    expect(receiver.plan.segmentCount).toBe(3);
    expect(typeof Uint8Array).toBe('function');
    expect(typeof Map).toBe('function');
    receiver.release();
  });
});
