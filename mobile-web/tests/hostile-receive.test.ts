import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  V2_COMPRESSION,
  V2_COMPRESSION_WINDOW,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  V2_LIMITS,
  V2_MAGIC_0,
  V2_MAGIC_1,
  V2_MANIFEST_LAYOUT,
  V2_PROTOCOL_VERSION,
  V2_WINDOW_LENGTH_PREFIX_BYTES,
  parseManifestFrame,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
  type DeqrV2Manifest,
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import { crc32 } from '../../src/core/crc32';
import { RECEIVER_POLICY } from '../../src/core/receiver-policy';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { digestToHex } from '../../src/core/sha256-stream';
import {
  CHECKPOINT_SCHEMA,
  MAX_CHECKPOINT_BYTES,
  OPFS_CHECKPOINT_FILE,
  OPFS_DATA_FILE,
  OPFS_ORIGINAL_FILE,
  bytesToBase64,
  isReceiverSessionFile,
  isReceiverSessionPath,
  matchCheckpoint,
  readCheckpointEntry,
  sessionDirectoryName,
  sessionPath,
  type SessionCheckpoint,
} from '../src/opfs';
import { inflateWindowContainer } from '../src/inflate-verify';
import { ReceivePipeline } from '../src/receive-pipeline';
import { ReceiverStorage } from '../src/receiver-storage';
import {
  MANIFEST_POLICY_FAULT_CODES,
  faultCopy,
  isCapacityFault,
  isStorageFault,
} from '../src/receiver-view-model';
import { BoundedMemoryOriginalSink, STORE_WRITE } from '../src/segment-store';
import {
  RECEIVE_WORKER_PROTOCOL,
  isReceiveWorkerEvent,
  isReceiveWorkerRequest,
} from '../src/worker-protocol';
import { FakeStorage, fakeEnvironment } from './helpers/fake-opfs';

/**
 * Phase 10's gate, driven through the receiver a phone actually runs.
 *
 * The parser suites prove no byte string can make a *parse* misbehave. This
 * file asks the next question: what happens when the malformed thing gets past
 * the parser because it is not a frame at all - a manifest that is well formed
 * and asks for a terabyte, a container that decompresses to more than it
 * declared, a checkpoint on the device that says bytes are present which are
 * not, a `postMessage` naming a file the receiver never wrote.
 *
 * The property throughout is the same one: **fail closed, without unbounded
 * allocation, without an arbitrary file being opened, and without a false
 * verified state.** Each refusal is asserted by its enumerated code, because a
 * refusal a user cannot act on is only half of one.
 */

/* ----------------------------------------------------------------- fixtures */

const SESSION_ID = 0x51c0_0110;
const FILE_ID = 0x0dd0_0f1e;
const SEGMENT_BYTES = 65_536;
const SYMBOL_BYTES = 512;
const WINDOW_LOG2 = V2_COMPRESSION_WINDOW.minLog2;
const WINDOW = 2 ** WINDOW_LOG2;

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function manifestFor(file: Uint8Array, overrides: Partial<DeqrV2Manifest> = {}): DeqrV2Manifest {
  const transportSize = BigInt(file.length);
  const plan = planSegmentation({
    transportSize,
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
  });
  return {
    featureFlags: 0,
    sessionId: SESSION_ID,
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
    ...overrides,
  };
}

/** Source and repair frames for a whole transfer, as the sender emits them. */
function framesFor(file: Uint8Array, manifest: DeqrV2Manifest, plan: SegmentPlan): Uint8Array[] {
  const out: Uint8Array[] = [];
  const encoder = new SegmentEncoder(manifest.symbolSizeBytes);
  for (let segmentIndex = 0; segmentIndex < plan.segmentCount; segmentIndex += 1) {
    const range = segmentByteRange(plan, segmentIndex);
    encoder.loadSegment(file.subarray(Number(range.start), Number(range.end)));
    const sourceSymbolCount = sourceSymbolCountForSegment(plan, segmentIndex);
    for (let symbolId = 0; symbolId < sourceSymbolCount; symbolId += 1) {
      const payload = new Uint8Array(manifest.symbolSizeBytes);
      encoder.symbolInto(symbolId, payload);
      out.push(serializeDataFrame({
        frameType: V2_FRAME_TYPE.SOURCE,
        sessionId: manifest.sessionId,
        fileId: manifest.fileId,
        segmentIndex,
        symbolId,
        sourceSymbolCount,
        frameFlags: 0,
        payload,
      }));
    }
  }
  encoder.release();
  return out;
}

/**
 * Rewrites a serialized manifest's fields and repairs its CRC.
 *
 * The serializer refuses everything below, correctly - it is our own side of
 * the wire. A hostile sender has a QR generator and no such constraint, so the
 * frames here are edited after serialization, which is exactly what would
 * arrive at a camera.
 */
function forgeManifest(
  frame: Uint8Array,
  edits: (view: DataView, out: Uint8Array) => void,
): Uint8Array {
  const out = frame.slice();
  edits(new DataView(out.buffer), out);
  new DataView(out.buffer).setUint32(out.length - 4, crc32(out, 0, out.length - 4));
  return out;
}

/** One window record: a big-endian length in front of a gzip member. */
function record(member: Uint8Array): Uint8Array {
  const out = new Uint8Array(V2_WINDOW_LENGTH_PREFIX_BYTES + member.length);
  new DataView(out.buffer).setUint32(0, member.length, false);
  out.set(member, V2_WINDOW_LENGTH_PREFIX_BYTES);
  return out;
}

/** A `CompressedSource` over a plain buffer, which is all inflation needs. */
function sourceOver(container: Uint8Array) {
  return {
    read(offset: number, into: Uint8Array): number {
      if (offset < 0 || offset >= container.length) return 0;
      const take = Math.min(into.length, container.length - offset);
      into.set(container.subarray(offset, offset + take), 0);
      return take;
    },
  };
}

/* ------------------------------------------------------------- frame budget */

describe('a decoded payload is bounded before it is looked at', () => {
  it('refuses anything longer than the largest frame either protocol can carry', () => {
    const pipeline = new ReceivePipeline();
    const oversized = new Uint8Array(RECEIVER_POLICY.maxFrameBytes + 1);
    oversized[0] = V2_MAGIC_0;
    oversized[1] = V2_MAGIC_1;
    oversized[2] = V2_PROTOCOL_VERSION;
    oversized[3] = V2_FRAME_TYPE.SOURCE;

    const result = pipeline.submit(oversized);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('FRAME_TOO_LONG');
    // Not fingerprinted either, so a flood of long payloads cannot evict the
    // dedupe set that a real transfer depends on.
    expect(pipeline.progress().framesDuplicate).toBe(0);
  });

  it('still accepts a frame at exactly the bound', () => {
    const pipeline = new ReceivePipeline();
    const atLimit = new Uint8Array(RECEIVER_POLICY.maxFrameBytes);
    // Not a DEQR frame, so `NOT_DEQR` - the point is that the length gate did
    // not fire and the payload reached the version detector.
    expect(pipeline.submit(atLimit).reason).toBe('NOT_DEQR');
  });

  it('never throws on random payloads, whatever they are shaped like', () => {
    const pipeline = new ReceivePipeline();
    let state = 0xa5a5_a5a5;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);

    for (let iteration = 0; iteration < 5_000; iteration += 1) {
      const length = next() % (RECEIVER_POLICY.maxFrameBytes + 64);
      const frame = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) frame[index] = next() >>> 24;
      if (iteration % 3 === 0 && length >= 4) {
        // Force the v2 prefix on a third of them, so the interesting paths are
        // reached rather than bounced at the magic.
        frame[0] = V2_MAGIC_0;
        frame[1] = V2_MAGIC_1;
        frame[2] = V2_PROTOCOL_VERSION;
        frame[3] = 1 + (next() % 3);
      }
      expect(() => pipeline.submit(frame)).not.toThrow();
    }
    expect(pipeline.isComplete).toBe(false);
    expect(pipeline.heldBytes()).toBe(0);
  });
});

/* ---------------------------------------------------------- manifest budgets */

describe('a manifest cannot make the receiver reserve what it likes', () => {
  const file = bytes(SEGMENT_BYTES * 2, 3);
  const manifest = manifestFor(file);
  const manifestBytes = serializeManifestFrame(manifest);

  async function refusalFor(
    frame: Uint8Array,
    storage: FakeStorage,
  ): Promise<{ reason?: string; fault?: string }> {
    const pipeline = new ReceivePipeline({
      storage: new ReceiverStorage({ environment: { storage, supportsSyncAccess: true } }),
    });
    const result = pipeline.submit(frame);
    await pipeline.whenStorageReady();
    // Both, because they answer different questions: the frame was refused,
    // and the session is dead rather than merely quiet. Only the second
    // reaches a screen.
    return { reason: result.reason, fault: pipeline.progress().fault };
  }

  it('refuses a segment count above the policy before any storage is touched', async () => {
    const { storage } = fakeEnvironment();
    // A segment count past the bitmap budget, with the sizes rewritten to keep
    // the manifest self-consistent so the parser admits it and the *policy* is
    // what refuses.
    const hostile = forgeManifest(manifestBytes, (view) => {
      const segmentSize = V2_LIMITS.maxSegmentSizeBytes;
      const segments = BigInt(RECEIVER_POLICY.maxSegmentCount + 1);
      view.setUint32(V2_MANIFEST_LAYOUT.segmentSizeBytes, segmentSize);
      view.setUint16(V2_MANIFEST_LAYOUT.symbolSizeBytes, V2_LIMITS.minSymbolSizeBytes);
      view.setUint32(V2_MANIFEST_LAYOUT.segmentCount, RECEIVER_POLICY.maxSegmentCount + 1);
      const transport = BigInt(segmentSize) * segments;
      view.setBigUint64(V2_MANIFEST_LAYOUT.originalSize, transport);
      view.setBigUint64(V2_MANIFEST_LAYOUT.transportSize, transport);
    });

    const refusal = await refusalFor(hostile, storage);
    expect(refusal.reason).toBe('SEGMENT_COUNT_EXCEEDED');
    // And the session is dead rather than quietly still scanning. A refusal
    // nothing can see leaves someone holding a phone at a screen that will
    // never advance.
    expect(refusal.fault).toBe('SEGMENT_COUNT_EXCEEDED');
    // Nothing was created on the device: the refusal happened at the manifest.
    expect(storage.sessionNames()).toEqual([]);
    expect(storage.usedBytes()).toBe(0);
  });

  it('refuses a segment larger than one decoder may hold', async () => {
    const { storage } = fakeEnvironment();
    const hostile = forgeManifest(manifestBytes, (view) => {
      // 128 MiB segments: twice the protocol's own ceiling, so the parser's
      // `planSegmentation` refuses it first. Reported as an inconsistent
      // manifest, which is the honest description of a frame the format
      // cannot express.
      view.setUint32(V2_MANIFEST_LAYOUT.segmentSizeBytes, V2_LIMITS.maxSegmentSizeBytes * 2);
    });
    const pipeline = new ReceivePipeline({
      storage: new ReceiverStorage({ environment: { storage, supportsSyncAccess: true } }),
    });
    const result = pipeline.submit(hostile);
    expect(result.outcome).toBe('rejected');
    expect(storage.usedBytes()).toBe(0);
  });

  it('accepts an ordinary manifest, so the bound is a bound and not an aversion', async () => {
    const { storage } = fakeEnvironment();
    const refusal = await refusalFor(manifestBytes, storage);
    expect(refusal.reason).toBeUndefined();
    expect(refusal.fault).toBeUndefined();
    expect(storage.sessionNames()).toEqual([sessionDirectoryName(SESSION_ID, FILE_ID)]);
  });
});

/* ------------------------------------------------------------- filenames */

describe('a filename from the wire never becomes a path', () => {
  const file = bytes(1_024, 4);

  it('sanitizes traversal, separators and control characters out of a manifest', () => {
    for (const hostile of [
      '../../../../etc/passwd',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      'a/b/c/payload.bin',
      '..\\..\\payload.bin',
      'nul\u0000byte.bin',
      '   ...   ',
      '.'.repeat(300),
      '\u0007\u001b[2Jclear.bin',
    ]) {
      const frame = serializeManifestFrame(manifestFor(file, { filename: hostile }));
      const parsed = parseManifestFrame(frame);
      expect(parsed.ok, hostile).toBe(true);
      if (!parsed.ok) continue;
      // The serializer sanitizes on the way out and the parser sanitizes again
      // on the way in, so the name a receiver holds cannot carry a separator,
      // a traversal, a control character or a null - whichever side produced it.
      const name = parsed.value.filename;
      expect(name, hostile).not.toMatch(/[\\/]/);
      expect(name, hostile).not.toContain('..');
      expect(name, hostile).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(name.length, hostile).toBeGreaterThan(0);
      expect(name.length, hostile).toBeLessThanOrEqual(255);
    }
  });

  it('derives the session directory from the identifiers, never from the filename', () => {
    // The one place a name could reach a path. Both fields are u32 rendered as
    // fixed-width hex, which is filename-safe by construction.
    expect(sessionDirectoryName(SESSION_ID, FILE_ID)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(isReceiverSessionPath(sessionPath(SESSION_ID, FILE_ID))).toBe(true);
    expect(isReceiverSessionPath(sessionPath(0, 0))).toBe(true);
    expect(isReceiverSessionPath(sessionPath(0xffff_ffff, 0xffff_ffff))).toBe(true);
  });

  it('refuses a blocked extension at the manifest rather than after the transfer', async () => {
    const { storage } = fakeEnvironment();
    const pipeline = new ReceivePipeline({
      storage: new ReceiverStorage({ environment: { storage, supportsSyncAccess: true } }),
    });
    const frame = serializeManifestFrame(manifestFor(file, { filename: 'payload.exe' }));
    const result = pipeline.submit(frame);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('FILE_TYPE_BLOCKED');
    // Refused before storage, so nobody is asked to scan a file they will not
    // be given.
    expect(storage.usedBytes()).toBe(0);
  });
});

/* --------------------------------------------------------- decompression bombs */

describe('decompression bombs expand into a buffer, never into an allocation', () => {
  const windows = { windowBytes: WINDOW, windowCount: 1, lastWindowBytes: WINDOW };

  it('stops a member that produces more than its window declares', async () => {
    // 64 MiB of zeros gzips to a few kilobytes. The manifest says this window
    // holds 64 KiB, and that number - not anything in the stream - is the
    // bound the decompressor is given.
    const bomb = gzipSync(new Uint8Array(64 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(WINDOW);
    const container = record(new Uint8Array(bomb));
    const sink = new BoundedMemoryOriginalSink(WINDOW);

    const result = await inflateWindowContainer(sourceOver(container), sink, {
      transportSize: container.length,
      originalSize: WINDOW,
      windows,
      yieldTo: async () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('DECOMPRESSED_SIZE_MISMATCH');
    // The sink is still exactly one window: nothing grew to hold the bomb.
    expect(sink.residentBytes()).toBe(WINDOW);
  });

  it('refuses a record length above zlib own expansion ceiling before reading it', async () => {
    const container = new Uint8Array(V2_WINDOW_LENGTH_PREFIX_BYTES + 64);
    // A declared length far beyond anything a window of this size could
    // compress to, and beyond the container itself.
    new DataView(container.buffer).setUint32(0, 0xffff_ffff, false);

    const result = await inflateWindowContainer(
      sourceOver(container),
      new BoundedMemoryOriginalSink(WINDOW),
      { transportSize: container.length, originalSize: WINDOW, windows, yieldTo: async () => undefined },
    );
    expect(result.ok === false && result.code).toBe('COMPRESSED_CONTAINER_INVALID');
  });

  it('refuses a window that decompresses short', async () => {
    const container = record(new Uint8Array(gzipSync(bytes(WINDOW - 1, 9))));
    const result = await inflateWindowContainer(
      sourceOver(container),
      new BoundedMemoryOriginalSink(WINDOW),
      { transportSize: container.length, originalSize: WINDOW, windows, yieldTo: async () => undefined },
    );
    expect(result.ok === false && result.code).toBe('DECOMPRESSED_SIZE_MISMATCH');
  });

  it('refuses a member that is not gzip at all', async () => {
    const container = record(bytes(512, 10));
    const result = await inflateWindowContainer(
      sourceOver(container),
      new BoundedMemoryOriginalSink(WINDOW),
      { transportSize: container.length, originalSize: WINDOW, windows, yieldTo: async () => undefined },
    );
    expect(result.ok === false && result.code).toBe('DECOMPRESSION_FAILED');
  });

  it('refuses bytes past the last window', async () => {
    const member = record(new Uint8Array(gzipSync(bytes(WINDOW, 11))));
    const container = new Uint8Array(member.length + 16);
    container.set(member);
    const result = await inflateWindowContainer(
      sourceOver(container),
      new BoundedMemoryOriginalSink(WINDOW),
      { transportSize: container.length, originalSize: WINDOW, windows, yieldTo: async () => undefined },
    );
    expect(result.ok === false && result.code).toBe('COMPRESSED_CONTAINER_INVALID');
  });

  it('refuses a sink write outside the file it was opened for', () => {
    const sink = new BoundedMemoryOriginalSink(1_024);
    expect(sink.write(1_000, bytes(64, 12))).toBe(STORE_WRITE.INVALID);
    expect(sink.write(-1, bytes(8, 13))).toBe(STORE_WRITE.INVALID);
    expect(sink.write(0, bytes(64, 14))).toBe(STORE_WRITE.OK);
  });
});

/* ------------------------------------------------------------ checkpoints */

describe('a checkpoint on the device is untrusted input', () => {
  const file = bytes(SEGMENT_BYTES * 4, 15);
  const plan = planSegmentation({
    transportSize: BigInt(file.length),
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
  });
  const digest = createHash('sha256').update(file).digest();

  function baseCheckpoint(overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
    const bits = new Uint8Array(Math.ceil(plan.segmentCount / 8));
    return {
      schema: CHECKPOINT_SCHEMA,
      protocol: 2,
      sessionId: SESSION_ID,
      fileId: FILE_ID,
      filename: 'hostile.bin',
      mimeType: 'application/octet-stream',
      originalSize: String(file.length),
      transportSize: String(file.length),
      segmentSizeBytes: SEGMENT_BYTES,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentCount: plan.segmentCount,
      sha256: digestToHex(digest),
      dataFile: OPFS_DATA_FILE,
      createdAt: 1_000,
      updatedAt: 2_000,
      bytesCommitted: 0,
      segmentsCommitted: 0,
      committed: bytesToBase64(bits),
      state: 'receiving',
      ...overrides,
    };
  }

  function match(checkpoint: SessionCheckpoint) {
    return matchCheckpoint({
      checkpoint,
      present: true,
      sessionId: SESSION_ID,
      fileId: FILE_ID,
      sha256Hex: digestToHex(digest),
      transportSize: BigInt(file.length),
      segmentSizeBytes: SEGMENT_BYTES,
      symbolSizeBytes: SYMBOL_BYTES,
      segmentCount: plan.segmentCount,
      expectedBytes: () => 0,
    });
  }

  it('adopts a checkpoint that agrees with the manifest in every field', () => {
    expect(match(baseCheckpoint()).ok).toBe(true);
  });

  it('refuses a committed bitmap larger than the policy admits, before decoding it', () => {
    // The decode allocates three bytes for every four characters. A checkpoint
    // carrying a hundred megabytes of base64 must cost a length comparison.
    const enormous = 'A'.repeat(RECEIVER_POLICY.maxCommittedBase64Chars + 4);
    const outcome = match(baseCheckpoint({ committed: enormous }));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe('CHECKPOINT_UNREADABLE');
  });

  it('refuses a bitmap whose counters do not add up', () => {
    const bits = new Uint8Array(Math.ceil(plan.segmentCount / 8));
    bits[0] = 0b0000_0011;
    const outcome = match(baseCheckpoint({ committed: bytesToBase64(bits), segmentsCommitted: 900 }));
    expect(outcome.ok === false && outcome.code).toBe('CHECKPOINT_INCONSISTENT');
  });

  it('refuses bits set past the last segment', () => {
    const width = Math.ceil(plan.segmentCount / 8);
    const bits = new Uint8Array(width).fill(0xff);
    const spare = plan.segmentCount & 7;
    // Only meaningful when the segment count is not a multiple of eight; this
    // fixture is chosen so it is not.
    expect(spare).not.toBe(0);
    const outcome = match(baseCheckpoint({
      committed: bytesToBase64(bits),
      segmentsCommitted: plan.segmentCount,
    }));
    expect(outcome.ok === false && outcome.code).toBe('CHECKPOINT_INCONSISTENT');
  });

  it('refuses a checkpoint for a different file, session, or segmentation', () => {
    expect(match(baseCheckpoint({ sessionId: SESSION_ID + 1 })).ok === false
      && match(baseCheckpoint({ sessionId: SESSION_ID + 1 })).ok === false).toBe(true);
    const outcomes = [
      [baseCheckpoint({ sessionId: SESSION_ID + 1 }), 'CHECKPOINT_SESSION_MISMATCH'],
      [baseCheckpoint({ fileId: FILE_ID + 1 }), 'CHECKPOINT_SESSION_MISMATCH'],
      [baseCheckpoint({ sha256: 'f'.repeat(64) }), 'CHECKPOINT_FILE_MISMATCH'],
      [baseCheckpoint({ segmentCount: plan.segmentCount + 1 }), 'CHECKPOINT_PLAN_MISMATCH'],
      [baseCheckpoint({ symbolSizeBytes: SYMBOL_BYTES * 2 }), 'CHECKPOINT_PLAN_MISMATCH'],
      [baseCheckpoint({ transportSize: String(file.length + 1) }), 'CHECKPOINT_PLAN_MISMATCH'],
    ] as const;
    for (const [checkpoint, code] of outcomes) {
      const outcome = match(checkpoint);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.code).toBe(code);
    }
  });

  it('refuses a checkpoint file above the size bound without reading its text', async () => {
    const { storage } = fakeEnvironment();
    const root = storage.root;
    const deqr = await root.getDirectoryHandle('deqr', { create: true });
    const sessions = await deqr.getDirectoryHandle('sessions', { create: true });
    const directory = await sessions.getDirectoryHandle(
      sessionDirectoryName(SESSION_ID, FILE_ID),
      { create: true },
    );
    const handle = await directory.getFileHandle(OPFS_CHECKPOINT_FILE, { create: true });
    const writable = await handle.createWritable!();
    await writable.write('x'.repeat(MAX_CHECKPOINT_BYTES + 1));
    await writable.close();

    const read = await readCheckpointEntry(directory);
    // Present and unusable, which is the answer that makes the caller clear
    // the directory rather than pre-size a file next to unaccountable bytes.
    expect(read.present).toBe(true);
    expect(read.checkpoint).toBeNull();
  });
});

/* ------------------------------------------------- the worker message boundary */

describe('the worker message boundary opens only what this receiver wrote', () => {
  const path = sessionPath(SESSION_ID, FILE_ID);

  function verifiedEvent(source: unknown): unknown {
    return {
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'verified',
      epoch: 1,
      filename: 'hostile.bin',
      mimeType: 'application/octet-stream',
      size: 10,
      sha256: new ArrayBuffer(32),
      source,
    };
  }

  it('admits both payload files a session can produce', () => {
    // The regression this covers: the guard named only `data.part` while a
    // compressed transfer exports `original.part`, so a completed, verified
    // compressed transfer was discarded on arrival at the main thread.
    expect(isReceiverSessionFile(OPFS_DATA_FILE)).toBe(true);
    expect(isReceiverSessionFile(OPFS_ORIGINAL_FILE)).toBe(true);
    for (const file of [OPFS_DATA_FILE, OPFS_ORIGINAL_FILE]) {
      expect(isReceiveWorkerEvent(verifiedEvent({ kind: 'opfs', path, file }))).toBe(true);
    }
  });

  it('refuses every other filename, including its own metadata', () => {
    for (const file of [
      OPFS_CHECKPOINT_FILE,
      '../data.part',
      'data.part\u0000',
      '',
      'DATA.PART',
      undefined,
      null,
      42,
    ]) {
      expect(isReceiverSessionFile(file), String(file)).toBe(false);
      expect(isReceiveWorkerEvent(verifiedEvent({ kind: 'opfs', path, file }))).toBe(false);
    }
  });

  it('refuses every path shape that is not one session directory', () => {
    for (const hostile of [
      [],
      ['deqr'],
      ['deqr', 'sessions'],
      ['deqr', 'sessions', '..'],
      ['deqr', 'sessions', 'aaaaaaaa-bbbbbbbb', 'extra'],
      ['deqr', 'other', 'aaaaaaaa-bbbbbbbb'],
      ['..', 'sessions', 'aaaaaaaa-bbbbbbbb'],
      ['deqr', 'sessions', 'AAAAAAAA-BBBBBBBB'],
      ['deqr', 'sessions', 'aaaaaaa-bbbbbbbb'],
    ]) {
      expect(isReceiverSessionPath(hostile), JSON.stringify(hostile)).toBe(false);
      expect(isReceiveWorkerEvent(verifiedEvent({ kind: 'opfs', path: hostile, file: OPFS_DATA_FILE })))
        .toBe(false);
    }
  });

  it('lets a real compressed OPFS transfer through the guard end to end', async () => {
    // The regression above, proved against the pipeline rather than against
    // the predicate. A compressed transfer written to OPFS seals from
    // `original.part`, and until Phase 10 the guard threw that message away -
    // so this test fails on the old code with a verified file that vanished.
    const original = new TextEncoder().encode('deqr '.repeat(20_000));
    // One record per window, exactly as the sender frames it. The window count
    // is derived from `originalSize`, so a single record over the whole file
    // would be a container the manifest does not describe.
    const records: Uint8Array[] = [];
    for (let at = 0; at < original.length; at += WINDOW) {
      records.push(record(new Uint8Array(
        gzipSync(original.subarray(at, Math.min(at + WINDOW, original.length)), { level: 6 }),
      )));
    }
    const container = new Uint8Array(records.reduce((sum, part) => sum + part.length, 0));
    records.reduce((offset, part) => {
      container.set(part, offset);
      return offset + part.length;
    }, 0);
    const digest = createHash('sha256').update(original).digest();
    const plan = planSegmentation({
      transportSize: BigInt(container.length),
      segmentSizeBytes: SEGMENT_BYTES,
      symbolSizeBytes: SYMBOL_BYTES,
    });
    const manifest = manifestFor(original, {
      originalSize: BigInt(original.length),
      transportSize: BigInt(container.length),
      segmentCount: plan.segmentCount,
      compressionMode: V2_COMPRESSION.GZIP,
      compressionParam: WINDOW_LOG2,
      sha256: digest,
      filename: 'compressed.bin',
    });

    const { storage } = fakeEnvironment();
    const pipeline = new ReceivePipeline({
      storage: new ReceiverStorage({ environment: { storage, supportsSyncAccess: true } }),
    });
    pipeline.submit(serializeManifestFrame(manifest));
    await pipeline.whenStorageReady();
    for (const frame of framesFor(container, manifest, plan)) pipeline.submit(frame);

    const verified = await pipeline.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.source.kind).toBe('opfs');
    if (verified.value.source.kind !== 'opfs') return;
    // The file it names is the decompressed one, and the guard on the main
    // thread accepts the message carrying it.
    expect(verified.value.source.file).toBe(OPFS_ORIGINAL_FILE);
    expect(isReceiveWorkerEvent(verifiedEvent({
      kind: 'opfs',
      path: verified.value.source.path,
      file: verified.value.source.file,
    }))).toBe(true);
  });

  it('refuses a message from a mismatched bundle before reading a field', () => {
    expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL - 1, type: 'close', epoch: 1 })).toBe(false);
    expect(isReceiveWorkerEvent({ v: RECEIVE_WORKER_PROTOCOL + 1, type: 'ready', acceptsBitmap: true })).toBe(false);
  });

  it('refuses a frame request whose pixel payload disagrees with its dimensions', () => {
    // The worker checks this again against `maxDecodePixels`; this is the shape
    // check that runs first, and it is what keeps a malformed message from
    // being read positionally at all.
    expect(isReceiveWorkerRequest({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'frame',
      epoch: 1,
      frameId: 1,
      capturedAt: 0,
      width: 10,
      height: 10,
      captureScale: 1,
    })).toBe(false);
    expect(isReceiveWorkerRequest({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'frame',
      epoch: 1,
      frameId: -1,
      capturedAt: 0,
      width: 10,
      height: 10,
      captureScale: 1,
      pixels: new ArrayBuffer(400),
    })).toBe(false);
  });

  it('refuses a session end reason it does not recognise', () => {
    // Guessing here would mean guessing whether to delete a partial transfer.
    for (const reason of ['keep', 'discard', 1, {}]) {
      expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'close', epoch: 1, reason }))
        .toBe(false);
    }
    for (const reason of ['cancelled', 'failed', 'interrupted', 'completed', undefined]) {
      expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'reset', epoch: 1, reason }))
        .toBe(true);
    }
  });
});

/* ------------------------------------------------------------- refusal copy */

describe('every Phase 10 refusal has something to say to the person holding the phone', () => {
  it('explains a manifest the receiver will not act on, and where the remedy is', () => {
    for (const code of MANIFEST_POLICY_FAULT_CODES) {
      const copy = faultCopy({ kind: 'transfer', code });
      expect(copy.heading.length).toBeGreaterThan(0);
      expect(copy.action, code).not.toBeNull();
      // Nothing was scanned and nothing is retained, so the only thing that can
      // change the outcome is on the other device.
      expect(copy.senderSide, code).toBe(true);
    }
  });

  it('does not classify a manifest refusal as a storage problem', () => {
    // Freeing space cannot change the answer, and sending someone to delete
    // photos over a segmentation they cannot see would be worse than silence.
    for (const code of MANIFEST_POLICY_FAULT_CODES) {
      expect(isStorageFault(code), code).toBe(false);
      expect(isCapacityFault(code), code).toBe(false);
    }
  });
});

/* --------------------------------------------------- cancel under a hostile stream */

describe('cancelling while a hostile stream is running', () => {
  it('leaves nothing on the device and refuses everything after', async () => {
    const file = bytes(SEGMENT_BYTES * 2, 17);
    const manifest = manifestFor(file);
    const plan = planSegmentation({
      transportSize: manifest.transportSize,
      segmentSizeBytes: SEGMENT_BYTES,
      symbolSizeBytes: SYMBOL_BYTES,
    });
    const { storage } = fakeEnvironment();
    const pipeline = new ReceivePipeline({
      storage: new ReceiverStorage({ environment: { storage, supportsSyncAccess: true } }),
    });

    pipeline.submit(serializeManifestFrame(manifest));
    await pipeline.whenStorageReady();
    const frames = framesFor(file, manifest, plan);
    for (const frame of frames.slice(0, 40)) pipeline.submit(frame);

    pipeline.release('cancelled');
    await pipeline.settled();

    // The directory is gone, and a released pipeline answers everything the
    // same way whatever is pointed at it.
    expect(storage.sessionNames()).toEqual([]);
    for (const frame of frames) {
      expect(pipeline.submit(frame).reason).toBe('RELEASED');
    }
    await expect(pipeline.verify()).resolves.toMatchObject({ ok: false, code: 'RELEASED' });
  });
});
