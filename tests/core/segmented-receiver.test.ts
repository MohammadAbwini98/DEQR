import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PRNG } from '../../src/core/prng';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import {
  CompletedSegment,
  RECEIVE_ACCEPT,
  SegmentedReceiver,
} from '../../src/core/segmented-receiver';
import {
  DeqrV2DataFrame,
  DeqrV2Manifest,
  V2_COMPRESSION,
  V2_DATA_LAYOUT,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
} from '../../src/core/protocol-v2';
import { FRAME_PROTOCOL_VERSION, serializeFrame } from '../../src/core/protocol';

/* ------------------------------------------------------------------ fixtures */

/** The protocol's floor. Every segment in these tests is a real, legal segment. */
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

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

interface Transfer {
  file: Uint8Array;
  manifest: DeqrV2Manifest;
  manifestBytes: Uint8Array;
  frames: DeqrV2DataFrame[];
  frameBytes: Uint8Array[];
}

/**
 * A whole transfer, materialised.
 *
 * Built the way the sender builds one - `planSegmentation`, then a
 * `SegmentEncoder` per segment - so the receiver under test faces the real wire
 * format rather than a convenient approximation of it.
 */
function buildTransfer(
  file: Uint8Array,
  repairRatio = 1.0,
  segmentSizeBytes = SEGMENT_BYTES,
  symbolSizeBytes = SYMBOL_BYTES,
): Transfer {
  const transportSize = BigInt(file.length);
  const plan = planSegmentation({ transportSize, segmentSizeBytes, symbolSizeBytes });

  const manifest: DeqrV2Manifest = {
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
    sha256: createHash('sha256').update(file).digest(),
    filename: 'segmented.bin',
    mimeType: 'application/octet-stream',
  };

  const frames: DeqrV2DataFrame[] = [];
  const encoder = new SegmentEncoder(symbolSizeBytes);
  for (let segmentIndex = 0; segmentIndex < plan.segmentCount; segmentIndex += 1) {
    const range = segmentByteRange(plan, segmentIndex);
    encoder.loadSegment(file.subarray(Number(range.start), Number(range.end)));
    const sourceSymbolCount = sourceSymbolCountForSegment(plan, segmentIndex);
    expect(encoder.sourceSymbolCount).toBe(sourceSymbolCount);

    const total = sourceSymbolCount + Math.ceil(sourceSymbolCount * repairRatio);
    for (let symbolId = 0; symbolId < total; symbolId += 1) {
      const payload = new Uint8Array(symbolSizeBytes);
      encoder.symbolInto(symbolId, payload);
      frames.push({
        frameType: symbolId < sourceSymbolCount ? V2_FRAME_TYPE.SOURCE : V2_FRAME_TYPE.REPAIR,
        sessionId: SESSION_ID,
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

/** Collects committed segments and stitches them back into a file. */
function collector(totalBytes: number): { sink: (segment: CompletedSegment) => void; file: Uint8Array; order: number[] } {
  const file = new Uint8Array(totalBytes);
  const order: number[] = [];
  return {
    file,
    order,
    sink: (segment) => {
      order.push(segment.segmentIndex);
      file.set(segment.bytes, Number(segment.byteOffset));
    },
  };
}

function survivors<T>(frames: T[], lossRate: number, seed: number): T[] {
  if (lossRate <= 0) return [...frames];
  const prng = new PRNG(seed);
  return frames.filter(() => prng.next() >= lossRate);
}

/* ------------------------------------------------------------- reassembly */

describe('a multi-segment transfer reassembles to the original file', () => {
  it('commits every segment in order and hashes identically', () => {
    // 200,000 bytes over 64 KiB segments: three full segments and a short one.
    const transfer = buildTransfer(bytes(200_000, 3), 0);
    expect(transfer.manifest.segmentCount).toBe(4);

    const sink = collector(200_000);
    const receiver = new SegmentedReceiver(transfer.manifest, { onSegmentComplete: sink.sink });

    for (const frame of transfer.frames) receiver.acceptFrame(frame);

    expect(receiver.isComplete).toBe(true);
    expect(sink.order).toEqual([0, 1, 2, 3]);
    expect(sha256(sink.file)).toBe(sha256(transfer.file));
    // The cheap path all the way through: nothing was reconstructed.
    expect(receiver.stats().xorBytes).toBe(0);
    expect(receiver.stats().symbolsRepaired).toBe(0);
  });

  it('reassembles under loss, with repair doing the work', () => {
    const transfer = buildTransfer(bytes(200_000, 4), 3.0);
    const expected = sha256(transfer.file);

    for (const [lossRate, seed] of [[0.05, 0xa1], [0.2, 0xb2], [0.3, 0xc3]] as const) {
      const sink = collector(200_000);
      const receiver = new SegmentedReceiver(transfer.manifest, { onSegmentComplete: sink.sink });
      for (const frame of survivors(transfer.frames, lossRate, seed)) receiver.acceptFrame(frame);

      expect(receiver.isComplete, `loss ${lossRate}`).toBe(true);
      expect(sha256(sink.file), `loss ${lossRate}`).toBe(expected);
      expect(receiver.stats().symbolsRepaired).toBeGreaterThan(0);
    }
  });

  it('handles a file that is exactly one segment and one that is exactly two', () => {
    for (const size of [SEGMENT_BYTES, SEGMENT_BYTES * 2]) {
      const transfer = buildTransfer(bytes(size, 5), 0);
      expect(transfer.manifest.segmentCount).toBe(size / SEGMENT_BYTES);

      const sink = collector(size);
      const receiver = new SegmentedReceiver(transfer.manifest, { onSegmentComplete: sink.sink });
      for (const frame of transfer.frames) receiver.acceptFrame(frame);

      expect(receiver.isComplete).toBe(true);
      expect(sha256(sink.file)).toBe(sha256(transfer.file));
    }
  });

  it('handles a final segment of a single byte', () => {
    const size = SEGMENT_BYTES * 2 + 1;
    const transfer = buildTransfer(bytes(size, 6), 1.0);
    expect(transfer.manifest.segmentCount).toBe(3);
    // One byte becomes one zero-padded symbol on the wire.
    expect(sourceSymbolCountForSegment(
      planSegmentation({
        transportSize: BigInt(size),
        segmentSizeBytes: SEGMENT_BYTES,
        symbolSizeBytes: SYMBOL_BYTES,
      }),
      2,
    )).toBe(1);

    const sink = collector(size);
    const receiver = new SegmentedReceiver(transfer.manifest, { onSegmentComplete: sink.sink });
    for (const frame of transfer.frames) receiver.acceptFrame(frame);

    expect(receiver.isComplete).toBe(true);
    expect(sha256(sink.file)).toBe(sha256(transfer.file));
  });

  it('accepts segments delivered in a shuffled order', () => {
    const transfer = buildTransfer(bytes(200_000, 7), 0);
    const shuffledFrames = [...transfer.frames];
    const prng = new PRNG(0xd4);
    for (let index = shuffledFrames.length - 1; index > 0; index -= 1) {
      const swap = prng.nextInt(0, index + 1);
      [shuffledFrames[index], shuffledFrames[swap]] = [shuffledFrames[swap], shuffledFrames[index]];
    }

    const sink = collector(200_000);
    // Every segment is live at once here, because a shuffled stream touches all
    // four before finishing any. That is the case the bound has to survive.
    const receiver = new SegmentedReceiver(transfer.manifest, {
      onSegmentComplete: sink.sink,
      maxActiveSegments: 4,
    });
    for (const frame of shuffledFrames) receiver.acceptFrame(frame);

    expect(receiver.isComplete).toBe(true);
    expect(sha256(sink.file)).toBe(sha256(transfer.file));
  });
});

/* ---------------------------------------------------------- segment budget */

describe('decoder state is bounded and short-lived', () => {
  it('never holds more decoders than the budget allows', () => {
    const transfer = buildTransfer(bytes(400_000, 11), 0.25);
    const receiver = new SegmentedReceiver(transfer.manifest, { maxActiveSegments: 2 });

    let peakHeld = 0;
    for (const frame of transfer.frames) {
      receiver.acceptFrame(frame);
      expect(receiver.stats().activeSegments).toBeLessThanOrEqual(2);
      peakHeld = Math.max(peakHeld, receiver.heldBytes());
    }

    // Two decoders' worst case, plus the committed bitmap. Nothing here is a
    // function of the file: the same bound holds for a terabyte.
    const perDecoder = SEGMENT_BYTES + Math.ceil(SEGMENT_BYTES / SYMBOL_BYTES / 8)
      + (SEGMENT_BYTES / SYMBOL_BYTES) * SYMBOL_BYTES;
    expect(peakHeld).toBeLessThanOrEqual(2 * perDecoder + 8);
  });

  it('drops a segment the moment it is committed', () => {
    const transfer = buildTransfer(bytes(200_000, 12), 0);
    const receiver = new SegmentedReceiver(transfer.manifest);

    const heldAfterFirstSegment: number[] = [];
    for (const frame of transfer.frames) {
      const result = receiver.acceptFrame(frame);
      if (result.segmentCompleted) heldAfterFirstSegment.push(receiver.heldBytes());
    }

    // After every commit the receiver holds only the bitmap: no decoder for a
    // finished segment survives to the next frame.
    for (const held of heldAfterFirstSegment) expect(held).toBe(1);
    expect(receiver.stats().activeSegments).toBe(0);
    expect(receiver.segmentsCommitted).toBe(4);
  });

  it('answers a frame for a committed segment without rebuilding a decoder', () => {
    const transfer = buildTransfer(bytes(200_000, 13), 0.5);
    const receiver = new SegmentedReceiver(transfer.manifest);
    for (const frame of transfer.frames) receiver.acceptFrame(frame);
    expect(receiver.isComplete).toBe(true);

    // A second display pass. Every frame is for a segment already written out.
    const before = receiver.stats();
    for (const frame of transfer.frames) {
      const result = receiver.acceptFrame(frame);
      expect(result.status).toBe(RECEIVE_ACCEPT.SEGMENT_COMMITTED);
    }
    const after = receiver.stats();

    expect(after.activeSegments).toBe(0);
    expect(after.xorBytes).toBe(before.xorBytes);
    expect(after.segmentsCommitted).toBe(before.segmentsCommitted);
    expect(receiver.heldBytes()).toBe(1);
  });

  it('carries no state from one segment into the next', () => {
    // Two segments whose contents are identical. If anything leaked - a solved
    // bitmap, an equation, a store - the second would appear pre-solved.
    const half = bytes(SEGMENT_BYTES, 14);
    const file = new Uint8Array(SEGMENT_BYTES * 2);
    file.set(half, 0);
    file.set(half, SEGMENT_BYTES);

    const transfer = buildTransfer(file, 0);
    const perSegment: Array<{ index: number; placed: number }> = [];
    const receiver = new SegmentedReceiver(transfer.manifest, {
      onSegmentComplete: (segment) => {
        perSegment.push({ index: segment.segmentIndex, placed: segment.symbolsRepaired });
      },
    });

    let firstSegmentFrames = 0;
    let secondSegmentFrames = 0;
    for (const frame of transfer.frames) {
      const result = receiver.acceptFrame(frame);
      if (result.status !== RECEIVE_ACCEPT.ACCEPTED) continue;
      if (frame.segmentIndex === 0) firstSegmentFrames += 1;
      else secondSegmentFrames += 1;
    }

    // Identical bytes cost identical work. The second segment is not cheaper.
    expect(firstSegmentFrames).toBe(SEGMENT_BYTES / SYMBOL_BYTES);
    expect(secondSegmentFrames).toBe(SEGMENT_BYTES / SYMBOL_BYTES);
    expect(perSegment).toEqual([{ index: 0, placed: 0 }, { index: 1, placed: 0 }]);
  });

  it('evicts the least recently advanced segment when the budget is full', () => {
    const transfer = buildTransfer(bytes(200_000, 15), 0);
    const receiver = new SegmentedReceiver(transfer.manifest, { maxActiveSegments: 1 });

    // One symbol each into segments 0, 1 and 2. With room for one decoder, each
    // new segment displaces the previous one and its partial work is lost.
    const first = transfer.frames.find((frame) => frame.segmentIndex === 0 && frame.symbolId === 0)!;
    const second = transfer.frames.find((frame) => frame.segmentIndex === 1 && frame.symbolId === 0)!;
    const third = transfer.frames.find((frame) => frame.segmentIndex === 2 && frame.symbolId === 0)!;

    receiver.acceptFrame(first);
    receiver.acceptFrame(second);
    receiver.acceptFrame(third);

    expect(receiver.stats().activeSegments).toBe(1);
    expect(receiver.stats().segmentsEvicted).toBe(2);
    expect(receiver.segmentsCommitted).toBe(0);

    // Nothing was committed on a guess: an evicted segment simply starts again.
    for (const frame of transfer.frames) receiver.acceptFrame(frame);
    expect(receiver.isComplete).toBe(true);
  });

  it('reports which live segments still need repair', () => {
    const transfer = buildTransfer(bytes(200_000, 16), 0);
    const receiver = new SegmentedReceiver(transfer.manifest, { maxActiveSegments: 2 });

    for (const frame of transfer.frames.filter((f) => f.segmentIndex === 0 && f.symbolId < 100)) {
      receiver.acceptFrame(frame);
    }

    const recovery = receiver.recovery();
    expect(recovery).toHaveLength(1);
    expect(recovery[0].segmentIndex).toBe(0);
    expect(recovery[0].solvedCount).toBe(100);
    expect(recovery[0].missingCount).toBe(28);
    expect(recovery[0].needsMoreRepair).toBe(true);
    expect(receiver.outstandingSegments()).toBe(4);
  });
});

/* ---------------------------------------------------------------- refusal */

describe('the receiver validates before it decodes', () => {
  const transfer = buildTransfer(bytes(200_000, 21), 0.25);

  function fresh(): SegmentedReceiver {
    return new SegmentedReceiver(transfer.manifest);
  }

  it('accepts a manifest for its own session and ignores it', () => {
    const receiver = fresh();
    const result = receiver.acceptFrameBytes(transfer.manifestBytes);
    expect(result.status).toBe(RECEIVE_ACCEPT.MANIFEST);
    expect(receiver.stats().manifestFrames).toBe(1);
    expect(receiver.stats().activeSegments).toBe(0);
  });

  it('rejects a manifest for a different session', () => {
    const other = serializeManifestFrame({ ...transfer.manifest, sessionId: 0x1234_5678 });
    const result = fresh().acceptFrameBytes(other);
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('SESSION_MISMATCH');
  });

  it('rejects a data frame from a foreign session or file', () => {
    for (const [field, value] of [['sessionId', 0x9999_0000], ['fileId', 0x8888_0000]] as const) {
      const result = fresh().acceptFrame({ ...transfer.frames[0], [field]: value });
      expect(result.status, field).toBe(RECEIVE_ACCEPT.REJECTED);
      expect(result.reason, field).toBe('SESSION_MISMATCH');
    }
  });

  it('rejects a segment index outside the manifest', () => {
    const result = fresh().acceptFrame({ ...transfer.frames[0], segmentIndex: 99 });
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('SEGMENT_OUT_OF_RANGE');
  });

  it('rejects a source-symbol count the manifest does not imply', () => {
    const result = fresh().acceptFrame({ ...transfer.frames[0], sourceSymbolCount: 7 });
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('INCONSISTENT_MANIFEST');
  });

  it('rejects a payload that is not one symbol long', () => {
    const result = fresh().acceptFrame({ ...transfer.frames[0], payload: new Uint8Array(SYMBOL_BYTES - 1) });
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('FIELD_OUT_OF_RANGE');
  });

  it('rejects a frame whose CRC does not match its contents', () => {
    const corrupted = transfer.frameBytes[0].slice();
    // A payload byte, so the header still parses and only the CRC can catch it.
    corrupted[V2_DATA_LAYOUT.payload + 4] ^= 0xff;

    const receiver = fresh();
    const result = receiver.acceptFrameBytes(corrupted);
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('CRC_MISMATCH');
    // Refused before any decoder existed, so a corrupt frame cannot start one.
    expect(receiver.stats().activeSegments).toBe(0);
  });

  it('names a v1 frame as a v1 frame rather than as corruption', () => {
    const v1 = serializeFrame({
      header: {
        protocolVersion: FRAME_PROTOCOL_VERSION,
        sessionId: 1,
        segmentNumber: 0,
        sequenceNumber: 0,
        blockCount: 4,
        blockSize: 512,
        totalPayloadLength: 2048,
      },
      payload: Buffer.alloc(512),
    });

    const result = fresh().acceptFrameBytes(new Uint8Array(v1));
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('V1_FRAME');
  });

  it('rejects a payload that is not a DEQR frame at all', () => {
    const result = fresh().acceptFrameBytes(new TextEncoder().encode('https://example.invalid'));
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('BAD_MAGIC');
  });

  it('refuses a manifest declaring more segments than the receiver will track', () => {
    expect(() => new SegmentedReceiver(transfer.manifest, { maxSegmentCount: 2 }))
      .toThrow(/above this receiver's limit/);
  });

  it('drives a whole transfer through the byte-level entry point', () => {
    const sink = collector(200_000);
    const receiver = new SegmentedReceiver(transfer.manifest, { onSegmentComplete: sink.sink });

    // Manifest repeats interleaved with data, the way the sender emits them.
    for (const [index, frameBytes] of transfer.frameBytes.entries()) {
      if (index % 64 === 0) receiver.acceptFrameBytes(transfer.manifestBytes);
      receiver.acceptFrameBytes(frameBytes);
    }

    expect(receiver.isComplete).toBe(true);
    expect(sha256(sink.file)).toBe(sha256(transfer.file));
    expect(receiver.stats().manifestFrames).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------- lifecycle */

describe('cancel and reset', () => {
  it('drops every decoder on release and refuses afterwards', () => {
    const transfer = buildTransfer(bytes(200_000, 31), 0.25);
    const receiver = new SegmentedReceiver(transfer.manifest);

    for (const frame of transfer.frames.slice(0, 60)) receiver.acceptFrame(frame);
    expect(receiver.stats().activeSegments).toBe(1);
    expect(receiver.heldBytes()).toBeGreaterThan(SEGMENT_BYTES);

    receiver.release();

    expect(receiver.isReleased).toBe(true);
    expect(receiver.heldBytes()).toBe(1);
    const result = receiver.acceptFrame(transfer.frames[0]);
    expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
    expect(result.reason).toBe('session-released');
    expect(receiver.acceptFrameBytes(transfer.frameBytes[0]).reason).toBe('session-released');
  });

  it('starts clean when a released receive is replaced by a new one', () => {
    const transfer = buildTransfer(bytes(200_000, 32), 0.25);
    const abandoned = new SegmentedReceiver(transfer.manifest);
    for (const frame of transfer.frames.slice(0, 200)) abandoned.acceptFrame(frame);
    abandoned.release();

    const sink = collector(200_000);
    const restarted = new SegmentedReceiver(transfer.manifest, { onSegmentComplete: sink.sink });
    expect(restarted.segmentsCommitted).toBe(0);
    for (const frame of transfer.frames) restarted.acceptFrame(frame);

    expect(restarted.isComplete).toBe(true);
    expect(sha256(sink.file)).toBe(sha256(transfer.file));
  });

  it('releases mid-recovery with equations still outstanding', () => {
    const transfer = buildTransfer(bytes(200_000, 33), 2.0);
    const receiver = new SegmentedReceiver(transfer.manifest);

    // Repair symbols for segment 0 only, with no source symbols at all: every
    // one of them becomes an equation that cannot resolve.
    const repairOnly = transfer.frames.filter(
      (frame) => frame.segmentIndex === 0 && frame.frameType === V2_FRAME_TYPE.REPAIR,
    );
    for (const frame of repairOnly) receiver.acceptFrame(frame);
    expect(receiver.recovery()[0].pendingEquations).toBeGreaterThan(0);

    receiver.release();
    expect(receiver.recovery()).toEqual([]);
    expect(receiver.heldBytes()).toBe(1);
  });
});
