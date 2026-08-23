/**
 * The file a compressed transfer is decompressed into.
 *
 * `OpfsSegmentStore` owns `data.part`, which for a compressed transfer holds
 * the GZIP container exactly as it came off the screen. This owns
 * `original.part`, which holds the file itself, and the two exist at once
 * because a container cannot be expanded into the buffer it is being read from.
 *
 * It is deliberately much less than a `SegmentStore`. There is no bitmap, no
 * checkpoint and no resume: decompression runs once, at the end of a session
 * that has already received everything, and a session interrupted during it
 * still has its container and simply runs it again. What it does keep is
 * `read`, because verification hashes the bytes the device holds - handing the
 * digest what the writer was *given* would make the write itself unverified.
 *
 * The handle is opened by `OpfsSegmentStore` at session start and closed again
 * immediately: pre-sizing is how the receiver turns "is there room for both
 * files?" from an estimate into an attempt, and holding an exclusive lock for
 * the hours in between would buy nothing.
 */

import {
  OPFS_ORIGINAL_FILE,
  type DirectoryHandleLike,
  type RetentionPolicy,
  type SyncAccessHandleLike,
} from './opfs';
import { STORE_WRITE, type ExportSource, type OriginalSink, type StoreWriteOutcome } from './segment-store';

export interface OpfsOriginalSinkOptions {
  directory: DirectoryHandleLike;
  /** Path of the session directory from the OPFS root, for the export handoff. */
  path: readonly string[];
  size: number;
}

export class OpfsOriginalSink implements OriginalSink {
  readonly kind = 'opfs' as const;

  private constructor(
    private handle: SyncAccessHandleLike | undefined,
    private readonly path: readonly string[],
    private readonly size: number,
  ) {}

  /**
   * Opens the pre-sized file for writing.
   *
   * Returns null rather than throwing, and every reason is the same reason to
   * the caller: this device will not give us the file, so the session ends.
   * The distinctions that matter - no room, no OPFS - were made when the file
   * was created at session start.
   */
  static async open(options: OpfsOriginalSinkOptions): Promise<OpfsOriginalSink | null> {
    try {
      const file = await options.directory.getFileHandle(OPFS_ORIGINAL_FILE, { create: true });
      if (typeof file.createSyncAccessHandle !== 'function') return null;
      const handle = await file.createSyncAccessHandle();
      try {
        // Re-asserted rather than assumed. The file was pre-sized at session
        // start; a sweep, a quota reclaim, or a browser restart in between
        // could have left it shorter, and writing into a short file would put
        // zeros where the tail of the file belongs.
        if (handle.getSize() !== options.size) handle.truncate(options.size);
      } catch {
        closeQuietly(handle);
        return null;
      }
      return new OpfsOriginalSink(handle, [...options.path], options.size);
    } catch {
      return null;
    }
  }

  /**
   * Creates and pre-sizes the file without holding it open.
   *
   * Called at session start, which is the whole point: a device that cannot
   * hold the original alongside the container says so before anyone scans.
   * Returns false on a quota refusal or any other failure to reserve.
   */
  static async reserve(directory: DirectoryHandleLike, size: number): Promise<boolean> {
    let handle: SyncAccessHandleLike;
    try {
      const file = await directory.getFileHandle(OPFS_ORIGINAL_FILE, { create: true });
      if (typeof file.createSyncAccessHandle !== 'function') return false;
      handle = await file.createSyncAccessHandle();
    } catch {
      return false;
    }
    try {
      handle.truncate(size);
      return true;
    } catch {
      return false;
    } finally {
      closeQuietly(handle);
    }
  }

  write(offset: number, bytes: Uint8Array): StoreWriteOutcome {
    const handle = this.handle;
    if (!handle) return STORE_WRITE.FAILED;
    if (!Number.isInteger(offset) || offset < 0 || offset + bytes.length > this.size) {
      return STORE_WRITE.INVALID;
    }
    try {
      const written = handle.write(bytes, { at: offset });
      if (written !== bytes.length) {
        // A short write on a pre-sized file is the device refusing room, not a
        // partial success to retry: the space was reserved and is now gone.
        return STORE_WRITE.FULL;
      }
      return STORE_WRITE.OK;
    } catch (error) {
      return isQuotaError(error) ? STORE_WRITE.FULL : STORE_WRITE.FAILED;
    }
  }

  read(offset: number, into: Uint8Array): number {
    const handle = this.handle;
    if (!handle) return 0;
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.size) return 0;
    const want = Math.min(into.length, this.size - offset);
    if (want <= 0) return 0;
    try {
      const view = want === into.length ? into : into.subarray(0, want);
      const read = handle.read(view, { at: offset });
      return typeof read === 'number' && read >= 0 ? read : 0;
    } catch {
      return 0;
    }
  }

  bytesWritten(): number {
    return this.size;
  }

  /** Zero: nothing but a handle is held between writes. */
  residentBytes(): number {
    return 0;
  }

  async seal(): Promise<ExportSource> {
    const handle = this.handle;
    if (handle) {
      try {
        handle.flush();
      } catch {
        // Nothing more is being written; a failed flush cannot be acted on.
      }
    }
    // The lock goes before the path does. The main thread cannot open this
    // file for a share sheet while a synchronous access handle is held on it.
    this.releaseHandle();
    return { kind: 'opfs', path: [...this.path], file: OPFS_ORIGINAL_FILE, size: this.size };
  }

  release(): void {
    this.releaseHandle();
  }

  private releaseHandle(): void {
    const handle = this.handle;
    this.handle = undefined;
    if (handle) closeQuietly(handle);
  }

  /**
   * Retention is the session directory's business, not this file's.
   *
   * `OpfsSegmentStore.dispose` removes or keeps the whole directory, and this
   * file lives inside it. Doing anything else here would mean two owners for
   * one deletion, which is how a share sheet ends up reading a file that has
   * just been removed underneath it.
   */
  async dispose(_policy: RetentionPolicy): Promise<void> {
    this.release();
  }
}

function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === 'QuotaExceededError' || name === 'NotAllowedError';
}

function closeQuietly(handle: SyncAccessHandleLike): void {
  try {
    handle.close();
  } catch {
    // Already closed, or closed by a context teardown. Nothing to do.
  }
}
