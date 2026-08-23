import { describe, expect, it } from 'vitest';

import {
  V2_COMPRESSION,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  type DeqrV2Manifest,
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { OPFS_DATA_FILE, readCheckpoint, sessionDirectoryName } from '../src/opfs';
import {
  ReceivePipeline,
  SESSION_END,
  VERIFY_YIELD_BYTES,
  digestSegmentStore,
  type VerifyProgress,
} from '../src/receive-pipeline';
import { ReceiverStorage } from '../src/receiver-storage';
import { BoundedMemorySegmentStore } from '../src/segment-store';
import { FakeStorage, fakeEnvironment } from './helpers/fake-opfs';

/**
 * Integrity, and what it is allowed to let through.
 *
 * The phase's rule is one sentence: a transfer is never `verified` until
 * SHA-256 over the reconstructed original bytes matches the manifest. This file
 * is that sentence held to account from both directions - the digest has to
 * catch corruption wherever it was introduced, and a transfer that fails it
 * must produce no export route at all, not a route that the caller is trusted
 * to ignore.
 *
 * The second theme is that verification is *reported*. Hashing a gigabyte takes
 * about nine seconds, during which transfer progress is complete and frozen. A
 * receiver that says nothing for those nine seconds looks hung at exactly the
 * moment somebody is watching it hardest.
 */

/* ----------------------------------------------------------------- fixtures */

const SESSION_ID = 0x5eed_0107;
const FILE_ID = 0x0a0b_0c0e;
const SEGMENT_BYTES = 65_536;
const SYMBOL_BYTES = 512;

function pseudoRandomBytes(length: number, seed = 0x51ed_2317): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b_79f5) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

interface Fixture {
  manifest: DeqrV2Manifest;
  manifestFrame: Uint8Array;
  plan: SegmentPlan;
  payload: Uint8Array;
  directoryName: string;
  allFrames(): Uint8Array[];
}

async function fixture(options: { segments?: number; corruptDigest?: boolean } = {}): Promise<Fixture> {
  const segments = options.segments ?? 3;
  const transportSize = SEGMENT_BYTES * (segments - 1) + 2_048;
  const payload = pseudoRandomBytes(transportSize);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload.buffer as ArrayBuffer));
  if (options.corruptDigest) digest[0] ^= 0xff;

  const plan = planSegmentation({
    transportSize: BigInt(transportSize),
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
  });

  const manifest: DeqrV2Manifest = {
    featureFlags: 0,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    originalSize: BigInt(transportSize),
    transportSize: BigInt(transportSize),
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: digest,
    filename: 'phase07-integrity.bin',
    mimeType: 'application/octet-stream',
  };

  return {
    manifest,
    manifestFrame: serializeManifestFrame(manifest),
    plan,
    payload,
    directoryName: sessionDirectoryName(SESSION_ID, FILE_ID),
    allFrames() {
      const frames: Uint8Array[] = [];
      for (let segmentIndex = 0; segmentIndex < plan.segmentCount; segmentIndex += 1) {
        const range = segmentByteRange(plan, segmentIndex);
        const encoder = new SegmentEncoder(SYMBOL_BYTES);
        encoder.loadSegment(payload.subarray(Number(range.start), Number(range.end)));
        for (let symbolId = 0; symbolId < encoder.sourceSymbolCount; symbolId += 1) {
          const out = new Uint8Array(SYMBOL_BYTES);
          encoder.symbolInto(symbolId, out);
          frames.push(serializeDataFrame({
            frameType: V2_FRAME_TYPE.SOURCE,
            sessionId: SESSION_ID,
            fileId: FILE_ID,
            segmentIndex,
            symbolId,
            sourceSymbolCount: encoder.sourceSymbolCount,
            frameFlags: 0,
            payload: out,
          }));
        }
      }
      return frames;
    },
  };
}

function pipelineOver(
  storage: FakeStorage,
  options: { resume?: boolean; onVerifyProgress?: ReceivePipelineVerifyHook } = {},
): ReceivePipeline {
  return new ReceivePipeline({
    storage: new ReceiverStorage({
      environment: { storage, supportsSyncAccess: true },
      now: () => 1_700_000_000_000,
    }),
    resume: options.resume ?? false,
    onVerifyProgress: options.onVerifyProgress,
  });
}

type ReceivePipelineVerifyHook = (progress: VerifyProgress) => void;

async function receiveEverything(pipeline: ReceivePipeline, at: Fixture): Promise<void> {
  pipeline.submit(at.manifestFrame);
  await pipeline.whenStorageReady();
  for (const frame of at.allFrames()) pipeline.submit(frame);
}

/* -------------------------------------------------------- the hash decides */

describe('SHA-256 over the reconstruction is the only thing that verifies a transfer', () => {
  it('verifies a complete transfer against the manifest digest', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage);
    await receiveEverything(pipeline, at);

    const result = await pipeline.verify();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source.kind).toBe('opfs');
    expect(result.value.size).toBe(at.payload.length);
  });

  it('refuses a transfer whose bytes were altered on the device, and offers no export', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage);
    await receiveEverything(pipeline, at);

    // Flip one bit in the middle of the stored file, behind the store's back.
    // Nothing upstream can see it: every frame was well formed, every CRC
    // passed, every segment completed. Only the final digest can catch this.
    const file = storage.sessions().get(at.directoryName)?.files.get(OPFS_DATA_FILE);
    expect(file).toBeDefined();
    const one = new Uint8Array(1);
    file!.backing.read(SEGMENT_BYTES + 17, one);
    file!.backing.write(SEGMENT_BYTES + 17, Uint8Array.of(one[0] ^ 0x01));

    const result = await pipeline.verify();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('HASH_MISMATCH');
    // There is no `value` on a failure, which is the structural version of
    // "never expose a verified/exportable result": a caller cannot reach an
    // export route from here even by ignoring the code.
    expect('value' in result).toBe(false);
  });

  it('destroys working data the hash has proven wrong', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveEverything(pipeline, at);

    const file = storage.sessions().get(at.directoryName)!.files.get(OPFS_DATA_FILE)!;
    const one = new Uint8Array(1);
    file.backing.read(64, one);
    file.backing.write(64, Uint8Array.of(one[0] ^ 0xff));

    expect((await pipeline.verify()).ok).toBe(false);
    await pipeline.settled();

    // Keeping it would let a later resume adopt bytes already known to be
    // wrong and spend a whole transfer failing in exactly the same way.
    expect(storage.sessionNames()).not.toContain(at.directoryName);
  });

  it('refuses a transfer whose manifest digest describes different bytes', async () => {
    const { storage } = fakeEnvironment();
    // The stored file is perfect and the manifest is wrong - a sender whose
    // file changed under it between preflight and transmission. Same verdict:
    // the receiver cannot hand over something it cannot prove.
    const at = await fixture({ corruptDigest: true });
    const pipeline = pipelineOver(storage);
    await receiveEverything(pipeline, at);

    const result = await pipeline.verify();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('HASH_MISMATCH');
  });

  it('refuses to verify a transfer that is not complete', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage);
    pipeline.submit(at.manifestFrame);
    await pipeline.whenStorageReady();
    const frames = at.allFrames();
    for (const frame of frames.slice(0, frames.length - 10)) pipeline.submit(frame);

    const result = await pipeline.verify();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TRANSFER_INCOMPLETE');
  });

  it('hashes what the store holds rather than what the manifest claims', async () => {
    // A digest over a caller-supplied length would let a manifest decide how
    // much of a file to read. This drives the free-standing digest directly to
    // pin that it reads exactly the range it was given and refuses a short one.
    const store = new BoundedMemorySegmentStore(1 << 20);
    const payload = pseudoRandomBytes(4_096);
    store.write({ segmentIndex: 0, byteOffset: 0n, bytes: Uint8Array.from(payload) });

    const digest = await digestSegmentStore(store, payload.length);
    expect(digest).not.toBeNull();
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', payload.buffer as ArrayBuffer));
    expect([...digest!]).toEqual([...expected]);

    // Past the end of what was written, the store yields nothing and the digest
    // reports failure rather than hashing whatever it managed to read.
    expect(await digestSegmentStore(store, payload.length + 1)).toBeNull();
  });
});

/* ---------------------------------------------------- verification progress */

describe('verification reports its own progress', () => {
  it('reports first and last, so a bar can start at zero and reach the end', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const seen: Array<{ bytesHashed: number; bytesTotal: number; phase: string }> = [];
    const pipeline = pipelineOver(storage, {
      onVerifyProgress: (progress) => seen.push({ ...progress }),
    });
    await receiveEverything(pipeline, at);

    expect((await pipeline.verify()).ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // An uncompressed transfer has one verification phase, and says so on
    // every report: there is nothing before the hash for it to be doing.
    expect(seen[0]).toEqual({ bytesHashed: 0, bytesTotal: at.payload.length, phase: 'hashing' });
    expect(seen[seen.length - 1]).toEqual({
      bytesHashed: at.payload.length,
      bytesTotal: at.payload.length,
      phase: 'hashing',
    });
  });

  it('never goes backwards and never overshoots', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const seen: number[] = [];
    const pipeline = pipelineOver(storage, { onVerifyProgress: ({ bytesHashed }) => seen.push(bytesHashed) });
    await receiveEverything(pipeline, at);
    await pipeline.verify();

    for (let index = 1; index < seen.length; index += 1) expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]);
    expect(Math.max(...seen)).toBe(at.payload.length);
  });

  it('is measured apart from transfer progress, which is already finished', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    let progressDuringHash: number | undefined;
    const pipeline = pipelineOver(storage, {
      onVerifyProgress: () => {
        // Transfer progress does not move during verification and cannot stand
        // in for it. That is the whole reason this is a separate channel.
        progressDuringHash = pipeline.progress().unitsRecovered;
      },
    });
    await receiveEverything(pipeline, at);
    await pipeline.verify();
    expect(progressDuringHash).toBe(at.plan.segmentCount);
  });

  it('yields between windows so a cancel is answered mid-hash', async () => {
    // The yield exists for a nine-second hash on a phone. Driving it directly
    // over a small store is how that stays testable without a gigabyte.
    const store = new BoundedMemorySegmentStore(1 << 20);
    const payload = pseudoRandomBytes(64 * 1024);
    store.write({ segmentIndex: 0, byteOffset: 0n, bytes: Uint8Array.from(payload) });

    let yields = 0;
    let cancelled = false;
    const digest = await digestSegmentStore(store, payload.length, {
      chunkBytes: 4_096,
      yieldEveryBytes: 8_192,
      yieldTo: async () => {
        yields += 1;
        if (yields === 2) cancelled = true;
      },
      isCancelled: () => cancelled,
    });

    expect(yields).toBe(2);
    // Abandoned rather than finished, and reported as null rather than as a
    // digest that happens not to match.
    expect(digest).toBeNull();
  });

  it('yields on the documented boundary and not per window', async () => {
    const store = new BoundedMemorySegmentStore(1 << 20);
    const payload = pseudoRandomBytes(4_096);
    store.write({ segmentIndex: 0, byteOffset: 0n, bytes: Uint8Array.from(payload) });

    let yields = 0;
    await digestSegmentStore(store, payload.length, { yieldTo: async () => void (yields += 1) });
    // 4 KiB is far below the 16 MiB yield boundary, so a well-behaved hash of
    // it yields not at all. A yield per 256 KiB window would be four thousand
    // macrotasks per gigabyte.
    expect(yields).toBe(0);
    expect(VERIFY_YIELD_BYTES).toBe(16 * 1024 * 1024);
  });
});

/* --------------------------------------------------------- the empty file */

describe('a zero-byte file', () => {
  it('cannot be described by a v2 manifest at all', () => {
    // The protocol's segmentation refuses a transport size below one byte, so
    // there is no such manifest to serialize, parse, or resume. An empty file
    // is turned away by the sender before a session exists; this pins that the
    // receiver could not be handed one even by something that is not the sender.
    expect(() => planSegmentation({
      transportSize: 0n,
      segmentSizeBytes: SEGMENT_BYTES,
      symbolSizeBytes: SYMBOL_BYTES,
    })).toThrow(/transportSize/);
  });

  it('leaves the smallest describable transfer working', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture({ segments: 1 });
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveEverything(pipeline, at);

    const result = await pipeline.verify();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.size).toBe(at.payload.length);
    pipeline.reset(SESSION_END.COMPLETED);
    await pipeline.settled();
  });
});

/* -------------------------------------------------------- checkpoint state */

describe('the checkpoint records where a session got to', () => {
  it('says receiving while segments are still arriving', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture({ segments: 4 });
    const pipeline = pipelineOver(storage, { resume: true });
    pipeline.submit(at.manifestFrame);
    await pipeline.whenStorageReady();
    const frames = at.allFrames();
    for (const frame of frames.slice(0, 200)) pipeline.submit(frame);

    pipeline.reset(SESSION_END.INTERRUPTED);
    await pipeline.settled();
    const checkpoint = await readCheckpoint(storage.sessions().get(at.directoryName)!);
    expect(checkpoint?.state).toBe('receiving');
    expect(checkpoint?.segmentsCommitted).toBeGreaterThan(0);
    expect(checkpoint?.segmentsCommitted).toBeLessThan(at.plan.segmentCount);
  });

  it('says complete the moment the last segment lands, before any hashing', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveEverything(pipeline, at);

    // Deliberately *not* verified yet. A session that dies in this window is
    // the one a resume should pick up with nothing left to scan.
    pipeline.reset(SESSION_END.INTERRUPTED);
    await pipeline.settled();
    const checkpoint = await readCheckpoint(storage.sessions().get(at.directoryName)!);
    expect(checkpoint?.state).toBe('complete');
    expect(checkpoint?.segmentsCommitted).toBe(at.plan.segmentCount);
  });

  it('says verified only after the digest matched', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveEverything(pipeline, at);
    expect((await pipeline.verify()).ok).toBe(true);

    const checkpoint = await readCheckpoint(storage.sessions().get(at.directoryName)!);
    expect(checkpoint?.state).toBe('verified');
  });

  it('carries the manifest identity a resume has to match against', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    pipeline.submit(at.manifestFrame);
    await pipeline.whenStorageReady();
    pipeline.reset(SESSION_END.INTERRUPTED);
    await pipeline.settled();

    const checkpoint = await readCheckpoint(storage.sessions().get(at.directoryName)!);
    expect(checkpoint?.sessionId).toBe(SESSION_ID);
    expect(checkpoint?.fileId).toBe(FILE_ID);
    expect(checkpoint?.segmentCount).toBe(at.plan.segmentCount);
    expect(checkpoint?.segmentSizeBytes).toBe(SEGMENT_BYTES);
    expect(checkpoint?.symbolSizeBytes).toBe(SYMBOL_BYTES);
    // A decimal string, not a JSON number: `transportSize` is a u64 and a
    // double would silently lose its low bits on a multi-petabyte manifest.
    expect(checkpoint?.transportSize).toBe(at.manifest.transportSize.toString(10));
  });
});
