/**
 * The receiver's working storage, described as a seam rather than as globals.
 *
 * Everything below deals with the Origin Private File System: a per-origin
 * private directory tree that is not the user's Files app, is never enumerated
 * by anything outside this page, and is where a transfer's bytes live between
 * the moment a segment is recovered and the moment the user saves the file.
 *
 * ## Why the API is retyped here
 *
 * Three reasons, and none of them is style.
 *
 * - **The DOM lib's types are not what Safari ships.** `FileSystemSyncAccessHandle`
 *   went through a period where `read` and `write` returned promises rather
 *   than byte counts. A build that trusts the ambient type compiles perfectly
 *   and then writes `[object Promise]` worth of nothing to disk. The structural
 *   types here describe what this code actually calls, and
 *   `probeSyncAccessHandle` checks the shape at runtime before a single
 *   payload byte is written.
 * - **Tests need a substitute.** These run under Node, where there is no OPFS
 *   at all. Every entry point takes its root and its clock as arguments, so the
 *   whole storage layer is exercised against a fake that implements the same
 *   five methods.
 * - **Capability, not user agent.** iOS version sniffing is how a receiver ends
 *   up broken on a device nobody tested. What matters is whether
 *   `createSyncAccessHandle` exists and behaves, and that is a question with a
 *   direct answer.
 *
 * ## What this module will not claim
 *
 * That there is room. `navigator.storage.estimate()` reports a *quota* the
 * browser is willing to grant and a *usage* against it; neither is a promise
 * about free space on the device, and on iOS the quota moves with overall disk
 * pressure. So the preflight here computes a required working budget, compares
 * it against what the browser reports, and labels the answer with the
 * confidence it actually has. A transfer refused on this basis is refused
 * before the optical transfer starts; a transfer allowed on this basis can
 * still run out, which is why the write path treats a quota error as a normal
 * outcome rather than as a bug.
 */

import { RECEIVER_POLICY } from '../../src/core/receiver-policy';

/* ----------------------------------------------------------- platform types */

/** The slice of `FileSystemSyncAccessHandle` the receiver uses. */
export interface SyncAccessHandleLike {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** The slice of `FileSystemFileHandle` the receiver uses. */
export interface FileHandleLike {
  createSyncAccessHandle?(): Promise<SyncAccessHandleLike>;
  createWritable?(options?: { keepExistingData?: boolean }): Promise<FileWritableLike>;
  getFile(): Promise<Blob>;
}

export interface FileWritableLike {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}

/** The slice of `FileSystemDirectoryHandle` the receiver uses. */
export interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys?(): AsyncIterableIterator<string>;
}

export interface StorageManagerLike {
  getDirectory?(): Promise<DirectoryHandleLike>;
  estimate?(): Promise<{ quota?: number; usage?: number }>;
}

/** What this module needs from its environment. Injected so tests can supply it. */
export interface StorageEnvironment {
  storage?: StorageManagerLike;
  /** Present only in a worker. Sync access handles exist nowhere else. */
  supportsSyncAccess?: boolean;
  now?: () => number;
}

/* -------------------------------------------------------------- session paths */

export const OPFS_ROOT_DIR = 'deqr';
export const OPFS_SESSIONS_DIR = 'sessions';
export const OPFS_DATA_FILE = 'data.part';
/**
 * The decompressed file, for a compressed transfer only.
 *
 * `data.part` holds whatever the segments carried. When that is a GZIP
 * container the file the user asked for does not exist until the container is
 * read out, and it has to be read out into somewhere that is not itself - so a
 * compressed session holds two files and an uncompressed one still holds a
 * single file. It is created and pre-sized when the session opens, not when
 * decompression starts, so a device that cannot hold both refuses in the second
 * after Receive rather than after an hour of scanning.
 */
export const OPFS_ORIGINAL_FILE = 'original.part';
export const OPFS_CHECKPOINT_FILE = 'checkpoint.json';

/**
 * The directory name for one transfer.
 *
 * Derived from the manifest's own identifiers rather than from a random id, so
 * a transfer interrupted and restarted lands on the same directory and Phase
 * 07 can find its partial data without a lookup table. Both fields are u32 and
 * are rendered as fixed-width hex, which is filename-safe by construction -
 * nothing from the sender's *filename* ever reaches a path component.
 */
export function sessionDirectoryName(sessionId: number, fileId: number): string {
  const left = (sessionId >>> 0).toString(16).padStart(8, '0');
  const right = (fileId >>> 0).toString(16).padStart(8, '0');
  return `${left}-${right}`;
}

/** Path of a session directory from the OPFS root, for the export handoff. */
export function sessionPath(sessionId: number, fileId: number): string[] {
  return [OPFS_ROOT_DIR, OPFS_SESSIONS_DIR, sessionDirectoryName(sessionId, fileId)];
}

/**
 * Rejects anything that is not a path this receiver itself produced.
 *
 * The path crosses the worker boundary on its way to the export handler, and a
 * path is an instruction to open a file. Rather than sanitize, this checks the
 * whole shape: the two fixed roots and one session directory whose name is the
 * exact hex form above. Nothing else is openable.
 */
export function isReceiverSessionPath(path: readonly string[]): boolean {
  return (
    path.length === 3
    && path[0] === OPFS_ROOT_DIR
    && path[1] === OPFS_SESSIONS_DIR
    && /^[0-9a-f]{8}-[0-9a-f]{8}$/.test(path[2])
  );
}

/**
 * The payload files a verified session may be exported from.
 *
 * Two, not one, and the distinction is the whole reason this is a named set
 * rather than an equality test. An uncompressed transfer exports `data.part`,
 * which is the file. A compressed one exports `original.part`, because
 * `data.part` holds the GZIP container and the container is not what anybody
 * asked for. `checkpoint.json` is deliberately absent: it is metadata this
 * receiver writes about a transfer and is never a thing to hand a user.
 *
 * Phase 10 found the allowlist naming only `data.part` while the receiver
 * wrote both, so a compressed transfer received to OPFS produced a `verified`
 * message the main thread's own guard threw away — the transfer completed,
 * verified, and then vanished. A too-narrow allowlist is a correctness defect
 * exactly as a too-wide one is a security defect; this is the closed set.
 */
export const OPFS_EXPORTABLE_FILES: readonly string[] = [OPFS_DATA_FILE, OPFS_ORIGINAL_FILE];

/** Whether a name is one of the two payload files a session may be exported from. */
export function isReceiverSessionFile(name: unknown): name is string {
  return name === OPFS_DATA_FILE || name === OPFS_ORIGINAL_FILE;
}

/* ------------------------------------------------------------- capabilities */

export interface StorageSupport {
  /** `navigator.storage.getDirectory` exists. */
  opfs: boolean;
  /** A sync access handle can be requested, which is worker-only by spec. */
  syncAccess: boolean;
  /** `navigator.storage.estimate` exists, so a preflight can say a real number. */
  estimate: boolean;
}

/**
 * What this context can actually do.
 *
 * `syncAccess` is reported optimistically - the API's *presence* is all that
 * can be known without opening a file - and is confirmed for real by
 * `probeSyncAccessHandle` once a handle exists. Both checks are needed: this
 * one decides whether to try, that one decides whether to trust it.
 */
export function detectStorageSupport(environment: StorageEnvironment = defaultEnvironment()): StorageSupport {
  const storage = environment.storage;
  const opfs = typeof storage?.getDirectory === 'function';
  return {
    opfs,
    syncAccess: opfs && environment.supportsSyncAccess === true,
    estimate: typeof storage?.estimate === 'function',
  };
}

/** The ambient environment, read once at the call site rather than at import time. */
export function defaultEnvironment(): StorageEnvironment {
  const globalScope = globalThis as unknown as {
    navigator?: { storage?: StorageManagerLike };
    FileSystemFileHandle?: { prototype?: Record<string, unknown> };
    WorkerGlobalScope?: unknown;
  };
  const prototype = globalScope.FileSystemFileHandle?.prototype;
  return {
    storage: globalScope.navigator?.storage,
    // Sync access handles are specified as worker-only. Checking for the method
    // on the prototype rather than for a worker-shaped global keeps this true
    // if that ever widens, and false on a main thread that merely has OPFS.
    supportsSyncAccess:
      typeof globalScope.WorkerGlobalScope !== 'undefined'
      && typeof prototype?.createSyncAccessHandle === 'function',
  };
}

/**
 * Confirms a handle is the synchronous one this receiver is written against.
 *
 * Safari shipped an early revision whose `write` returned a promise. Such a
 * handle satisfies every type check and silently writes nothing, which would
 * surface as a hash mismatch after an hour of scanning. One probe byte,
 * written and then truncated away, settles it before any payload is committed.
 */
export function probeSyncAccessHandle(handle: SyncAccessHandleLike): boolean {
  try {
    const probe = new Uint8Array([0x44]);
    const written = handle.write(probe, { at: 0 });
    if (typeof written !== 'number' || written !== 1) return false;
    const readBack = new Uint8Array(1);
    const read = handle.read(readBack, { at: 0 });
    if (typeof read !== 'number' || read !== 1 || readBack[0] !== 0x44) return false;
    handle.truncate(0);
    return handle.getSize() === 0;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- preflight */

/** Fraction of the transfer size kept free on top of it. */
export const DEFAULT_STORAGE_MARGIN_RATIO = 0.15;
/** Floor for the margin, so a small transfer still leaves room for metadata. */
export const MIN_STORAGE_MARGIN_BYTES = 4 * 1024 * 1024;

export type StorageConfidence =
  /** The browser reported a quota and a usage, and the sum fits. */
  | 'reported'
  /** No estimate API. The transfer proceeds and may still run out. */
  | 'unknown';

export interface StoragePreflight {
  ok: boolean;
  /** Transport bytes plus the safety margin. */
  requiredBytes: number;
  marginBytes: number;
  /** As reported by the browser. Not a measurement of the device's free space. */
  quotaBytes?: number;
  usageBytes?: number;
  availableBytes?: number;
  confidence: StorageConfidence;
  /** Set when `ok` is false. An enumerated code, never free text. */
  reason?: 'INSUFFICIENT_STORAGE';
}

/**
 * Decides whether a transfer of this size should be started at all.
 *
 * Deliberately conservative in one direction only: a missing estimate API is
 * not treated as a refusal, because refusing every transfer on a browser that
 * cannot answer the question would be worse than starting one that might fail
 * at the far end - and the write path handles that outcome cleanly. What it
 * will not do is call a browser-granted quota "free space"; `confidence` says
 * which of the two the caller is looking at.
 */
export async function preflightStorage(
  requiredTransportBytes: number,
  environment: StorageEnvironment = defaultEnvironment(),
  marginRatio: number = DEFAULT_STORAGE_MARGIN_RATIO,
): Promise<StoragePreflight> {
  const ratio = Number.isFinite(marginRatio) && marginRatio >= 0 ? marginRatio : DEFAULT_STORAGE_MARGIN_RATIO;
  const marginBytes = Math.max(MIN_STORAGE_MARGIN_BYTES, Math.ceil(requiredTransportBytes * ratio));
  const requiredBytes = requiredTransportBytes + marginBytes;

  const estimate = environment.storage?.estimate;
  if (typeof estimate !== 'function') {
    return { ok: true, requiredBytes, marginBytes, confidence: 'unknown' };
  }

  let quotaBytes: number | undefined;
  let usageBytes: number | undefined;
  try {
    const reported = await estimate.call(environment.storage);
    quotaBytes = typeof reported?.quota === 'number' ? reported.quota : undefined;
    usageBytes = typeof reported?.usage === 'number' ? reported.usage : undefined;
  } catch {
    // An estimate that throws is an estimate that does not exist.
    return { ok: true, requiredBytes, marginBytes, confidence: 'unknown' };
  }

  if (quotaBytes === undefined) {
    return { ok: true, requiredBytes, marginBytes, usageBytes, confidence: 'unknown' };
  }

  const availableBytes = Math.max(0, quotaBytes - (usageBytes ?? 0));
  const ok = availableBytes >= requiredBytes;
  return {
    ok,
    requiredBytes,
    marginBytes,
    quotaBytes,
    usageBytes,
    availableBytes,
    confidence: 'reported',
    reason: ok ? undefined : 'INSUFFICIENT_STORAGE',
  };
}

/* ------------------------------------------------------------- directories */

/** Resolves `/deqr/sessions`, creating it when asked. */
export async function sessionsDirectory(
  root: DirectoryHandleLike,
  create = false,
): Promise<DirectoryHandleLike | null> {
  try {
    const deqr = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create });
    return await deqr.getDirectoryHandle(OPFS_SESSIONS_DIR, { create });
  } catch {
    return null;
  }
}

/** Resolves one session directory under `/deqr/sessions`. */
export async function openSessionDirectory(
  root: DirectoryHandleLike,
  name: string,
  create = false,
): Promise<DirectoryHandleLike | null> {
  const sessions = await sessionsDirectory(root, create);
  if (!sessions) return null;
  try {
    return await sessions.getDirectoryHandle(name, { create });
  } catch {
    return null;
  }
}

/** Deletes one session directory and everything in it. Never throws. */
export async function removeSessionDirectory(root: DirectoryHandleLike, name: string): Promise<boolean> {
  const sessions = await sessionsDirectory(root, false);
  if (!sessions) return false;
  try {
    await sessions.removeEntry(name, { recursive: true });
    return true;
  } catch {
    // Already gone, or held by a handle that has not closed yet. Either way the
    // caller cannot do anything about it and must not fail a transfer over it.
    return false;
  }
}

export async function listSessionNames(root: DirectoryHandleLike): Promise<string[]> {
  const sessions = await sessionsDirectory(root, false);
  if (!sessions || typeof sessions.keys !== 'function') return [];
  const names: string[] = [];
  try {
    for await (const name of sessions.keys()) {
      if (/^[0-9a-f]{8}-[0-9a-f]{8}$/.test(name)) names.push(name);
    }
  } catch {
    return names;
  }
  return names;
}

/* ------------------------------------------------------------- checkpoints */

/** Bumped when a field changes meaning. Phase 07 refuses a schema it cannot read. */
export const CHECKPOINT_SCHEMA = 1;

export type CheckpointState = 'receiving' | 'complete' | 'verified';

/**
 * What a session leaves behind, and the whole of what a resume gets to read.
 *
 * Sizes are decimal strings because `transportSize` is a u64 and JSON numbers
 * are doubles; a 9 PiB manifest is not expected but a size that silently loses
 * its low bits on the way to disk is the kind of defect that only shows up as a
 * corrupted file. `committed` is a base64 bitmap rather than a list of indices
 * so its size stays proportional to the segment count and not to progress.
 */
export interface SessionCheckpoint {
  schema: number;
  protocol: 2;
  sessionId: number;
  fileId: number;
  filename: string;
  mimeType: string;
  originalSize: string;
  transportSize: string;
  segmentSizeBytes: number;
  symbolSizeBytes: number;
  segmentCount: number;
  /** Lowercase hex of the manifest's declared digest over the original file. */
  sha256: string;
  dataFile: string;
  createdAt: number;
  updatedAt: number;
  bytesCommitted: number;
  segmentsCommitted: number;
  /** Base64 bitmap, one bit per segment, least-significant bit first. */
  committed: string;
  state: CheckpointState;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without a platform dependency: `btoa` is absent from a worker in some runtimes. */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    output += BASE64_ALPHABET[a >> 2];
    output += BASE64_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[c & 0x3f] : '=';
  }
  return output;
}

export function base64ToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  const clean = text.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of clean) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (accumulator >> bits) & 0xff;
      written += 1;
    }
  }
  return bytes.subarray(0, written);
}

/**
 * Writes checkpoint metadata.
 *
 * Uses the async writable rather than a second sync access handle: a sync
 * handle takes an exclusive lock on its file, and holding two of them across a
 * session is a deadlock waiting for a browser that serialises them. The
 * checkpoint is a few hundred bytes written at segment boundaries, so the async
 * path costs nothing that matters here.
 */
export async function writeCheckpoint(
  directory: DirectoryHandleLike,
  checkpoint: SessionCheckpoint,
): Promise<boolean> {
  try {
    const handle = await directory.getFileHandle(OPFS_CHECKPOINT_FILE, { create: true });
    if (typeof handle.createWritable !== 'function') return false;
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(checkpoint));
    await writable.close();
    return true;
  } catch {
    // A checkpoint that cannot be written costs a resume, not a transfer. The
    // payload handle is entirely separate and is still good.
    return false;
  }
}

/**
 * What is at a session's checkpoint path, with "nothing" kept apart from "broken".
 *
 * The distinction matters exactly once, and it matters a lot: a directory with
 * no checkpoint is a fresh session, while a directory with an unreadable one
 * holds bytes nothing can account for. Only the second is debris that has to be
 * cleared before a new transfer pre-sizes its file there, so collapsing the two
 * into `null` would leave a stale payload under an empty bitmap.
 */
export interface CheckpointRead {
  /** A checkpoint file exists, whether or not it could be understood. */
  present: boolean;
  /** Null when absent, unparseable, or failing validation. */
  checkpoint: SessionCheckpoint | null;
}

/**
 * Bytes a checkpoint file may occupy before it is refused unread.
 *
 * The largest legitimate checkpoint is the base64 completion bitmap for the
 * largest segment count this receiver admits, plus four kilobytes for every
 * other field. Anything above that was not written by this code.
 *
 * The bound exists because the checkpoint is *acted on*: it tells a session
 * that bytes already on the device are already received. Origin-private
 * storage is only writable by this origin, which is a statement about a
 * browser rather than a property of this code — and a truncated write, a
 * corrupted volume or a devtools edit all produce the same shape. Reading the
 * file's length before its text is what makes any of those cost a rejection
 * instead of an allocation proportional to whatever is on disk.
 */
export const MAX_CHECKPOINT_BYTES = RECEIVER_POLICY.maxCheckpointBytes;

export async function readCheckpointEntry(directory: DirectoryHandleLike): Promise<CheckpointRead> {
  let text: string;
  try {
    const handle = await directory.getFileHandle(OPFS_CHECKPOINT_FILE, { create: false });
    const file = await handle.getFile();
    if (typeof file.size === 'number' && file.size > MAX_CHECKPOINT_BYTES) {
      // Present, and larger than anything this receiver writes. Reported as
      // damaged rather than absent, because that is what decides whether the
      // caller clears the directory before pre-sizing a new file in it.
      return { present: true, checkpoint: null };
    }
    text = await file.text();
  } catch {
    // No entry, or one that cannot be opened at all. Either way there is
    // nothing here to have been damaged.
    return { present: false, checkpoint: null };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return { present: true, checkpoint: isCheckpoint(parsed) ? parsed : null };
  } catch {
    return { present: true, checkpoint: null };
  }
}

/** Reads checkpoint metadata back, returning null for anything it cannot trust. */
export async function readCheckpoint(directory: DirectoryHandleLike): Promise<SessionCheckpoint | null> {
  return (await readCheckpointEntry(directory)).checkpoint;
}

/**
 * Whether a parsed object is a checkpoint this build can act on.
 *
 * Stricter than it needed to be for Phase 06, where a checkpoint was only ever
 * written and read back by the same code in the same session. Phase 07 *acts*
 * on one: it seeds a live session's progress from these fields, so a file that
 * was truncated mid-write, hand-edited, or left behind by a different build has
 * to be rejected rather than partially believed. Every field the resume path
 * reads is checked here, including the ones Phase 06 only ever wrote.
 */
function isCheckpoint(value: unknown): value is SessionCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === CHECKPOINT_SCHEMA
    && record.protocol === 2
    && isU32(record.sessionId)
    && isU32(record.fileId)
    && typeof record.filename === 'string'
    && typeof record.mimeType === 'string'
    && isDecimalDigits(record.originalSize)
    && isDecimalDigits(record.transportSize)
    && isPositiveInteger(record.segmentSizeBytes)
    && isPositiveInteger(record.symbolSizeBytes)
    && isPositiveInteger(record.segmentCount)
    // Bounded against the receiver's own segment budget, not merely against
    // "is a positive integer". A checkpoint declaring four billion segments
    // would otherwise be handed to a bitmap allocation before anything else
    // looked at it.
    && record.segmentCount <= RECEIVER_POLICY.maxSegmentCount
    && typeof record.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(record.sha256)
    && record.dataFile === OPFS_DATA_FILE
    && isNonNegativeInteger(record.createdAt)
    && isNonNegativeInteger(record.updatedAt)
    && isNonNegativeInteger(record.bytesCommitted)
    && isNonNegativeInteger(record.segmentsCommitted)
    && typeof record.committed === 'string'
    // Length before decode, and the order is the point: `base64ToBytes`
    // allocates three bytes for every four characters it is given, so checking
    // afterwards would be checking after the allocation it exists to prevent.
    && record.committed.length <= RECEIVER_POLICY.maxCommittedBase64Chars
    && base64ToBytes(record.committed) !== null
    && (record.state === 'receiving' || record.state === 'complete' || record.state === 'verified')
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isU32(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 0xffff_ffff;
}

/** A u64 rendered as decimal, which is how sizes survive a JSON round trip. */
function isDecimalDigits(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
}

/* ------------------------------------------------------------------ resume */

/**
 * Why a checkpoint on disk cannot drive the manifest now on screen.
 *
 * Enumerated rather than collapsed into "no", because the resume path has to
 * decide what to do with the directory afterwards and the answers differ: a
 * checkpoint for a *different* transfer is debris to clear before this one
 * pre-sizes its file, while an absent one is simply the ordinary first run.
 */
export type CheckpointRejection =
  /** Nothing on disk for this session. The ordinary first-run answer. */
  | 'CHECKPOINT_ABSENT'
  /** Present and unreadable: truncated, malformed, or from a schema this build does not know. */
  | 'CHECKPOINT_UNREADABLE'
  /** Readable, and describes a different session or file. */
  | 'CHECKPOINT_SESSION_MISMATCH'
  /** Same session identity, different bytes. The digest disagrees. */
  | 'CHECKPOINT_FILE_MISMATCH'
  /** Same file, different segmentation. A transport profile changed between runs. */
  | 'CHECKPOINT_PLAN_MISMATCH'
  /** Internally inconsistent: the bitmap and the counters do not agree. */
  | 'CHECKPOINT_INCONSISTENT';

/** What a resumable checkpoint yields to the session adopting it. */
export interface CheckpointAdoption {
  checkpoint: SessionCheckpoint;
  /** One bit per segment, exactly `ceil(segmentCount / 8)` bytes. */
  committedBits: Uint8Array;
  segmentsCommitted: number;
  bytesCommitted: number;
}

export type CheckpointMatch =
  | { ok: true; value: CheckpointAdoption }
  | { ok: false; code: CheckpointRejection };

/** Set bits per byte value, so counting a bitmap is one lookup per byte. */
const POPCOUNT = new Uint8Array(256);
for (let value = 0; value < 256; value += 1) POPCOUNT[value] = (value & 1) + POPCOUNT[value >> 1];

export interface CheckpointMatchInput {
  checkpoint: SessionCheckpoint | null;
  /**
   * Whether a checkpoint file was there at all.
   *
   * Read only when `checkpoint` is null, where it separates the fresh-session
   * case from the damaged one - and that separation is what decides whether the
   * caller clears the directory. Omitting it means "there was nothing there",
   * which is the safe reading: it leaves a directory alone rather than deleting
   * one on a caller's silence.
   */
  present?: boolean;
  sessionId: number;
  fileId: number;
  /** Lowercase hex of the manifest's declared digest. */
  sha256Hex: string;
  transportSize: bigint;
  segmentSizeBytes: number;
  symbolSizeBytes: number;
  segmentCount: number;
  /** Transport bytes the committed bitmap accounts for, derived from the plan. */
  expectedBytes: (committedBits: Uint8Array) => number;
}

/**
 * Decides whether a checkpoint describes the transfer a manifest just declared.
 *
 * This is the gate the whole resume path hangs on, and it is written to refuse.
 * A checkpoint tells the receiver that bytes already on the device are *already
 * received*: believing a wrong one does not produce an error, it produces a
 * file with someone else's data in the first half and a hash failure hours
 * later. So every field that could make the two disagree is compared -
 * identity, digest, and the whole segmentation - and the bitmap is checked
 * against its own counters, because a checkpoint whose bitmap says 400 segments
 * while its counter says 900 was not written by this code.
 *
 * `expectedBytes` is supplied by the caller, which derives it from the plan.
 * It catches what a bitmap check alone cannot: a bitmap and a segment count
 * that agree with each other and with nothing that was ever written.
 */
export function matchCheckpoint(input: CheckpointMatchInput): CheckpointMatch {
  const { checkpoint } = input;
  if (!checkpoint) {
    const present = input.present ?? false;
    return { ok: false, code: present ? 'CHECKPOINT_UNREADABLE' : 'CHECKPOINT_ABSENT' };
  }

  if (checkpoint.sessionId !== input.sessionId || checkpoint.fileId !== input.fileId) {
    return { ok: false, code: 'CHECKPOINT_SESSION_MISMATCH' };
  }
  if (checkpoint.sha256 !== input.sha256Hex) {
    return { ok: false, code: 'CHECKPOINT_FILE_MISMATCH' };
  }
  if (
    checkpoint.transportSize !== input.transportSize.toString(10)
    || checkpoint.segmentSizeBytes !== input.segmentSizeBytes
    || checkpoint.symbolSizeBytes !== input.symbolSizeBytes
    || checkpoint.segmentCount !== input.segmentCount
  ) {
    return { ok: false, code: 'CHECKPOINT_PLAN_MISMATCH' };
  }

  // Re-checked here as well as in `isCheckpoint`, because this function is
  // callable with any object and the decode below allocates from the string's
  // length. Two cheap checks are worth one unbounded allocation.
  if (checkpoint.committed.length > RECEIVER_POLICY.maxCommittedBase64Chars) {
    return { ok: false, code: 'CHECKPOINT_UNREADABLE' };
  }
  const bits = base64ToBytes(checkpoint.committed);
  if (bits === null) return { ok: false, code: 'CHECKPOINT_UNREADABLE' };

  const wanted = (input.segmentCount + 7) >> 3;
  const committedBits = new Uint8Array(wanted);
  // An empty bitmap is what the first checkpoint of a session carries, written
  // before any segment landed. It is consistent, and it adopts nothing.
  if (bits.length !== 0) {
    if (bits.length !== wanted) return { ok: false, code: 'CHECKPOINT_INCONSISTENT' };
    committedBits.set(bits);
  }

  const spare = input.segmentCount & 7;
  if (spare !== 0 && (committedBits[wanted - 1] & ~((1 << spare) - 1)) !== 0) {
    // Bits past the last segment index. Nothing this receiver writes sets them.
    return { ok: false, code: 'CHECKPOINT_INCONSISTENT' };
  }

  let segmentsCommitted = 0;
  for (const byte of committedBits) segmentsCommitted += POPCOUNT[byte];
  if (segmentsCommitted !== checkpoint.segmentsCommitted) {
    return { ok: false, code: 'CHECKPOINT_INCONSISTENT' };
  }

  const bytesCommitted = input.expectedBytes(committedBits);
  if (bytesCommitted !== checkpoint.bytesCommitted) {
    return { ok: false, code: 'CHECKPOINT_INCONSISTENT' };
  }

  return { ok: true, value: { checkpoint, committedBits, segmentsCommitted, bytesCommitted } };
}

/* -------------------------------------------------------------- retention */

/**
 * What happens to a session's working data when the session ends.
 *
 * `discard` is the default and the privacy-preserving one: the user stopped, so
 * the partial file goes. `retain` is what an explicit resume needs, and it is
 * opt-in precisely because leaving a half-received file on a device that the
 * user believes they cancelled would be a surprise, not a feature.
 */
export type RetentionPolicy = 'discard' | 'retain';

/** How long an abandoned session's bytes may sit on the device. */
export const DEFAULT_SESSION_RETENTION_MS = RECEIVER_POLICY.sessionRetentionMs;
/** How many abandoned sessions may exist at once, newest kept. */
export const DEFAULT_MAX_RETAINED_SESSIONS = RECEIVER_POLICY.maxRetainedSessions;

export interface SweepOptions {
  retentionMs?: number;
  maxRetained?: number;
  /** Never swept - the session about to start writing to it. */
  keep?: string;
  now?: () => number;
}

/**
 * Deletes abandoned session data on a deterministic policy.
 *
 * A crashed or backgrounded receiver leaves a partial file behind on purpose,
 * because Phase 07's resume needs it. "On purpose" has to have an end, though:
 * without one, a device accumulates the debris of every transfer that was ever
 * interrupted, in a directory the user cannot see and cannot clear from the
 * Files app. So a sweep runs when a session opens, and it is bounded twice -
 * by age and by count - so neither a single ancient session nor a run of recent
 * ones can grow without limit.
 *
 * Returns the names it removed, which is what makes the policy testable rather
 * than merely stated.
 */
export async function sweepStaleSessions(
  root: DirectoryHandleLike,
  options: SweepOptions = {},
): Promise<string[]> {
  const now = options.now ?? (() => Date.now());
  const retentionMs = options.retentionMs ?? DEFAULT_SESSION_RETENTION_MS;
  const maxRetained = options.maxRetained ?? DEFAULT_MAX_RETAINED_SESSIONS;
  const names = await listSessionNames(root);
  if (names.length === 0) return [];

  const at = now();
  const survivors: { name: string; updatedAt: number }[] = [];
  const removed: string[] = [];

  for (const name of names) {
    if (name === options.keep) continue;
    const directory = await openSessionDirectory(root, name, false);
    const checkpoint = directory ? await readCheckpoint(directory) : null;
    // A session directory with no readable checkpoint cannot be resumed by
    // anything, so it is debris by definition and goes first.
    if (!checkpoint) {
      if (await removeSessionDirectory(root, name)) removed.push(name);
      continue;
    }
    if (at - checkpoint.updatedAt > retentionMs) {
      if (await removeSessionDirectory(root, name)) removed.push(name);
      continue;
    }
    survivors.push({ name, updatedAt: checkpoint.updatedAt });
  }

  survivors.sort((left, right) => right.updatedAt - left.updatedAt);
  for (const stale of survivors.slice(maxRetained)) {
    if (await removeSessionDirectory(root, stale.name)) removed.push(stale.name);
  }
  return removed;
}
