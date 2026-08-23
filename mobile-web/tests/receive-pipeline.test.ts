import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { computeSha256 } from '../../src/core/hash';
import { serializeFrame as serializeV1Frame } from '../../src/core/protocol';
import {
  V2_COMPRESSION,
  V2_DATA_LAYOUT,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
  type DeqrV2Manifest,
} from '../../src/core/protocol-v2';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { ReceivePipeline, type VerifiedPayload } from '../src/receive-pipeline';
import { BoundedMemorySegmentStore } from '../src/segment-store';
import { FRAME_OUTCOME } from '../src/worker-protocol';

/**
 * The pipeline is the phase's centre of gravity, so this is where the behaviour
 * that used to live on the main thread is pinned down.
 *
 * Every test here runs the *real* codecs - the desktop sender's own encoder for
 * v1, the shared v2 encoder for v2 - because the failure this suite exists to
 * catch is a receiver that agrees with a hand-written fixture and disagrees
 * with the thing that will actually be pointed at it.
 */

/* ----------------------------------------------------------------- fixtures */

function pseudoRandomBytes(length: number, seed = 0x9e3779b9): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b79f5) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

/** A complete v1 transfer, exactly as the shipping desktop sender emits it. */
function v1Frames(payload: Uint8Array, sessionId = 0x1234_5678): Uint8Array[] {
  const container = serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename: 'phase05.bin',
      mimeType: 'application/octet-stream',
      originalSize: payload.length,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256: computeSha256(Buffer.from(payload)),
    },
    payload: Buffer.from(payload),
  });
  const encoder = new FountainEncoder(container, 512, sessionId);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < encoder.getBlockCount(); index += 1) {
    frames.push(new Uint8Array(serializeV1Frame(encoder.nextFrame())));
  }
  return frames;
}

interface V2Fixture {
  manifest: DeqrV2Manifest;
  manifestFrame: Uint8Array;
  payload: Uint8Array;
  /** Systematic frames, in sender order. */
  sourceFrames: Uint8Array[];
  /** `count` repair frames for one segment, ids starting at its symbol count. */
  repairFrames(segmentIndex: number, count: number): Uint8Array[];
}

async function v2Fixture(options: {
  transportSize?: number;
  segmentSizeBytes?: number;
  symbolSizeBytes?: number;
  filename?: string;
  sessionId?: number;
} = {}): Promise<V2Fixture> {
  // 64 KiB is the v2 protocol's minimum segment size, so the fixtures use it:
  // three segments of 128 symbols is enough to exercise segment sequencing and
  // eviction without making every test a benchmark.
  const transportSize = options.transportSize ?? 3 * 65_536;
  const segmentSizeBytes = options.segmentSizeBytes ?? 65_536;
  const symbolSizeBytes = options.symbolSizeBytes ?? 512;
  const sessionId = options.sessionId ?? 0x5eed_0005;
  const fileId = 0x0a0b_0c0d;

  const payload = pseudoRandomBytes(transportSize);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload.buffer as ArrayBuffer));
  const plan = planSegmentation({
    transportSize: BigInt(transportSize),
    segmentSizeBytes,
    symbolSizeBytes,
  });

  const manifest: DeqrV2Manifest = {
    featureFlags: 0,
    sessionId,
    fileId,
    originalSize: BigInt(transportSize),
    transportSize: BigInt(transportSize),
    segmentSizeBytes,
    symbolSizeBytes,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: digest,
    filename: options.filename ?? 'phase05-v2.bin',
    mimeType: 'application/octet-stream',
  };

  const frameFor = (segmentIndex: number, symbolId: number): Uint8Array => {
    const range = segmentByteRange(plan, segmentIndex);
    const encoder = new SegmentEncoder(symbolSizeBytes);
    encoder.loadSegment(payload.subarray(Number(range.start), Number(range.end)));
    const out = new Uint8Array(symbolSizeBytes);
    encoder.symbolInto(symbolId, out);
    return serializeDataFrame({
      frameType: symbolId < encoder.sourceSymbolCount ? V2_FRAME_TYPE.SOURCE : V2_FRAME_TYPE.REPAIR,
      sessionId,
      fileId,
      segmentIndex,
      symbolId,
      sourceSymbolCount: encoder.sourceSymbolCount,
      frameFlags: 0,
      payload: out,
    });
  };

  const sourceFrames: Uint8Array[] = [];
  for (let segmentIndex = 0; segmentIndex < plan.segmentCount; segmentIndex += 1) {
    const symbols = sourceSymbolCountForSegment(plan, segmentIndex);
    for (let symbolId = 0; symbolId < symbols; symbolId += 1) {
      sourceFrames.push(frameFor(segmentIndex, symbolId));
    }
  }

  return {
    manifest,
    manifestFrame: serializeManifestFrame(manifest),
    payload,
    sourceFrames,
    repairFrames(segmentIndex, count) {
      const symbols = sourceSymbolCountForSegment(plan, segmentIndex);
      const frames: Uint8Array[] = [];
      for (let offset = 0; offset < count; offset += 1) frames.push(frameFor(segmentIndex, symbols + offset));
      return frames;
    },
  };
}

/** The bytes behind a verified payload, whichever route the store handed back. */
function exportedBytes(payload: VerifiedPayload): Uint8Array {
  if (payload.source.kind !== 'bytes') {
    throw new Error(`expected an in-memory export source, received ${payload.source.kind}`);
  }
  return payload.source.bytes;
}

/* --------------------------------------------------------------------- v1 */

describe('the pipeline still receives the protocol the shipping sender speaks', () => {
  it('reconstructs and verifies a v1 transfer end to end', async () => {
    const payload = pseudoRandomBytes(4_000);
    const pipeline = new ReceivePipeline();

    for (const frame of v1Frames(payload)) pipeline.submit(frame);

    expect(pipeline.activeProtocol).toBe(1);
    expect(pipeline.isComplete).toBe(true);

    const verified = await pipeline.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.filename).toBe('phase05.bin');
    expect(Array.from(exportedBytes(verified.value))).toEqual(Array.from(payload));
  });

  it('counts a frame the camera mangled instead of failing the transfer', async () => {
    const payload = pseudoRandomBytes(2_000);
    const frames = v1Frames(payload);
    const pipeline = new ReceivePipeline();

    // A decode that lands one bit wrong is a normal camera event, and gets more
    // likely as the frame rate rises. Before this phase it ended the transfer:
    // the session parsed it, failed itself, and rejected everything after.
    const damaged = Uint8Array.from(frames[0]);
    damaged[3] ^= 0x40;
    expect(pipeline.submit(damaged).outcome).toBe(FRAME_OUTCOME.REJECTED);

    for (const frame of frames) pipeline.submit(frame);

    expect(pipeline.progress().fault, 'a bad frame killed the session').toBeUndefined();
    expect(pipeline.isComplete).toBe(true);
    const verified = await pipeline.verify();
    expect(verified.ok).toBe(true);
  });

  it('reports a dead v1 session rather than scanning against it forever', () => {
    const pipeline = new ReceivePipeline();
    const first = v1Frames(pseudoRandomBytes(2_000), 0x1111_1111);
    pipeline.submit(first[0]);

    // Same sequence number, different payload: v1 calls this a conflicting
    // duplicate and fails permanently. The UI has to be told, because a session
    // that rejects everything looks exactly like a camera that sees nothing.
    const conflicting = Uint8Array.from(first[0]);
    conflicting[conflicting.length - 1] ^= 0xff;
    pipeline.submit(conflicting);

    expect(pipeline.progress().fault).toBe('CONFLICTING_DUPLICATE');
  });
});

/* --------------------------------------------------------------------- v2 */

describe('the pipeline receives v2 through the engine the sender shares', () => {
  it('recovers, verifies and hands back a segmented transfer', async () => {
    const fixture = await v2Fixture();
    const pipeline = new ReceivePipeline({ segmentBudgetBytes: 1024 * 1024 });

    expect(pipeline.submit(fixture.manifestFrame).outcome).toBe(FRAME_OUTCOME.MANIFEST);
    await pipeline.whenStorageReady();
    for (const frame of fixture.sourceFrames) pipeline.submit(frame);

    expect(pipeline.activeProtocol).toBe(2);
    expect(pipeline.isComplete).toBe(true);

    const verified = await pipeline.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.filename).toBe('phase05-v2.bin');
    expect(Array.from(exportedBytes(verified.value))).toEqual(Array.from(fixture.payload));
  });

  it('closes a segment from repair symbols when source frames are missed', async () => {
    const fixture = await v2Fixture({ transportSize: 65_536, segmentSizeBytes: 65_536 });
    const pipeline = new ReceivePipeline({ segmentBudgetBytes: 1024 * 1024 });
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    // Drop every seventh source frame, then let repair close the gap.
    fixture.sourceFrames.forEach((frame, index) => {
      if (index % 7 !== 0) pipeline.submit(frame);
    });
    expect(pipeline.isComplete, 'the fixture did not actually lose anything').toBe(false);

    for (const repair of fixture.repairFrames(0, 192)) {
      pipeline.submit(repair);
      if (pipeline.isComplete) break;
    }

    expect(pipeline.isComplete).toBe(true);
    const verified = await pipeline.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(Array.from(exportedBytes(verified.value))).toEqual(Array.from(fixture.payload));
  });

  it('holds data frames that arrive before the manifest, and takes them afterwards', async () => {
    const fixture = await v2Fixture({ transportSize: 65_536, segmentSizeBytes: 65_536 });
    const pipeline = new ReceivePipeline({ segmentBudgetBytes: 1024 * 1024 });

    // A receiver can start scanning at any moment, so this is the normal case,
    // not an edge one - the sender repeats its manifest every 64 frames.
    const early = pipeline.submit(fixture.sourceFrames[0]);
    expect(early.outcome).toBe(FRAME_OUTCOME.PENDING_MANIFEST);

    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();
    // The very same frame must now be usable. If the early attempt had been
    // fingerprinted, this symbol would be discarded as a duplicate forever.
    expect(pipeline.submit(fixture.sourceFrames[0]).outcome).toBe(FRAME_OUTCOME.ACCEPTED);
  });

  it('reports a frame from another transfer as foreign, not as damage', async () => {
    const mine = await v2Fixture({ sessionId: 0x1111_0000 });
    const theirs = await v2Fixture({ sessionId: 0x2222_0000 });
    const pipeline = new ReceivePipeline({ segmentBudgetBytes: 1024 * 1024 });

    pipeline.submit(mine.manifestFrame);
    await pipeline.whenStorageReady();
    expect(pipeline.submit(theirs.sourceFrames[0]).outcome).toBe(FRAME_OUTCOME.FOREIGN);
    expect(pipeline.progress().framesForeign).toBe(1);
    expect(pipeline.progress().framesRejected).toBe(0);
  });

  it('refuses a manifest whose file the receiver would never hand over', async () => {
    const fixture = await v2Fixture({ filename: 'payload.exe' });
    const pipeline = new ReceivePipeline();
    const result = pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    // Refused at the manifest rather than after the transfer, so nobody is
    // asked to hold a phone still for a file that was always going to be
    // rejected.
    expect(result.outcome).toBe(FRAME_OUTCOME.REJECTED);
    expect(result.reason).toBe('FILE_TYPE_BLOCKED');
    expect(pipeline.activeProtocol).toBe(0);
  });

  it('rejects a damaged v2 frame on its CRC without touching the session', async () => {
    const fixture = await v2Fixture({ transportSize: 65_536, segmentSizeBytes: 65_536 });
    const pipeline = new ReceivePipeline({ segmentBudgetBytes: 1024 * 1024 });
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    const damaged = Uint8Array.from(fixture.sourceFrames[1]);
    damaged[V2_DATA_LAYOUT.payload + 3] ^= 0x80;
    expect(pipeline.submit(damaged).reason).toBe('CRC_MISMATCH');

    for (const frame of fixture.sourceFrames) pipeline.submit(frame);
    expect(pipeline.isComplete).toBe(true);
  });

  it('stops the session when the store runs out of room instead of growing', async () => {
    const fixture = await v2Fixture();
    // Room for one segment of three. Phase 06 replaces this store with OPFS;
    // what must never happen is the receiver quietly holding the whole file.
    const store = new BoundedMemorySegmentStore(65_536);
    const pipeline = new ReceivePipeline({ store });

    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();
    for (const frame of fixture.sourceFrames) pipeline.submit(frame);

    const progress = pipeline.progress();
    expect(progress.storagePressure).toBe(true);
    expect(progress.fault).toBe('STORAGE_FULL');
    expect(store.bytesCommitted()).toBeLessThanOrEqual(65_536);

    const verified = await pipeline.verify();
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe('STORAGE_FULL');
  });

  it('keeps decoder memory a function of the segment, not of the file', async () => {
    const fixture = await v2Fixture({ transportSize: 10 * 65_536 });
    const store = new BoundedMemorySegmentStore(1024 * 1024);
    const pipeline = new ReceivePipeline({ store, maxActiveSegments: 2 });
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    let peakDecoderBytes = 0;
    for (const frame of fixture.sourceFrames) {
      pipeline.submit(frame);
      const heldByDecoders = pipeline.progress().heldBytes - store.bytesCommitted();
      peakDecoderBytes = Math.max(peakDecoderBytes, heldByDecoders);
    }

    // Two decoders, each bounded by one segment plus its bookkeeping. Ten
    // segments went through and the ceiling did not move with them.
    expect(peakDecoderBytes).toBeLessThan(4 * 65_536);
    expect(pipeline.isComplete).toBe(true);
  });
});

/* ---------------------------------------------------------------- dedupe */

describe('duplicates are discarded before anything expensive happens', () => {
  it('answers a repeated frame without parsing it', async () => {
    const fixture = await v2Fixture({ transportSize: 65_536, segmentSizeBytes: 65_536 });
    const pipeline = new ReceivePipeline({ segmentBudgetBytes: 1024 * 1024 });
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    const frame = fixture.sourceFrames[0];
    expect(pipeline.submit(frame).outcome).toBe(FRAME_OUTCOME.ACCEPTED);
    for (let repeat = 0; repeat < 20; repeat += 1) {
      expect(pipeline.submit(frame).outcome).toBe(FRAME_OUTCOME.DUPLICATE);
    }
    expect(pipeline.progress().framesDuplicate).toBe(20);
    expect(pipeline.progress().framesAccepted).toBe(1);
  });

  it('stays correct when a frame ages out of the fingerprint set', async () => {
    const fixture = await v2Fixture({ transportSize: 65_536, segmentSizeBytes: 65_536 });
    // Capacity of two: the first frame is forgotten almost immediately. The set
    // is a cost optimisation and correctness must not depend on its size.
    const pipeline = new ReceivePipeline({ dedupeCapacity: 2, segmentBudgetBytes: 64 * 1024 });
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    for (const frame of fixture.sourceFrames) pipeline.submit(frame);
    for (const frame of fixture.sourceFrames) pipeline.submit(frame);

    expect(pipeline.isComplete).toBe(true);
    const verified = await pipeline.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(Array.from(exportedBytes(verified.value))).toEqual(Array.from(fixture.payload));
  });

  it('counts a QR code that is not DEQR at all without reporting an error', () => {
    const pipeline = new ReceivePipeline();
    const wifiCode = new TextEncoder().encode('WIFI:T:WPA;S:SomeNetwork;P:hunter2;;');
    const result = pipeline.submit(wifiCode);

    expect(result.outcome).toBe(FRAME_OUTCOME.REJECTED);
    expect(result.reason).toBe('NOT_DEQR');
    expect(pipeline.progress().sessionActive).toBe(false);
  });
});

/* -------------------------------------------------------------- lifecycle */

describe('a released pipeline holds nothing', () => {
  it('clears every buffer and can be reused', async () => {
    const fixture = await v2Fixture({ transportSize: 65_536, segmentSizeBytes: 65_536 });
    const store = new BoundedMemorySegmentStore(1024 * 1024);
    const pipeline = new ReceivePipeline({ store });

    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();
    for (const frame of fixture.sourceFrames) pipeline.submit(frame);
    expect(store.bytesCommitted()).toBeGreaterThan(0);

    pipeline.reset();
    expect(store.bytesCommitted()).toBe(0);
    expect(pipeline.progress().sessionActive).toBe(false);
    expect(pipeline.progress().heldBytes).toBe(0);
    expect(pipeline.isComplete).toBe(false);

    // Reusable: the same object takes a fresh transfer without a new one.
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();
    for (const frame of fixture.sourceFrames) pipeline.submit(frame);
    expect(pipeline.isComplete).toBe(true);
  });

  it('refuses everything after release', () => {
    const pipeline = new ReceivePipeline();
    pipeline.release();
    expect(pipeline.submit(new Uint8Array(64)).reason).toBe('RELEASED');
  });
});
