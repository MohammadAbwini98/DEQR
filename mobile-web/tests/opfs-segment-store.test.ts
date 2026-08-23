import { describe, expect, it } from 'vitest';

import {
  planSegmentation,
  segmentByteRange,
  type DeqrV2Manifest,
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import { Sha256Stream, digestToHex, sha256Bytes } from '../../src/core/sha256-stream';
import {
  OPFS_CHECKPOINT_FILE,
  OPFS_DATA_FILE,
  base64ToBytes,
  isReceiverSessionPath,
  readCheckpoint,
  sessionDirectoryName,
  sweepStaleSessions,
  type DirectoryHandleLike,
} from '../src/opfs';
import { OpfsSegmentStore } from '../src/opfs-segment-store';
import { digestSegmentStore } from '../src/receive-pipeline';
import { STORE_WRITE } from '../src/segment-store';
import {
  BufferBacking,
  FakeStorage,
  PatternBacking,
  patternBytes,
  quotaError,
  type FakeSyncAccessHandle,
} from './helpers/fake-opfs';

/**
 * The store is the phase, so this is where its promises are held to account.
 *
 * Two properties run through every test here and neither is about happy paths.
 * The first is that **a byte written is a byte at the right offset** - out of
 * order, at the short final segment, and at a gigabyte of scale, where an
 * off-by-one is invisible until a hash fails hours later. The second is that
 * **every way a device says no is a different answer**: full, invalid, and
 * broken are three outcomes because they are three things to tell a user.
 *
 * The 1 GiB case at the bottom is the phase's acceptance gate. It runs against
 * a backing that stores no bytes at all, which is not a way of avoiding the
 * test - it is the only way to run it, and a segment written to the wrong place
 * still fails it, because an unwritten range reads back as zeros.
 */

/* ----------------------------------------------------------------- fixtures */

const SESSION_ID = 0x5eed_0006;
const FILE_ID = 0x0a0b_0c0d;

interface Fixture {
  manifest: DeqrV2Manifest;
  plan: SegmentPlan;
  transportSize: number;
  directoryName: string;
}

function fixture(options: {
  transportSize: number;
  segmentSizeBytes?: number;
  symbolSizeBytes?: number;
  sha256?: Uint8Array;
  sessionId?: number;
  fileId?: number;
  filename?: string;
} ): Fixture {
  const segmentSizeBytes = options.segmentSizeBytes ?? 65_536;
  const symbolSizeBytes = options.symbolSizeBytes ?? 512;
  const sessionId = options.sessionId ?? SESSION_ID;
  const fileId = options.fileId ?? FILE_ID;
  const plan = planSegmentation({
    transportSize: BigInt(options.transportSize),
    segmentSizeBytes,
    symbolSizeBytes,
  });
  const manifest: DeqrV2Manifest = {
    featureFlags: 0,
    sessionId,
    fileId,
    originalSize: BigInt(options.transportSize),
    transportSize: BigInt(options.transportSize),
    segmentSizeBytes,
    symbolSizeBytes,
    segmentCount: plan.segmentCount,
    fecProfileId: 1,
    compressionMode: 0,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: options.sha256 ?? new Uint8Array(32),
    filename: options.filename ?? 'phase06.bin',
    mimeType: 'application/octet-stream',
  };
  return {
    manifest,
    plan,
    transportSize: options.transportSize,
    directoryName: sessionDirectoryName(sessionId, fileId),
  };
}

async function openStore(storage: FakeStorage, at: Fixture, now = () => 1_000): Promise<OpfsSegmentStore> {
  const opened = await OpfsSegmentStore.open({
    root: await storage.getDirectory(),
    manifest: at.manifest,
    plan: at.plan,
    filename: at.manifest.filename,
    now,
  });
  if (!opened.ok) throw new Error(`store did not open: ${opened.code}`);
  return opened.store;
}

/** The bytes of one segment of a pseudo-random payload, as the decoder hands them over. */
function segmentOf(payload: Uint8Array, plan: SegmentPlan, index: number) {
  const range = segmentByteRange(plan, index);
  return {
    segmentIndex: index,
    byteOffset: range.start,
    bytes: Uint8Array.from(payload.subarray(Number(range.start), Number(range.end))),
  };
}

/**
 * Resident JavaScript memory, array buffers included.
 *
 * `heapUsed` on its own would make this gate meaningless: a `Uint8Array`'s
 * bytes are external memory, so a receiver holding the whole file in one would
 * report a flat heap and pass. `arrayBuffers` is where a held payload shows.
 */
function residentBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

function pseudoRandomBytes(length: number, seed = 0x9e37_79b9): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b_79f5) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

function handleOf(storage: FakeStorage, directoryName: string): FakeSyncAccessHandle {
  const handle = storage.sessions().get(directoryName)?.files.get(OPFS_DATA_FILE)?.handle;
  if (!handle) throw new Error('the store never opened an access handle');
  return handle;
}

function backingOf(storage: FakeStorage, directoryName: string): BufferBacking {
  const file = storage.sessions().get(directoryName)?.files.get(OPFS_DATA_FILE);
  if (!file) throw new Error('the store never created a data file');
  return file.backing as BufferBacking;
}

/* ------------------------------------------------------------- offset math */

describe('a segment lands at the offset the manifest says it does', () => {
  it('reassembles a file written entirely out of order', async () => {
    const transportSize = 4 * 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);

    // Deliberately not ascending. Nothing about the wire guarantees order, and
    // a store that only works in order works only on a perfect transfer.
    for (const index of [2, 0, 3, 1]) {
      expect(store.write(segmentOf(payload, at.plan, index))).toBe(STORE_WRITE.OK);
    }

    expect(store.segmentsWritten()).toBe(4);
    expect(store.bytesCommitted()).toBe(transportSize);
    expect(Array.from(backingOf(storage, at.directoryName).snapshot())).toEqual(Array.from(payload));
  });

  it('writes a final segment shorter than the others', async () => {
    // 2.5 segments: the last one is half length, which is the case that a
    // fixed-stride write would corrupt and a full-length one would overrun.
    const transportSize = 2 * 65_536 + 32_768;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);

    expect(at.plan.segmentCount).toBe(3);
    expect(at.plan.lastSegmentBytes).toBe(32_768);
    for (let index = 0; index < 3; index += 1) {
      expect(store.write(segmentOf(payload, at.plan, index))).toBe(STORE_WRITE.OK);
    }

    expect(store.bytesCommitted()).toBe(transportSize);
    const stored = backingOf(storage, at.directoryName).snapshot();
    expect(stored.length).toBe(transportSize);
    expect(Array.from(stored)).toEqual(Array.from(payload));
  });

  it('reads back through bounded windows that straddle segment boundaries', async () => {
    const transportSize = 3 * 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize });
    const store = await openStore(new FakeStorage(), at);
    for (let index = 0; index < at.plan.segmentCount; index += 1) {
      store.write(segmentOf(payload, at.plan, index));
    }

    // A window size that divides neither the segment size nor the file size, so
    // every read after the first is misaligned to both.
    const digest = await digestSegmentStore(store, transportSize, { chunkBytes: 7_001 });
    expect(digest).not.toBeNull();
    expect(digestToHex(digest!)).toBe(digestToHex(sha256Bytes(payload)));
  });

  it('refuses to read outside the declared transport size', async () => {
    const at = fixture({ transportSize: 65_536 });
    const store = await openStore(new FakeStorage(), at);
    store.write(segmentOf(pseudoRandomBytes(65_536), at.plan, 0));

    const window = new Uint8Array(64);
    expect(store.read(65_536, window)).toBe(0);
    expect(store.read(-1, window)).toBe(0);
    // A window longer than the remainder is clamped, never over-read.
    expect(store.read(65_500, new Uint8Array(1_024))).toBe(36);
  });
});

/* -------------------------------------------------------------- validation */

describe('a write that disagrees with the manifest is refused, not performed', () => {
  it('rejects an index outside the plan', async () => {
    const at = fixture({ transportSize: 2 * 65_536 });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);

    expect(store.write({ segmentIndex: 2, byteOffset: 0n, bytes: new Uint8Array(65_536) })).toBe(STORE_WRITE.INVALID);
    expect(store.write({ segmentIndex: -1, byteOffset: 0n, bytes: new Uint8Array(65_536) })).toBe(STORE_WRITE.INVALID);
    expect(store.segmentsWritten()).toBe(0);
    expect(store.bytesCommitted()).toBe(0);
  });

  it('rejects an offset the plan does not put that segment at', async () => {
    const at = fixture({ transportSize: 2 * 65_536 });
    const store = await openStore(new FakeStorage(), at);

    // Segment 1 belongs at 65,536. Every other offset is a write into another
    // segment's bytes, and the only place that can be caught is here.
    expect(store.write({ segmentIndex: 1, byteOffset: 0n, bytes: new Uint8Array(65_536) })).toBe(STORE_WRITE.INVALID);
    expect(store.write({ segmentIndex: 1, byteOffset: 65_537n, bytes: new Uint8Array(65_536) })).toBe(STORE_WRITE.INVALID);
    expect(store.write({ segmentIndex: 1, byteOffset: -1n, bytes: new Uint8Array(65_536) })).toBe(STORE_WRITE.INVALID);
    expect(store.segmentsWritten()).toBe(0);
  });

  it('rejects a segment longer or shorter than its own range', async () => {
    const at = fixture({ transportSize: 2 * 65_536 });
    const store = await openStore(new FakeStorage(), at);
    const offset = segmentByteRange(at.plan, 1).start;

    // The oversized case is the dangerous one: it would write past the end of
    // the declared file.
    expect(store.write({ segmentIndex: 1, byteOffset: offset, bytes: new Uint8Array(65_537) })).toBe(STORE_WRITE.INVALID);
    expect(store.write({ segmentIndex: 1, byteOffset: offset, bytes: new Uint8Array(65_535) })).toBe(STORE_WRITE.INVALID);
    expect(store.segmentsWritten()).toBe(0);
  });

  it('rejects a segment it has already committed rather than overwriting it', async () => {
    const transportSize = 2 * 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);

    expect(store.write(segmentOf(payload, at.plan, 0))).toBe(STORE_WRITE.OK);
    expect(store.isCommitted(0)).toBe(true);

    const impostor = segmentOf(payload, at.plan, 0);
    impostor.bytes.fill(0xff);
    expect(store.write(impostor)).toBe(STORE_WRITE.INVALID);
    expect(store.bytesCommitted()).toBe(65_536);
    // The committed bytes are untouched, which is the point of refusing.
    expect(Array.from(backingOf(storage, at.directoryName).snapshot().subarray(0, 65_536)))
      .toEqual(Array.from(payload.subarray(0, 65_536)));
  });
});

/* ------------------------------------------------------------------ failure */

describe('the three ways storage says no stay distinguishable', () => {
  it('refuses to open when the device cannot hold the transfer', async () => {
    const at = fixture({ transportSize: 8 * 65_536 });
    // A quota under the transfer size: pre-sizing the file fails, which is the
    // check that is an attempt rather than an estimate.
    const storage = new FakeStorage({ quotaBytes: 4 * 65_536 });
    const opened = await OpfsSegmentStore.open({
      root: await storage.getDirectory(),
      manifest: at.manifest,
      plan: at.plan,
      filename: at.manifest.filename,
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.code).toBe('INSUFFICIENT_STORAGE');
  });

  it('reports a quota error during the transfer as full, not as broken', async () => {
    const transportSize = 3 * 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);

    expect(store.write(segmentOf(payload, at.plan, 0))).toBe(STORE_WRITE.OK);
    const handle = handleOf(storage, at.directoryName);
    handle.breakAfter = handle.writes;
    handle.breakWith = quotaError();

    expect(store.write(segmentOf(payload, at.plan, 1))).toBe(STORE_WRITE.FULL);
    expect(store.refusedWrites).toBe(1);
  });

  it('reports a writer that dies as failed, not as full', async () => {
    const transportSize = 3 * 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);

    const handle = handleOf(storage, at.directoryName);
    handle.breakAfter = handle.writes;
    expect(store.write(segmentOf(payload, at.plan, 0))).toBe(STORE_WRITE.FAILED);
  });

  it('treats a short write as full, because a half-written segment is not data', async () => {
    const transportSize = 2 * 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);

    handleOf(storage, at.directoryName).nextWriteReturns = 1_024;
    expect(store.write(segmentOf(payload, at.plan, 0))).toBe(STORE_WRITE.FULL);
    expect(store.segmentsWritten()).toBe(0);
  });

  it('refuses a browser whose synchronous handle is not synchronous', async () => {
    const at = fixture({ transportSize: 65_536 });
    // The early Safari revision: `write` returns a promise, satisfies every
    // type check, and writes nothing. Detected before a payload byte is trusted.
    const storage = new FakeStorage({ asyncWriteApi: true });
    const opened = await OpfsSegmentStore.open({
      root: await storage.getDirectory(),
      manifest: at.manifest,
      plan: at.plan,
      filename: at.manifest.filename,
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.code).toBe('STORAGE_UNSUPPORTED');
    // And the handle was released, so the fallback is not blocked by a lock.
    expect(storage.sessions().get(at.directoryName)?.files.get(OPFS_DATA_FILE)?.locked).toBe(false);
  });

  it('refuses every write once released', async () => {
    const at = fixture({ transportSize: 65_536 });
    const store = await openStore(new FakeStorage(), at);
    store.release();
    expect(store.write(segmentOf(pseudoRandomBytes(65_536), at.plan, 0))).toBe(STORE_WRITE.FAILED);
    expect(store.read(0, new Uint8Array(16))).toBe(0);
  });
});

/* ---------------------------------------------------------------- lifecycle */

describe('working data is managed deterministically, not left to chance', () => {
  it('deletes a cancelled session outright', async () => {
    const transportSize = 2 * 65_536;
    const at = fixture({ transportSize });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);
    store.write(segmentOf(pseudoRandomBytes(transportSize), at.plan, 0));

    expect(storage.sessionNames()).toEqual([at.directoryName]);
    await store.dispose('discard');
    expect(storage.sessionNames()).toEqual([]);
    expect(storage.usedBytes()).toBe(0);
  });

  it('retains an interrupted session with metadata a resume can read', async () => {
    const transportSize = 4 * 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize, sha256: sha256Bytes(payload) });
    const storage = new FakeStorage();
    const store = await openStore(storage, at, () => 5_000);

    store.write(segmentOf(payload, at.plan, 0));
    store.write(segmentOf(payload, at.plan, 2));
    await store.settled();
    await store.dispose('retain');

    expect(storage.sessionNames()).toEqual([at.directoryName]);
    const directory = storage.sessions().get(at.directoryName) as unknown as DirectoryHandleLike;
    const checkpoint = await readCheckpoint(directory);
    expect(checkpoint).not.toBeNull();
    if (!checkpoint) return;

    expect(checkpoint.segmentCount).toBe(4);
    expect(checkpoint.segmentsCommitted).toBe(2);
    expect(checkpoint.bytesCommitted).toBe(2 * 65_536);
    expect(checkpoint.transportSize).toBe(String(transportSize));
    expect(checkpoint.sha256).toBe(digestToHex(at.manifest.sha256));
    expect(checkpoint.dataFile).toBe(OPFS_DATA_FILE);
    expect(checkpoint.state).toBe('receiving');

    // The bitmap is what tells a resume which ranges of the file are real
    // rather than pre-sized zeros, so it is read back bit by bit.
    const committed = base64ToBytes(checkpoint.committed);
    expect(committed).not.toBeNull();
    const bitSet = (index: number) => ((committed![index >> 3] >> (index & 7)) & 1) === 1;
    expect([bitSet(0), bitSet(1), bitSet(2), bitSet(3)]).toEqual([true, false, true, false]);
  });

  it('keeps a sealed session even when told to discard, because the export owns it', async () => {
    const transportSize = 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize, sha256: sha256Bytes(payload) });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);
    store.write(segmentOf(payload, at.plan, 0));

    const source = await store.seal();
    expect(source.kind).toBe('opfs');
    if (source.kind !== 'opfs') return;
    expect(isReceiverSessionPath(source.path)).toBe(true);
    expect(source.size).toBe(transportSize);

    // Sealing releases the exclusive lock. Without this the main thread's
    // `getFile` would fail on the last step of the whole transfer.
    const file = storage.sessions().get(at.directoryName)?.files.get(OPFS_DATA_FILE);
    expect(file?.locked).toBe(false);

    await store.dispose('discard');
    expect(storage.sessionNames()).toEqual([at.directoryName]);
    const checkpoint = await readCheckpoint(
      storage.sessions().get(at.directoryName) as unknown as DirectoryHandleLike,
    );
    expect(checkpoint?.state).toBe('verified');
  });

  it('coalesces checkpoint writes instead of queueing one per segment', async () => {
    const transportSize = 8 * 65_536;
    const payload = pseudoRandomBytes(transportSize);
    const at = fixture({ transportSize });
    const storage = new FakeStorage();
    const store = await openStore(storage, at);

    for (let index = 0; index < 8; index += 1) store.write(segmentOf(payload, at.plan, index));
    await store.settled();

    // Eight segments in one synchronous burst must not leave eight writes in
    // flight; the last state written is the one that matters.
    const checkpoint = await readCheckpoint(
      storage.sessions().get(at.directoryName) as unknown as DirectoryHandleLike,
    );
    expect(checkpoint?.segmentsCommitted).toBe(8);
    expect(checkpoint?.bytesCommitted).toBe(transportSize);
  });

  it('sweeps abandoned sessions by age and by count, and never the live one', async () => {
    const storage = new FakeStorage();
    const root = await storage.getDirectory();
    const now = 10_000_000;

    // Four abandoned sessions of different ages, plus one with no checkpoint
    // at all - which nothing could resume and is therefore debris.
    const ages = [1_000, 2_000, 3_000, 5_000_000];
    const names: string[] = [];
    for (let index = 0; index < ages.length; index += 1) {
      const at = fixture({ transportSize: 65_536, sessionId: 0x1000_0000 + index });
      const store = await openStore(storage, at, () => now - ages[index]);
      await store.settled();
      store.release();
      names.push(at.directoryName);
    }
    const sessions = storage.sessions();
    const orphan = await root.getDirectoryHandle('deqr', { create: true })
      .then((deqr) => deqr.getDirectoryHandle('sessions', { create: true }))
      .then((dir) => dir.getDirectoryHandle('deadbeef-deadbeef', { create: true }));
    await orphan.getFileHandle(OPFS_DATA_FILE, { create: true });
    expect(sessions.size).toBe(5);

    const removed = await sweepStaleSessions(root, {
      now: () => now,
      retentionMs: 100_000,
      maxRetained: 2,
      keep: names[2],
    });

    // Gone: the one past its retention age, the one with no checkpoint, and the
    // oldest survivor once the count bound applied. Kept: the newest two, and
    // `keep` regardless.
    expect(removed).toContain(names[3]);
    expect(removed).toContain('deadbeef-deadbeef');
    expect(storage.sessionNames()).toContain(names[2]);
    expect(storage.sessionNames().length).toBeLessThanOrEqual(3);
    expect(await readCheckpoint(
      storage.sessions().get(names[0]) as unknown as DirectoryHandleLike,
    )).not.toBeNull();
  });

  it('writes a checkpoint before the first segment, so a crash leaves an identifiable session', async () => {
    const at = fixture({ transportSize: 65_536 });
    const storage = new FakeStorage();
    await openStore(storage, at, () => 42);

    const directory = storage.sessions().get(at.directoryName);
    expect(directory?.files.has(OPFS_CHECKPOINT_FILE)).toBe(true);
    const checkpoint = await readCheckpoint(directory as unknown as DirectoryHandleLike);
    expect(checkpoint?.segmentsCommitted).toBe(0);
    expect(checkpoint?.createdAt).toBe(42);
  });
});

/* ------------------------------------------------------------ the 1 GiB gate */

describe('the acceptance gate: a gigabyte through a receiver that never holds one', () => {
  it('writes, reads back and verifies 1 GiB without allocating it', async () => {
    const transportSize = 1024 * 1024 * 1024;
    // Phase 04's Turbo shape: 1,139-byte symbols, 2,048 to a segment. 461
    // segments, the last of them short, which is the arithmetic that has to
    // hold at scale and not only in a three-segment fixture.
    const symbolSizeBytes = 1_139;
    const segmentSizeBytes = 2_048 * symbolSizeBytes;
    const at = fixture({ transportSize, segmentSizeBytes, symbolSizeBytes });

    expect(at.plan.segmentCount).toBe(461);
    expect(at.plan.lastSegmentBytes).toBeLessThan(segmentSizeBytes);

    const storage = new FakeStorage({ backing: () => new PatternBacking() });
    const store = await openStore(storage, at);

    const before = residentBytes();
    let peakResident = 0;
    for (let index = 0; index < at.plan.segmentCount; index += 1) {
      const range = segmentByteRange(at.plan, index);
      const bytes = patternBytes(Number(range.start), Number(range.end - range.start));
      expect(store.write({ segmentIndex: index, byteOffset: range.start, bytes })).toBe(STORE_WRITE.OK);
      peakResident = Math.max(peakResident, store.residentBytes());
    }
    await store.settled();

    expect(store.segmentsWritten()).toBe(at.plan.segmentCount);
    expect(store.bytesCommitted()).toBe(transportSize);

    const backing = storage.sessions().get(at.directoryName)!.files.get(OPFS_DATA_FILE)!.backing as PatternBacking;
    // Every write carried the bytes its offset says it should, and together
    // they cover the file exactly. A segment at the wrong offset fails both.
    expect(backing.mismatches).toBe(0);
    expect(backing.coveredBytes()).toBe(transportSize);
    expect(backing.size).toBe(transportSize);

    // The claim, stated three ways: the store holds nothing between writes, the
    // heap never grew by anything like the file, and the read path that follows
    // allocates one window rather than a gigabyte.
    expect(peakResident).toBe(0);
    expect(store.residentBytes()).toBe(0);

    const digest = await digestSegmentStore(store, transportSize, { yieldTo: async () => undefined });
    expect(digest).not.toBeNull();

    const expected = new Sha256Stream();
    const chunk = 1 << 20;
    for (let offset = 0; offset < transportSize; offset += chunk) {
      expected.update(patternBytes(offset, Math.min(chunk, transportSize - offset)));
    }
    expect(digestToHex(digest!)).toBe(digestToHex(expected.digest()));

    const growth = residentBytes() - before;
    expect(
      growth,
      `receiving 1 GiB grew the JS heap by ${(growth / (1024 * 1024)).toFixed(1)} MiB`,
    ).toBeLessThan(256 * 1024 * 1024);
  }, 300_000);
});
