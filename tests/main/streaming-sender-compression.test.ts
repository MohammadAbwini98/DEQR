import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  V2_COMPRESSION,
  V2_COMPRESSION_WINDOW,
  V2_FRAME_TYPE,
  V2_WINDOW_LENGTH_PREFIX_BYTES,
  parseFrame,
} from '../../src/core/protocol-v2';
import { COMPRESSION_REASON } from '../../src/core/compression-policy';
import {
  SenderFileHandle,
  SenderFileOpener,
  SenderFileStat,
  StreamingTransferSession,
} from '../../src/main/streaming-sender';

/* ------------------------------------------------------------------ fixtures */

const SEGMENT_SIZE = 64 * 1024;
const SYMBOL_SIZE = 1_024;
const WINDOW_LOG2 = 16;
const WINDOW = 2 ** WINDOW_LOG2;

/** English-shaped bytes: a small vocabulary with structure. Compresses well. */
function textLike(length: number, seed = 1): Uint8Array {
  const words = ['transfer', 'segment', 'symbol', 'manifest', 'receiver', 'optical', 'window', 'stream'];
  let out = '';
  let state = seed >>> 0;
  while (out.length < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += `${words[state % words.length]} ${state % 1000} `;
  }
  return new TextEncoder().encode(out).subarray(0, length);
}

/** Row-structured bytes, the CSV/SQL-like case the plan asks to benchmark. */
function tableLike(length: number): Uint8Array {
  let out = 'id,name,department,salary,started\n';
  let row = 0;
  while (out.length < length) {
    out += `${row},Employee ${row % 500},Engineering,${80_000 + (row % 40) * 1_000},2020-0${1 + (row % 9)}-15\n`;
    row += 1;
  }
  return new TextEncoder().encode(out).subarray(0, length);
}

/** High-entropy bytes. Stands in for anything already compressed or encrypted. */
function randomLike(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

class BufferFile implements SenderFileHandle {
  closed = false;

  constructor(private readonly bytes: Uint8Array) {}

  async stat(): Promise<SenderFileStat> {
    return { size: BigInt(this.bytes.length), mtimeMs: 1_700_000_000_000n, isFile: true };
  }

  async read(buffer: Uint8Array, length: number, position: bigint): Promise<number> {
    const start = Number(position);
    const take = Math.min(length, this.bytes.length - start);
    if (take <= 0) return 0;
    buffer.set(this.bytes.subarray(start, start + take), 0);
    return take;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** One set of bytes, openable under any name at all. */
function openerFor(bytes: Uint8Array): SenderFileOpener {
  return async () => new BufferFile(bytes);
}

const overrides = {
  segmentSizeBytes: SEGMENT_SIZE,
  symbolSizeBytes: SYMBOL_SIZE,
  compressionWindowLog2: WINDOW_LOG2,
  compressibilitySampleBytes: 4_096,
  sessionId: 0x1111_2222,
  fileId: 0x3333_4444,
};

async function open(bytes: Uint8Array, name: string, extra: Record<string, unknown> = {}) {
  return StreamingTransferSession.open(`D:/fixtures/${name}`, { ...overrides, ...extra }, openerFor(bytes));
}

/** Every frame the session produces, in order. */
async function drainFrames(session: StreamingTransferSession): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = [];
  for (;;) {
    const frame = await session.take();
    if (!frame) break;
    frames.push(frame);
  }
  return frames;
}

/* -------------------------------------------------------------------- tests */

describe('the extension never reaches the transport decision', () => {
  /**
   * The phase gate, stated literally: identical bytes saved under five
   * different names must take the same path. Nothing in the sender is given
   * the chance to look at the name - `decideCompression` has no parameter for
   * one - and this is the end-to-end demonstration of it.
   */
  it('gives identical compression decisions to identical bytes under five names', async () => {
    const bytes = tableLike(WINDOW * 3 + 517);
    const names = ['report.txt', 'report.zip', 'report.pdf', 'report.xlsx', 'report.bin'];

    const results = [];
    for (const name of names) {
      const session = await open(bytes, name);
      results.push({
        mode: session.manifest.compressionMode,
        param: session.manifest.compressionParam,
        transportSize: session.manifest.transportSize.toString(),
        originalSize: session.manifest.originalSize.toString(),
        segmentCount: session.manifest.segmentCount,
        digest: session.preflight.sha256Hex,
        reason: session.preflight.compression.reason,
      });
      await session.dispose();
    }

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(results[0].mode).toBe(V2_COMPRESSION.GZIP);
  });

  it('gives identical decisions to incompressible bytes under the same five names', async () => {
    // The other half of the rule. A `.txt` full of high-entropy bytes must be
    // refused compression exactly as a `.zip` full of them is.
    const bytes = randomLike(WINDOW * 3);
    const names = ['blob.txt', 'blob.zip', 'blob.pdf', 'blob.xlsx', 'blob.bin'];

    const modes = new Set<number>();
    for (const name of names) {
      const session = await open(bytes, name);
      modes.add(session.manifest.compressionMode);
      await session.dispose();
    }
    expect(modes).toEqual(new Set([V2_COMPRESSION.NONE]));
  });
});

describe('the bytes decide, and the decision is recorded', () => {
  it('compresses text-shaped bytes and says why', async () => {
    const session = await open(textLike(WINDOW * 4), 'notes.dat');
    expect(session.manifest.compressionMode).toBe(V2_COMPRESSION.GZIP);
    expect(session.manifest.compressionParam).toBe(WINDOW_LOG2);
    expect(session.preflight.compression.reason).toBe(COMPRESSION_REASON.MEASURED_ABOVE_THRESHOLD);
    expect(session.preflight.compression.ratio).toBeLessThan(0.9);
    expect(session.manifest.transportSize).toBeLessThan(session.manifest.originalSize);
    await session.dispose();
  });

  it('bypasses compression for incompressible bytes, leaving the sizes equal', async () => {
    const session = await open(randomLike(WINDOW * 4), 'noise.dat');
    expect(session.manifest.compressionMode).toBe(V2_COMPRESSION.NONE);
    expect(session.manifest.compressionParam).toBe(0);
    expect(session.manifest.transportSize).toBe(session.manifest.originalSize);
    expect(session.preflight.compression.reason).toBe(COMPRESSION_REASON.BELOW_THRESHOLD);
    await session.dispose();
  });

  it('bypasses compression when it is switched off, whatever the bytes say', async () => {
    const session = await open(textLike(WINDOW * 4), 'notes.dat', { compressionEnabled: false });
    expect(session.manifest.compressionMode).toBe(V2_COMPRESSION.NONE);
    expect(session.preflight.compression.reason).toBe(COMPRESSION_REASON.DISABLED);
    // The measurement still happens, because reporting compressibility and
    // acting on it are two decisions.
    expect(session.preflight.compressibility.sampled).toBe(true);
    await session.dispose();
  });

  it('lets the whole-file measurement overrule an optimistic sample', async () => {
    // The file built to fool the sampler: text in exactly the three 4 KiB
    // windows it reads - first, middle, last - and high-entropy noise in the
    // 99% between them. The sample sees a ratio near zero; the file is
    // incompressible.
    const bytes = randomLike(WINDOW * 16);
    const size = bytes.length;
    for (const [at, seed] of [[0, 1], [size / 2 - 2_048, 3], [size - 4_096, 5]] as const) {
      bytes.set(textLike(4_096, seed), at);
    }

    const session = await open(bytes, 'mixed.dat');
    expect(session.preflight.compressibility.ratio).toBeLessThan(0.5);
    expect(session.manifest.compressionMode).toBe(V2_COMPRESSION.NONE);
    expect(session.preflight.compression.reason).toBe(COMPRESSION_REASON.MEASURED_BELOW_THRESHOLD);
    expect(session.manifest.transportSize).toBe(session.manifest.originalSize);
    await session.dispose();
  });

  it('honours a threshold that a caller moves', async () => {
    // One window of text in sixteen of noise: a real gain of a few percent,
    // which is exactly the region the threshold exists to rule on.
    const bytes = randomLike(WINDOW * 16);
    bytes.set(textLike(WINDOW), 0);

    const strict = await open(bytes, 'mostly-noise.dat');
    expect(strict.manifest.compressionMode).toBe(V2_COMPRESSION.NONE);
    await strict.dispose();

    const lenient = await open(bytes, 'mostly-noise.dat', { compressionThreshold: 0.01 });
    expect(lenient.manifest.compressionMode).toBe(V2_COMPRESSION.GZIP);
    await lenient.dispose();
  });
});

describe('compression changes the wire and nothing else', () => {
  it('hashes the original file in both modes', async () => {
    // The rule the whole integrity story rests on: SHA-256 describes the file,
    // never the container. A receiver checks the same digest either way.
    const bytes = textLike(WINDOW * 3);
    const expected = createHash('sha256').update(bytes).digest('hex');

    const compressed = await open(bytes, 'a.dat');
    const plain = await open(bytes, 'a.dat', { compressionEnabled: false });
    expect(compressed.preflight.sha256Hex).toBe(expected);
    expect(plain.preflight.sha256Hex).toBe(expected);
    expect(compressed.manifest.compressionMode).toBe(V2_COMPRESSION.GZIP);
    await compressed.dispose();
    await plain.dispose();
  });

  it('puts fewer frames on the wire for the same file', async () => {
    // "Compressible data improves effective throughput", measured the only way
    // that matters optically: frames a display has to show.
    const bytes = tableLike(WINDOW * 8);

    const compressed = await open(bytes, 'rows.dat');
    const compressedFrames = (await drainFrames(compressed)).length;
    await compressed.dispose();

    const plain = await open(bytes, 'rows.dat', { compressionEnabled: false });
    const plainFrames = (await drainFrames(plain)).length;
    await plain.dispose();

    expect(compressedFrames).toBeLessThan(plainFrames / 2);
  });

  it('emits a transport stream that expands back to the file', async () => {
    const bytes = textLike(WINDOW * 3 + 991);
    const session = await open(bytes, 'roundtrip.dat');
    const transportSize = Number(session.manifest.transportSize);

    // Rebuilt from the source symbols the way a receiver's store does: each
    // segment's payload written at its own transport offset.
    const container = new Uint8Array(transportSize);
    for (const frame of await drainFrames(session)) {
      const parsed = sourceFrame(frame);
      if (!parsed) continue;
      const offset = parsed.segmentIndex * SEGMENT_SIZE + parsed.symbolId * SYMBOL_SIZE;
      if (offset >= transportSize) continue;
      const take = Math.min(SYMBOL_SIZE, transportSize - offset);
      container.set(parsed.payload.subarray(0, take), offset);
    }
    await session.dispose();

    expect(expandContainer(container)).toEqual(Buffer.from(bytes));
  });
});

describe('memory stays a function of configuration', () => {
  it('never holds more than its budget with compression on', async () => {
    const session = await open(tableLike(WINDOW * 24), 'big-rows.dat');
    expect(session.manifest.compressionMode).toBe(V2_COMPRESSION.GZIP);

    const budget = session.memoryBudgetBytes();
    let peak = 0;
    for (;;) {
      const frame = await session.take();
      if (!frame) break;
      peak = Math.max(peak, session.bufferedBytes());
    }
    expect(peak).toBeLessThanOrEqual(budget);
    // The budget covers a window and a record on top of the uncompressed one,
    // and it is still nowhere near the file.
    expect(budget).toBeLessThan(WINDOW * 24);
    await session.dispose();
  });
});

/* ------------------------------------------------------------------ helpers */

/**
 * Source-frame fields, or null for a manifest or a repair frame.
 *
 * Read through the real parser rather than by re-deriving the layout here: a
 * test that reimplements the wire format can pass against a sender that has
 * stopped writing it.
 */
function sourceFrame(frame: Uint8Array): {
  segmentIndex: number;
  symbolId: number;
  payload: Uint8Array;
} | null {
  const result = parseFrame(frame);
  if (!result.ok || result.value.kind !== 'data') return null;
  if (result.value.frame.frameType !== V2_FRAME_TYPE.SOURCE) return null;
  const { segmentIndex, symbolId, payload } = result.value.frame;
  return { segmentIndex, symbolId, payload };
}

/** Splits a container into its gzip members and inflates each one. */
function expandContainer(container: Uint8Array): Buffer {
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const parts: Buffer[] = [];
  let cursor = 0;
  while (cursor < container.length) {
    const declared = view.getUint32(cursor, false);
    cursor += V2_WINDOW_LENGTH_PREFIX_BYTES;
    parts.push(gunzipSync(container.subarray(cursor, cursor + declared)));
    cursor += declared;
  }
  return Buffer.concat(parts);
}

describe('the window size is the sender\'s to choose inside the protocol range', () => {
  it('declares whichever window it used', async () => {
    const bytes = tableLike(1024 * 1024 * 2);
    const session = await open(bytes, 'rows.dat', { compressionWindowLog2: V2_COMPRESSION_WINDOW.defaultLog2 });
    expect(session.manifest.compressionParam).toBe(V2_COMPRESSION_WINDOW.defaultLog2);
    expect(session.preflight.compression.windowBytes).toBe(1024 * 1024);
    await session.dispose();
  });

  it('refuses a window outside it before anything is read', async () => {
    await expect(open(textLike(WINDOW), 'a.dat', { compressionWindowLog2: 8 }))
      .rejects.toThrow(/compressionWindowLog2/);
  });
});
