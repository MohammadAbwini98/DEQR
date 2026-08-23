import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { SegmentEncoder } from '../../src/core/segment-encoder';
import { SEGMENT_ACCEPT, SegmentDecoder } from '../../src/core/segment-decoder';
import { RECEIVE_ACCEPT, SegmentedReceiver } from '../../src/core/segmented-receiver';
import { RECEIVER_POLICY } from '../../src/core/receiver-policy';
import {
  DeqrV2DataFrame,
  DeqrV2Manifest,
  V2_COMPRESSION,
  V2_DATA_LAYOUT,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  V2_LIMITS,
  V2_MAGIC_0,
  V2_MAGIC_1,
  V2_PROTOCOL_VERSION,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
} from '../../src/core/protocol-v2';
import { crc32 } from '../../src/core/crc32';

/**
 * Recovery under a hostile stream, which is a different question from parsing one.
 *
 * `protocol-v2-fuzz.test.ts` establishes that no byte string can make the
 * *parser* throw or allocate. That leaves the half of the attack surface where
 * every frame is perfectly well formed and the damage is done by their
 * *quantity, order, or identity*: a duplicate storm, a repair flood of distinct
 * ids, an equation whose degree is maximal, a segment index that walks the
 * bitmap, a second transfer sharing the camera.
 *
 * The property under test throughout is the phase gate itself: **no admissible
 * sequence of frames can cause unbounded allocation, unbounded queue growth, or
 * a long CPU loop, and none can produce a false verified state.** Every
 * assertion is against numbers the decoder reports about itself - `heldBytes`,
 * `pendingEquations`, `pendingNeighborRefs`, `xorBytes` - rather than against
 * wall-clock time, so a slow machine does not turn a security property into a
 * flaky test.
 */

/* ------------------------------------------------------------------ fixtures */

const SEGMENT_BYTES = 64 * 1024;
const SYMBOL_BYTES = 512;
const SESSION_ID = 0x5eed_1234;
const FILE_ID = 0x0a0b_0c0d;

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

interface Transfer {
  file: Uint8Array;
  manifest: DeqrV2Manifest;
  manifestBytes: Uint8Array;
  frames: DeqrV2DataFrame[];
  frameBytes: Uint8Array[];
}

/** A whole transfer, built the way the sender builds one. */
function buildTransfer(file: Uint8Array, repairRatio = 1.0, sessionId = SESSION_ID): Transfer {
  const transportSize = BigInt(file.length);
  const plan = planSegmentation({
    transportSize,
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
  });

  const manifest: DeqrV2Manifest = {
    featureFlags: 0,
    sessionId,
    fileId: FILE_ID,
    originalSize: transportSize,
    transportSize,
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: createHash('sha256').update(file).digest(),
    filename: 'hostile.bin',
    mimeType: 'application/octet-stream',
  };

  const frames: DeqrV2DataFrame[] = [];
  const encoder = new SegmentEncoder(SYMBOL_BYTES);
  for (let segmentIndex = 0; segmentIndex < plan.segmentCount; segmentIndex += 1) {
    const range = segmentByteRange(plan, segmentIndex);
    encoder.loadSegment(file.subarray(Number(range.start), Number(range.end)));
    const sourceSymbolCount = sourceSymbolCountForSegment(plan, segmentIndex);
    const total = sourceSymbolCount + Math.ceil(sourceSymbolCount * repairRatio);
    for (let symbolId = 0; symbolId < total; symbolId += 1) {
      const payload = new Uint8Array(SYMBOL_BYTES);
      encoder.symbolInto(symbolId, payload);
      frames.push({
        frameType: symbolId < sourceSymbolCount ? V2_FRAME_TYPE.SOURCE : V2_FRAME_TYPE.REPAIR,
        sessionId,
        fileId: FILE_ID,
        segmentIndex,
        symbolId,
        sourceSymbolCount,
        frameFlags: 0,
        payload,
      });
    }
  }
  encoder.release();

  return {
    file,
    manifest,
    manifestBytes: serializeManifestFrame(manifest),
    frames,
    frameBytes: frames.map(serializeDataFrame),
  };
}

/**
 * Rewrites a field of an already-serialized data frame and fixes its CRC.
 *
 * The serializer refuses most of what these tests need to send, and rightly so
 * - it is our side of the wire. A hostile sender has no such scruples, so the
 * frames below are edited after the fact and re-checksummed, which is exactly
 * what an attacker with a QR generator would produce.
 */
function rewriteDataFrame(frame: Uint8Array, edits: Partial<Record<'sessionId' | 'fileId' | 'segmentIndex' | 'symbolId' | 'sourceSymbolCount', number>>): Uint8Array {
  const out = frame.slice();
  const view = new DataView(out.buffer);
  if (edits.sessionId !== undefined) view.setUint32(V2_DATA_LAYOUT.sessionId, edits.sessionId);
  if (edits.fileId !== undefined) view.setUint32(V2_DATA_LAYOUT.fileId, edits.fileId);
  if (edits.segmentIndex !== undefined) view.setUint32(V2_DATA_LAYOUT.segmentIndex, edits.segmentIndex);
  if (edits.symbolId !== undefined) view.setUint32(V2_DATA_LAYOUT.symbolId, edits.symbolId);
  if (edits.sourceSymbolCount !== undefined) {
    view.setUint32(V2_DATA_LAYOUT.sourceSymbolCount, edits.sourceSymbolCount);
  }
  view.setUint32(out.length - 4, crc32(out, 0, out.length - 4));
  return out;
}

/** A deterministic generator, so a failure is reproducible from the seed alone. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

/* ------------------------------------------------------------ duplicate floods */

describe('duplicate and redundant floods buy no work', () => {
  it('answers fifty thousand identical repair frames in constant space', () => {
    const decoder = new SegmentDecoder({
      sourceSymbolCount: 128,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentBytes: 128 * SYMBOL_BYTES,
    });
    const payload = bytes(SYMBOL_BYTES, 7);

    // One repair symbol, repeated. The first is stored as an equation; every
    // one after it must be an O(1) set lookup.
    const first = decoder.accept(200, payload);
    expect(first.status).toBe(SEGMENT_ACCEPT.REPAIR_PENDING);
    const afterFirst = decoder.stats();
    const heldAfterFirst = decoder.heldBytes();

    for (let repeat = 0; repeat < 50_000; repeat += 1) {
      const result = decoder.accept(200, payload);
      expect(result.status).toBe(SEGMENT_ACCEPT.DUPLICATE);
    }

    const after = decoder.stats();
    expect(after.repairDuplicates).toBe(50_000);
    // Nothing grew: not the equations, not the neighbour index, not the bytes.
    expect(after.pendingEquations).toBe(afterFirst.pendingEquations);
    expect(after.pendingNeighborRefs).toBe(afterFirst.pendingNeighborRefs);
    expect(after.xorBytes).toBe(afterFirst.xorBytes);
    expect(decoder.heldBytes()).toBe(heldAfterFirst);
  });

  it('saturates rather than grows under a flood the algebra cannot consume', () => {
    const sourceSymbolCount = 64;
    const decoder = new SegmentDecoder({
      sourceSymbolCount,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentBytes: sourceSymbolCount * SYMBOL_BYTES,
      // Every symbol is a distinct identity naming the same two unknowns. Belief
      // propagation resolves only degree-one equations, so nothing here can ever
      // resolve and the equations pile up - which is precisely the shape a
      // hostile sender would choose, and precisely what the caps exist for.
      neighborsFor: () => [0, 1],
    });

    let saturated = 0;
    for (let symbolId = sourceSymbolCount; symbolId < sourceSymbolCount + 20_000; symbolId += 1) {
      const result = decoder.accept(symbolId, bytes(SYMBOL_BYTES, symbolId));
      if (result.status === SEGMENT_ACCEPT.REJECTED) {
        expect(result.reason).toBe('saturated');
        saturated += 1;
      }
    }

    const stats = decoder.stats();
    // The whole point: the flood is refused, and refused by a cap the decoder
    // states rather than by memory pressure.
    expect(saturated).toBeGreaterThan(19_000);
    expect(stats.pendingEquations).toBeLessThanOrEqual(decoder.limits.maxPendingEquations);
    expect(stats.pendingNeighborRefs).toBeLessThanOrEqual(
      decoder.limits.maxPendingNeighborRefs + sourceSymbolCount,
    );
    // Held bytes are the segment, the bitmap, and one symbol per equation.
    const ceiling = sourceSymbolCount * SYMBOL_BYTES
      + Math.ceil(sourceSymbolCount / 8)
      + decoder.limits.maxPendingEquations * SYMBOL_BYTES;
    expect(decoder.heldBytes()).toBeLessThanOrEqual(ceiling);
    // Nothing was learned from twenty thousand frames, and the decoder says so
    // rather than reporting a segment it cannot produce.
    expect(decoder.isComplete).toBe(false);
    expect(() => decoder.segment()).toThrow(/not complete/);
  });

  it('stays inside its caps under a distinct-id flood on the shipping profile', () => {
    const sourceSymbolCount = 64;
    const decoder = new SegmentDecoder({
      sourceSymbolCount,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentBytes: sourceSymbolCount * SYMBOL_BYTES,
    });
    const ceiling = sourceSymbolCount * SYMBOL_BYTES
      + Math.ceil(sourceSymbolCount / 8)
      + decoder.limits.maxPendingEquations * SYMBOL_BYTES;

    // The real robust-soliton generator, fed twenty thousand identities it has
    // never seen. Whatever it does with them - solve, store, or refuse - it
    // must do inside the same bound throughout, checked every single frame.
    for (let symbolId = sourceSymbolCount; symbolId < sourceSymbolCount + 20_000; symbolId += 1) {
      decoder.accept(symbolId, bytes(SYMBOL_BYTES, symbolId));
      expect(decoder.heldBytes()).toBeLessThanOrEqual(ceiling);
    }
    const stats = decoder.stats();
    expect(stats.pendingEquations).toBeLessThanOrEqual(decoder.limits.maxPendingEquations);
    expect(decoder.trackedRepairIds).toBeLessThanOrEqual(decoder.limits.maxTrackedRepairIds);
  });

  it('keeps a completed segment free to re-scan', () => {
    const sourceSymbolCount = 32;
    const decoder = new SegmentDecoder({
      sourceSymbolCount,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentBytes: sourceSymbolCount * SYMBOL_BYTES,
    });
    for (let symbolId = 0; symbolId < sourceSymbolCount; symbolId += 1) {
      decoder.accept(symbolId, bytes(SYMBOL_BYTES, symbolId + 1));
    }
    expect(decoder.isComplete).toBe(true);
    const before = decoder.stats();

    // A second display pass over a finished segment. Every frame must cost one
    // comparison, which is what makes a looping sender free rather than
    // quadratic.
    for (let repeat = 0; repeat < 10_000; repeat += 1) {
      expect(decoder.accept(repeat % 200, bytes(SYMBOL_BYTES, 99)).status)
        .toBe(SEGMENT_ACCEPT.DUPLICATE);
    }
    expect(decoder.stats().xorBytes).toBe(before.xorBytes);
  });
});

/* --------------------------------------------------------- pathological metadata */

describe('pathological frame metadata is refused against the manifest', () => {
  const transfer = buildTransfer(bytes(SEGMENT_BYTES * 3 + 999, 5));

  function receiver(): SegmentedReceiver {
    return new SegmentedReceiver(transfer.manifest, { maxSegmentCount: RECEIVER_POLICY.maxSegmentCount });
  }

  it('refuses a u32-maximum source symbol count without allocating for it', () => {
    const session = receiver();
    const before = session.heldBytes();
    const hostile = rewriteDataFrame(transfer.frameBytes[0], {
      sourceSymbolCount: V2_LIMITS.maxSymbolsPerSegment,
      symbolId: 0,
    });

    const result = session.acceptFrameBytes(hostile);
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    // The manifest says how many symbols this segment has. A frame that
    // disagrees is rejected before a decoder is built, so nothing was sized
    // from four billion.
    expect(result.reason).toBe('INCONSISTENT_MANIFEST');
    expect(session.heldBytes()).toBe(before);
    expect(session.stats().activeSegments).toBe(0);
  });

  it('refuses a segment index past the end without touching the bitmap', () => {
    const session = receiver();
    for (const segmentIndex of [transfer.manifest.segmentCount, 0xffff_ffff, 0x7fff_ffff]) {
      const hostile = rewriteDataFrame(transfer.frameBytes[0], { segmentIndex });
      const result = session.acceptFrameBytes(hostile);
      expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
      expect(result.reason).toBe('SEGMENT_OUT_OF_RANGE');
    }
    expect(session.segmentsCommitted).toBe(0);
    expect(session.isComplete).toBe(false);
  });

  it('refuses a repair id at the u32 ceiling as a bounded equation or not at all', () => {
    const sourceSymbolCount = 64;
    const decoder = new SegmentDecoder({
      sourceSymbolCount,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentBytes: sourceSymbolCount * SYMBOL_BYTES,
    });
    // A generator seed at the top of the field is legal and must produce a
    // neighbour set inside the segment like any other.
    const result = decoder.accept(0xffff_ffff, bytes(SYMBOL_BYTES, 3));
    expect([
      SEGMENT_ACCEPT.REPAIR_PENDING,
      SEGMENT_ACCEPT.REPAIR_SOLVED,
      SEGMENT_ACCEPT.REDUNDANT,
    ]).toContain(result.status);
    expect(decoder.stats().pendingNeighborRefs).toBeLessThanOrEqual(sourceSymbolCount);
  });

  it('refuses an equation whose generator claims a neighbour outside the segment', () => {
    const sourceSymbolCount = 32;
    const decoder = new SegmentDecoder({
      sourceSymbolCount,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentBytes: sourceSymbolCount * SYMBOL_BYTES,
      // A deliberately broken FEC profile, which is what a mismatched build or
      // a hostile profile id would amount to. The decoder re-checks the set it
      // is given rather than trusting the generator.
      neighborsFor: () => [0, sourceSymbolCount + 5, -1],
    });
    const result = decoder.accept(sourceSymbolCount, bytes(SYMBOL_BYTES, 4));
    expect(result.status).toBe(SEGMENT_ACCEPT.REJECTED);
    expect(result.reason).toBe('invalid-equation');
    expect(decoder.stats().pendingEquations).toBe(0);
  });

  it('refuses a degree above the source symbol count', () => {
    const sourceSymbolCount = 16;
    const decoder = new SegmentDecoder({
      sourceSymbolCount,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentBytes: sourceSymbolCount * SYMBOL_BYTES,
      neighborsFor: () => Array.from({ length: sourceSymbolCount + 1 }, (_, index) => index % sourceSymbolCount),
    });
    const result = decoder.accept(sourceSymbolCount, bytes(SYMBOL_BYTES, 6));
    expect(result.status).toBe(SEGMENT_ACCEPT.REJECTED);
    expect(result.reason).toBe('invalid-equation');
  });

  it('refuses a payload that is not the manifest symbol size', () => {
    const session = receiver();
    const short = serializeDataFrame({
      ...transfer.frames[0],
      payload: transfer.frames[0].payload.subarray(0, SYMBOL_BYTES - 1),
    });
    const result = session.acceptFrameBytes(short);
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('FIELD_OUT_OF_RANGE');
  });
});

/* ------------------------------------------------------------ session collision */

describe('two transfers in one camera', () => {
  it('never folds a foreign session into the one being received', () => {
    const mine = buildTransfer(bytes(SEGMENT_BYTES + 100, 21));
    const theirs = buildTransfer(bytes(SEGMENT_BYTES + 100, 22), 1.0, SESSION_ID ^ 0x0f0f_0f0f);
    const session = new SegmentedReceiver(mine.manifest);

    for (const frame of theirs.frameBytes) {
      const result = session.acceptFrameBytes(frame);
      expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
      expect(result.reason).toBe('SESSION_MISMATCH');
    }
    expect(session.segmentsCommitted).toBe(0);

    // And a frame that differs only in `fileId` is the same refusal: a sender
    // sending two files in one session must not have its second file's symbols
    // written into the first file's segments.
    const wrongFile = rewriteDataFrame(mine.frameBytes[0], { fileId: FILE_ID + 1 });
    expect(session.acceptFrameBytes(wrongFile).reason).toBe('SESSION_MISMATCH');
    expect(session.segmentsCommitted).toBe(0);
  });

  it('refuses a manifest for another transfer without restarting', () => {
    const mine = buildTransfer(bytes(SEGMENT_BYTES + 100, 31));
    const theirs = buildTransfer(bytes(SEGMENT_BYTES + 100, 32), 1.0, SESSION_ID + 1);
    const session = new SegmentedReceiver(mine.manifest);

    session.acceptFrameBytes(mine.frameBytes[0]);
    const before = session.stats();
    expect(session.acceptFrameBytes(theirs.manifestBytes).reason).toBe('SESSION_MISMATCH');
    // Its own manifest is accepted and changes nothing.
    expect(session.acceptFrameBytes(mine.manifestBytes).status).toBe(RECEIVE_ACCEPT.MANIFEST);
    expect(session.stats().sourceSymbolsPlaced).toBe(before.sourceSymbolsPlaced);
  });
});

/* --------------------------------------------------------------- manifest caps */

describe('a manifest cannot make the receiver reserve what it likes', () => {
  it('refuses a segment count above the receiver policy', () => {
    // Built by hand: `planSegmentation` would have to be given a 1 PiB
    // transport size to produce this legitimately, and the point is the
    // receiver's refusal rather than the sender's arithmetic.
    const manifest = {
      ...buildTransfer(bytes(SEGMENT_BYTES, 41)).manifest,
      segmentCount: RECEIVER_POLICY.maxSegmentCount + 1,
    };
    expect(() => new SegmentedReceiver(manifest)).toThrow(/above this receiver/);
  });

  it('sizes the completion bitmap from the segment count and nothing else', () => {
    const transfer = buildTransfer(bytes(SEGMENT_BYTES * 4, 42));
    const session = new SegmentedReceiver(transfer.manifest);
    // One bit per segment, and it is the only state proportional to the file.
    expect(session.committedBitmap().length).toBe(Math.ceil(transfer.manifest.segmentCount / 8));
    expect(session.heldBytes()).toBeLessThan(4 * 1024);
  });

  it('refuses an adopted bitmap sized for a different transfer', () => {
    const transfer = buildTransfer(bytes(SEGMENT_BYTES * 4, 43));
    expect(() => new SegmentedReceiver(transfer.manifest, {
      adoptedSegments: new Uint8Array(1_024),
    })).toThrow(/adoptedSegments/);
  });

  it('masks adopted bits past the last segment so progress cannot be faked', () => {
    const transfer = buildTransfer(bytes(SEGMENT_BYTES * 3 + 1, 44));
    const width = Math.ceil(transfer.manifest.segmentCount / 8);
    const forged = new Uint8Array(width).fill(0xff);
    const session = new SegmentedReceiver(transfer.manifest, { adoptedSegments: forged });
    // Every real segment is claimed, which is what the bitmap says. What it
    // must not do is claim more segments than exist.
    expect(session.segmentsCommitted).toBe(transfer.manifest.segmentCount);
    expect(session.segmentsAdopted).toBe(transfer.manifest.segmentCount);
    expect(session.isComplete).toBe(true);
    expect(session.firstMissingSegment()).toBe(transfer.manifest.segmentCount);
  });
});

/* ---------------------------------------------------------------- randomized */

describe('randomized hostile streams', () => {
  it('survives twenty thousand mutated frames without throwing or growing', () => {
    const transfer = buildTransfer(bytes(SEGMENT_BYTES * 2 + 77, 51));
    const session = new SegmentedReceiver(transfer.manifest);
    const next = lcg(0xbadc0de);

    const ceiling = RECEIVER_POLICY.maxActiveSegments
      * (SEGMENT_BYTES + Math.ceil(SEGMENT_BYTES / SYMBOL_BYTES / 8) + (SEGMENT_BYTES / SYMBOL_BYTES) * SYMBOL_BYTES)
      + session.committedBitmap().length;

    for (let iteration = 0; iteration < 20_000; iteration += 1) {
      const source = transfer.frameBytes[next() % transfer.frameBytes.length].slice();
      // Flip one byte anywhere in the frame, CRC included. Most land in the
      // payload and are caught by the CRC; a few land in a header field and
      // reach the range checks. Both are refusals and neither may throw.
      const at = next() % source.length;
      source[at] ^= 1 << (next() % 8);
      expect(() => session.acceptFrameBytes(source)).not.toThrow();
      expect(session.heldBytes()).toBeLessThanOrEqual(ceiling);
    }
  });

  it('never reports a session complete from mutated frames alone', () => {
    const transfer = buildTransfer(bytes(SEGMENT_BYTES * 2 + 77, 52));
    const session = new SegmentedReceiver(transfer.manifest);
    const next = lcg(0x5eed);

    for (let iteration = 0; iteration < 5_000; iteration += 1) {
      const source = transfer.frameBytes[next() % transfer.frameBytes.length].slice();
      // Corrupt a header field specifically, leaving the CRC stale, so the
      // frame is well formed in length and wrong in identity.
      const at = V2_DATA_LAYOUT.sessionId + (next() % 16);
      source[at] ^= 0xff;
      const result = session.acceptFrameBytes(source);
      expect(result.sessionComplete).toBe(false);
    }
    expect(session.isComplete).toBe(false);
    expect(session.segmentsCommitted).toBe(0);
  });

  it('survives random buffers carrying a valid v2 prefix', () => {
    const transfer = buildTransfer(bytes(SEGMENT_BYTES, 53));
    const session = new SegmentedReceiver(transfer.manifest);
    const next = lcg(0xfeed);

    for (let iteration = 0; iteration < 5_000; iteration += 1) {
      const length = 4 + (next() % 600);
      const frame = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) frame[index] = next() >>> 24;
      frame[0] = V2_MAGIC_0;
      frame[1] = V2_MAGIC_1;
      frame[2] = V2_PROTOCOL_VERSION;
      frame[3] = 1 + (next() % 3);
      expect(() => session.acceptFrameBytes(frame)).not.toThrow();
    }
    expect(session.segmentsCommitted).toBe(0);
  });
});

/* -------------------------------------------------------- cancel under attack */

describe('cancelling during a hostile stream', () => {
  it('drops every buffer and refuses everything after', () => {
    const transfer = buildTransfer(bytes(SEGMENT_BYTES * 2 + 5, 61));
    const session = new SegmentedReceiver(transfer.manifest);

    // Half a segment in, with equations pending.
    for (const frame of transfer.frameBytes.slice(0, 40)) session.acceptFrameBytes(frame);
    expect(session.stats().activeSegments).toBeGreaterThan(0);

    session.release();

    expect(session.isReleased).toBe(true);
    expect(session.stats().activeSegments).toBe(0);
    // Only the bitmap survives, and it holds no payload.
    expect(session.heldBytes()).toBe(session.committedBitmap().length);

    for (const frame of transfer.frameBytes) {
      const result = session.acceptFrameBytes(frame);
      expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
      expect(result.reason).toBe('session-released');
    }
    expect(session.isComplete).toBe(false);
  });

  it('leaves a released decoder unable to hand out a segment', () => {
    const decoder = new SegmentDecoder({
      sourceSymbolCount: 8,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentBytes: 8 * SYMBOL_BYTES,
    });
    for (let symbolId = 0; symbolId < 8; symbolId += 1) {
      decoder.accept(symbolId, bytes(SYMBOL_BYTES, symbolId + 1));
    }
    decoder.release();
    expect(() => decoder.segment()).toThrow(/released/);
    expect(decoder.accept(0, bytes(SYMBOL_BYTES, 1)).reason).toBe('closed');
  });
});
