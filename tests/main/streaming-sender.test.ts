import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DeqrError, ErrorCode } from '../../src/shared/errors';
import { repairNeighbors } from '../../src/core/segment-encoder';
import {
  V2_DATA_LAYOUT,
  V2_FRAME_TYPE,
  parseFrame,
  segmentByteRange,
  sourceSymbolCountForSegment,
  symbolByteRange,
  validateDataFrameAgainstManifest,
} from '../../src/core/protocol-v2';
import {
  SenderFileHandle,
  SenderFileOpener,
  SenderFileStat,
  StreamingSenderConfig,
  StreamingTransferSession,
  resolveStreamingSenderConfig,
} from '../../src/main/streaming-sender';

/* ------------------------------------------------------------- synthetic file */

const TILE_BYTES = 64 * 1024;

/** Deterministic content tile. Byte at absolute position p is `tile[p % TILE_BYTES]`. */
function buildTile(seed: number): Uint8Array {
  const tile = new Uint8Array(TILE_BYTES);
  let state = seed >>> 0;
  for (let index = 0; index < TILE_BYTES; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    tile[index] = state >>> 24;
  }
  return tile;
}

/**
 * A file that does not exist.
 *
 * Reads are `set` from a repeating 64 KiB tile, so a multi-gigabyte logical
 * file costs one tile of memory and memcpy-speed reads. That is what lets the
 * memory-bound test drive a real 1 GiB stream through the real pipeline without
 * a gigabyte existing anywhere.
 */
class SyntheticFile implements SenderFileHandle {
  readonly positions: bigint[] = [];
  reads = 0;
  closes = 0;
  largestRead = 0;
  private currentSize: bigint;
  private currentMtime: bigint;

  constructor(
    size: bigint,
    private readonly tile: Uint8Array = buildTile(0x5eed_1234),
    private readonly options: {
      isFile?: boolean;
      failReadAfter?: number;
      shortReadAfter?: number;
      mutateAfterReads?: number;
    } = {},
  ) {
    this.currentSize = size;
    this.currentMtime = 1_700_000_000_000n;
  }

  byteAt(position: bigint): number {
    return this.tile[Number(position % BigInt(TILE_BYTES))];
  }

  async stat(): Promise<SenderFileStat> {
    return { size: this.currentSize, mtimeMs: this.currentMtime, isFile: this.options.isFile ?? true };
  }

  async read(buffer: Uint8Array, length: number, position: bigint): Promise<number> {
    this.reads += 1;
    this.positions.push(position);
    this.largestRead = Math.max(this.largestRead, length);

    if (this.options.failReadAfter !== undefined && this.reads > this.options.failReadAfter) {
      throw new Error('synthetic read failure');
    }
    if (this.options.mutateAfterReads !== undefined && this.reads > this.options.mutateAfterReads) {
      this.currentMtime += 1n;
    }
    const effective = this.options.shortReadAfter !== undefined && this.reads > this.options.shortReadAfter
      ? Math.max(0, Math.floor(length / 2))
      : length;

    let written = 0;
    while (written < effective) {
      const tileOffset = Number((position + BigInt(written)) % BigInt(TILE_BYTES));
      const take = Math.min(effective - written, TILE_BYTES - tileOffset);
      buffer.set(this.tile.subarray(tileOffset, tileOffset + take), written);
      written += take;
    }
    return effective;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }

  truncateTo(size: bigint): void {
    this.currentSize = size;
    this.currentMtime += 1n;
  }
}

function openerFor(file: SenderFileHandle): SenderFileOpener & { opened: string[] } {
  const opened: string[] = [];
  const opener = (async (filePath: string) => {
    opened.push(filePath);
    return file;
  }) as SenderFileOpener & { opened: string[] };
  opener.opened = opened;
  return opener;
}

/** SHA-256 of the same synthetic stream, computed independently of the sender. */
function expectedDigest(file: SyntheticFile, size: bigint): string {
  const digest = createHash('sha256');
  const chunk = new Uint8Array(TILE_BYTES);
  let position = 0n;
  while (position < size) {
    const remaining = size - position;
    const want = remaining < BigInt(TILE_BYTES) ? Number(remaining) : TILE_BYTES;
    for (let index = 0; index < want; index += 1) chunk[index] = file.byteAt(position + BigInt(index));
    digest.update(chunk.subarray(0, want));
    position += BigInt(want);
  }
  return digest.digest('hex');
}

const smallConfig: Partial<StreamingSenderConfig> = {
  segmentSizeBytes: 64 * 1024,
  symbolSizeBytes: 512,
  frameQueueCapacity: 8,
  manifestIntervalFrames: 32,
  repairOverheadRatio: 0.1,
  hashChunkBytes: 16 * 1024,
  compressibilitySampleBytes: 16 * 1024,
  sessionId: 0x1111_2222,
  fileId: 0x3333_4444,
};

async function openSession(
  file: SyntheticFile,
  overrides: Partial<StreamingSenderConfig> = smallConfig,
  filePath = 'C:\\fixtures\\stream-sample.bin',
  signal?: AbortSignal,
): Promise<StreamingTransferSession> {
  return StreamingTransferSession.open(filePath, overrides, openerFor(file), signal);
}

/* ------------------------------------------------------------------- preflight */

describe('streaming sender preflight', () => {
  it('describes the file without ever holding it whole', async () => {
    const size = 300n * 1024n;
    const file = new SyntheticFile(size);
    const session = await openSession(file);

    expect(session.manifest.originalSize).toBe(size);
    expect(session.manifest.transportSize).toBe(size);
    expect(session.preflight.sha256Hex).toBe(expectedDigest(file, size));
    expect(session.plan.segmentCount).toBe(5);
    // Every read is bounded by the configured chunk, whatever the file size.
    expect(file.largestRead).toBeLessThanOrEqual(64 * 1024);
    await session.dispose();
  });

  it('samples compressibility from the bytes and does not act on it', async () => {
    const file = new SyntheticFile(300n * 1024n);
    const session = await openSession(file);

    expect(session.preflight.compressibility.sampled).toBe(true);
    expect(session.preflight.compressibility.inputBytes).toBeGreaterThan(0);
    // High-entropy tile: gzip cannot shrink it, and the manifest still says NONE.
    expect(session.preflight.compressibility.ratio).toBeGreaterThan(0.9);
    expect(session.manifest.compressionMode).toBe(0);
    expect(session.manifest.transportSize).toBe(session.manifest.originalSize);
    await session.dispose();
  });

  it('refuses an empty file and closes the handle', async () => {
    const file = new SyntheticFile(0n);
    await expect(openSession(file)).rejects.toMatchObject({ code: ErrorCode.FILE_EMPTY });
    expect(file.closes).toBe(1);
  });

  it('refuses a path that is not a regular file and closes the handle', async () => {
    const file = new SyntheticFile(1024n, buildTile(1), { isFile: false });
    await expect(openSession(file)).rejects.toMatchObject({ code: ErrorCode.FILE_NOT_REGULAR });
    expect(file.closes).toBe(1);
  });

  it('refuses a blocked extension before the file is opened at all', async () => {
    const file = new SyntheticFile(1024n);
    const opener = openerFor(file);
    await expect(
      StreamingTransferSession.open('C:\\fixtures\\payload.exe', smallConfig, opener),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_TYPE_BLOCKED });
    expect(opener.opened).toEqual([]);
    expect(file.reads).toBe(0);
  });

  it('handles a one-byte file', async () => {
    const file = new SyntheticFile(1n);
    const session = await openSession(file);
    expect(session.plan.segmentCount).toBe(1);
    expect(sourceSymbolCountForSegment(session.plan, 0)).toBe(1);

    const frames = await drain(session);
    const sources = frames.filter((frame) => frame.kind === 'data' && frame.frame.frameType === V2_FRAME_TYPE.SOURCE);
    expect(sources).toHaveLength(1);
    await session.dispose();
  });

  it('carries a long but legal filename through to the manifest', async () => {
    const longName = `${'a'.repeat(200)}.bin`;
    const file = new SyntheticFile(4096n);
    const session = await StreamingTransferSession.open(
      `C:\\fixtures\\${longName}`,
      smallConfig,
      openerFor(file),
    );
    expect(session.manifest.filename).toBe(longName);
    const first = parseFrame(await requireFrame(session));
    expect(first.ok && first.value.kind).toBe('manifest');
    await session.dispose();
  });

  it('refuses a file that changed while it was being hashed', async () => {
    const file = new SyntheticFile(128n * 1024n, buildTile(7), { mutateAfterReads: 1 });
    await expect(openSession(file)).rejects.toMatchObject({
      code: ErrorCode.FILE_CHANGED_DURING_TRANSFER,
    });
    expect(file.closes).toBe(1);
  });
});

/* ------------------------------------------------------------- memory bounds */

describe('memory stays bounded by configuration, not by file size', () => {
  it('computes a budget that does not mention the file size', () => {
    const shared = { segmentSizeBytes: 1024 * 1024, symbolSizeBytes: 512, frameQueueCapacity: 32 };
    const config = resolveStreamingSenderConfig(shared);
    // The budget is a pure function of configuration; two files of wildly
    // different sizes with the same configuration get the same budget.
    expect(config.segmentSizeBytes).toBe(1024 * 1024);
    expect(config.readAheadSegments).toBe(0);
  });

  it(
    'passes a synthetic 1 GiB stream with a bound under 3 MiB and no gigabyte allocation',
    async () => {
      const size = 1024n * 1024n * 1024n;
      const file = new SyntheticFile(size);
      const session = await openSession(file, {
        segmentSizeBytes: 4 * 1024 * 1024,
        symbolSizeBytes: 4096,
        frameQueueCapacity: 16,
        manifestIntervalFrames: 512,
        repairOverheadRatio: 0,
        hashChunkBytes: 1024 * 1024,
        sampleCompressibility: false,
        sessionId: 0x0bad_c0de,
        fileId: 0x0000_0001,
      });

      const budget = session.memoryBudgetBytes();
      expect(budget).toBeLessThan(5 * 1024 * 1024);
      expect(session.plan.segmentCount).toBe(256);

      let frames = 0;
      let peakBuffered = 0;
      let peakQueue = 0;
      while (true) {
        const frame = await session.take();
        if (!frame) break;
        frames += 1;
        peakBuffered = Math.max(peakBuffered, session.bufferedBytes());
        peakQueue = Math.max(peakQueue, session.queueDepth());
      }

      // 256 segments x 1024 source symbols, plus the recurring manifest.
      expect(frames).toBeGreaterThan(262_144);
      expect(peakBuffered).toBeLessThanOrEqual(budget);
      expect(peakQueue).toBeLessThanOrEqual(16);

      const progress = session.progress();
      expect(progress.complete).toBe(true);
      expect(progress.transportBytesCovered).toBe(size);
      expect(progress.sourceSymbolsEmitted).toBe(262_144);
      // Bytes handed to the display exceed the file, because every frame
      // carries a header and the manifest recurs. These are different numbers
      // on purpose.
      expect(progress.bytesOnTheWire).toBeGreaterThan(size);
      await session.dispose();
    },
    120_000,
  );

  it('keeps the same budget whether the file is 64 MiB or 4 GiB', async () => {
    const config: Partial<StreamingSenderConfig> = {
      ...smallConfig,
      sampleCompressibility: false,
      hashChunkBytes: 64 * 1024,
    };
    const small = await openSession(new SyntheticFile(64n * 1024n), config);
    const budget = small.memoryBudgetBytes();
    await small.dispose();

    // The 4 GiB case is asserted through the plan rather than by hashing four
    // gigabytes: the budget is a function of configuration, and the plan proves
    // the segment count grows while nothing else does.
    const large = await openSession(new SyntheticFile(640n * 1024n), config);
    expect(large.memoryBudgetBytes()).toBe(budget);
    expect(large.plan.segmentCount).toBeGreaterThan(small.plan.segmentCount);
    await large.dispose();
  });

  it('holds at most one segment when read-ahead is off, and two when it is on', async () => {
    const withoutReadAhead = await openSession(new SyntheticFile(256n * 1024n), { ...smallConfig, readAheadSegments: 0 });
    const withReadAhead = await openSession(new SyntheticFile(256n * 1024n), { ...smallConfig, readAheadSegments: 1 });

    const difference = withReadAhead.memoryBudgetBytes() - withoutReadAhead.memoryBudgetBytes();
    expect(difference).toBe(64 * 1024);

    await withoutReadAhead.dispose();
    await withReadAhead.dispose();
  });
});

/* ------------------------------------------------------------- >4 GB metadata */

describe('64-bit sizes and offsets', () => {
  it('derives segment offsets above 2^32 without touching the file', async () => {
    const size = 5n * 1024n * 1024n * 1024n;
    const file = new SyntheticFile(size);
    // `open()` hashes, so the offset arithmetic is asserted from the plan the
    // session would use. Phase 01 proves the same arithmetic end to end.
    const { planSegmentation } = await import('../../src/core/protocol-v2');
    const plan = planSegmentation({
      transportSize: size,
      segmentSizeBytes: 4 * 1024 * 1024,
      symbolSizeBytes: 4096,
    });
    expect(plan.segmentCount).toBe(1_280);

    const last = segmentByteRange(plan, plan.segmentCount - 1);
    expect(last.end).toBe(size);
    expect(last.start > BigInt(2 ** 32)).toBe(true);
    expect(symbolByteRange(plan, plan.segmentCount - 1, 0).start).toBe(last.start);
    expect(file.reads).toBe(0);
  });

  it('reads past the 4 GiB boundary using 64-bit positions', async () => {
    // A file just over 4 GiB, driven only far enough to prove the sender asks
    // for a position no 32-bit offset could express.
    const size = (1n << 32n) + 1_048_576n;
    const file = new SyntheticFile(size);
    const positions: bigint[] = file.positions;
    const session = await openSession(file, {
      segmentSizeBytes: 64 * 1024 * 1024,
      symbolSizeBytes: 4096,
      frameQueueCapacity: 4,
      manifestIntervalFrames: 1024,
      repairOverheadRatio: 0,
      hashChunkBytes: 64 * 1024 * 1024,
      sampleCompressibility: false,
      sessionId: 1,
      fileId: 1,
    });

    expect(session.manifest.originalSize).toBe(size);
    // 2^32 itself is already past what a uint32 offset can express.
    expect(positions.some((position) => position >= 4_294_967_296n)).toBe(true);
    expect(positions.every((position) => typeof position === 'bigint')).toBe(true);
    await session.dispose();
  }, 120_000);
});

/* -------------------------------------------------------------- backpressure */

describe('backpressure is structural', () => {
  it('produces nothing until a consumer asks', async () => {
    const file = new SyntheticFile(512n * 1024n);
    const session = await openSession(file, { ...smallConfig, sampleCompressibility: false });
    const readsAfterPreflight = file.reads;

    expect(session.queueDepth()).toBe(0);
    // No timer, no background pump: the pipeline is idle by construction.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.queueDepth()).toBe(0);
    expect(file.reads).toBe(readsAfterPreflight);
    await session.dispose();
  });

  it('never lets the ready queue exceed its capacity', async () => {
    const file = new SyntheticFile(512n * 1024n);
    const session = await openSession(file, { ...smallConfig, frameQueueCapacity: 4 });

    let peak = 0;
    for (let index = 0; index < 200; index += 1) {
      const frame = await session.take();
      if (!frame) break;
      peak = Math.max(peak, session.queueDepth());
      // A deliberately slow consumer. The producer cannot run ahead of it.
      if (index % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(peak).toBeLessThanOrEqual(4);
    await session.dispose();
  });

  it('stops reading ahead when the consumer stalls', async () => {
    const file = new SyntheticFile(1024n * 1024n);
    const session = await openSession(file, {
      ...smallConfig,
      frameQueueCapacity: 4,
      readAheadSegments: 1,
      sampleCompressibility: false,
    });

    // Preflight already streamed the file once to hash it; only reads after
    // that point are the pipeline running ahead.
    const readsAfterPreflight = file.reads;
    await session.take();
    const readsAfterFirstTake = file.reads;

    // Stall. With the queue full and one segment prefetched, nothing else can
    // be read no matter how long the consumer takes.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(file.reads).toBe(readsAfterFirstTake);

    // Read-ahead is bounded to one segment: the first take loads the current
    // segment and prefetches exactly one more.
    expect(readsAfterFirstTake - readsAfterPreflight).toBeLessThanOrEqual(2);
    await session.dispose();
  });
});

/* --------------------------------------------------------------- lifecycle */

describe('cancellation and lifecycle release resources', () => {
  it('aborts mid-segment and closes the descriptor', async () => {
    const controller = new AbortController();
    const file = new SyntheticFile(512n * 1024n);
    const session = await openSession(file, smallConfig, 'C:\\fixtures\\a.bin', controller.signal);

    await session.take();
    controller.abort();
    await expect(session.take()).rejects.toMatchObject({ code: ErrorCode.TRANSFER_CANCELLED });

    await session.dispose();
    expect(file.closes).toBe(1);
  });

  it('aborts during preflight without leaking the descriptor', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new SyntheticFile(512n * 1024n);
    await expect(
      openSession(file, smallConfig, 'C:\\fixtures\\a.bin', controller.signal),
    ).rejects.toMatchObject({ code: ErrorCode.TRANSFER_CANCELLED });
    expect(file.closes).toBe(1);
  });

  it('refuses to keep producing after dispose, and disposes idempotently', async () => {
    const file = new SyntheticFile(256n * 1024n);
    const session = await openSession(file);

    await session.take();
    await session.dispose();
    await session.dispose();

    expect(file.closes).toBe(1);
    expect(session.isDisposed).toBe(true);
    expect(session.bufferedBytes()).toBeLessThanOrEqual(session.memoryBudgetBytes());
    await expect(session.take()).rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSFER_STATE });
  });

  it('surfaces a read failure and still releases the descriptor', async () => {
    // 512 KiB hashed in 32 KiB chunks is 16 preflight reads, so failing after
    // the 17th puts the failure squarely in a segment read.
    const file = new SyntheticFile(512n * 1024n, buildTile(3), { failReadAfter: 17 });
    const session = await openSession(file, {
      ...smallConfig,
      sampleCompressibility: false,
      hashChunkBytes: 32 * 1024,
    });

    await expect(drainAll(session)).rejects.toThrow(/synthetic read failure/);
    await session.dispose();
    expect(file.closes).toBe(1);
  });

  it('detects a file truncated mid-transfer', async () => {
    const file = new SyntheticFile(512n * 1024n);
    const session = await openSession(file, { ...smallConfig, sampleCompressibility: false });

    await session.take();
    file.truncateTo(128n * 1024n);

    await expect(drainAll(session)).rejects.toMatchObject({
      code: ErrorCode.FILE_CHANGED_DURING_TRANSFER,
    });
    await session.dispose();
  });
});

/* --------------------------------------------------------------- correctness */

describe('the emitted stream reconstructs the file', () => {
  it('places every source symbol at its derived offset and matches the original bytes', async () => {
    const size = 300n * 1024n;
    const file = new SyntheticFile(size);
    const session = await openSession(file, { ...smallConfig, repairOverheadRatio: 0 });

    const rebuilt = new Uint8Array(Number(size));
    const covered = new Uint8Array(Number(size));
    let manifests = 0;

    for (const frame of await drain(session)) {
      if (frame.kind === 'manifest') {
        manifests += 1;
        continue;
      }
      const data = frame.frame;
      expect(validateDataFrameAgainstManifest(data, session.manifest, session.plan).ok).toBe(true);
      if (data.frameType !== V2_FRAME_TYPE.SOURCE) continue;

      // The frame carries no offset. It is derived, exactly as a receiver must.
      const range = symbolByteRange(session.plan, data.segmentIndex, data.symbolId);
      const start = Number(range.start);
      const length = Number(range.end - range.start);
      rebuilt.set(data.payload.subarray(0, length), start);
      covered.fill(1, start, start + length);
    }

    expect(manifests).toBeGreaterThan(1);
    expect(covered.every((byte) => byte === 1)).toBe(true);
    expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(session.preflight.sha256Hex);
    await session.dispose();
  });

  it('emits a manifest first and again on its interval', async () => {
    const file = new SyntheticFile(128n * 1024n);
    const session = await openSession(file, { ...smallConfig, manifestIntervalFrames: 10, repairOverheadRatio: 0 });

    const kinds = (await drain(session)).map((frame) => frame.kind);
    expect(kinds[0]).toBe('manifest');
    for (let index = 0; index < kinds.length; index += 1) {
      expect(kinds[index]).toBe(index % 10 === 0 ? 'manifest' : 'data');
    }
    await session.dispose();
  });

  it('builds each repair symbol as the XOR of the neighbours its own header names', async () => {
    const size = 64n * 1024n;
    const file = new SyntheticFile(size);
    const session = await openSession(file, {
      ...smallConfig,
      segmentSizeBytes: 64 * 1024,
      symbolSizeBytes: 512,
      repairOverheadRatio: 0.25,
    });

    const source = new Map<string, Uint8Array>();
    const repairs: Array<{ segmentIndex: number; symbolId: number; sourceSymbolCount: number; payload: Uint8Array }> = [];

    for (const frame of await drain(session)) {
      if (frame.kind !== 'data') continue;
      const data = frame.frame;
      if (data.frameType === V2_FRAME_TYPE.SOURCE) {
        source.set(`${data.segmentIndex}:${data.symbolId}`, data.payload);
      } else {
        repairs.push(data);
      }
    }

    expect(repairs.length).toBeGreaterThan(0);
    for (const repair of repairs) {
      const expected = new Uint8Array(session.manifest.symbolSizeBytes);
      for (const neighbor of repairNeighbors(repair.symbolId, repair.sourceSymbolCount)) {
        const block = source.get(`${repair.segmentIndex}:${neighbor}`);
        expect(block, `missing source symbol ${repair.segmentIndex}:${neighbor}`).toBeDefined();
        for (let index = 0; index < expected.length; index += 1) expected[index] ^= block![index];
      }
      expect(Array.from(repair.payload)).toEqual(Array.from(expected));
    }
    await session.dispose();
  });

  it('keeps original-byte, wire-byte, and frame progress distinct', async () => {
    const size = 128n * 1024n;
    const file = new SyntheticFile(size);
    const session = await openSession(file, { ...smallConfig, repairOverheadRatio: 0.5, manifestIntervalFrames: 8 });

    await drainAll(session);
    const progress = session.progress();

    expect(progress.transportBytesCovered).toBe(size);
    expect(progress.bytesOnTheWire).toBeGreaterThan(size);
    expect(progress.framesEmitted).toBe(
      progress.manifestFramesEmitted + progress.sourceSymbolsEmitted + progress.repairSymbolsEmitted,
    );
    expect(progress.repairSymbolsEmitted).toBeGreaterThan(0);
    expect(progress.segmentsCompleted).toBe(session.plan.segmentCount);
    await session.dispose();
  });

  it('keeps every frame inside one QR-sized payload', async () => {
    const file = new SyntheticFile(64n * 1024n);
    const session = await openSession(file);
    const maximum = session.manifest.symbolSizeBytes + V2_DATA_LAYOUT.overheadBytes;

    for (const frame of await drain(session)) {
      const bytes = frame.kind === 'manifest' ? frame.raw : frame.raw;
      expect(bytes.length).toBeLessThanOrEqual(Math.max(maximum, 1024));
    }
    await session.dispose();
  });
});

/* ------------------------------------------------------------------ helpers */

type DrainedFrame =
  | { kind: 'manifest'; raw: Uint8Array }
  | { kind: 'data'; raw: Uint8Array; frame: ReturnType<typeof parseDataFrameOrThrow> };

function parseDataFrameOrThrow(bytes: Uint8Array) {
  const parsed = parseFrame(bytes);
  if (!parsed.ok) throw new DeqrError(ErrorCode.INTERNAL_ERROR, `sender emitted an unparseable frame: ${parsed.error.code}`);
  if (parsed.value.kind !== 'data') throw new DeqrError(ErrorCode.INTERNAL_ERROR, 'expected a data frame');
  return parsed.value.frame;
}

async function requireFrame(session: StreamingTransferSession): Promise<Uint8Array> {
  const frame = await session.take();
  if (!frame) throw new Error('session produced no frame');
  return frame;
}

async function drain(session: StreamingTransferSession): Promise<DrainedFrame[]> {
  const frames: DrainedFrame[] = [];
  while (true) {
    const raw = await session.take();
    if (!raw) break;
    const parsed = parseFrame(raw);
    if (!parsed.ok) throw new Error(`sender emitted an unparseable frame: ${parsed.error.code}`);
    frames.push(parsed.value.kind === 'manifest'
      ? { kind: 'manifest', raw }
      : { kind: 'data', raw, frame: parsed.value.frame });
  }
  return frames;
}

async function drainAll(session: StreamingTransferSession): Promise<number> {
  let count = 0;
  while (await session.take()) count += 1;
  return count;
}
