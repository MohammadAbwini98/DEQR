import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  V2_COMPRESSION,
  V2_COMPRESSION_WINDOW,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  V2_WINDOW_LENGTH_PREFIX_BYTES,
  planCompressionWindows,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  type DeqrV2Manifest,
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import { maxCompressedWindowBytes } from '../../src/core/compression-policy';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { OPFS_DATA_FILE, OPFS_ORIGINAL_FILE, sessionDirectoryName } from '../src/opfs';
import { canDecompress, inflateWindowContainer } from '../src/inflate-verify';
import { ReceivePipeline, type VerifyProgress } from '../src/receive-pipeline';
import { ReceiverStorage } from '../src/receiver-storage';
import { BoundedMemoryOriginalSink, STORE_WRITE } from '../src/segment-store';
import { FakeStorage, fakeEnvironment } from './helpers/fake-opfs';

/**
 * Receiving a transfer that arrived compressed.
 *
 * Everything up to the last segment is unchanged from Phase 06 and 07 - the
 * same frames, the same decoders, the same pre-sized file at the same transport
 * offsets - and this file is about the two things that are different:
 *
 * - **The container is expanded, under bounds taken from the manifest.** A
 *   window that decompresses to the wrong length, a record that declares more
 *   bytes than zlib could produce, a member that will not decode, and bytes
 *   past the last window are four separate refusals, and none of them is
 *   allowed to allocate first.
 * - **The digest is still the only authority.** It runs over the decompressed
 *   file, read back off the device, exactly as it runs over an uncompressed
 *   one. Decompressing successfully proves the container was well formed; it
 *   proves nothing about identity.
 */

/* ----------------------------------------------------------------- fixtures */

const SESSION_ID = 0x5eed_0108;
const FILE_ID = 0x0a0b_0c0f;
const SEGMENT_BYTES = 65_536;
const SYMBOL_BYTES = 512;
const WINDOW_LOG2 = V2_COMPRESSION_WINDOW.minLog2;
const WINDOW = 2 ** WINDOW_LOG2;

/** Bytes that compress, so a compressed fixture is smaller than its file. */
function textLike(length: number, seed = 1): Uint8Array {
  const words = ['transfer', 'segment', 'symbol', 'manifest', 'receiver', 'optical'];
  let out = '';
  let state = seed >>> 0;
  while (out.length < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += `${words[state % words.length]} ${state % 1000} `;
  }
  return new TextEncoder().encode(out).slice(0, length);
}

/** One window record: a big-endian length in front of a gzip member. */
function record(member: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(V2_WINDOW_LENGTH_PREFIX_BYTES + member.length);
  new DataView(bytes.buffer).setUint32(0, member.length, false);
  bytes.set(member, V2_WINDOW_LENGTH_PREFIX_BYTES);
  return bytes;
}

/** Builds the container a Phase 08 sender would put on the wire. */
function buildContainer(original: Uint8Array, windowBytes = WINDOW): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < original.length; at += windowBytes) {
    parts.push(record(gzipSync(original.subarray(at, Math.min(at + windowBytes, original.length)), { level: 6 })));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const container = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    container.set(part, offset);
    offset += part.length;
  }
  return container;
}

interface Fixture {
  manifest: DeqrV2Manifest;
  manifestFrame: Uint8Array;
  plan: SegmentPlan;
  original: Uint8Array;
  container: Uint8Array;
  directoryName: string;
  allFrames(): Uint8Array[];
}

async function fixture(options: {
  original?: Uint8Array;
  container?: Uint8Array;
  windowLog2?: number;
  corruptDigest?: boolean;
} = {}): Promise<Fixture> {
  const original = options.original ?? textLike(WINDOW * 3 + 4_321);
  const windowLog2 = options.windowLog2 ?? WINDOW_LOG2;
  const container = options.container ?? buildContainer(original, 2 ** windowLog2);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', original.buffer as ArrayBuffer));
  if (options.corruptDigest) digest[0] ^= 0xff;

  const plan = planSegmentation({
    transportSize: BigInt(container.length),
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
  });

  const manifest: DeqrV2Manifest = {
    featureFlags: 0,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    originalSize: BigInt(original.length),
    transportSize: BigInt(container.length),
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.GZIP,
    compressionParam: windowLog2,
    transportProfileId: 0,
    sha256: digest,
    filename: 'phase08-compressed.bin',
    mimeType: 'application/octet-stream',
  };

  return {
    manifest,
    manifestFrame: serializeManifestFrame(manifest),
    plan,
    original,
    container,
    directoryName: sessionDirectoryName(SESSION_ID, FILE_ID),
    allFrames() {
      const frames: Uint8Array[] = [];
      for (let segmentIndex = 0; segmentIndex < plan.segmentCount; segmentIndex += 1) {
        const range = segmentByteRange(plan, segmentIndex);
        const encoder = new SegmentEncoder(SYMBOL_BYTES);
        encoder.loadSegment(container.subarray(Number(range.start), Number(range.end)));
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
  options: { onVerifyProgress?: (progress: VerifyProgress) => void } = {},
): ReceivePipeline {
  return new ReceivePipeline({
    storage: new ReceiverStorage({
      environment: { storage, supportsSyncAccess: true },
      now: () => 1_700_000_000_000,
    }),
    onVerifyProgress: options.onVerifyProgress,
  });
}

async function receiveEverything(pipeline: ReceivePipeline, at: Fixture): Promise<void> {
  pipeline.submit(at.manifestFrame);
  await pipeline.whenStorageReady();
  for (const frame of at.allFrames()) pipeline.submit(frame);
}

/* ------------------------------------------------------------ the happy path */

describe('a compressed transfer verifies to the file it carried', () => {
  it('expands the container, hashes the file, and exports the file', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage);
    await receiveEverything(pipeline, at);

    const result = await pipeline.verify();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The size a user sees is the file's, not the container's.
    expect(result.value.size).toBe(at.original.length);
    expect(at.container.length).toBeLessThan(at.original.length);
    expect(result.value.source.kind).toBe('opfs');
    if (result.value.source.kind !== 'opfs') return;
    // And the export route points at the decompressed file, not the container.
    expect(result.value.source.file).toBe(OPFS_ORIGINAL_FILE);
    expect(result.value.source.size).toBe(at.original.length);
  });

  it('writes the original bytes to the device, byte for byte', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage);
    await receiveEverything(pipeline, at);
    expect((await pipeline.verify()).ok).toBe(true);

    const file = storage.sessions().get(at.directoryName)?.files.get(OPFS_ORIGINAL_FILE);
    expect(file).toBeDefined();
    const read = new Uint8Array(at.original.length);
    file!.backing.read(0, read);
    expect(Buffer.from(read).equals(Buffer.from(at.original))).toBe(true);
  });

  it('reports both sizes and the mode while it is receiving', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage);
    await receiveEverything(pipeline, at);

    const progress = pipeline.progress();
    expect(progress.originalBytes).toBe(at.original.length);
    expect(progress.transportBytes).toBe(at.container.length);
    expect(progress.compressionMode).toBe(V2_COMPRESSION.GZIP);
    // The two are genuinely different, which is the reason both are carried.
    expect(progress.transportBytes).toBeLessThan(progress.originalBytes);
  });

  it('names the two verification passes so a bar can span both', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const seen: VerifyProgress[] = [];
    const pipeline = pipelineOver(storage, { onVerifyProgress: (progress) => seen.push({ ...progress }) });
    await receiveEverything(pipeline, at);
    expect((await pipeline.verify()).ok).toBe(true);

    const phases = seen.map((progress) => progress.phase);
    expect(phases[0]).toBe('decompressing');
    expect(phases[phases.length - 1]).toBe('hashing');
    // Decompression finishes before hashing starts; a phase that reappeared
    // later would mean the two passes were interleaved.
    expect(phases.lastIndexOf('decompressing')).toBeLessThan(phases.indexOf('hashing'));
  });

  it('still fails a transfer whose decompressed bytes are not the file', async () => {
    // The container is well formed and expands perfectly. Only the digest can
    // catch a manifest that describes a different file.
    const { storage } = fakeEnvironment();
    const at = await fixture({ corruptDigest: true });
    const pipeline = pipelineOver(storage);
    await receiveEverything(pipeline, at);

    const result = await pipeline.verify();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('HASH_MISMATCH');
    expect('value' in result).toBe(false);
  });

  it('still fails when the container was altered on the device', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage);
    await receiveEverything(pipeline, at);

    // A bit flipped inside a stored gzip member. Every frame was well formed
    // and every CRC passed; the member's own checksum is what refuses it.
    const file = storage.sessions().get(at.directoryName)?.files.get(OPFS_DATA_FILE);
    const one = new Uint8Array(1);
    file!.backing.read(200, one);
    file!.backing.write(200, Uint8Array.of(one[0] ^ 0x01));

    const result = await pipeline.verify();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['DECOMPRESSION_FAILED', 'DECOMPRESSED_SIZE_MISMATCH']).toContain(result.code);
  });
});

/* ------------------------------------------------------------ refusing input */

describe('the receiver refuses a manifest it cannot honour', () => {
  it('refuses compression when the browser has no decompressor', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const original = (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
    try {
      delete (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
      expect(canDecompress()).toBe(false);
      const pipeline = pipelineOver(storage);
      const result = pipeline.submit(at.manifestFrame);
      expect(result.outcome).toBe('rejected');
      expect(result.reason).toBe('UNSUPPORTED_COMPRESSION');
      // And nothing was provisioned: the refusal costs no storage work at all.
      expect(storage.sessions().size).toBe(0);
    } finally {
      (globalThis as { DecompressionStream?: unknown }).DecompressionStream = original;
    }
  });

  it('reserves room for both files before a single frame is accepted', async () => {
    const at = await fixture();
    // Enough for the container, not enough for the container and the file.
    const { storage } = fakeEnvironment({
      quotaBytes: at.container.length + Math.floor(at.original.length / 2),
    });
    const pipeline = pipelineOver(storage);
    pipeline.submit(at.manifestFrame);
    await pipeline.whenStorageReady();

    const result = pipeline.submit(at.allFrames()[0]);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('INSUFFICIENT_STORAGE');
  });

  it('pre-sizes the decompressed file at session start, not at verification', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage);
    pipeline.submit(at.manifestFrame);
    await pipeline.whenStorageReady();

    // Before any segment has landed, both files already exist at full size.
    const session = storage.sessions().get(at.directoryName);
    expect(session?.files.get(OPFS_DATA_FILE)?.backing.size).toBe(at.container.length);
    expect(session?.files.get(OPFS_ORIGINAL_FILE)?.backing.size).toBe(at.original.length);
  });
});

/* -------------------------------------------------- the container's own rules */

describe('expanding a container is bounded by the manifest, never by the stream', () => {
  const windows = planCompressionWindows({ originalSize: BigInt(WINDOW * 2), compressionParam: WINDOW_LOG2 });

  function sourceOf(container: Uint8Array) {
    return {
      read(offset: number, into: Uint8Array): number {
        if (offset < 0 || offset >= container.length) return 0;
        const take = Math.min(into.length, container.length - offset);
        into.set(container.subarray(offset, offset + take), 0);
        return take;
      },
    };
  }

  async function expand(container: Uint8Array, originalSize = WINDOW * 2) {
    const sink = new BoundedMemoryOriginalSink(originalSize);
    return inflateWindowContainer(sourceOf(container), sink, {
      transportSize: container.length,
      originalSize,
      windows,
    });
  }

  it('expands a well-formed container', async () => {
    const original = textLike(WINDOW * 2);
    const result = await expand(buildContainer(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytesWritten).toBe(original.length);
  });

  it('refuses a record longer than zlib could ever produce, before allocating for it', async () => {
    const container = buildContainer(textLike(WINDOW * 2));
    // 4 GiB minus one, in the length prefix of the first record. A receiver
    // that trusted this would try to hold four gigabytes.
    new DataView(container.buffer, container.byteOffset, container.byteLength).setUint32(0, 0xffff_fffe, false);
    const result = await expand(container);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPRESSED_CONTAINER_INVALID');
    // The bound the guard used is a function of the window, not of the file.
    expect(maxCompressedWindowBytes(WINDOW)).toBeLessThan(WINDOW * 1.01 + 64);
  });

  it('refuses a window that expands past its declared length', async () => {
    // The decompression bomb. A member holding a whole window's worth of zeros
    // is tiny; the manifest says this window is only 64 bytes long.
    const bomb = record(gzipSync(new Uint8Array(WINDOW), { level: 9 }));
    const tinyWindows = planCompressionWindows({ originalSize: 64n, compressionParam: WINDOW_LOG2 });
    const sink = new BoundedMemoryOriginalSink(64);
    const result = await inflateWindowContainer(sourceOf(bomb), sink, {
      transportSize: bomb.length,
      originalSize: 64,
      windows: tinyWindows,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DECOMPRESSED_SIZE_MISMATCH');
    // Nothing was written: the sink is still empty.
    expect(sink.bytesWritten()).toBe(0);
  });

  it('refuses a window that decompresses short', async () => {
    const container = record(gzipSync(textLike(WINDOW - 1), { level: 6 }));
    const result = await inflateWindowContainer(sourceOf(container), new BoundedMemoryOriginalSink(WINDOW * 2), {
      transportSize: container.length,
      originalSize: WINDOW * 2,
      windows,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DECOMPRESSED_SIZE_MISMATCH');
  });

  it('refuses a member that will not decode', async () => {
    const container = buildContainer(textLike(WINDOW * 2));
    container[V2_WINDOW_LENGTH_PREFIX_BYTES + 40] ^= 0xff;
    const result = await expand(container);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DECOMPRESSION_FAILED');
  });

  it('refuses bytes past the last window', async () => {
    const good = buildContainer(textLike(WINDOW * 2));
    const padded = new Uint8Array(good.length + 32);
    padded.set(good);
    const result = await expand(padded);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPRESSED_CONTAINER_INVALID');
  });

  it('refuses a container that ends before its last window', async () => {
    const good = buildContainer(textLike(WINDOW * 2));
    const result = await expand(good.subarray(0, good.length - 40));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['COMPRESSED_CONTAINER_INVALID', 'DECOMPRESSION_FAILED']).toContain(result.code);
  });

  it('stops when the session is cancelled during a yield', async () => {
    const original = textLike(WINDOW * 2);
    const container = buildContainer(original);
    let cancelled = false;
    const result = await inflateWindowContainer(sourceOf(container), new BoundedMemoryOriginalSink(original.length), {
      transportSize: container.length,
      originalSize: original.length,
      windows,
      yieldEveryBytes: 1,
      yieldTo: async () => { cancelled = true; },
      isCancelled: () => cancelled,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('RELEASED');
  });

  it('reports a sink that refuses, rather than carrying on', async () => {
    const original = textLike(WINDOW * 2);
    const container = buildContainer(original);
    const refusing = {
      write: () => STORE_WRITE.FULL,
    };
    const result = await inflateWindowContainer(sourceOf(container), refusing, {
      transportSize: container.length,
      originalSize: original.length,
      windows,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('STORAGE_FULL');
  });
});

/* ------------------------------------------------------------------- memory */

describe('expanding a container is bounded memory', () => {
  it('holds one window and one record, whatever the file weighs', async () => {
    // 4 MiB of file through 64 KiB windows. The sink is the only thing that
    // scales, and on the OPFS path it holds nothing at all.
    const original = textLike(WINDOW * 64);
    const container = buildContainer(original);
    const windows = planCompressionWindows({
      originalSize: BigInt(original.length),
      compressionParam: WINDOW_LOG2,
    });

    let peak = 0;
    const sink = {
      write(_offset: number, bytes: Uint8Array) {
        peak = Math.max(peak, bytes.length);
        return STORE_WRITE.OK;
      },
    };
    const result = await inflateWindowContainer(
      {
        read(offset: number, into: Uint8Array): number {
          const take = Math.min(into.length, container.length - offset);
          if (take <= 0) return 0;
          into.set(container.subarray(offset, offset + take), 0);
          return take;
        },
      },
      sink,
      { transportSize: container.length, originalSize: original.length, windows },
    );
    expect(result.ok).toBe(true);
    // No write ever carried more than one window, so nothing accumulated.
    expect(peak).toBeLessThanOrEqual(WINDOW);
  });
});
