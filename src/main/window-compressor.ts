/**
 * The sender's half of the DEQR v2 GZIP transport container.
 *
 * `protocol-v2.ts` defines the shape - a `u32BE` length in front of each gzip
 * member, one member per fixed run of original bytes - and this turns a file
 * into it, one window at a time, holding exactly one window and one record.
 *
 * ## Why it can be asked for an arbitrary transport range
 *
 * The streaming sender reads *transport segments*: byte ranges of the
 * compressed stream, derived from the manifest's segmentation. Those ranges do
 * not line up with window boundaries and there is no reason they should. So the
 * interface here is `readTransport(start, into, length)`, and the encoder walks
 * its windows until it holds the record that covers `start`.
 *
 * Walking forward is free - it is the compression the transfer needs anyway.
 * Walking **backward** is not: windows share no deflate history, but the
 * encoder does not remember where each record began, so a backward seek is
 * served by restarting at window 0 and recompressing forward until the offset
 * is reached. That is deliberate. The alternative is an index of per-window
 * lengths, which is memory proportional to the file size - four bytes per
 * megabyte, so 4 MiB for a terabyte - and the program's first rule is that no
 * buffer scales with the file. A resume is a person typing a code across an air
 * gap, once, and paying one compression pass for it is the cheaper trade.
 *
 * ## What is bounded, and by what
 *
 * | Buffer | Size |
 * |---|---|
 * | window scratch | `windowBytes` |
 * | current record | `4 + gzip(window)`, at most about `windowBytes + 1 KiB` |
 *
 * Nothing else is retained. `measure()` walks every window and keeps none of
 * them: it is a counting pass, which is what lets the manifest declare an exact
 * `transportSize` without the compressed file ever existing anywhere at once.
 */

import { gzipSync } from 'node:zlib';

import { DeqrError, ErrorCode } from '../shared/errors';
import { V2_WINDOW_LENGTH_PREFIX_BYTES } from '../core/protocol-v2';

/** The read capability this encoder needs. Matches `SenderFileHandle.read`. */
export interface WindowByteSource {
  read(buffer: Uint8Array, length: number, position: bigint): Promise<number>;
}

export interface WindowCompressorOptions {
  source: WindowByteSource;
  originalSize: bigint;
  /** Original bytes per independently compressed window. A power of two. */
  windowBytes: number;
  /** zlib level. 6 is zlib's default and what the Phase 08 benchmark selected. */
  level?: number;
  signal?: AbortSignal;
}

export interface WindowMeasurement {
  transportSize: bigint;
  windowCount: number;
  /** Original bytes fed through the compressor. Equals `originalSize`. */
  originalBytes: bigint;
  ms: number;
}

export interface MeasureOptions {
  /**
   * Each window's **original** bytes, before they are compressed.
   *
   * This is what lets the sender fuse the sizing walk into the SHA-256 pass it
   * already had to make: one read of the file feeds both the digest and the
   * compressor. The view is the encoder's own scratch buffer and is valid only
   * for the duration of the call.
   */
  onWindow?: (bytes: Uint8Array) => void;
  onProgress?: (windowsDone: number, transportBytes: bigint) => void;
}

export const DEFAULT_COMPRESSION_LEVEL = 6;

export class WindowContainerEncoder {
  private readonly source: WindowByteSource;
  private readonly originalSize: bigint;
  private readonly windowBytes: number;
  private readonly level: number;
  private readonly signal: AbortSignal | undefined;

  private readonly windowScratch: Uint8Array;
  readonly windowCount: number;

  /** The record currently held, or null before the first window is compressed. */
  private record: Uint8Array | null = null;
  private recordIndex = -1;
  private recordStart = 0n;
  /** Set once `measure()` has walked the whole file. */
  private measured: WindowMeasurement | null = null;

  private windowsCompressed = 0;
  private compressionMs = 0;

  constructor(options: WindowCompressorOptions) {
    this.source = options.source;
    this.originalSize = options.originalSize;
    this.windowBytes = options.windowBytes;
    this.level = options.level ?? DEFAULT_COMPRESSION_LEVEL;
    this.signal = options.signal;

    if (!Number.isInteger(this.windowBytes) || this.windowBytes < 1) {
      throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'windowBytes must be a positive integer');
    }
    if (this.originalSize < 1n) {
      throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'originalSize must be at least 1');
    }

    const window = BigInt(this.windowBytes);
    this.windowCount = Number((this.originalSize + window - 1n) / window);
    this.windowScratch = new Uint8Array(this.windowBytes);
  }

  /** Bytes this encoder is holding right now. */
  memoryBytes(): number {
    return this.windowScratch.length + (this.record?.length ?? 0);
  }

  /** Windows compressed since construction, counting a rewind's repeats. */
  get compressedWindows(): number {
    return this.windowsCompressed;
  }

  /** Wall-clock spent inside gzip, for the CPU line of the record. */
  get compressionMilliseconds(): number {
    return this.compressionMs;
  }

  /**
   * Walks every window and returns what the container will weigh.
   *
   * The output bytes are produced and dropped. That is the price of an exact
   * `transportSize` in the first manifest, and the manifest cannot be written
   * without one: `segmentCount` is derived from it, and a receiver checks the
   * derivation. The alternative - declaring an estimate and correcting it later
   * - would mean a manifest that disagrees with itself for part of a transfer.
   */
  async measure(options: MeasureOptions = {}): Promise<WindowMeasurement> {
    const started = Date.now();
    let transportSize = 0n;

    for (let index = 0; index < this.windowCount; index += 1) {
      this.throwIfAborted();
      const record = await this.compressWindow(index, options.onWindow);
      transportSize += BigInt(record.length);
      options.onProgress?.(index + 1, transportSize);
    }

    // Back to the state a fresh encoder is in. The counting walk ends holding
    // the *last* window, and production almost always starts at the first; a
    // cursor left pointing at the end would answer `readTransport(0)` with the
    // wrong record rather than rewinding, because it has no record start to
    // compare against yet.
    this.record = null;
    this.recordIndex = -1;
    this.recordStart = 0n;

    this.measured = {
      transportSize,
      windowCount: this.windowCount,
      originalBytes: this.originalSize,
      ms: Date.now() - started,
    };
    return this.measured;
  }

  /** What `measure()` found, or null if it has not run. */
  get measurement(): WindowMeasurement | null {
    return this.measured;
  }

  /**
   * Copies transport bytes `[start, start + length)` into `into`.
   *
   * Returns how many bytes were written, which is `length` for any range inside
   * the container. A caller that asks past the end gets the short count rather
   * than an error, because the only caller derives its ranges from the same
   * plan the container was measured into and a short read there means the two
   * disagree - which its own length check catches with a better message.
   */
  async readTransport(start: bigint, into: Uint8Array, length: number): Promise<number> {
    if (length <= 0) return 0;
    if (start < 0n) {
      throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'transport offset cannot be negative');
    }
    if (length > into.length) {
      throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'requested more transport bytes than the buffer holds');
    }

    let filled = 0;
    while (filled < length) {
      this.throwIfAborted();
      const wanted = start + BigInt(filled);
      const record = await this.recordCovering(wanted);
      if (!record) return filled;

      const inRecord = Number(wanted - this.recordStart);
      const available = record.length - inRecord;
      const take = Math.min(available, length - filled);
      into.set(record.subarray(inRecord, inRecord + take), filled);
      filled += take;
    }
    return filled;
  }

  release(): void {
    this.windowScratch.fill(0);
    this.record?.fill(0);
    this.record = null;
    this.recordIndex = -1;
    this.recordStart = 0n;
  }

  /* ------------------------------------------------------------- internals */

  /**
   * The record holding a transport offset, compressing forward to reach it.
   *
   * A backward seek restarts at window zero - see the module comment for why
   * that is a deliberate trade and not an oversight.
   */
  private async recordCovering(offset: bigint): Promise<Uint8Array | null> {
    if (this.record !== null && offset < this.recordStart) {
      this.recordIndex = -1;
      this.recordStart = 0n;
      this.record = null;
    }
    if (this.record === null) {
      if (this.windowCount === 0) return null;
      this.recordStart = 0n;
      this.recordIndex = 0;
      this.record = await this.compressWindow(0);
    }

    while (offset >= this.recordStart + BigInt(this.record.length)) {
      if (this.recordIndex + 1 >= this.windowCount) return null;
      this.throwIfAborted();
      this.recordStart += BigInt(this.record.length);
      this.recordIndex += 1;
      this.record = await this.compressWindow(this.recordIndex);
    }
    return this.record;
  }

  /**
   * Reads window `index`, compresses it, and returns its complete record.
   *
   * Pure with respect to the cursor: it does not decide which window is
   * current, so `measure()` can walk every window without leaving the read path
   * pointing somewhere it did not choose.
   */
  private async compressWindow(
    index: number,
    onWindow?: (bytes: Uint8Array) => void,
  ): Promise<Uint8Array> {
    const window = BigInt(this.windowBytes);
    const start = window * BigInt(index);
    const remaining = this.originalSize - start;
    const want = Number(remaining < window ? remaining : window);
    if (want <= 0) {
      throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, `compression window ${index} is empty`);
    }

    let filled = 0;
    while (filled < want) {
      this.throwIfAborted();
      const read = await this.source.read(
        this.windowScratch.subarray(filled, want),
        want - filled,
        start + BigInt(filled),
      );
      if (read <= 0) {
        throw new DeqrError(
          ErrorCode.FILE_CHANGED_DURING_TRANSFER,
          'The source file ended earlier than its size promised. It may have been modified.',
        );
      }
      filled += read;
    }

    const original = this.windowScratch.subarray(0, want);
    onWindow?.(original);

    const began = Date.now();
    const member = gzipSync(original, { level: this.level });
    this.compressionMs += Date.now() - began;
    this.windowsCompressed += 1;

    const record = new Uint8Array(V2_WINDOW_LENGTH_PREFIX_BYTES + member.length);
    new DataView(record.buffer, record.byteOffset, record.byteLength).setUint32(0, member.length, false);
    record.set(member, V2_WINDOW_LENGTH_PREFIX_BYTES);
    return record;
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new DeqrError(ErrorCode.TRANSFER_CANCELLED, 'Transfer was cancelled.');
    }
  }
}
