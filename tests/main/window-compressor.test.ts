import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { V2_WINDOW_LENGTH_PREFIX_BYTES } from '../../src/core/protocol-v2';
import { compressorBudgetBytes } from '../../src/main/streaming-sender';
import { WindowContainerEncoder, type WindowByteSource } from '../../src/main/window-compressor';

const WINDOW = 64 * 1024;

/** Bytes that compress: a small vocabulary repeated with structure. */
function textLike(length: number, seed = 1): Uint8Array {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const out: string[] = [];
  let size = 0;
  let state = seed >>> 0;
  while (size < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const word = `${words[state % words.length]}-${state % 97} `;
    out.push(word);
    size += word.length;
  }
  return new TextEncoder().encode(out.join('')).subarray(0, length);
}

/** Bytes that do not compress. */
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

class MemorySource implements WindowByteSource {
  reads = 0;

  constructor(readonly bytes: Uint8Array) {}

  async read(buffer: Uint8Array, length: number, position: bigint): Promise<number> {
    this.reads += 1;
    const start = Number(position);
    const take = Math.min(length, this.bytes.length - start);
    if (take <= 0) return 0;
    buffer.set(this.bytes.subarray(start, start + take), 0);
    return take;
  }
}

/** Reads the whole container out through the public range interface. */
async function drain(encoder: WindowContainerEncoder, transportSize: number, chunk = 9_973): Promise<Uint8Array> {
  const out = new Uint8Array(transportSize);
  const buffer = new Uint8Array(chunk);
  let offset = 0;
  while (offset < transportSize) {
    const want = Math.min(chunk, transportSize - offset);
    const got = await encoder.readTransport(BigInt(offset), buffer, want);
    expect(got).toBe(want);
    out.set(buffer.subarray(0, want), offset);
    offset += want;
  }
  return out;
}

/** Splits a container back into its gzip members and inflates each one. */
function expand(container: Uint8Array): { windows: number; bytes: Uint8Array } {
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  let windows = 0;
  while (cursor < container.length) {
    const declared = view.getUint32(cursor, false);
    cursor += V2_WINDOW_LENGTH_PREFIX_BYTES;
    parts.push(new Uint8Array(gunzipSync(container.subarray(cursor, cursor + declared))));
    cursor += declared;
    windows += 1;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { windows, bytes };
}

function newEncoder(source: MemorySource, windowBytes = WINDOW): WindowContainerEncoder {
  return new WindowContainerEncoder({
    source,
    originalSize: BigInt(source.bytes.length),
    windowBytes,
    level: 6,
  });
}

describe('the container round-trips the file it was built from', () => {
  it('expands back to the original bytes exactly', async () => {
    const original = textLike(WINDOW * 5 + 1_234);
    const encoder = newEncoder(new MemorySource(original));
    const measured = await encoder.measure();

    const container = await drain(encoder, Number(measured.transportSize));
    const expanded = expand(container);
    expect(expanded.windows).toBe(6);
    expect(expanded.bytes.length).toBe(original.length);
    expect(Buffer.from(expanded.bytes).equals(Buffer.from(original))).toBe(true);
  });

  it('round-trips a file smaller than one window', async () => {
    const original = textLike(4_096);
    const encoder = newEncoder(new MemorySource(original));
    const measured = await encoder.measure();
    expect(measured.windowCount).toBe(1);

    const expanded = expand(await drain(encoder, Number(measured.transportSize)));
    expect(Buffer.from(expanded.bytes).equals(Buffer.from(original))).toBe(true);
  });

  it('round-trips incompressible bytes, which deflate makes slightly larger', async () => {
    const original = randomLike(WINDOW * 2);
    const encoder = newEncoder(new MemorySource(original));
    const measured = await encoder.measure();
    expect(Number(measured.transportSize)).toBeGreaterThan(original.length);

    const expanded = expand(await drain(encoder, Number(measured.transportSize)));
    expect(Buffer.from(expanded.bytes).equals(Buffer.from(original))).toBe(true);
  });
});

describe('reading a range is independent of the order it is asked for', () => {
  it('answers a backward seek with the same bytes as a forward walk', async () => {
    const original = textLike(WINDOW * 6);
    const source = new MemorySource(original);
    const encoder = newEncoder(source);
    const size = Number((await encoder.measure()).transportSize);
    const forward = await drain(encoder, size);

    // Ask for the last quarter first, then the first quarter. The second one is
    // the backward seek, which is served by recompressing from window zero.
    const quarter = Math.floor(size / 4);
    const tail = new Uint8Array(quarter);
    expect(await encoder.readTransport(BigInt(size - quarter), tail, quarter)).toBe(quarter);
    expect(Buffer.from(tail).equals(Buffer.from(forward.subarray(size - quarter)))).toBe(true);

    const head = new Uint8Array(quarter);
    expect(await encoder.readTransport(0n, head, quarter)).toBe(quarter);
    expect(Buffer.from(head).equals(Buffer.from(forward.subarray(0, quarter)))).toBe(true);
  });

  it('produces byte-identical containers from two independent encoders', async () => {
    // The property a resume depends on: the same file compressed twice is the
    // same transport stream, so a token minted in one run addresses the same
    // segments in the next.
    const original = textLike(WINDOW * 3 + 99);
    const first = newEncoder(new MemorySource(original));
    const second = newEncoder(new MemorySource(original));
    const size = Number((await first.measure()).transportSize);
    expect(Number((await second.measure()).transportSize)).toBe(size);
    expect(Buffer.from(await drain(first, size)).equals(Buffer.from(await drain(second, size, 4_096)))).toBe(true);
  });

  it('returns a short count past the end rather than inventing bytes', async () => {
    const encoder = newEncoder(new MemorySource(textLike(WINDOW)));
    const size = Number((await encoder.measure()).transportSize);
    const buffer = new Uint8Array(size + 100);
    expect(await encoder.readTransport(0n, buffer, size + 100)).toBe(size);
  });
});

describe('the measuring walk is a counting pass, not a buffered one', () => {
  it('reports the size the container actually has', async () => {
    const original = textLike(WINDOW * 4);
    const encoder = newEncoder(new MemorySource(original));
    const measured = await encoder.measure();
    const container = await drain(encoder, Number(measured.transportSize));
    expect(container.length).toBe(Number(measured.transportSize));
    expect(measured.originalBytes).toBe(BigInt(original.length));
  });

  it('hands every original byte to its caller once, in order', async () => {
    // The hook the sender hashes through, so a gap or a repeat here would be a
    // digest computed over something that is not the file.
    const original = textLike(WINDOW * 3 + 77);
    const encoder = newEncoder(new MemorySource(original));
    const seen: number[] = [];
    let total = 0;
    await encoder.measure({
      onWindow: (bytes) => {
        seen.push(bytes.length);
        total += bytes.length;
      },
    });
    expect(total).toBe(original.length);
    expect(seen.slice(0, 3)).toEqual([WINDOW, WINDOW, WINDOW]);
    expect(seen[3]).toBe(77);
  });

  it('leaves the cursor able to answer offset zero', async () => {
    // The walk ends holding the last window. A cursor left there would answer
    // the first read with the wrong record instead of rewinding.
    const original = textLike(WINDOW * 3);
    const encoder = newEncoder(new MemorySource(original));
    const size = Number((await encoder.measure()).transportSize);
    const head = new Uint8Array(16);
    await encoder.readTransport(0n, head, 16);
    const container = await drain(newEncoder(new MemorySource(original)), size);
    expect(Buffer.from(head).equals(Buffer.from(container.subarray(0, 16)))).toBe(true);
  });
});

describe('memory is a function of the window, not the file', () => {
  it('never holds more than one window and one record', async () => {
    const original = textLike(WINDOW * 40);
    const encoder = newEncoder(new MemorySource(original));
    const budget = compressorBudgetBytes(WINDOW);

    let peak = 0;
    await encoder.measure({ onWindow: () => { peak = Math.max(peak, encoder.memoryBytes()); } });
    const size = Number(encoder.measurement!.transportSize);

    const buffer = new Uint8Array(5_000);
    for (let offset = 0; offset < size; offset += 5_000) {
      await encoder.readTransport(BigInt(offset), buffer, Math.min(5_000, size - offset));
      peak = Math.max(peak, encoder.memoryBytes());
    }
    expect(peak).toBeLessThanOrEqual(budget);
    // And it is genuinely holding a window, not nothing - a bound that passes
    // because the encoder never loaded anything would prove nothing.
    expect(peak).toBeGreaterThanOrEqual(WINDOW);
  });

  it('drops both buffers on release', async () => {
    const encoder = newEncoder(new MemorySource(textLike(WINDOW * 2)));
    await encoder.measure();
    await encoder.readTransport(0n, new Uint8Array(64), 64);
    encoder.release();
    expect(encoder.memoryBytes()).toBe(WINDOW);
  });
});

describe('the file is not allowed to change underneath it', () => {
  it('fails a window whose bytes ran out', async () => {
    const source = new MemorySource(textLike(WINDOW * 2));
    const encoder = new WindowContainerEncoder({
      source,
      // Claims more than the source will produce, which is what a truncated
      // file looks like from here.
      originalSize: BigInt(WINDOW * 3),
      windowBytes: WINDOW,
    });
    await expect(encoder.measure()).rejects.toThrow(/ended earlier than its size promised/);
  });

  it('stops on an aborted signal', async () => {
    const controller = new AbortController();
    const encoder = new WindowContainerEncoder({
      source: new MemorySource(textLike(WINDOW * 4)),
      originalSize: BigInt(WINDOW * 4),
      windowBytes: WINDOW,
      signal: controller.signal,
    });
    controller.abort();
    await expect(encoder.measure()).rejects.toThrow(/cancelled/i);
  });
});
