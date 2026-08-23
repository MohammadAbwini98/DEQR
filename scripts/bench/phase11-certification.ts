/**
 * Phase 11 - certification: does the file arrive, byte for byte, and how fast.
 *
 * Every phase before this one measured a component. This one measures the
 * product: a real `StreamingTransferSession` produces real v2 frames, a
 * modelled optical channel loses, duplicates, reorders and corrupts them, and
 * the receiver's own `ReceivePipeline` puts what survives into a file-backed
 * store, hashes it, and seals it for export. Nothing between the two ends is a
 * stand-in. What *is* a stand-in is stated plainly below, because a
 * certification whose limits are not written down certifies nothing.
 *
 * ## The three clocks
 *
 * A number here can be one of three things and they are not interchangeable:
 *
 * - **Optical seconds.** `framesEmitted / effectiveFps(profile)`. This is the
 *   clock the user waits on and the only one throughput claims are made in.
 * - **Pipeline seconds.** Wall clock for this harness on this machine. It says
 *   whether the software can keep up with the optical clock, and nothing about
 *   how long a transfer takes.
 * - **Verification seconds.** Wall clock for the end-of-transfer SHA-256 read
 *   back out of storage, which is real time a user waits after the last frame.
 *
 * `verifiedBytesPerSecond` in every result below is original bytes over optical
 * seconds. It is the plan's primary metric and it is the one that decides a
 * profile.
 *
 * ## What is modelled rather than measured
 *
 * - **The camera and the QR layer.** Frames move as bytes. Phase 04 measured
 *   decode success against camera pixels per module with a real encoder and the
 *   receiver's own jsQR; that surface is imported here as a loss rate, not
 *   re-derived. An automated run therefore certifies *the pipeline*, and the
 *   optical constant stays the physical matrix's to close.
 * - **OPFS.** Node has none. `SyncAccessHandleLike` here is positioned `fs`,
 *   which is the same API shape and a different implementation. The browser
 *   half of this phase exercises the real one; the iOS half stays PENDING.
 *
 *   node --expose-gc node_modules/vite-node/vite-node.mjs \
 *     scripts/bench/phase11-certification.ts -- --mode ladder --maxMib 64
 *
 *   --mode ladder        the size ladder against each data class, hash-gated
 *   --mode channel       loss, bursts, duplicates, reorder, corruption
 *   --mode interrupt     interrupt, resume from a checkpoint, finish, verify
 *   --mode backpressure  a slow store, a slow decoder, a slow display
 *   --mode faults        quota, refusal, cancel, and the empty file
 *   --mode profiles      ranked end-to-end goodput, for Balanced and Turbo
 *
 * Shared flags: `--sizeMib` (the size a non-ladder mode runs at), `--maxMib`
 * and `--sizesMib` (the ladder's ceiling, or specific tiers to continue at),
 * `--classes`, `--compression on`, `--profile`, `--px`, `--maxPasses` (how many
 * times the sender may run the stream before a run is called incomplete), and
 * `--tag` to keep two runs of one mode from overwriting each other's JSON.
 *
 * Payload safety: every fixture byte is a pure function of its own offset and a
 * seed. Nothing is read from a user's disk and no payload byte is printed.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  BALANCED_PROFILE,
  MEASURED_DECODE_SUCCESS,
  TRANSPORT_PROFILES,
  effectiveFps,
  frameBytesFor,
  requiredRepairRatio,
  type TransportProfile,
} from '../../src/core/transport-profiles';
import { PRNG } from '../../src/core/prng';
import {
  StreamingTransferSession,
  configFromProfile,
  type SenderFileHandle,
  type SenderFileOpener,
} from '../../src/main/streaming-sender';
import { ReceivePipeline } from '../../mobile-web/src/receive-pipeline';
import { ReceiverStorage } from '../../mobile-web/src/receiver-storage';
import { FRAME_OUTCOME } from '../../mobile-web/src/worker-protocol';
import type {
  DirectoryHandleLike,
  FileHandleLike,
  FileWritableLike,
  StorageEnvironment,
  SyncAccessHandleLike,
} from '../../mobile-web/src/opfs';

/* ---------------------------------------------------------------- plumbing */

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArgument(name: string, fallback: number): number {
  const value = Number(argument(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function report(tag: string, fields: Record<string, string | number | boolean>): void {
  const parts = Object.entries(fields).map(
    ([key, value]) => `${key}=${typeof value === 'number' ? round(value) : String(value)}`,
  );
  console.log([tag, ...parts].join(' '));
}

function round(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 1 ? 4 : 2);
}

const KIB = 1024;
const MIB = 1024 * 1024;

function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
}

/** Resident JavaScript memory, array buffers included. Same gauge as Phase 06. */
function heapMib(): number {
  const usage = process.memoryUsage();
  return (usage.heapUsed + usage.arrayBuffers) / MIB;
}

/** Yields to the event loop so the pipeline's async storage work can run. */
function yieldOnce(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/* ----------------------------------------------------------------- fixtures */

export type DataClass = 'compressible' | 'structured' | 'random';

const DATA_CLASSES: readonly DataClass[] = ['compressible', 'structured', 'random'];

/**
 * A fixture byte is a pure function of its offset.
 *
 * That is not a stylistic choice. A 1 GiB fixture cannot be held in memory to
 * compare against afterwards, and writing one to disk would make every run
 * depend on free space and on the last run's debris. A positional generator
 * lets the expected digest be streamed independently of the sender, which is
 * what makes the hash gate a real check rather than the sender agreeing with
 * itself.
 */
function fillFixture(view: Uint8Array, offset: number, dataClass: DataClass, seed: number): void {
  switch (dataClass) {
    case 'compressible':
      fillCompressible(view, offset, seed);
      return;
    case 'structured':
      fillStructured(view, offset, seed);
      return;
    default:
      fillRandom(view, offset, seed);
  }
}

/**
 * Long runs over a tiny dictionary, refreshed once per megabyte.
 *
 * Deflate reduces this by three orders of magnitude. It is the upper bound of
 * what Phase 08's policy can buy, and it exists so the ladder has a row where
 * the compression path carries the whole transfer.
 */
function fillCompressible(view: Uint8Array, offset: number, seed: number): void {
  const DICTIONARY = 64;
  for (let index = 0; index < view.length; index += 1) {
    const absolute = offset + index;
    const era = Math.floor(absolute / MIB);
    view[index] = ((Math.imul(era + seed + 1, 0x9e37_79b1) >>> 24) ^ (absolute % DICTIONARY)) & 0xff;
  }
}

/**
 * Fixed-width records that read like a CSV export.
 *
 * Fixed width because a record boundary has to be computable from an offset;
 * variable-length lines would make the generator sequential, and the expected
 * digest would then have to come from the same walk the sender does.
 */
const RECORD_BYTES = 64;

function fillStructured(view: Uint8Array, offset: number, seed: number): void {
  const record = new Uint8Array(RECORD_BYTES);
  let recordIndex = -1;
  for (let index = 0; index < view.length; index += 1) {
    const absolute = offset + index;
    const wanted = Math.floor(absolute / RECORD_BYTES);
    if (wanted !== recordIndex) {
      writeRecord(record, wanted, seed);
      recordIndex = wanted;
    }
    view[index] = record[absolute % RECORD_BYTES];
  }
}

function writeRecord(into: Uint8Array, index: number, seed: number): void {
  const id = String(index % 1_000_000_000).padStart(9, '0');
  const bucket = (Math.imul(index + seed + 1, 0x85eb_ca6b) >>> 20) % 1000;
  const line = 'row,' + id + ',2026-08-23T00:00:00Z,bucket-' + String(bucket).padStart(3, '0') + ',';
  const padded = line + '.'.repeat(Math.max(0, RECORD_BYTES - 1 - line.length)) + '\n';
  for (let position = 0; position < RECORD_BYTES; position += 1) {
    into[position] = padded.charCodeAt(position) & 0xff;
  }
}

/**
 * A mixing function over the offset, eight bytes at a time.
 *
 * Incompressible to within a rounding error, which is what makes it the row
 * that proves the compression decision *declines* rather than merely succeeds.
 */
function fillRandom(view: Uint8Array, offset: number, seed: number): void {
  let index = 0;
  while (index < view.length) {
    const absolute = offset + index;
    const block = Math.floor(absolute / 8);
    let hash = Math.imul(block ^ seed, 0x2545_f491) >>> 0;
    hash = (hash ^ (hash >>> 13)) >>> 0;
    hash = Math.imul(hash, 0x27d4_eb2f) >>> 0;
    const low = (hash ^ (hash >>> 16)) >>> 0;
    const high = Math.imul(low ^ (low >>> 15), 0x9e37_79b1) >>> 0;
    for (let byte = absolute % 8; byte < 8 && index < view.length; byte += 1, index += 1) {
      const word = byte < 4 ? low : high;
      view[index] = (word >>> ((byte % 4) * 8)) & 0xff;
    }
  }
}

/**
 * A file that exists only as a rule for producing its bytes.
 *
 * The sender never learns the difference: it gets `stat` and positioned `read`,
 * which is the whole of `SenderFileHandle`. A 4 GiB certification run therefore
 * needs no 4 GiB of disk, and the read path being synthetic shows up only in
 * pipeline seconds - as an unrealistically fast source - never in optical ones.
 */
function syntheticOpener(sizeBytes: number, dataClass: DataClass, seed: number): SenderFileOpener {
  return async (filePath: string): Promise<SenderFileHandle> => {
    void filePath;
    return {
      async stat() {
        return { size: BigInt(sizeBytes), isFile: true, mtimeMs: 0n };
      },
      async read(buffer: Uint8Array, length: number, position: bigint) {
        const start = Number(position);
        const count = Math.max(0, Math.min(length, sizeBytes - start));
        if (count > 0) fillFixture(buffer.subarray(0, count), start, dataClass, seed);
        return count;
      },
      async close() {
        /* nothing is open */
      },
    };
  };
}

/**
 * A sender configuration with fixed identifiers.
 *
 * `configFromProfile` takes only the runtime knobs, so the session and file
 * identifiers - which every mode here needs to hold still across passes, and
 * which a resume is defined in terms of - are applied on top of what it
 * returns rather than passed into it.
 */
function senderConfig(profile: TransportProfile, options: {
  compression: boolean;
  sessionId: number;
  fileId: number;
  resumeToken?: string;
}) {
  return {
    ...configFromProfile(profile, {
      compressionEnabled: options.compression,
      sampleCompressibility: true,
    }),
    sessionId: options.sessionId,
    fileId: options.fileId,
    resumeToken: options.resumeToken,
  };
}

/** SHA-256 of a fixture, computed from the generator and not from the sender. */
function expectedDigest(sizeBytes: number, dataClass: DataClass, seed: number): string {
  const hash = createHash('sha256');
  const window = new Uint8Array(4 * MIB);
  for (let offset = 0; offset < sizeBytes; offset += window.length) {
    const count = Math.min(window.length, sizeBytes - offset);
    const view = window.subarray(0, count);
    fillFixture(view, offset, dataClass, seed);
    hash.update(view);
  }
  return hash.digest('hex');
}

/* ------------------------------------------------- a filesystem-backed OPFS */

/**
 * Counters shared by every handle under one root.
 *
 * The store writes through a sync access handle, so the only place the write
 * rate can be observed without instrumenting the store itself is here. That
 * separation matters: `opfsWriteBytesPerSecond` in the results is measured at
 * the syscall, not inferred from progress.
 */
interface StorageMeter {
  writeCalls: number;
  writeBytes: number;
  writeMs: number;
  readCalls: number;
  readBytes: number;
  readMs: number;
  /** Refuse writes once this many bytes exist under the root. Infinity disables. */
  capacityBytes: number;
  /** Artificial per-write cost, for the storage-backpressure mode. */
  delayPerWriteUs: number;
  bytesOnDisk: number;
  /**
   * Refuse every write after this many have succeeded.
   *
   * Models the one storage failure pre-sizing cannot prevent: the reservation
   * succeeded, and then something else on the device consumed the disk.
   */
  capacityDropsAfterWrites: number;
}

function newMeter(overrides: Partial<StorageMeter> = {}): StorageMeter {
  return {
    writeCalls: 0,
    writeBytes: 0,
    writeMs: 0,
    readCalls: 0,
    readBytes: 0,
    readMs: 0,
    capacityBytes: Number.POSITIVE_INFINITY,
    delayPerWriteUs: 0,
    bytesOnDisk: 0,
    capacityDropsAfterWrites: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

/** Busy-waits. A sync access handle has no other way to be slow. */
function spin(microseconds: number): void {
  if (microseconds <= 0) return;
  const until = performance.now() + microseconds / 1000;
  while (performance.now() < until) {
    /* the storage writer is synchronous; so is its slowdown */
  }
}

class MeteredSyncAccessHandle implements SyncAccessHandleLike {
  constructor(private fd: number | null, private readonly meter: StorageMeter) {}

  read(buffer: ArrayBufferView, options?: { at?: number }): number {
    if (this.fd === null) throw new Error('handle closed');
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const started = performance.now();
    const count = readSync(this.fd, view, 0, view.byteLength, options?.at ?? 0);
    this.meter.readMs += performance.now() - started;
    this.meter.readCalls += 1;
    this.meter.readBytes += count;
    return count;
  }

  write(buffer: ArrayBufferView, options?: { at?: number }): number {
    if (this.fd === null) throw new Error('handle closed');
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const at = options?.at ?? 0;
    if (this.meter.writeCalls >= this.meter.capacityDropsAfterWrites
      || at + view.byteLength > this.meter.capacityBytes) {
      // The shape a browser uses when the origin is out of room. The store has
      // to turn this into `STORE_WRITE.FULL` rather than a crash, and that
      // conversion is what the quota row of `--mode faults` checks.
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    spin(this.meter.delayPerWriteUs);
    const started = performance.now();
    const count = writeSync(this.fd, view, 0, view.byteLength, at);
    this.meter.writeMs += performance.now() - started;
    this.meter.writeCalls += 1;
    this.meter.writeBytes += count;
    this.meter.bytesOnDisk = Math.max(this.meter.bytesOnDisk, at + count);
    return count;
  }

  truncate(newSize: number): void {
    if (this.fd === null) throw new Error('handle closed');
    if (newSize > this.meter.capacityBytes) {
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    ftruncateSync(this.fd, newSize);
  }

  getSize(): number {
    if (this.fd === null) throw new Error('handle closed');
    return fstatSync(this.fd).size;
  }

  flush(): void {
    if (this.fd !== null) fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

class NodeFileHandle implements FileHandleLike {
  constructor(private readonly file: string, private readonly meter: StorageMeter) {}

  async createSyncAccessHandle(): Promise<SyncAccessHandleLike> {
    // Not `a+`: append mode ignores the position argument, so every offset the
    // store computed would collapse to "the end".
    closeSync(openSync(this.file, 'a'));
    return new MeteredSyncAccessHandle(openSync(this.file, 'r+'), this.meter);
  }

  async createWritable(): Promise<FileWritableLike> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data) => {
        chunks.push(
          typeof data === 'string'
            ? new TextEncoder().encode(data)
            : new Uint8Array(ArrayBuffer.isView(data) ? data.buffer : (data as ArrayBuffer)),
        );
      },
      close: async () => {
        const fd = openSync(this.file, 'w');
        for (const chunk of chunks) writeSync(fd, chunk, 0, chunk.length);
        closeSync(fd);
      },
    };
  }

  async getFile(): Promise<Blob> {
    const fd = openSync(this.file, 'r');
    try {
      const size = fstatSync(fd).size;
      const bytes = new Uint8Array(size);
      readSync(fd, bytes, 0, size, 0);
      return new Blob([bytes]);
    } finally {
      closeSync(fd);
    }
  }
}

class NodeDirectoryHandle implements DirectoryHandleLike {
  constructor(private readonly directory: string, private readonly meter: StorageMeter) {
    mkdirSync(directory, { recursive: true });
  }

  async getDirectoryHandle(name: string): Promise<DirectoryHandleLike> {
    return new NodeDirectoryHandle(path.join(this.directory, name), this.meter);
  }

  async getFileHandle(name: string): Promise<FileHandleLike> {
    return new NodeFileHandle(path.join(this.directory, name), this.meter);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    rmSync(path.join(this.directory, name), { recursive: options?.recursive ?? false, force: true });
  }

  /**
   * Real enumeration, unlike the Phase 06 and 07 harnesses.
   *
   * The sweep of stale sessions runs off this, and the interrupt mode needs a
   * root that still contains the previous run's directory - so a `keys()` that
   * yields nothing would quietly make every resume a fresh transfer.
   */
  async *keys(): AsyncIterableIterator<string> {
    let entries: string[];
    try {
      entries = readdirSync(this.directory);
    } catch {
      return;
    }
    for (const entry of entries) yield entry;
  }
}

interface StorageRoot {
  environment: StorageEnvironment;
  meter: StorageMeter;
  directory: string;
  reset(): void;
}

const RUN_ROOT = path.resolve('.local-run/bench/phase11');

function storageRoot(name: string, meter: StorageMeter, quotaBytes?: number): StorageRoot {
  const directory = path.join(RUN_ROOT, name);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const root = new NodeDirectoryHandle(directory, meter);
  return {
    meter,
    directory,
    environment: {
      supportsSyncAccess: true,
      storage: {
        getDirectory: async () => root,
        // `preflightStorage` reads this before the store is opened. A run that
        // wants to be refused *before* any byte is written sets it low; one
        // that wants to fail mid-write leaves it high and sets a capacity.
        estimate: async () => ({
          quota: quotaBytes ?? 512 * 1024 * MIB,
          usage: meter.bytesOnDisk,
        }),
      },
    },
    reset() {
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(directory, { recursive: true });
    },
  };
}

/* ------------------------------------------------------------ the channel */

/**
 * What a camera pointed at a screen does to a stream of frames.
 *
 * Loss, duplication, reordering and corruption are four separate things and a
 * receiver answers each differently: a lost frame costs repair overhead, a
 * duplicate costs nothing but must be recognised, a reordered frame must not be
 * mistaken for either, and a corrupt one must be refused before it reaches a
 * buffer. Modelling them together in one object is what lets a run say which
 * of the four a failure came from.
 */
export interface ChannelOptions {
  /** Fraction of frames that never arrive. */
  lossRate: number;
  /** When non-zero, losses arrive in runs of this length rather than singly. */
  burstFrames: number;
  /** Fraction of delivered frames the receiver sees twice. */
  duplicateRate: number;
  /** Frames held back and released out of order. Zero delivers in order. */
  reorderWindow: number;
  /** Fraction of delivered frames with one byte flipped. The CRC must catch these. */
  corruptRate: number;
  seed: number;
}

function channel(overrides: Partial<ChannelOptions> = {}): ChannelOptions {
  return {
    lossRate: 0,
    burstFrames: 0,
    duplicateRate: 0,
    reorderWindow: 0,
    corruptRate: 0,
    seed: 0x11_11_11,
    ...overrides,
  };
}

interface ChannelCounters {
  offered: number;
  dropped: number;
  duplicated: number;
  corrupted: number;
  reordered: number;
  delivered: number;
}

class OpticalChannel {
  private readonly random: PRNG;
  private readonly holding: Uint8Array[] = [];
  private burstRemaining = 0;
  readonly counters: ChannelCounters = {
    offered: 0,
    dropped: 0,
    duplicated: 0,
    corrupted: 0,
    reordered: 0,
    delivered: 0,
  };

  constructor(private readonly options: ChannelOptions) {
    this.random = new PRNG(options.seed);
  }

  /**
   * Offers one frame and returns what the receiver sees, in order.
   *
   * Returns an array because a duplicate is two deliveries and a reorder is
   * often zero - the frame is held and something older comes out instead.
   */
  offer(frame: Uint8Array): Uint8Array[] {
    this.counters.offered += 1;

    if (this.burstRemaining > 0) {
      this.burstRemaining -= 1;
      this.counters.dropped += 1;
      return [];
    }
    if (this.options.lossRate > 0) {
      // A burst of length B starting with probability p/B loses the same
      // fraction of frames as independent loss at p, which is the point: the
      // two rows differ in their distribution and not in their severity.
      const trigger = this.options.burstFrames > 0
        ? this.options.lossRate / this.options.burstFrames
        : this.options.lossRate;
      if (this.random.next() < trigger) {
        this.burstRemaining = Math.max(0, this.options.burstFrames - 1);
        this.counters.dropped += 1;
        return [];
      }
    }

    let delivered = frame;
    if (this.options.corruptRate > 0 && this.random.next() < this.options.corruptRate) {
      delivered = this.corrupt(frame);
      this.counters.corrupted += 1;
    }

    const out: Uint8Array[] = [];
    if (this.options.reorderWindow > 0) {
      // Copied on the way in: the sender hands out one shared buffer for the
      // manifest frame and rewrites its symbol scratch every frame, so a frame
      // held for later delivery has to own its bytes.
      this.holding.push(delivered.slice());
      if (this.holding.length > this.options.reorderWindow) {
        const index = this.random.nextInt(0, this.holding.length);
        if (index !== 0) this.counters.reordered += 1;
        out.push(this.holding.splice(index, 1)[0]);
      }
    } else {
      out.push(delivered);
    }

    if (out.length > 0 && this.options.duplicateRate > 0 && this.random.next() < this.options.duplicateRate) {
      out.push(out[0]);
      this.counters.duplicated += 1;
    }

    this.counters.delivered += out.length;
    return out;
  }

  /** Everything still held by the reorder buffer, at the end of a pass. */
  drain(): Uint8Array[] {
    const rest = this.holding.splice(0, this.holding.length);
    this.counters.delivered += rest.length;
    return rest;
  }

  /**
   * One byte flipped past the header.
   *
   * Past the header on purpose: a frame with a mangled magic or version is
   * rejected by the parser, which proves nothing about the CRC. Corrupting the
   * payload leaves a structurally valid frame whose only defence is the
   * checksum, which is the thing under test.
   */
  private corrupt(frame: Uint8Array): Uint8Array {
    const copy = frame.slice();
    if (copy.length <= 12) return copy;
    const index = this.random.nextInt(12, copy.length);
    copy[index] = copy[index] ^ (1 << this.random.nextInt(0, 8));
    return copy;
  }
}

/* --------------------------------------------------------------- one run */

export interface RunOptions {
  label: string;
  sizeBytes: number;
  dataClass: DataClass;
  profile: TransportProfile;
  channel: ChannelOptions;
  seed: number;
  /** Off by default so a ladder row measures the transport and not zlib. */
  compression: boolean;
  /** Sender passes allowed before a run is declared incomplete. */
  maxPasses: number;
  /** Stop the first pass at this fraction of the file, for the interrupt mode. */
  interruptAtFraction?: number;
  /** Adopt working data left on the device by an earlier run. */
  resume?: boolean;
  /** A token from the receiver, so the sender restarts at the right segment. */
  resumeToken?: string;
  /** Artificial per-frame receiver cost. Models a decoder that cannot keep up. */
  decodeDelayUs?: number;
  /** Artificial per-frame sender cost. Models a display that cannot keep up. */
  renderDelayUs?: number;
  /** Directory and meter this run's storage lives in. */
  root: StorageRoot;
  /** Refuse to fall back to memory, so a storage failure is visible as one. */
  allowMemoryFallback?: boolean;
}

export interface RunResult {
  label: string;
  sizeBytes: number;
  dataClass: DataClass;
  profile: string;
  ok: boolean;
  failure?: string;
  passes: number;
  compressionUsed: boolean;
  compressionRatio: number;
  transportBytes: number;
  bytesOnTheWire: number;
  framesEmitted: number;
  framesDelivered: number;
  framesAccepted: number;
  framesDuplicate: number;
  framesRejected: number;
  framesForeign: number;
  framesPendingStorage: number;
  channelDropped: number;
  channelDuplicated: number;
  channelCorrupted: number;
  channelReordered: number;
  sourceSymbols: number;
  repairSymbols: number;
  repairOverheadUsed: number;
  opticalSeconds: number;
  pipelineSeconds: number;
  verifySeconds: number;
  verifiedBytesPerSecond: number;
  opticalBytesPerSecond: number;
  renderFps: number;
  decodedFps: number;
  uniqueFps: number;
  duplicateRatio: number;
  /** Fraction of offered frames the channel removed. The plan's "drop ratio". */
  dropRatio: number;
  rejectRatio: number;
  /**
   * Frames that arrived and were needed by nobody.
   *
   * Repair symbols for a segment already recovered, and manifests after the
   * first. Not waste - it is what makes a receiver able to start scanning late
   * - but it is the difference between optical bytes and useful ones.
   */
  redundantRatio: number;
  manifestFrames: number;
  segmentRecoveryMeanSeconds: number;
  segmentRecoveryMaxSeconds: number;
  senderBudgetMib: number;
  senderPeakBufferedMib: number;
  senderCpuSeconds: number;
  peakHeapMib: number;
  receiverPeakHeldMib: number;
  storageKind: string;
  opfsWriteMibPerSecond: number;
  opfsWriteCalls: number;
  hashMibPerSecond: number;
  expectedSha: string;
  /** What the sender's own preflight pass computed. Must equal `expectedSha`. */
  senderSha: string;
  verifiedSha: string;
  hashMatch: boolean;
  exportKind: string;
  exportSize: number;
  storagePressure: boolean;
  fault?: string;
}

/**
 * One transfer, end to end, with everything the plan asks to be recorded.
 *
 * The loop is deliberately the shape a real pair of devices makes: the sender
 * produces frames until it runs out, the channel decides what arrives, and the
 * receiver is asked nothing except to accept bytes. Nothing here reaches inside
 * either end to help it along - a segment that does not recover stays
 * unrecovered, and the run ends incomplete rather than being retried into
 * success.
 */
async function runTransfer(options: RunOptions): Promise<RunResult> {
  const {
    label, sizeBytes, dataClass, profile, seed, root,
  } = options;

  const expectedSha = expectedDigest(sizeBytes, dataClass, seed);
  const opener = syntheticOpener(sizeBytes, dataClass, seed);
  const fps = effectiveFps(profile);

  const storage = new ReceiverStorage({
    environment: root.environment,
    allowMemoryFallback: options.allowMemoryFallback ?? true,
  });
  const pipeline = new ReceivePipeline({
    storage,
    resume: options.resume === true,
    // A store that has to be woken between segments is the receiver's real
    // behaviour on a phone; a bench that never yields would hide it.
    yieldToEventLoop: yieldOnce,
  });

  const counters = {
    framesEmitted: 0,
    framesAccepted: 0,
    framesPendingStorage: 0,
    sourceSymbols: 0,
    repairSymbols: 0,
    bytesOnTheWire: 0,
    transportBytes: 0,
    compressionUsed: false,
    compressionRatio: 1,
    senderSha: '',
    senderPeakBuffered: 0,
    senderBudget: 0,
  };
  const wire: ChannelCounters = {
    offered: 0, dropped: 0, duplicated: 0, corrupted: 0, reordered: 0, delivered: 0,
  };
  const completions: number[] = [];
  let unitsRecovered = 0;
  let peakHeld = 0;
  let peakHeap = heapMib();
  let failure: string | undefined;
  let passes = 0;
  let complete = false;
  let provisioned = false;
  let resumeToken = options.resumeToken;

  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();

  try {
    while (!complete && passes < options.maxPasses) {
      passes += 1;
      const stream = new OpticalChannel({ ...options.channel, seed: options.channel.seed + passes });
      const session = await StreamingTransferSession.open(
        `phase11-${label}.bin`,
        senderConfig(profile, {
          compression: options.compression,
          sessionId: 0x11_00_00_01,
          fileId: 0x11_00_00_02,
          resumeToken,
        }),
        opener,
      );
      // The token is a one-shot: a second pass starts from zero again, because
      // the receiver's own checkpoint is what carries recovered segments across
      // passes and re-applying a stale token would skip segments it has lost.
      resumeToken = undefined;

      try {
        const preflight = session.preflight;
        counters.compressionUsed = preflight.compression.mode !== 0;
        counters.compressionRatio = preflight.compression.ratio;
        counters.senderSha = preflight.sha256Hex;
        counters.transportBytes = Number(session.progress().transportBytesTotal);
        counters.senderBudget = session.memoryBudgetBytes();

        const stopAt = options.interruptAtFraction !== undefined
          ? Math.floor(counters.transportBytes * options.interruptAtFraction)
          : Number.POSITIVE_INFINITY;

        for (;;) {
          const frame = await session.take();
          if (!frame) break;
          counters.framesEmitted += 1;
          counters.bytesOnTheWire += frame.length;
          spin(options.renderDelayUs ?? 0);

          for (const delivered of stream.offer(frame)) {
            const outcome = deliver(pipeline, delivered, options.decodeDelayUs ?? 0);
            if (outcome === FRAME_OUTCOME.PENDING_STORAGE || outcome === FRAME_OUTCOME.PENDING_MANIFEST) {
              counters.framesPendingStorage += 1;
            }
          }

          // Until storage is open the receiver is asked between every frame.
          // That is the faithful ratio and not a convenience: opening a store
          // takes single-digit milliseconds against a frame every 83, so a real
          // phone is ready inside one frame. Sampling only every 64 would make
          // a 1 KiB transfer - five frames long in total - lose its whole file
          // to an artefact of this harness.
          if (!provisioned) {
            await yieldOnce();
            provisioned = pipeline.progress().storageKind !== 'none';
          }

          if (counters.framesEmitted % 64 === 0) {
            // Storage provisioning, the store's own async work and the sample
            // of both ends' memory all happen here, on the same cadence the
            // sender retransmits its manifest.
            await yieldOnce();
            const progress = pipeline.progress();
            while (unitsRecovered < progress.unitsRecovered) {
              unitsRecovered += 1;
              completions.push(counters.framesEmitted);
            }
            peakHeld = Math.max(peakHeld, progress.heldBytes);
            peakHeap = Math.max(peakHeap, heapMib());
            counters.senderPeakBuffered = Math.max(counters.senderPeakBuffered, session.bufferedBytes());
            if (progress.complete) break;
            if (progress.fault) {
              failure = progress.fault;
              break;
            }
          }

          if (Number(session.progress().transportBytesCovered) >= stopAt) break;
        }

        for (const delivered of stream.drain()) {
          deliver(pipeline, delivered, options.decodeDelayUs ?? 0);
        }
        await yieldOnce();

        const senderProgress = session.progress();
        counters.sourceSymbols += senderProgress.sourceSymbolsEmitted;
        counters.repairSymbols += senderProgress.repairSymbolsEmitted;
        counters.senderPeakBuffered = Math.max(counters.senderPeakBuffered, session.bufferedBytes());
      } finally {
        await session.dispose();
        for (const key of Object.keys(wire) as (keyof ChannelCounters)[]) {
          wire[key] += stream.counters[key];
        }
      }

      const progress = pipeline.progress();
      while (unitsRecovered < progress.unitsRecovered) {
        unitsRecovered += 1;
        completions.push(counters.framesEmitted);
      }
      complete = progress.complete;
      if (progress.fault) {
        failure = progress.fault;
        break;
      }
      if (options.interruptAtFraction !== undefined) break;
    }
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  const pipelineSeconds = (performance.now() - wallStart) / 1000;
  const cpu = process.cpuUsage(cpuStart);

  let verifySeconds = 0;
  let verifiedSha = '';
  let exportKind = 'none';
  let exportSize = 0;
  if (complete && !failure) {
    const verifyStart = performance.now();
    const verified = await pipeline.verify();
    verifySeconds = (performance.now() - verifyStart) / 1000;
    if (verified.ok) {
      verifiedSha = hex(verified.value.sha256);
      exportKind = verified.value.source.kind;
      exportSize = verified.value.source.kind === 'opfs'
        ? verified.value.source.size
        : verified.value.source.bytes.length;
    } else {
      failure = `${verified.code}: ${verified.message}`;
    }
  }

  const progress = pipeline.progress();
  peakHeld = Math.max(peakHeld, progress.heldBytes);
  const storageKind = progress.storageKind;
  const storagePressure = progress.storagePressure;
  const fault = progress.fault;

  pipeline.release(complete && !failure ? 'completed' : options.interruptAtFraction !== undefined ? 'interrupted' : 'failed');
  await pipeline.settled();

  const opticalSeconds = counters.framesEmitted / fps;
  const gaps = completions.map((frameIndex, index) => (
    index === 0 ? frameIndex : frameIndex - completions[index - 1]
  ) / fps);
  const meter = root.meter;

  collect();
  return {
    label,
    sizeBytes,
    dataClass,
    profile: profile.name,
    ok: complete && !failure && verifiedSha === expectedSha && counters.senderSha === expectedSha,
    failure,
    passes,
    compressionUsed: counters.compressionUsed,
    compressionRatio: counters.compressionRatio,
    transportBytes: counters.transportBytes,
    bytesOnTheWire: counters.bytesOnTheWire,
    framesEmitted: counters.framesEmitted,
    framesDelivered: wire.delivered,
    framesAccepted: progress.framesAccepted,
    framesDuplicate: progress.framesDuplicate,
    framesRejected: progress.framesRejected,
    framesForeign: progress.framesForeign,
    framesPendingStorage: counters.framesPendingStorage,
    channelDropped: wire.dropped,
    channelDuplicated: wire.duplicated,
    channelCorrupted: wire.corrupted,
    channelReordered: wire.reordered,
    sourceSymbols: counters.sourceSymbols,
    repairSymbols: counters.repairSymbols,
    repairOverheadUsed: counters.sourceSymbols > 0 ? counters.repairSymbols / counters.sourceSymbols : 0,
    opticalSeconds,
    pipelineSeconds,
    verifySeconds,
    // Zero unless a file arrived and its digest matched. A rate computed from
    // a transfer that never completed is not a slow transfer, it is no
    // transfer, and letting it carry a number puts failed rows into a ranking.
    verifiedBytesPerSecond: verifiedSha === expectedSha && verifiedSha !== '' && opticalSeconds > 0
      ? sizeBytes / opticalSeconds
      : 0,
    opticalBytesPerSecond: opticalSeconds > 0 ? counters.bytesOnTheWire / opticalSeconds : 0,
    renderFps: fps,
    decodedFps: opticalSeconds > 0 ? (progress.framesAccepted + progress.framesDuplicate) / opticalSeconds : 0,
    uniqueFps: opticalSeconds > 0 ? progress.framesAccepted / opticalSeconds : 0,
    duplicateRatio: wire.delivered > 0 ? progress.framesDuplicate / wire.delivered : 0,
    dropRatio: wire.offered > 0 ? wire.dropped / wire.offered : 0,
    rejectRatio: wire.delivered > 0 ? progress.framesRejected / wire.delivered : 0,
    redundantRatio: wire.delivered > 0
      ? (progress.framesDuplicate + Math.max(0, progress.manifestFrames - 1)) / wire.delivered
      : 0,
    manifestFrames: progress.manifestFrames,
    segmentRecoveryMeanSeconds: gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0,
    segmentRecoveryMaxSeconds: gaps.length > 0 ? Math.max(...gaps) : 0,
    senderBudgetMib: counters.senderBudget / MIB,
    senderPeakBufferedMib: counters.senderPeakBuffered / MIB,
    senderCpuSeconds: (cpu.user + cpu.system) / 1_000_000,
    peakHeapMib: peakHeap,
    receiverPeakHeldMib: peakHeld / MIB,
    storageKind,
    opfsWriteMibPerSecond: meter.writeMs > 0 ? (meter.writeBytes / MIB) / (meter.writeMs / 1000) : 0,
    opfsWriteCalls: meter.writeCalls,
    hashMibPerSecond: verifySeconds > 0 ? (sizeBytes / MIB) / verifySeconds : 0,
    expectedSha,
    senderSha: counters.senderSha,
    verifiedSha,
    hashMatch: verifiedSha === expectedSha && verifiedSha !== '' && counters.senderSha === expectedSha,
    exportKind,
    exportSize,
    storagePressure,
    fault,
  };
}

/** One delivery, with the decoder's cost charged before the pipeline sees it. */
function deliver(pipeline: ReceivePipeline, frame: Uint8Array, delayUs: number): string {
  spin(delayUs);
  return pipeline.submit(frame).outcome;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) out += bytes[index].toString(16).padStart(2, '0');
  return out;
}

/* ------------------------------------------------------------- collection */

const RESULTS: RunResult[] = [];

/**
 * Rows that are not transfers.
 *
 * A refusal, a foreign-session count and a cancel are results the phase is
 * gated on and none of them is a `RunResult` - there is no throughput and no
 * digest. They are collected separately so the machine-readable evidence
 * carries them rather than only the console.
 */
const NOTES: Array<{ tag: string; fields: Record<string, string | number | boolean> }> = [];

function note(tag: string, fields: Record<string, string | number | boolean>): void {
  NOTES.push({ tag, fields });
  report(tag, fields);
}

function record(result: RunResult, tag: string): RunResult {
  RESULTS.push(result);
  report(tag, {
    label: result.label,
    size: sizeLabel(result.sizeBytes),
    data: result.dataClass,
    profile: result.profile,
    ok: result.ok,
    passes: result.passes,
    hashMatch: result.hashMatch,
    verifiedBps: result.verifiedBytesPerSecond,
    opticalBps: result.opticalBytesPerSecond,
    opticalHours: result.opticalSeconds / 3600,
    uniqueFps: result.uniqueFps,
    dupRatio: result.duplicateRatio,
    dropRatio: result.dropRatio,
    rejectRatio: result.rejectRatio,
    redundantRatio: result.redundantRatio,
    repairUsed: result.repairOverheadUsed,
    segRecovMax: result.segmentRecoveryMaxSeconds,
    heldMib: result.receiverPeakHeldMib,
    senderBufMib: result.senderPeakBufferedMib,
    heapMib: result.peakHeapMib,
    storeMibPerSec: result.opfsWriteMibPerSecond,
    hashMibPerSec: result.hashMibPerSecond,
    export: result.exportKind,
    pipelineSec: result.pipelineSeconds,
    failure: result.failure ?? '-',
  });
  return result;
}

function sizeLabel(bytes: number): string {
  if (bytes >= MIB) return `${bytes / MIB}MiB`;
  if (bytes >= KIB) return `${bytes / KIB}KiB`;
  return `${bytes}B`;
}

/* ------------------------------------------------------------ mode: ladder */

/** Every size the plan names, in bytes, smallest first. */
const LADDER_SIZES: readonly number[] = [
  1 * KIB,
  5 * KIB,
  100 * KIB,
  1 * MIB,
  10 * MIB,
  32 * MIB,
  64 * MIB,
  128 * MIB,
  256 * MIB,
  512 * MIB,
  1024 * MIB,
  2048 * MIB,
  4096 * MIB,
];

/**
 * The size ladder, hash-gated, against each class of data.
 *
 * Ordered smallest first and never skipped: the plan's rule is that a tier is
 * not attempted after a failure below it, so a run that fails at 64 MiB stops
 * rather than reporting a green 512 MiB row that nothing underneath supports.
 */
async function runLadder(
  maxBytes: number,
  classes: readonly DataClass[],
  compression: boolean,
  only?: readonly number[],
): Promise<void> {
  const root = storageRoot('ladder', newMeter());

  // The zero-byte row is a refusal, not a transfer, and it is checked here
  // because "what happens at zero" is a ladder question. Skipped when the
  // caller asked for specific sizes, because then this is a continuation of a
  // ladder rather than a ladder.
  if (!only) await reportEmptyFile();

  for (const sizeBytes of only ?? LADDER_SIZES) {
    if (sizeBytes > maxBytes) break;
    let tierOk = true;
    for (const dataClass of classes) {
      root.reset();
      root.meter.writeBytes = 0;
      root.meter.writeMs = 0;
      root.meter.writeCalls = 0;
      const result = await runTransfer({
        label: `ladder-${sizeLabel(sizeBytes)}-${dataClass}`,
        sizeBytes,
        dataClass,
        profile: BALANCED_PROFILE,
        channel: channel(),
        seed: 0x5eed + sizeBytes,
        compression,
        maxPasses: 1,
        root,
      });
      record(result, 'ladder');
      tierOk = tierOk && result.ok;
    }
    if (!tierOk) {
      note('ladder-stop', { size: sizeLabel(sizeBytes), reason: 'a row at this size failed; higher tiers not attempted' });
      return;
    }
  }
}

/** The zero-byte case: the sender refuses it, and the refusal is the result. */
async function reportEmptyFile(): Promise<void> {
  let code = 'accepted';
  try {
    const session = await StreamingTransferSession.open(
      'phase11-empty.bin',
      configFromProfile(BALANCED_PROFILE),
      syntheticOpener(0, 'random', 1),
    );
    await session.dispose();
  } catch (error) {
    code = error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error);
  }
  note('ladder', { label: 'ladder-0B', size: '0B', ok: code !== 'accepted', outcome: code });
}

/* ----------------------------------------------------------- mode: channel */

const LOSS_RATES: readonly number[] = [0, 0.01, 0.05, 0.10, 0.20, 0.30];

/**
 * What the channel can do to a transfer, one impairment at a time.
 *
 * Each row moves one variable. That is the only way a result is attributable:
 * a run with loss *and* reordering *and* duplicates that fails says nothing
 * about which of the three the receiver mishandled.
 */
async function runChannel(sizeBytes: number, profile: TransportProfile, maxPasses: number): Promise<void> {
  const root = storageRoot('channel', newMeter());

  for (const lossRate of LOSS_RATES) {
    root.reset();
    record(await runTransfer({
      label: `loss-${Math.round(lossRate * 100)}pct`,
      sizeBytes,
      dataClass: 'random',
      profile,
      channel: channel({ lossRate }),
      seed: 0xc0ffee,
      compression: false,
      // Loss above the repair budget needs the sender to run the stream again,
      // which is what a desktop does: the display loops until the phone says
      // it is finished. The cap is a cap, not an expectation - `--maxPasses`
      // raises it to ask how many a given loss rate actually needs.
      maxPasses,
      root,
    }), 'channel');
  }

  const impairments: ReadonlyArray<{ label: string; options: Partial<ChannelOptions> }> = [
    { label: 'burst-20pct-x8', options: { lossRate: 0.20, burstFrames: 8 } },
    { label: 'burst-20pct-x32', options: { lossRate: 0.20, burstFrames: 32 } },
    { label: 'duplicates-25pct', options: { duplicateRate: 0.25 } },
    { label: 'reorder-64', options: { reorderWindow: 64 } },
    { label: 'reorder-512-loss-10pct', options: { reorderWindow: 512, lossRate: 0.10 } },
    { label: 'corrupt-10pct', options: { corruptRate: 0.10 } },
    { label: 'corrupt-50pct', options: { corruptRate: 0.50 } },
    { label: 'hostile-mix', options: { lossRate: 0.10, burstFrames: 4, duplicateRate: 0.15, reorderWindow: 128, corruptRate: 0.10 } },
  ];

  for (const impairment of impairments) {
    root.reset();
    record(await runTransfer({
      label: impairment.label,
      sizeBytes,
      dataClass: 'random',
      profile,
      channel: channel(impairment.options),
      seed: 0xc0ffee,
      compression: false,
      maxPasses,
      root,
    }), 'channel');
  }
}

/* --------------------------------------------------------- mode: interrupt */

/**
 * Interrupt a transfer, walk away, come back, and finish it.
 *
 * Two pipelines and two senders, with only what a user actually carries
 * between them: the bytes left on the device and the token read off its
 * screen. Nothing else is passed from the first run to the second, which is
 * what makes this a resume rather than a paused loop.
 */
async function runInterrupt(sizeBytes: number, atFraction: number): Promise<void> {
  const root = storageRoot('interrupt', newMeter());

  // What the same transfer costs with nobody interrupting it. Measured rather
  // than derived, because the saving a resume claims is the difference between
  // two runs and both halves of that subtraction have to be real.
  const baseline = record(await runTransfer({
    label: 'interrupt-baseline',
    sizeBytes,
    dataClass: 'structured',
    profile: BALANCED_PROFILE,
    channel: channel(),
    seed: 0x1337,
    compression: false,
    maxPasses: 1,
    root,
  }), 'interrupt');
  root.reset();

  const first = await runTransfer({
    label: `interrupt-at-${Math.round(atFraction * 100)}pct`,
    sizeBytes,
    dataClass: 'structured',
    profile: BALANCED_PROFILE,
    channel: channel(),
    seed: 0x1337,
    compression: false,
    maxPasses: 1,
    interruptAtFraction: atFraction,
    root,
  });
  record(first, 'interrupt');

  // The token the interrupted receiver put on screen. Read from a fresh
  // pipeline over the same storage, exactly as a user re-opening the tab would
  // see it, rather than kept from the object that produced it.
  const token = await tokenFromDevice(root, sizeBytes);
  note('interrupt-token', {
    present: token !== undefined,
    length: token?.length ?? 0,
  });

  const resumed = await runTransfer({
    label: 'interrupt-resume',
    sizeBytes,
    dataClass: 'structured',
    profile: BALANCED_PROFILE,
    channel: channel(),
    seed: 0x1337,
    compression: false,
    maxPasses: 1,
    resume: true,
    resumeToken: token,
    root,
  });
  record(resumed, 'interrupt');

  note('interrupt-saving', {
    freshFrames: baseline.framesEmitted,
    firstPassFrames: first.framesEmitted,
    resumeFrames: resumed.framesEmitted,
    framesNotResent: baseline.framesEmitted - resumed.framesEmitted,
    savedOpticalSeconds: (baseline.framesEmitted - resumed.framesEmitted) / effectiveFps(BALANCED_PROFILE),
    // The whole round trip against one uninterrupted run. Above 1 means the
    // interruption cost more than starting over would have.
    totalVersusFresh: baseline.framesEmitted > 0
      ? (first.framesEmitted + resumed.framesEmitted) / baseline.framesEmitted
      : 0,
    resumedOk: resumed.ok,
    resumedHashMatch: resumed.hashMatch,
  });
}

/**
 * Reads the resume token a device would show, by opening the session again.
 *
 * The token is a property of the working data, not of the pipeline that wrote
 * it, so it has to survive being asked for by something new. Getting it needs
 * one manifest frame - which is the same thing the phone gets when the sender
 * is pointed at it again.
 */
async function tokenFromDevice(root: StorageRoot, sizeBytes: number): Promise<string | undefined> {
  const storage = new ReceiverStorage({ environment: root.environment });
  const pipeline = new ReceivePipeline({ storage, resume: true, yieldToEventLoop: yieldOnce });
  const session = await StreamingTransferSession.open(
    'phase11-interrupt.bin',
    senderConfig(BALANCED_PROFILE, {
      compression: false,
      sessionId: 0x11_00_00_01,
      fileId: 0x11_00_00_02,
    }),
    syntheticOpener(sizeBytes, 'structured', 0x1337),
  );
  try {
    const manifest = await session.take();
    if (manifest) pipeline.submit(manifest);
    await pipeline.whenStorageReady();
    const token = pipeline.progress().resumeToken;
    return token;
  } finally {
    await session.dispose();
    // `interrupted` so the working data survives for the resume that follows.
    pipeline.release('interrupted');
    await pipeline.settled();
  }
}

/* ------------------------------------------------------ mode: backpressure */

/**
 * Three ways to be too slow, and what each costs.
 *
 * **What this does not prove.** This harness is pull-based: one loop takes a
 * frame and hands it to the receiver, so the producer can never outrun the
 * consumer and no queue can grow. Queue-depth backpressure - the camera
 * sampler dropping frames, the worker's bounded inbox - is Phase 05's
 * measurement and is covered by `camera-backpressure.test.ts` and
 * `receiver-client-backpressure.test.ts`. Claiming it here would be claiming
 * something the shape of the harness makes untestable.
 *
 * What it does prove is the other half, and it is not nothing: a component
 * running an order of magnitude slower than the optical link still produces a
 * byte-exact file, still holds a bounded amount of memory while doing it, and
 * costs only the time it was made to cost.
 *
 * The store delay is set from a measurement rather than picked: real Chromium
 * OPFS wrote at ~29 MiB/s in the browser half of this phase, which is ~45 ms
 * for a 1.34 MiB segment. That is the `store-realistic` row.
 */
async function runBackpressure(sizeBytes: number): Promise<void> {
  const rows: ReadonlyArray<{ label: string; storeUs: number; decodeUs: number; renderUs: number }> = [
    { label: 'baseline', storeUs: 0, decodeUs: 0, renderUs: 0 },
    { label: 'store-realistic-45ms', storeUs: 45_000, decodeUs: 0, renderUs: 0 },
    { label: 'store-slow-200ms', storeUs: 200_000, decodeUs: 0, renderUs: 0 },
    { label: 'decoder-slow-2ms', storeUs: 0, decodeUs: 2_000, renderUs: 0 },
    { label: 'decoder-slow-10ms', storeUs: 0, decodeUs: 10_000, renderUs: 0 },
    { label: 'display-slow-2ms', storeUs: 0, decodeUs: 0, renderUs: 2_000 },
    { label: 'all-slow', storeUs: 45_000, decodeUs: 2_000, renderUs: 2_000 },
  ];

  for (const row of rows) {
    const root = storageRoot('backpressure', newMeter({ delayPerWriteUs: row.storeUs }));
    record(await runTransfer({
      label: `backpressure-${row.label}`,
      sizeBytes,
      dataClass: 'random',
      profile: BALANCED_PROFILE,
      channel: channel(),
      seed: 0xbeef,
      compression: false,
      maxPasses: 1,
      decodeDelayUs: row.decodeUs,
      renderDelayUs: row.renderUs,
      root,
    }), 'backpressure');
  }
}

/* ------------------------------------------------------------ mode: faults */

/**
 * The paths that must fail, and must fail cleanly.
 *
 * A certification that only records successes certifies half a product. Each
 * row here is a way a transfer ends without a file, and what is being checked
 * is that it ends *as itself* - a refusal that says which refusal it was,
 * with no crash and nothing left holding a handle.
 */
async function runFaults(sizeBytes: number): Promise<void> {
  // 1. The device is too small for the transfer, and says so before writing.
  const tiny = storageRoot('fault-preflight', newMeter(), Math.floor(sizeBytes / 4));
  reportRefusal('fault-insufficient-storage', await runTransfer({
    label: 'fault-insufficient-storage',
    sizeBytes,
    dataClass: 'random',
    profile: BALANCED_PROFILE,
    channel: channel(),
    seed: 1,
    compression: false,
    maxPasses: 1,
    allowMemoryFallback: false,
    root: tiny,
  }), 'INSUFFICIENT_STORAGE');

  // 2. A quota that would be exceeded during the transfer. Pre-sizing turns it
  //    into a refusal at session start rather than a failure an hour in, which
  //    is what reserving the whole file with `truncate` exists to do - so the
  //    expected code here is the up-front one, not the mid-write one.
  const shrinking = storageRoot('fault-quota', newMeter({ capacityBytes: Math.floor(sizeBytes / 3) }));
  reportRefusal('fault-quota-caught-by-pre-sizing', await runTransfer({
    label: 'fault-quota-caught-by-pre-sizing',
    sizeBytes,
    dataClass: 'random',
    profile: BALANCED_PROFILE,
    channel: channel(),
    seed: 2,
    compression: false,
    maxPasses: 1,
    allowMemoryFallback: false,
    root: shrinking,
  }), 'INSUFFICIENT_STORAGE');

  // 3. Room at the start, and something else eats the disk half way through.
  //    Pre-sizing cannot catch this one: the reservation succeeded.
  const filling = storageRoot('fault-fills-up', newMeter({ capacityDropsAfterWrites: 2 }));
  reportRefusal('fault-device-fills-up-mid-transfer', await runTransfer({
    label: 'fault-device-fills-up-mid-transfer',
    sizeBytes,
    dataClass: 'random',
    profile: BALANCED_PROFILE,
    channel: channel(),
    seed: 6,
    compression: false,
    maxPasses: 1,
    allowMemoryFallback: false,
    root: filling,
  }), 'STORAGE_FULL');

  // 4. Frames from somebody else's transfer, in the middle of this one.
  await reportForeignSession(sizeBytes);

  // 5. A cancel, mid-transfer, with the working data discarded.
  await reportCancel(sizeBytes);
}

/**
 * A run that was supposed to be refused, judged on the refusal.
 *
 * `ok` on a `RunResult` means "the file arrived", which is the wrong question
 * for these rows: a transfer the device cannot hold *must not* arrive. What is
 * being checked is that it stopped for the stated reason, that it named it, and
 * above all that it claimed no digest on the way out - a refusal that still
 * reports a hash would be the worst defect in the product.
 */
function reportRefusal(label: string, result: RunResult, expected: string): void {
  const fault = result.fault ?? result.failure ?? '-';
  note('faults', {
    label,
    expected,
    observedFault: fault,
    faultRaised: fault !== '-',
    matchesExpected: fault.includes(expected),
    completed: result.passes > 0,
    claimedDigest: result.verifiedSha !== '',
    storagePressure: result.storagePressure,
    storageKind: result.storageKind,
    bytesHeldMib: result.receiverPeakHeldMib,
    ok: fault !== '-' && result.verifiedSha === '',
  });
}

/**
 * A second sender in the room.
 *
 * The receiver must count these as foreign rather than reject them as corrupt:
 * the two are different events and the user acts on them differently - one
 * means aim at the other screen, the other means the code cannot be read.
 */
async function reportForeignSession(sizeBytes: number): Promise<void> {
  const root = storageRoot('fault-foreign', newMeter());
  const storage = new ReceiverStorage({ environment: root.environment });
  const pipeline = new ReceivePipeline({ storage, yieldToEventLoop: yieldOnce });

  const mine = await StreamingTransferSession.open(
    'phase11-mine.bin',
    senderConfig(BALANCED_PROFILE, { compression: false, sessionId: 0xaaaa_0001, fileId: 0xaaaa_0002 }),
    syntheticOpener(sizeBytes, 'random', 3),
  );
  const theirs = await StreamingTransferSession.open(
    'phase11-theirs.bin',
    senderConfig(BALANCED_PROFILE, { compression: false, sessionId: 0xbbbb_0001, fileId: 0xbbbb_0002 }),
    syntheticOpener(sizeBytes, 'random', 4),
  );

  try {
    for (let index = 0; index < 4096; index += 1) {
      const frame = await mine.take();
      if (!frame) break;
      pipeline.submit(frame);
      if (index % 8 === 0) {
        const intruder = await theirs.take();
        if (intruder) pipeline.submit(intruder);
      }
      if (index % 64 === 0) await yieldOnce();
    }
    await yieldOnce();
    const progress = pipeline.progress();
    note('faults', {
      label: 'fault-foreign-session',
      accepted: progress.framesAccepted,
      foreign: progress.framesForeign,
      rejected: progress.framesRejected,
      fault: progress.fault ?? '-',
      ok: progress.framesForeign > 0 && !progress.fault,
    });
  } finally {
    await mine.dispose();
    await theirs.dispose();
    pipeline.release('cancelled');
    await pipeline.settled();
  }
}

/** A cancel half way through, and what is left on the device afterwards. */
async function reportCancel(sizeBytes: number): Promise<void> {
  const root = storageRoot('fault-cancel', newMeter());
  const storage = new ReceiverStorage({ environment: root.environment });
  const pipeline = new ReceivePipeline({ storage, yieldToEventLoop: yieldOnce });
  const session = await StreamingTransferSession.open(
    'phase11-cancel.bin',
    senderConfig(BALANCED_PROFILE, { compression: false, sessionId: 0xcccc_0001, fileId: 0xcccc_0002 }),
    syntheticOpener(sizeBytes, 'random', 5),
  );

  let committed = 0;
  try {
    for (let index = 0; index < 20_000; index += 1) {
      const frame = await session.take();
      if (!frame) break;
      pipeline.submit(frame);
      if (index % 64 === 0) await yieldOnce();
      if (pipeline.progress().bytesCommitted > sizeBytes / 4) break;
    }
    await yieldOnce();
    committed = pipeline.progress().bytesCommitted;
  } finally {
    await session.dispose();
  }

  const started = performance.now();
  pipeline.release('cancelled');
  await pipeline.settled();
  const cancelMs = performance.now() - started;

  const leftBehind = directoryBytes(root.directory);
  note('faults', {
    label: 'fault-cancel-mid-transfer',
    committedMib: committed / MIB,
    cancelMs,
    bytesLeftOnDevice: leftBehind,
    ok: leftBehind === 0,
  });
}

function directoryBytes(directory: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else total += stat.size;
    }
  };
  walk(directory);
  return total;
}

/* ---------------------------------------------------------- mode: profiles */

/**
 * Ranked end-to-end goodput, per profile, per camera density.
 *
 * The loss rate is not chosen: it is `1 - decodeSuccess` from the surface
 * Phase 04 measured with a real encoder and the receiver's own jsQR. So each
 * row is a measured optical property driving a measured pipeline, and the
 * output is the plan's primary metric under a stated camera assumption.
 */
async function runProfiles(sizeBytes: number, densities: readonly string[], maxPasses: number): Promise<void> {
  const root = storageRoot('profiles', newMeter());
  const ranked: Array<{ profile: string; density: string; loss: number; verifiedBps: number; ok: boolean; passes: number }> = [];

  for (const profile of TRANSPORT_PROFILES) {
    const surface = MEASURED_DECODE_SUCCESS[profile.qrVersion];
    for (const density of densities) {
      const success = surface?.[density];
      if (success === undefined) continue;
      if (success === null) {
        note('profiles', {
          profile: profile.name,
          pxPerModule: density,
          decodeSuccess: 'n/a',
          note: 'symbol does not fit a 720-line capture frame',
          ok: false,
        });
        ranked.push({ profile: profile.name, density, loss: 1, verifiedBps: 0, ok: false, passes: 0 });
        continue;
      }
      const lossRate = 1 - success;
      root.reset();
      const result = await runTransfer({
        label: `${profile.name}-${density}px`,
        sizeBytes,
        dataClass: 'random',
        profile,
        channel: channel({ lossRate }),
        seed: 0xf00d,
        compression: false,
        maxPasses,
        root,
      });
      RESULTS.push(result);
      note('profiles', {
        profile: profile.name,
        pxPerModule: density,
        decodeSuccess: success,
        lossRate,
        repairBudget: profile.repairOverheadRatio,
        repairNeeded: requiredRepairRatio(lossRate) ?? -1,
        frameBytes: frameBytesFor(profile),
        fps: effectiveFps(profile),
        passes: result.passes,
        ok: result.ok,
        verifiedBps: result.verifiedBytesPerSecond,
        opticalBps: result.opticalBytesPerSecond,
        hoursPerGiB: result.verifiedBytesPerSecond > 0 ? (1024 * MIB) / result.verifiedBytesPerSecond / 3600 : 0,
      });
      ranked.push({
        profile: profile.name,
        density,
        loss: lossRate,
        verifiedBps: result.verifiedBytesPerSecond,
        ok: result.ok,
        passes: result.passes,
      });
    }
  }

  // Completed first, then everything that did not arrive. Sorting the two
  // together would let a combination that never delivered a file outrank one
  // that did, which is the single way a ranking like this goes wrong.
  ranked.sort((left, right) => {
    if (left.ok !== right.ok) return left.ok ? -1 : 1;
    return right.verifiedBps - left.verifiedBps;
  });
  let rank = 0;
  for (const entry of ranked) {
    rank += 1;
    note('profile-rank', {
      rank: entry.ok ? rank : -1,
      profile: entry.profile,
      pxPerModule: entry.density,
      lossRate: entry.loss,
      verifiedBps: entry.verifiedBps,
      hoursPerGiB: entry.verifiedBps > 0 ? (1024 * MIB) / entry.verifiedBps / 3600 : 0,
      passes: entry.passes,
      completed: entry.ok,
    });
  }

  const best = ranked.find((entry) => entry.ok);
  const widest = widestStable(ranked);
  note('profile-recommendation', {
    fastestCompleted: best ? `${best.profile} at ${best.density} px/module` : 'none',
    fastestVerifiedBps: best?.verifiedBps ?? 0,
    broadestStable: widest ? `${widest.profile} (completes at every measured density down to ${widest.lowest} px/module)` : 'none',
    broadestVerifiedBps: widest?.verifiedBps ?? 0,
    note: 'a recommendation from a simulated camera; the density a real iPhone supplies is unmeasured',
  });
}

/**
 * The profile that completes at the lowest camera density, and what it costs.
 *
 * "Broadest stable matrix" is the plan's rule for choosing Balanced, and it is
 * a different question from "fastest": the profile to default to is the one
 * that still delivers a file when the phone is further away than anyone
 * planned for.
 */
function widestStable(
  ranked: ReadonlyArray<{ profile: string; density: string; verifiedBps: number; ok: boolean }>,
): { profile: string; lowest: string; verifiedBps: number } | null {
  let best: { profile: string; lowest: string; verifiedBps: number } | null = null;
  for (const profile of TRANSPORT_PROFILES) {
    const rows = ranked.filter((entry) => entry.profile === profile.name);
    if (rows.length === 0 || rows.some((entry) => !entry.ok)) continue;
    const lowest = rows.reduce((low, entry) => (Number(entry.density) < Number(low.density) ? entry : low));
    const slowest = Math.min(...rows.map((entry) => entry.verifiedBps));
    if (!best || Number(lowest.density) < Number(best.lowest)) {
      best = { profile: profile.name, lowest: lowest.density, verifiedBps: slowest };
    }
  }
  return best;
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const mode = argument('mode', 'ladder');
  const maxMib = numberArgument('maxMib', 64);
  const sizeMib = numberArgument('sizeMib', 8);
  const classes = argument('classes', DATA_CLASSES.join(','))
    .split(',')
    .filter((entry): entry is DataClass => (DATA_CLASSES as readonly string[]).includes(entry));
  const profileName = argument('profile', 'Balanced');
  const profile = TRANSPORT_PROFILES.find((entry) => entry.name === profileName) ?? BALANCED_PROFILE;

  mkdirSync(RUN_ROOT, { recursive: true });
  report('environment', {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: (await import('node:os')).cpus().length,
    totalMemMib: (await import('node:os')).totalmem() / MIB,
    gcExposed: typeof (globalThis as { gc?: () => void }).gc === 'function',
    mode,
  });

  const started = performance.now();
  switch (mode) {
    case 'ladder': {
      // `--sizesMib` continues a ladder at chosen tiers, for the sizes whose
      // cost makes them a separate sitting. It does not weaken the no-skipping
      // rule: a tier run this way is only meaningful if the tiers below it have
      // already passed, and the report has to say so.
      const only = argument('sizesMib', '')
        .split(',')
        .filter((entry) => entry.length > 0)
        .map((entry) => Number(entry) * MIB)
        .filter((value) => Number.isFinite(value) && value > 0);
      await runLadder(
        maxMib * MIB,
        classes,
        argument('compression', 'off') === 'on',
        only.length > 0 ? only : undefined,
      );
      break;
    }
    case 'channel':
      await runChannel(sizeMib * MIB, profile, numberArgument('maxPasses', 4));
      break;
    case 'interrupt':
      await runInterrupt(sizeMib * MIB, numberArgument('atFraction', 0.6));
      break;
    case 'backpressure':
      await runBackpressure(sizeMib * MIB);
      break;
    case 'faults':
      await runFaults(sizeMib * MIB);
      break;
    case 'profiles':
      await runProfiles(sizeMib * MIB, argument('px', '2.5,3,3.5,4,5').split(','), numberArgument('maxPasses', 6));
      break;
    default:
      throw new Error('--mode must be ladder, channel, interrupt, backpressure, faults, or profiles');
  }

  const wallSeconds = (performance.now() - started) / 1000;
  const passed = RESULTS.filter((result) => result.ok).length;
  report('summary', {
    mode,
    runs: RESULTS.length,
    passed,
    failed: RESULTS.length - passed,
    wallSeconds,
  });

  // `--tag` keeps two runs of the same mode - a ladder to 1 GiB and its
  // continuation at 2 and 4 GiB - from overwriting each other's evidence.
  const tag = argument('tag', '');
  const out = path.join(RUN_ROOT, `phase11-${mode}${tag ? `-${tag}` : ''}.json`);
  writeFileSync(out, JSON.stringify({
    mode,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    wallSeconds,
    results: RESULTS,
    notes: NOTES,
  }, null, 2));
  report('written', { file: path.relative(process.cwd(), out) });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
