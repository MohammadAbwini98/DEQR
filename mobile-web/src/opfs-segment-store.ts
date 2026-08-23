/**
 * The `SegmentStore` that removes the size ceiling.
 *
 * One file per transfer, opened once with an exclusive synchronous access
 * handle, written at the exact byte offset each segment belongs at, and never
 * read back except through a caller-supplied window. The receiver's memory
 * therefore stops being a function of the file: a 1 GiB transfer and a 1 MiB
 * transfer hold the same two decoders and the same one segment in flight.
 *
 * ## Why a synchronous handle
 *
 * `SegmentedReceiver` commits a segment from inside a frame's decode, through a
 * synchronous sink. The alternatives to a synchronous write there are all
 * worse: buffering completed segments for an async writer reintroduces exactly
 * the unbounded growth this store exists to prevent, and making the sink async
 * would push a promise into the middle of the elimination loop. A
 * `FileSystemSyncAccessHandle` writes in the calling turn and returns a byte
 * count, which is what the sink's contract already assumes - and it is the
 * fastest OPFS path on the target platform besides.
 *
 * The cost is that it is worker-only and exclusive. Both are handled: the
 * pipeline already runs in the receive worker, and `seal` closes the handle
 * before the main thread is told where the file is, because the lock would
 * otherwise make the export fail on the last step of an hour-long transfer.
 *
 * ## What it refuses to write
 *
 * A segment whose index, offset or length does not match the manifest's own
 * segmentation, computed here from the plan rather than taken from the frame.
 * The offsets *are* derived locally today - `SegmentedReceiver` computes them
 * from the same plan - so this check is currently redundant, and it is here
 * anyway: this is the last code between camera-originated data and a byte
 * offset in a file, the protocol has room to carry explicit offsets later, and
 * a store that trusts its input is a store that can be told to write outside
 * the file.
 *
 * ## Pre-sizing, on purpose
 *
 * The file is truncated to the full transport size before the first segment
 * arrives. That converts "will this fit?" from an estimate into an attempt: a
 * device that cannot hold the transfer fails here, in the second before
 * scanning starts, rather than forty minutes in. The gaps between arrived
 * segments read as zeros, which is why the checkpoint carries a bitmap of what
 * is actually present.
 */

import {
  V2_COMPRESSION,
  segmentByteRange,
  toSafeNumber,
  type DeqrV2Manifest,
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import { digestToHex } from '../../src/core/sha256-stream';
import {
  CHECKPOINT_SCHEMA,
  OPFS_DATA_FILE,
  bytesToBase64,
  matchCheckpoint,
  openSessionDirectory,
  probeSyncAccessHandle,
  readCheckpointEntry,
  removeSessionDirectory,
  sessionDirectoryName,
  sessionPath,
  sweepStaleSessions,
  writeCheckpoint,
  type CheckpointAdoption,
  type CheckpointRejection,
  type CheckpointState,
  type DirectoryHandleLike,
  type RetentionPolicy,
  type SessionCheckpoint,
  type SweepOptions,
  type SyncAccessHandleLike,
} from './opfs';
import { OpfsOriginalSink } from './opfs-original-sink';
import {
  STORE_WRITE,
  type ExportSource,
  type OriginalSink,
  type SegmentStore,
  type StoreWriteOutcome,
  type StoredSegment,
} from './segment-store';

/** Why a store could not be opened. Enumerated, because it reaches the UI. */
export type OpfsOpenFailure =
  /** No OPFS, or no synchronous access handle in this context. */
  | 'STORAGE_UNAVAILABLE'
  /** The handle exists but is not the synchronous revision this code needs. */
  | 'STORAGE_UNSUPPORTED'
  /** Pre-sizing the file was refused. The device cannot hold this transfer. */
  | 'INSUFFICIENT_STORAGE'
  /** Something else threw while opening. */
  | 'STORAGE_OPEN_FAILED';

export type OpfsOpenResult =
  | {
      ok: true;
      store: OpfsSegmentStore;
      /** Present when a checkpoint was adopted. The session starts partway in. */
      adopted?: CheckpointAdoption;
      /** Why a checkpoint on disk was not adopted. Absent when one was. */
      rejection?: CheckpointRejection;
    }
  | { ok: false; code: OpfsOpenFailure };

export interface OpfsOpenOptions {
  root: DirectoryHandleLike;
  manifest: DeqrV2Manifest;
  plan: SegmentPlan;
  /** Already sanitized by the caller. Stored as metadata only, never as a path. */
  filename: string;
  now?: () => number;
  /** Retention sweep run before the session's own directory is created. */
  sweep?: SweepOptions;
  /**
   * Try to adopt a checkpoint left by an earlier run of this same transfer.
   *
   * Off by default, and deliberately: adopting means treating bytes already on
   * the device as received, so it has to be something a caller asks for rather
   * than something that happens because a directory existed.
   */
  resume?: boolean;
}

/** Transport bytes a committed bitmap accounts for, derived from the plan. */
function committedBytesOf(plan: SegmentPlan, bits: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < plan.segmentCount; index += 1) {
    if ((bits[index >> 3] & (1 << (index & 7))) === 0) continue;
    const range = segmentByteRange(plan, index);
    total += Number(range.end - range.start);
  }
  return total;
}

/** A quota refusal, by the name the platform gives it. */
function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === 'QuotaExceededError' || name === 'NotAllowedError';
}

export class OpfsSegmentStore implements SegmentStore {
  readonly kind = 'opfs' as const;
  readonly directoryName: string;
  readonly path: string[];

  private readonly root: DirectoryHandleLike;
  private readonly directory: DirectoryHandleLike;
  private readonly plan: SegmentPlan;
  private readonly transportSize: number;
  private readonly originalSize: number | null;
  private readonly now: () => number;
  private readonly committed: Uint8Array;
  private readonly template: SessionCheckpoint;

  private handle: SyncAccessHandleLike | undefined;
  private bytes = 0;
  private segments = 0;
  /** Of the counters above, what a checkpoint contributed rather than this run. */
  private adoptedSegments = 0;
  private adoptedBytes = 0;
  private refused = 0;
  private closed = false;
  private sealed = false;
  private state: CheckpointState = 'receiving';

  /** At most one checkpoint write is ever outstanding; see `scheduleCheckpoint`. */
  private checkpointInFlight: Promise<void> | null = null;
  private checkpointDirty = false;

  private constructor(options: {
    root: DirectoryHandleLike;
    directory: DirectoryHandleLike;
    directoryName: string;
    handle: SyncAccessHandleLike;
    plan: SegmentPlan;
    transportSize: number;
    /** Set only for a compressed transfer, where it is what `original.part` holds. */
    originalSize: number | null;
    template: SessionCheckpoint;
    now: () => number;
    adopted?: CheckpointAdoption;
  }) {
    this.root = options.root;
    this.directory = options.directory;
    this.directoryName = options.directoryName;
    this.path = [...sessionPath(options.template.sessionId, options.template.fileId)];
    this.handle = options.handle;
    this.plan = options.plan;
    this.transportSize = options.transportSize;
    this.originalSize = options.originalSize;
    this.template = options.template;
    this.now = options.now;
    this.committed = new Uint8Array(Math.ceil(options.plan.segmentCount / 8));
    if (options.adopted) {
      // The adopted state is progress, not a separate mode. Seeding the same
      // three fields a fresh session accumulates means every rule below -
      // refusing a re-write, counting bytes, minting a checkpoint - works on a
      // resumed session without knowing it is one.
      this.committed.set(options.adopted.committedBits);
      this.bytes = options.adopted.bytesCommitted;
      this.segments = options.adopted.segmentsCommitted;
      this.adoptedSegments = options.adopted.segmentsCommitted;
      this.adoptedBytes = options.adopted.bytesCommitted;
    }
  }

  /**
   * Opens working storage for one transfer.
   *
   * Every failure is a code rather than an exception, because every one of them
   * has a different thing to tell the user and none of them is a bug in the
   * receiver. The caller falls back to bounded memory on `STORAGE_UNAVAILABLE`
   * and `STORAGE_UNSUPPORTED`, and stops the session on the other two.
   */
  static async open(options: OpfsOpenOptions): Promise<OpfsOpenResult> {
    const { root, manifest, plan, filename } = options;
    const now = options.now ?? (() => Date.now());
    const directoryName = sessionDirectoryName(manifest.sessionId, manifest.fileId);

    let transportSize: number;
    // Only a compressed transfer needs a second file. For everything else the
    // segments already are the file, and `originalSize` stays null so nothing
    // downstream can accidentally reserve space that is not needed.
    let originalSize: number | null = null;
    try {
      transportSize = toSafeNumber(manifest.transportSize, 'transportSize');
      if (manifest.compressionMode !== V2_COMPRESSION.NONE) {
        originalSize = toSafeNumber(manifest.originalSize, 'originalSize');
      }
    } catch {
      return { ok: false, code: 'STORAGE_OPEN_FAILED' };
    }

    // Debris from earlier sessions goes before this one claims space, so a
    // device near its quota is not pushed over by files nothing will resume.
    try {
      await sweepStaleSessions(root, { ...options.sweep, keep: directoryName, now });
    } catch {
      // A sweep that fails costs disk, not correctness.
    }

    // What is already on the device for this session, and whether it can be
    // believed. Decided *before* the data file is opened, because a checkpoint
    // that does not match has to take its directory with it - and a directory
    // cannot be removed while a handle is held on a file inside it.
    let adopted: CheckpointAdoption | undefined;
    let rejection: CheckpointRejection | undefined;
    if (options.resume === true) {
      const existing = await openSessionDirectory(root, directoryName, false);
      const read = existing ? await readCheckpointEntry(existing) : { present: false, checkpoint: null };
      const match = matchCheckpoint({
        checkpoint: read.checkpoint,
        present: read.present,
        sessionId: manifest.sessionId,
        fileId: manifest.fileId,
        sha256Hex: digestToHex(manifest.sha256),
        transportSize: manifest.transportSize,
        segmentSizeBytes: manifest.segmentSizeBytes,
        symbolSizeBytes: manifest.symbolSizeBytes,
        segmentCount: plan.segmentCount,
        expectedBytes: (bits) => committedBytesOf(plan, bits),
      });
      if (match.ok) adopted = match.value;
      else rejection = match.code;
    }

    if (rejection !== undefined && rejection !== 'CHECKPOINT_ABSENT') {
      // Something is in this session's directory and it is not this session's.
      // Leaving it would mean pre-sizing a file that already holds another
      // transfer's bytes, whose gaps would then read back as *that* data rather
      // than as zeros. Clearing it is what makes a mismatched resume safe.
      await removeSessionDirectory(root, directoryName);
    }

    const directory = await openSessionDirectory(root, directoryName, true);
    if (!directory) return { ok: false, code: 'STORAGE_UNAVAILABLE' };

    let handle: SyncAccessHandleLike;
    try {
      const file = await directory.getFileHandle(OPFS_DATA_FILE, { create: true });
      if (typeof file.createSyncAccessHandle !== 'function') {
        return { ok: false, code: 'STORAGE_UNAVAILABLE' };
      }
      handle = await file.createSyncAccessHandle();
    } catch (error) {
      return { ok: false, code: isQuotaError(error) ? 'INSUFFICIENT_STORAGE' : 'STORAGE_UNAVAILABLE' };
    }

    // Before anything is trusted to it: is this the synchronous handle, or the
    // promise-returning revision that would silently write nothing?
    //
    // The probe writes a byte at offset 0 and then truncates the file to
    // nothing, so it cannot run against data a resume is about to adopt - it
    // would destroy exactly what it was called to protect. The adopted branch
    // checks the file's length instead, which catches the same broken revision
    // by a different route: a `getSize()` that returns a promise is not a
    // number and cannot equal the transport size, so such a handle falls
    // through to the fresh path below and is probed there.
    if (adopted) {
      // The checkpoint says these bytes are here. The one thing it cannot say
      // is that the *file* is, so its length is checked against the plan: a
      // data file that was deleted, truncated, or never pre-sized cannot carry
      // the segments the bitmap claims, and adopting it would put zeros into
      // the middle of a transfer that then fails its hash at the very end.
      let size = -1;
      try {
        size = handle.getSize();
      } catch {
        size = -1;
      }
      if (size !== transportSize) {
        closeQuietly(handle);
        await removeSessionDirectory(root, directoryName);
        // Start clean rather than fail: the user asked to receive a file, and
        // the honest answer to unusable partial data is a fresh transfer.
        return OpfsSegmentStore.open({ ...options, resume: false });
      }
    } else {
      if (!probeSyncAccessHandle(handle)) {
        closeQuietly(handle);
        return { ok: false, code: 'STORAGE_UNSUPPORTED' };
      }
      try {
        handle.truncate(transportSize);
      } catch (error) {
        closeQuietly(handle);
        return { ok: false, code: isQuotaError(error) ? 'INSUFFICIENT_STORAGE' : 'STORAGE_OPEN_FAILED' };
      }
    }

    const at = now();
    const template: SessionCheckpoint = {
      schema: CHECKPOINT_SCHEMA,
      protocol: 2,
      sessionId: manifest.sessionId,
      fileId: manifest.fileId,
      filename,
      mimeType: manifest.mimeType || 'application/octet-stream',
      originalSize: manifest.originalSize.toString(10),
      transportSize: manifest.transportSize.toString(10),
      segmentSizeBytes: manifest.segmentSizeBytes,
      symbolSizeBytes: manifest.symbolSizeBytes,
      segmentCount: plan.segmentCount,
      sha256: digestToHex(manifest.sha256),
      dataFile: OPFS_DATA_FILE,
      // Kept from the original run, so a transfer resumed three times still
      // ages out on the clock of when it started rather than being renewed
      // indefinitely by the sweep's retention window.
      createdAt: adopted?.checkpoint.createdAt ?? at,
      updatedAt: at,
      bytesCommitted: 0,
      segmentsCommitted: 0,
      committed: '',
      state: 'receiving',
    };

    // Reserved now, not at verification. The whole reason `data.part` is
    // pre-sized is that "will this fit?" should be answered before anyone holds
    // a phone up for an hour, and a compressed transfer needs room for both
    // files. Reserving in the adopted branch too is deliberate: a resumed
    // session's second file may have been reclaimed while it was gone.
    if (originalSize !== null && !(await OpfsOriginalSink.reserve(directory, originalSize))) {
      closeQuietly(handle);
      return { ok: false, code: 'INSUFFICIENT_STORAGE' };
    }

    const store = new OpfsSegmentStore({
      root,
      directory,
      directoryName,
      handle,
      plan,
      transportSize,
      originalSize,
      template,
      now,
      adopted,
    });
    // The first checkpoint is awaited rather than scheduled: a session that
    // crashes between its first segment and its first checkpoint would
    // otherwise leave a directory nothing can identify, which the sweep then
    // deletes as debris.
    await store.persistCheckpoint();
    return { ok: true, store, adopted, rejection };
  }

  /* -------------------------------------------------------------- writing */

  write(segment: StoredSegment): StoreWriteOutcome {
    const handle = this.handle;
    if (!handle || this.closed) {
      this.refused += 1;
      return STORE_WRITE.FAILED;
    }

    const validated = this.validate(segment);
    if (validated === null) {
      this.refused += 1;
      return STORE_WRITE.INVALID;
    }

    try {
      const written = handle.write(segment.bytes, { at: validated });
      if (written !== segment.bytes.length) {
        // A short write with no exception is how some implementations report a
        // full volume. Treated as full rather than broken, and terminal either
        // way, because a partially written segment is not recoverable data.
        this.refused += 1;
        return STORE_WRITE.FULL;
      }
      handle.flush();
    } catch (error) {
      this.refused += 1;
      return isQuotaError(error) ? STORE_WRITE.FULL : STORE_WRITE.FAILED;
    }

    this.committed[segment.segmentIndex >> 3] |= 1 << (segment.segmentIndex & 7);
    this.bytes += segment.bytes.length;
    this.segments += 1;
    // Recorded the moment the last segment lands, not at verification. A
    // session that dies between the two is exactly the one a resume should be
    // able to pick up without a single further frame.
    if (this.segments === this.plan.segmentCount) this.state = 'complete';
    // Ownership moved to this store at the top of the call and the bytes are
    // now on disk, so the copy in the heap is redundant plaintext.
    segment.bytes.fill(0);
    this.scheduleCheckpoint();
    return STORE_WRITE.OK;
  }

  /**
   * The byte offset this segment is allowed to occupy, or null if none is.
   *
   * Derived from the plan, compared against what the caller passed, and bounded
   * by the declared transport size. Nothing here reads an offset out of a frame.
   */
  private validate(segment: StoredSegment): number | null {
    const { segmentIndex, byteOffset, bytes } = segment;
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= this.plan.segmentCount) {
      return null;
    }
    if (this.isCommitted(segmentIndex)) return null;

    const range = segmentByteRange(this.plan, segmentIndex);
    if (byteOffset !== range.start) return null;

    const expectedLength = Number(range.end - range.start);
    if (bytes.length !== expectedLength) return null;

    const offset = Number(range.start);
    if (!Number.isSafeInteger(offset) || offset < 0) return null;
    if (offset + bytes.length > this.transportSize) return null;
    return offset;
  }

  isCommitted(segmentIndex: number): boolean {
    if (segmentIndex < 0 || segmentIndex >= this.plan.segmentCount) return false;
    return (this.committed[segmentIndex >> 3] & (1 << (segmentIndex & 7))) !== 0;
  }

  /* -------------------------------------------------------------- reading */

  read(offset: number, into: Uint8Array): number {
    const handle = this.handle;
    if (!handle || this.closed) return 0;
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.transportSize) return 0;
    const want = Math.min(into.length, this.transportSize - offset);
    if (want <= 0) return 0;
    try {
      const view = want === into.length ? into : into.subarray(0, want);
      const read = handle.read(view, { at: offset });
      return typeof read === 'number' && read >= 0 ? read : 0;
    } catch {
      return 0;
    }
  }

  /* ------------------------------------------------------------ accounting */

  bytesCommitted(): number {
    return this.bytes;
  }

  segmentsWritten(): number {
    return this.segments;
  }

  /**
   * Zero, and that is the entire point of the phase.
   *
   * The store holds a handle and a segment-count bitmap. No payload byte is
   * resident between writes, so the receiver's working set is the decoders'
   * plus one segment in flight, whatever the file's size.
   */
  residentBytes(): number {
    return 0;
  }

  get refusedWrites(): number {
    return this.refused;
  }

  /** Segments this store started with, from an adopted checkpoint. */
  get segmentsAdopted(): number {
    return this.adoptedSegments;
  }

  /** Bytes this store started with, from an adopted checkpoint. */
  get bytesAdopted(): number {
    return this.adoptedBytes;
  }

  /* ------------------------------------------------------------ checkpoints */

  /**
   * Records progress durably, coalescing rather than queueing.
   *
   * A segment lands every couple of minutes at the Phase 04 cadences, so this
   * is not a hot path - but it is called from a synchronous sink, so it cannot
   * await, and an un-awaited call per segment with no coalescing is an
   * unbounded queue by another name. At most one write is in flight and at most
   * one is pending; a burst collapses to "write the latest state once".
   */
  private scheduleCheckpoint(): void {
    if (this.checkpointInFlight) {
      this.checkpointDirty = true;
      return;
    }
    this.checkpointInFlight = this.persistCheckpoint()
      .catch(() => undefined)
      .then(() => {
        this.checkpointInFlight = null;
        if (!this.checkpointDirty || this.closed) return;
        this.checkpointDirty = false;
        this.scheduleCheckpoint();
      });
  }

  private async persistCheckpoint(): Promise<void> {
    await writeCheckpoint(this.directory, this.snapshot());
  }

  /** The checkpoint as it stands. Exposed so a test reads the same object the disk gets. */
  snapshot(): SessionCheckpoint {
    return {
      ...this.template,
      updatedAt: this.now(),
      bytesCommitted: this.bytes,
      segmentsCommitted: this.segments,
      committed: bytesToBase64(this.committed),
      state: this.state,
    };
  }

  /** Resolves once no checkpoint write is outstanding. For tests and for `seal`. */
  async settled(): Promise<void> {
    while (this.checkpointInFlight) {
      await this.checkpointInFlight;
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  async seal(): Promise<ExportSource> {
    this.state = 'verified';
    this.sealed = true;
    const handle = this.handle;
    if (handle) {
      try {
        handle.flush();
      } catch {
        // Nothing more is being written; a failed flush cannot be acted on.
      }
    }
    await this.settled();
    await this.persistCheckpoint();
    // The exclusive lock goes here and not a line later: the main thread cannot
    // open this file for export while a sync access handle is held on it.
    this.releaseHandle();
    return { kind: 'opfs', path: [...this.path], file: OPFS_DATA_FILE, size: this.transportSize };
  }

  /**
   * The file a compressed transfer decompresses into, opened for writing.
   *
   * Refuses any size but the one reserved when the session opened. The reserved
   * file is the receiver's promise that the device has room; opening a
   * different one would be making a second promise nobody checked.
   */
  async openOriginalSink(size: number): Promise<OriginalSink | null> {
    if (this.originalSize === null || size !== this.originalSize) return null;
    return OpfsOriginalSink.open({ directory: this.directory, path: this.path, size });
  }

  release(): void {
    this.closed = true;
    this.releaseHandle();
  }

  private releaseHandle(): void {
    const handle = this.handle;
    this.handle = undefined;
    if (handle) closeQuietly(handle);
  }

  /**
   * Applies the retention policy - unless the file has already been handed over.
   *
   * `seal` transfers ownership of the file to whoever asked for the export
   * route: the worker has closed its handle and the main thread is about to
   * open the same file for a share sheet or a download. Deleting it from here
   * after that point would be a race against a save the user has already
   * started, so a sealed session is always retained and is collected by the
   * next session's sweep instead. Everything unsealed - cancelled, failed,
   * interrupted - follows the policy it was given.
   */
  async dispose(policy: RetentionPolicy): Promise<void> {
    this.release();
    await this.settled();
    if (policy === 'retain' || this.sealed) {
      // Left on the device deliberately, with metadata describing exactly how
      // far it got. This is the state Phase 07's resume reads.
      await this.persistCheckpoint();
      return;
    }
    await removeSessionDirectory(this.root, this.directoryName);
  }
}

function closeQuietly(handle: SyncAccessHandleLike): void {
  try {
    handle.close();
  } catch {
    // Already closed, or closed by a context teardown. Nothing to do.
  }
}
