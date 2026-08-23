import { describe, expect, it } from 'vitest';

import {
  V2_COMPRESSION,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
  type DeqrV2Manifest,
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { digestToHex, sha256Bytes } from '../../src/core/sha256-stream';
import { discardExportedSession, fileForExport } from '../src/export';
import {
  DEFAULT_STORAGE_MARGIN_RATIO,
  MIN_STORAGE_MARGIN_BYTES,
  detectStorageSupport,
  preflightStorage,
  sessionDirectoryName,
} from '../src/opfs';
import { ReceivePipeline } from '../src/receive-pipeline';
import { ReceiverStorage } from '../src/receiver-storage';
import { FRAME_OUTCOME } from '../src/worker-protocol';
import { FakeStorage, fakeEnvironment } from './helpers/fake-opfs';

/**
 * Storage as the receiver actually meets it: chosen at the manifest, opened
 * asynchronously, and capable of saying no in several different ways.
 *
 * The tests that matter most here are not the ones where OPFS works. They are
 * the ones where it is missing, where the quota is too small, where the browser
 * is an older Safari, and where the user cancels in the middle - because those
 * are the paths a phone actually takes and the ones a happy-path fake would
 * never exercise.
 *
 * The end-to-end cases drive real frames from the sender's own encoder through
 * the real pipeline into a real `OpfsSegmentStore`. Nothing about the transfer
 * is stubbed except the device underneath it.
 */

/* ----------------------------------------------------------------- fixtures */

interface V2Fixture {
  manifest: DeqrV2Manifest;
  manifestFrame: Uint8Array;
  payload: Uint8Array;
  plan: SegmentPlan;
  sourceFrames: Uint8Array[];
  directoryName: string;
}

function pseudoRandomBytes(length: number, seed = 0x51ed_2701): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b_79f5) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

function v2Fixture(options: { transportSize?: number; filename?: string; sessionId?: number } = {}): V2Fixture {
  const transportSize = options.transportSize ?? 3 * 65_536;
  const segmentSizeBytes = 65_536;
  const symbolSizeBytes = 512;
  const sessionId = options.sessionId ?? 0x5eed_0006;
  const fileId = 0x0a0b_0c0d;

  const payload = pseudoRandomBytes(transportSize);
  const plan = planSegmentation({ transportSize: BigInt(transportSize), segmentSizeBytes, symbolSizeBytes });
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
    sha256: sha256Bytes(payload),
    filename: options.filename ?? 'phase06.bin',
    mimeType: 'application/octet-stream',
  };

  const sourceFrames: Uint8Array[] = [];
  for (let segmentIndex = 0; segmentIndex < plan.segmentCount; segmentIndex += 1) {
    const range = segmentByteRange(plan, segmentIndex);
    const encoder = new SegmentEncoder(symbolSizeBytes);
    encoder.loadSegment(payload.subarray(Number(range.start), Number(range.end)));
    const symbols = sourceSymbolCountForSegment(plan, segmentIndex);
    for (let symbolId = 0; symbolId < symbols; symbolId += 1) {
      const out = new Uint8Array(symbolSizeBytes);
      encoder.symbolInto(symbolId, out);
      sourceFrames.push(serializeDataFrame({
        frameType: V2_FRAME_TYPE.SOURCE,
        sessionId,
        fileId,
        segmentIndex,
        symbolId,
        sourceSymbolCount: encoder.sourceSymbolCount,
        frameFlags: 0,
        payload: out,
      }));
    }
  }

  return {
    manifest,
    manifestFrame: serializeManifestFrame(manifest),
    payload,
    plan,
    sourceFrames,
    directoryName: sessionDirectoryName(sessionId, fileId),
  };
}

/* ---------------------------------------------------------------- detection */

describe('storage support is a capability question, never a user-agent one', () => {
  it('reports nothing available when there is no storage API at all', () => {
    const support = detectStorageSupport({});
    expect(support).toEqual({ opfs: false, syncAccess: false, estimate: false });
  });

  it('reports OPFS without sync access outside a worker', () => {
    const { environment } = fakeEnvironment();
    const support = detectStorageSupport({ ...environment, supportsSyncAccess: false });
    // The main thread has OPFS and cannot have a synchronous handle. Treating
    // the first as implying the second is how a receiver ends up calling an
    // API that is not there.
    expect(support.opfs).toBe(true);
    expect(support.syncAccess).toBe(false);
  });

  it('reports a browser with no quota API without refusing it', () => {
    const { environment } = fakeEnvironment({ withoutEstimate: true });
    expect(detectStorageSupport(environment).estimate).toBe(false);
  });
});

/* ---------------------------------------------------------------- preflight */

describe('the storage preflight says what it knows and no more', () => {
  it('requires the transfer plus a margin, with a floor under small transfers', async () => {
    const { environment } = fakeEnvironment({ quotaBytes: 4 * 1024 * 1024 * 1024 });
    const small = await preflightStorage(1_000, environment);
    // A 15% margin on a kilobyte is meaningless, so the floor applies instead.
    expect(small.marginBytes).toBe(MIN_STORAGE_MARGIN_BYTES);

    const large = await preflightStorage(1024 * 1024 * 1024, environment);
    expect(large.marginBytes).toBe(Math.ceil(1024 * 1024 * 1024 * DEFAULT_STORAGE_MARGIN_RATIO));
    expect(large.requiredBytes).toBe(1024 * 1024 * 1024 + large.marginBytes);
    expect(large.ok).toBe(true);
  });

  it('refuses before the transfer starts when the reported quota cannot hold it', async () => {
    const { environment } = fakeEnvironment({ quotaBytes: 64 * 1024 * 1024 });
    const preflight = await preflightStorage(512 * 1024 * 1024, environment);

    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toBe('INSUFFICIENT_STORAGE');
    expect(preflight.confidence).toBe('reported');
    // Reported, and labelled as reported: available is quota minus usage, which
    // is the browser's grant and not a measurement of the device's free space.
    expect(preflight.quotaBytes).toBe(64 * 1024 * 1024);
    expect(preflight.availableBytes).toBe(64 * 1024 * 1024 - (preflight.usageBytes ?? 0));
  });

  it('proceeds with stated uncertainty when the browser cannot answer', async () => {
    const { environment } = fakeEnvironment({ withoutEstimate: true });
    const preflight = await preflightStorage(512 * 1024 * 1024, environment);

    // Refusing every transfer on a browser with no estimate API would be worse
    // than starting one that might fail at the far end, which the write path
    // already handles cleanly.
    expect(preflight.ok).toBe(true);
    expect(preflight.confidence).toBe('unknown');
    expect(preflight.quotaBytes).toBeUndefined();
  });

  it('treats an estimate that throws as an estimate that does not exist', async () => {
    const preflight = await preflightStorage(1_000, {
      storage: { estimate: async () => { throw new Error('denied'); } },
    });
    expect(preflight.ok).toBe(true);
    expect(preflight.confidence).toBe('unknown');
  });
});

/* -------------------------------------------------------------- provisioner */

describe('storage is chosen from the manifest, before a byte is accepted', () => {
  it('opens OPFS when the context can write to a device', async () => {
    const fixture = v2Fixture();
    const { storage, environment } = fakeEnvironment();
    const provision = await new ReceiverStorage({ environment })
      .provision(fixture.manifest, fixture.plan, fixture.manifest.filename);

    expect(provision.ok).toBe(true);
    if (!provision.ok) return;
    expect(provision.kind).toBe('opfs');
    expect(storage.sessionNames()).toEqual([fixture.directoryName]);
  });

  it('falls back to bounded memory for a transfer small enough to hold', async () => {
    const fixture = v2Fixture({ transportSize: 2 * 65_536 });
    const { environment } = fakeEnvironment({ withoutSyncAccess: true });
    const provision = await new ReceiverStorage({ environment, fallbackBudgetBytes: 1024 * 1024 })
      .provision(fixture.manifest, fixture.plan, fixture.manifest.filename);

    expect(provision.ok).toBe(true);
    if (!provision.ok) return;
    expect(provision.kind).toBe('memory');
  });

  it('refuses rather than starting a transfer the fallback could never finish', async () => {
    const fixture = v2Fixture({ transportSize: 8 * 65_536 });
    const { environment } = fakeEnvironment({ withoutSyncAccess: true });
    const provision = await new ReceiverStorage({ environment, fallbackBudgetBytes: 2 * 65_536 })
      .provision(fixture.manifest, fixture.plan, fixture.manifest.filename);

    // The alternative is letting someone scan for an hour into a store that
    // was always going to refuse the third segment.
    expect(provision.ok).toBe(false);
    if (provision.ok) return;
    expect(provision.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('refuses when the reported quota cannot hold the transfer', async () => {
    const fixture = v2Fixture({ transportSize: 4 * 65_536 });
    const { environment } = fakeEnvironment({ quotaBytes: 32 * 1024 });
    const provision = await new ReceiverStorage({ environment })
      .provision(fixture.manifest, fixture.plan, fixture.manifest.filename);

    expect(provision.ok).toBe(false);
    if (provision.ok) return;
    expect(provision.code).toBe('INSUFFICIENT_STORAGE');
    expect(provision.preflight?.ok).toBe(false);
  });

  it('falls back to memory on a browser whose sync handle is not synchronous', async () => {
    const fixture = v2Fixture({ transportSize: 2 * 65_536 });
    const { environment } = fakeEnvironment({ asyncWriteApi: true });
    const provision = await new ReceiverStorage({ environment, fallbackBudgetBytes: 1024 * 1024 })
      .provision(fixture.manifest, fixture.plan, fixture.manifest.filename);

    // The capability check said yes and the probe said no. A small transfer
    // still has a real answer.
    expect(provision.ok).toBe(true);
    if (!provision.ok) return;
    expect(provision.kind).toBe('memory');
  });
});

/* ------------------------------------------------------------- end to end */

describe('a v2 transfer runs through the device and never through the heap', () => {
  function pipelineOn(storage: FakeStorage, extra: { retention?: 'discard' | 'retain' } = {}) {
    return new ReceivePipeline({
      storage: new ReceiverStorage({
        environment: { storage, supportsSyncAccess: true },
        now: () => 7_000,
      }),
      retention: extra.retention,
    });
  }

  it('receives, verifies and hands back a file the receiver never held', async () => {
    const fixture = v2Fixture();
    const storage = new FakeStorage();
    const pipeline = pipelineOn(storage);

    expect(pipeline.submit(fixture.manifestFrame).outcome).toBe(FRAME_OUTCOME.MANIFEST);
    await pipeline.whenStorageReady();
    expect(pipeline.storageKind).toBe('opfs');

    for (const frame of fixture.sourceFrames) pipeline.submit(frame);
    expect(pipeline.isComplete).toBe(true);

    // No payload is resident: the decoders are dropped as segments commit and
    // the store writes through. What remains is the committed bitmap, one bit
    // per segment, which is reported rather than hidden.
    expect(pipeline.progress().heldBytes).toBe(Math.ceil(fixture.plan.segmentCount / 8));
    expect(pipeline.progress().bytesCommitted).toBe(fixture.payload.length);

    const verified = await pipeline.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.filename).toBe('phase06.bin');
    expect(verified.value.size).toBe(fixture.payload.length);
    expect(digestToHex(verified.value.sha256)).toBe(digestToHex(fixture.manifest.sha256));
    expect(verified.value.source.kind).toBe('opfs');
  });

  it('reports frames that arrive while storage is opening without counting them against anyone', async () => {
    const fixture = v2Fixture();
    const storage = new FakeStorage();
    const pipeline = pipelineOn(storage);

    pipeline.submit(fixture.manifestFrame);
    expect(pipeline.isProvisioningStorage).toBe(true);

    // A data frame in this window is neither accepted nor rejected. The sender
    // repeats everything, so the honest report is that the receiver was not
    // ready yet - and the frame is deliberately not fingerprinted.
    expect(pipeline.submit(fixture.sourceFrames[0]).outcome).toBe(FRAME_OUTCOME.PENDING_STORAGE);
    // The repeated manifest is a different case: it *was* acted on, so it is
    // remembered, and the sender's next copy of it costs one hash lookup.
    expect(pipeline.submit(fixture.manifestFrame).outcome).toBe(FRAME_OUTCOME.DUPLICATE);
    expect(pipeline.progress().framesRejected).toBe(0);

    await pipeline.whenStorageReady();
    // The very frame that was held must still be usable. Fingerprinting it
    // during the window would have discarded a symbol the receiver needs.
    expect(pipeline.submit(fixture.sourceFrames[0]).outcome).toBe(FRAME_OUTCOME.ACCEPTED);
  });

  it('keeps memory flat while committed bytes climb', async () => {
    const fixture = v2Fixture({ transportSize: 6 * 65_536 });
    const storage = new FakeStorage();
    const pipeline = pipelineOn(storage);
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    let peakHeld = 0;
    for (const frame of fixture.sourceFrames) {
      pipeline.submit(frame);
      peakHeld = Math.max(peakHeld, pipeline.progress().heldBytes);
    }

    // Two decoders' worth, and no more, against six segments of file. That
    // divergence between what is held and what is committed is the phase.
    expect(pipeline.progress().bytesCommitted).toBe(6 * 65_536);
    expect(peakHeld).toBeLessThanOrEqual(3 * 65_536);
    expect(pipeline.progress().heldBytes).toBe(Math.ceil(fixture.plan.segmentCount / 8));
  });

  it('stops the session when the device refuses a write, and says which refusal it was', async () => {
    const fixture = v2Fixture();
    const storage = new FakeStorage();
    const pipeline = pipelineOn(storage);
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    const handle = storage.sessions().get(fixture.directoryName)!.files.get('data.part')!.handle!;
    handle.breakAfter = handle.writes;

    for (const frame of fixture.sourceFrames) pipeline.submit(frame);

    const progress = pipeline.progress();
    // A dead writer is not a full device: reporting it as one would send
    // someone to delete photos over a fault that has nothing to do with space.
    expect(progress.fault).toBe('STORAGE_WRITE_FAILED');
    expect(progress.storagePressure).toBe(false);

    const verified = await pipeline.verify();
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe('STORAGE_WRITE_FAILED');
  });

  it('refuses the session at the manifest when there is nowhere to put the file', async () => {
    const fixture = v2Fixture({ transportSize: 8 * 65_536 });
    const storage = new FakeStorage({ quotaBytes: 64 * 1024 });
    const pipeline = new ReceivePipeline({
      storage: new ReceiverStorage({
        environment: { storage, supportsSyncAccess: true },
        allowMemoryFallback: false,
      }),
    });

    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();

    const progress = pipeline.progress();
    expect(progress.fault).toBe('INSUFFICIENT_STORAGE');
    expect(progress.storagePressure).toBe(true);
    // Refused before scanning got anywhere, and it stays refused: the sender
    // repeats everything and a retry would loop on the same answer, so every
    // frame afterwards carries the reason rather than going quiet.
    const rejected = pipeline.submit(fixture.sourceFrames[0]);
    expect(rejected.outcome).toBe(FRAME_OUTCOME.REJECTED);
    expect(rejected.reason).toBe('INSUFFICIENT_STORAGE');
    expect(pipeline.submit(fixture.sourceFrames[1]).reason).toBe('INSUFFICIENT_STORAGE');
  });

  it('deletes the working file when the user cancels', async () => {
    const fixture = v2Fixture();
    const storage = new FakeStorage();
    const pipeline = pipelineOn(storage);
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();
    for (const frame of fixture.sourceFrames.slice(0, 200)) pipeline.submit(frame);

    expect(storage.sessionNames()).toEqual([fixture.directoryName]);
    pipeline.reset();
    await pipeline.settled();

    expect(storage.sessionNames()).toEqual([]);
    expect(storage.usedBytes()).toBe(0);
  });

  it('keeps the working file when retention is on, for a resume to find', async () => {
    const fixture = v2Fixture();
    const storage = new FakeStorage();
    const pipeline = pipelineOn(storage, { retention: 'retain' });
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();
    for (const frame of fixture.sourceFrames.slice(0, 200)) pipeline.submit(frame);

    pipeline.reset();
    await pipeline.settled();
    expect(storage.sessionNames()).toEqual([fixture.directoryName]);
  });

  it('throws away a store that finished opening for a session already cancelled', async () => {
    const fixture = v2Fixture();
    const storage = new FakeStorage();
    const pipeline = pipelineOn(storage);

    pipeline.submit(fixture.manifestFrame);
    // Cancelled inside the one asynchronous window the pipeline has. Without
    // the generation fence the store would attach to the next session and
    // write one transfer's segments into another transfer's file.
    pipeline.reset();
    await pipeline.whenStorageReady();
    await pipeline.settled();

    expect(pipeline.storageKind).toBe('none');
    expect(pipeline.progress().sessionActive).toBe(false);
    expect(storage.sessionNames()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ export */

describe('a verified file is exported from where it is, not from a copy', () => {
  it('resolves a file-backed export with the sanitized name and the real size', async () => {
    const fixture = v2Fixture();
    const storage = new FakeStorage();
    const pipeline = new ReceivePipeline({
      storage: new ReceiverStorage({ environment: { storage, supportsSyncAccess: true } }),
    });
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();
    for (const frame of fixture.sourceFrames) pipeline.submit(frame);

    const verified = await pipeline.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok || verified.value.source.kind !== 'opfs') return;

    const file = await fileForExport(
      { filename: verified.value.filename, mimeType: verified.value.mimeType, source: verified.value.source },
      { storage },
    );
    expect(file.name).toBe('phase06.bin');
    expect(file.type).toBe('application/octet-stream');
    expect(file.size).toBe(fixture.payload.length);
    // And the bytes are the transfer's, read out of the device rather than
    // reassembled on the way past.
    expect(digestToHex(sha256Bytes(new Uint8Array(await file.arrayBuffer()))))
      .toBe(digestToHex(fixture.manifest.sha256));
  });

  it('opens nothing when handed a path this receiver did not write', async () => {
    const storage = new FakeStorage();
    for (const path of [
      ['deqr', 'sessions', '../../etc'],
      ['deqr', 'sessions'],
      ['other', 'sessions', '5eed0006-0a0b0c0d'],
      ['deqr', 'sessions', '5eed0006-0a0b0c0d', 'extra'],
    ]) {
      await expect(fileForExport(
        { filename: 'x.bin', mimeType: '', source: { kind: 'opfs', path, file: 'data.part' } },
        { storage },
      )).rejects.toThrow(/no longer on this device/);
    }
  });

  it('refuses a payload name other than the one it writes', async () => {
    const storage = new FakeStorage();
    await expect(fileForExport(
      {
        filename: 'x.bin',
        mimeType: '',
        source: { kind: 'opfs', path: ['deqr', 'sessions', '5eed0006-0a0b0c0d'], file: 'checkpoint.json' },
      },
      { storage },
    )).rejects.toThrow(/no longer on this device/);
  });

  it('hands over resident bytes directly when that is where the file is', async () => {
    const payload = pseudoRandomBytes(4_096);
    const file = await fileForExport({
      filename: 'small.bin',
      mimeType: 'application/octet-stream',
      source: { kind: 'bytes', bytes: payload.buffer as ArrayBuffer },
    });
    expect(file.size).toBe(4_096);
  });

  it('removes the working session once the export has settled', async () => {
    const fixture = v2Fixture();
    const storage = new FakeStorage();
    const pipeline = new ReceivePipeline({
      storage: new ReceiverStorage({ environment: { storage, supportsSyncAccess: true } }),
    });
    pipeline.submit(fixture.manifestFrame);
    await pipeline.whenStorageReady();
    for (const frame of fixture.sourceFrames) pipeline.submit(frame);
    const verified = await pipeline.verify();
    if (!verified.ok || verified.value.source.kind !== 'opfs') throw new Error('expected an OPFS export');

    expect(await discardExportedSession(verified.value.source, { storage })).toBe(true);
    expect(storage.sessionNames()).toEqual([]);
    // Idempotent: a second attempt after a reset must not throw at the user.
    expect(await discardExportedSession(verified.value.source, { storage })).toBe(false);
  });
});
