/**
 * Turning a received GZIP transport container back into the original file.
 *
 * Reception itself does not change when a transfer is compressed. The same
 * segments arrive, are recovered by the same decoders, and are written to the
 * same pre-sized file at the same transport offsets - `data.part` simply holds
 * the container instead of the file. Everything compression-specific happens
 * here, once, after the last segment has landed.
 *
 * ## The loop, and every bound in it
 *
 * The container is `[u32BE length][gzip member]` per window (see
 * `protocol-v2.ts`). For each window this reads the length, checks it, reads
 * that many bytes, decompresses them, checks the output length, and writes the
 * output at the window's original offset. Four things are bounded and none of
 * them by anything the stream says:
 *
 * - **The declared record length** is refused above `maxCompressedWindowBytes`
 *   *before a buffer is allocated for it*. That number is zlib's own expansion
 *   ceiling for a window of this size, so a legitimate record can never exceed
 *   it and a hostile one cannot make the receiver allocate.
 * - **The decompressed output** is copied into a buffer sized to exactly what
 *   the manifest says this window must hold, and a decompressor that produces
 *   one byte more is stopped mid-stream. This is the decompression-bomb guard,
 *   and its limit comes from `originalSize` - a field the sender committed to
 *   before the first frame and which the final SHA-256 will be checked against.
 * - **The container's total length** must be consumed exactly. Trailing bytes
 *   and a short container are both failures, not warnings.
 * - **Both working buffers** are allocated once and reused for every window,
 *   so this stage's memory is a function of the window size and not the file.
 *
 * ## What it is not
 *
 * It is not verification. Decompressing successfully proves the container was
 * well formed, not that the bytes are the file - gzip's per-member CRC-32 is a
 * transmission check, exactly like the frame CRC. SHA-256 over the *written*
 * original bytes is still the only authority, it still runs afterwards, and it
 * still reads back from the device rather than trusting what was handed to the
 * writer.
 */

import {
  maxCompressedWindowBytes,
} from '../../src/core/compression-policy';
import {
  V2_WINDOW_LENGTH_PREFIX_BYTES,
  windowOriginalRange,
  type CompressionWindowPlan,
} from '../../src/core/protocol-v2';
import { STORE_WRITE, type StoreWriteOutcome } from './segment-store';

/** Why the original bytes could not be recovered. Each reaches the UI. */
export const INFLATE_FAILURE = {
  /** No `DecompressionStream`. This browser cannot read a compressed transfer. */
  UNSUPPORTED: 'UNSUPPORTED_COMPRESSION',
  /** The container's framing is wrong: a bad length, a short read, trailing bytes. */
  CONTAINER_INVALID: 'COMPRESSED_CONTAINER_INVALID',
  /** A gzip member would not decode. Its own CRC or its Huffman tables disagree. */
  DECOMPRESSION_FAILED: 'DECOMPRESSION_FAILED',
  /** A window decompressed to a length the manifest does not allow. */
  SIZE_MISMATCH: 'DECOMPRESSED_SIZE_MISMATCH',
  /** The transport file would not read back. */
  READ_FAILED: 'STORAGE_READ_FAILED',
  /** The device filled up while the original file was being written. */
  FULL: 'STORAGE_FULL',
  /** The writer refused or broke. */
  WRITE_FAILED: 'STORAGE_WRITE_FAILED',
  /** The session was cancelled during one of the yields. */
  CANCELLED: 'RELEASED',
} as const;
export type InflateFailure = (typeof INFLATE_FAILURE)[keyof typeof INFLATE_FAILURE];

/** Bytes decompressed between yields to the event loop. */
export const INFLATE_YIELD_BYTES = 16 * 1024 * 1024;

export interface InflateProgress {
  bytesWritten: number;
  bytesTotal: number;
}

/** The transport side: a bounded window read out of whatever holds the container. */
export interface CompressedSource {
  read(offset: number, into: Uint8Array): number;
}

/** The original side: offset writes into whatever will hold the file. */
export interface OriginalWriter {
  write(offset: number, bytes: Uint8Array): StoreWriteOutcome;
}

export interface InflateOptions {
  transportSize: number;
  originalSize: number;
  windows: CompressionWindowPlan;
  yieldTo?: () => Promise<void>;
  /** Checked after each yield. Returning true abandons the pass. */
  isCancelled?: () => boolean;
  onProgress?: (progress: InflateProgress) => void;
  yieldEveryBytes?: number;
}

export type InflateResult =
  | { ok: true; bytesWritten: number; ms: number }
  | { ok: false; code: InflateFailure; message: string };

/** True when this context can decompress at all. Checked before a session opens. */
export function canDecompress(): boolean {
  return typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === 'function';
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Reads a whole GZIP container from `source` and writes original bytes to `sink`.
 *
 * Never throws: every outcome is a code, because every one of them has a
 * different thing to tell someone holding a phone.
 */
export async function inflateWindowContainer(
  source: CompressedSource,
  sink: OriginalWriter,
  options: InflateOptions,
): Promise<InflateResult> {
  if (!canDecompress()) {
    return { ok: false, code: INFLATE_FAILURE.UNSUPPORTED, message: 'This browser cannot decompress the transfer.' };
  }

  const { windows, transportSize, originalSize } = options;
  const yieldTo = options.yieldTo ?? defaultYield;
  const isCancelled = options.isCancelled ?? (() => false);
  const yieldEveryBytes = options.yieldEveryBytes ?? INFLATE_YIELD_BYTES;

  const compressed = new Uint8Array(maxCompressedWindowBytes(windows.windowBytes));
  const original = new Uint8Array(windows.windowBytes);
  const prefix = new Uint8Array(V2_WINDOW_LENGTH_PREFIX_BYTES);
  const prefixView = new DataView(prefix.buffer);

  const started = Date.now();
  let cursor = 0;
  let written = 0;
  let sinceYield = 0;

  const finish = (code: InflateFailure, message: string): InflateResult => {
    compressed.fill(0);
    original.fill(0);
    return { ok: false, code, message };
  };

  options.onProgress?.({ bytesWritten: 0, bytesTotal: originalSize });

  for (let index = 0; index < windows.windowCount; index += 1) {
    if (cursor + V2_WINDOW_LENGTH_PREFIX_BYTES > transportSize) {
      return finish(INFLATE_FAILURE.CONTAINER_INVALID, 'The compressed stream ended before its last window.');
    }
    if (!readExactly(source, cursor, prefix)) {
      return finish(INFLATE_FAILURE.READ_FAILED, 'Stored data could not be read back.');
    }
    const declared = prefixView.getUint32(0, false);
    cursor += V2_WINDOW_LENGTH_PREFIX_BYTES;

    // Checked against a ceiling derived from the window size, and against what
    // is left of the container, before a single byte is read for it.
    if (declared < 1 || declared > compressed.length || cursor + declared > transportSize) {
      return finish(
        INFLATE_FAILURE.CONTAINER_INVALID,
        `Window ${index} declares ${declared} bytes, which the transfer cannot contain.`,
      );
    }

    const member = compressed.subarray(0, declared);
    if (!readExactly(source, cursor, member)) {
      return finish(INFLATE_FAILURE.READ_FAILED, 'Stored data could not be read back.');
    }
    cursor += declared;

    const range = windowOriginalRange(windows, index);
    const expected = Number(range.end - range.start);
    const produced = await inflateMember(member, original.subarray(0, expected));
    if (produced === INFLATE_OVERFLOWED) {
      // Kept distinct from a decode failure on purpose. A member that expands
      // past its declared window is not damage - it is the shape of a
      // decompression bomb, and it should be logged as one.
      return finish(
        INFLATE_FAILURE.SIZE_MISMATCH,
        `Window ${index} expanded past the ${expected} bytes the manifest declares.`,
      );
    }
    if (produced === null) {
      return finish(INFLATE_FAILURE.DECOMPRESSION_FAILED, `Window ${index} could not be decompressed.`);
    }
    if (produced !== expected) {
      return finish(
        INFLATE_FAILURE.SIZE_MISMATCH,
        `Window ${index} decompressed to ${produced} bytes where the manifest declares ${expected}.`,
      );
    }

    const outcome = sink.write(Number(range.start), original.subarray(0, expected));
    if (outcome !== STORE_WRITE.OK) {
      return finish(
        outcome === STORE_WRITE.FULL ? INFLATE_FAILURE.FULL : INFLATE_FAILURE.WRITE_FAILED,
        'The decompressed file could not be written.',
      );
    }

    written += expected;
    sinceYield += expected;
    if (sinceYield >= yieldEveryBytes && index + 1 < windows.windowCount) {
      sinceYield = 0;
      await yieldTo();
      if (isCancelled()) {
        return finish(INFLATE_FAILURE.CANCELLED, 'The transfer was cancelled.');
      }
      options.onProgress?.({ bytesWritten: written, bytesTotal: originalSize });
    }
  }

  // Trailing bytes are a failure and not a curiosity: the container's length is
  // declared in the manifest and derived into the segmentation, so bytes past
  // the last window mean the two disagree about what was sent.
  if (cursor !== transportSize) {
    return finish(
      INFLATE_FAILURE.CONTAINER_INVALID,
      `The compressed stream has ${transportSize - cursor} bytes past its last window.`,
    );
  }
  if (written !== originalSize) {
    return finish(
      INFLATE_FAILURE.SIZE_MISMATCH,
      `Decompression produced ${written} bytes where the manifest declares ${originalSize}.`,
    );
  }

  compressed.fill(0);
  original.fill(0);
  options.onProgress?.({ bytesWritten: written, bytesTotal: originalSize });
  return { ok: true, bytesWritten: written, ms: Date.now() - started };
}

/** Fills `into` completely from `source`, or reports that it could not. */
function readExactly(source: CompressedSource, offset: number, into: Uint8Array): boolean {
  let filled = 0;
  while (filled < into.length) {
    const read = source.read(offset + filled, into.subarray(filled));
    if (read <= 0) return false;
    filled += read;
  }
  return true;
}

/** `inflateMember` produced more than the window allows. Not a decode failure. */
const INFLATE_OVERFLOWED = -1;

/**
 * Decompresses one gzip member into a buffer that is already the right size.
 *
 * The output buffer *is* the bound. A chunk that would not fit stops the
 * stream, so a member claiming to expand into gigabytes gets one buffer's worth
 * of work and no allocation at all. Three outcomes, and the last two are
 * deliberately not merged: a byte count, `INFLATE_OVERFLOWED` for a member that
 * kept producing, and null for a member that would not decode.
 */
async function inflateMember(member: Uint8Array, into: Uint8Array): Promise<number | null> {
  const stream = new Blob([member as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  let produced = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (produced + value.byteLength > into.length) {
        try {
          await reader.cancel();
        } catch {
          // The overflow is the authoritative answer; a failed cancel is not.
        }
        return INFLATE_OVERFLOWED;
      }
      into.set(value, produced);
      produced += value.byteLength;
      value.fill(0);
    }
    return produced;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
