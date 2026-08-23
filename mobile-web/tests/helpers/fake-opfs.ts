/**
 * An OPFS the tests can hold to a standard, including the parts that go wrong.
 *
 * The receiver's storage layer runs under Node, where there is no Origin
 * Private File System at all, so a substitute is not optional. What matters is
 * *which* substitute: a fake that only ever succeeds would let every one of the
 * phase's real failure modes through untested.
 *
 * So this one models the four things that actually break on a device:
 *
 * - **A quota.** Writes and truncations past it throw `QuotaExceededError`,
 *   by that name, because that name is what the store branches on.
 * - **An exclusive lock.** One synchronous access handle per file, and a second
 *   request throws, exactly as the spec requires. It is how a store that fails
 *   to close its handle before an export is caught.
 * - **A writer that dies.** `breakAfter` makes the handle throw mid-transfer.
 * - **A browser that lies.** `asyncWriteApi` reproduces the early Safari
 *   revision whose `write` returned a promise. That handle passes every type
 *   check and writes nothing, which is precisely why the store probes for it.
 *
 * ## Two backings
 *
 * `BufferBacking` stores real bytes and is what almost every test uses.
 * `PatternBacking` stores none: it records which byte ranges were written,
 * checks their contents against a generator as they arrive, and regenerates
 * them on read. That is what makes a 1 GiB test possible in a process that must
 * not allocate 1 GiB - and it is not a shortcut, because a segment written to
 * the wrong offset leaves a gap that reads back as zeros and changes the digest.
 */

import type {
  DirectoryHandleLike,
  FileHandleLike,
  FileWritableLike,
  StorageManagerLike,
  SyncAccessHandleLike,
} from '../../src/opfs';

/** A DOMException by name, which is all the store inspects. */
export function quotaError(): Error {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

function stateError(message: string): Error {
  const error = new Error(message);
  error.name = 'InvalidStateError';
  return error;
}

function lockError(): Error {
  const error = new Error('The file is locked by another access handle.');
  error.name = 'NoModificationAllowedError';
  return error;
}

/* ------------------------------------------------------------------ backings */

export interface Backing {
  size: number;
  read(at: number, view: Uint8Array): number;
  write(at: number, view: Uint8Array): number;
  truncate(size: number): void;
  /** Bytes this backing is really holding, so a test can assert it held none. */
  residentBytes(): number;
}

/** Real bytes. Used by every test whose file is small enough to hold. */
export class BufferBacking implements Backing {
  private data = new Uint8Array(0);

  get size(): number {
    return this.data.length;
  }

  read(at: number, view: Uint8Array): number {
    const available = Math.max(0, Math.min(view.length, this.data.length - at));
    if (available > 0) view.set(this.data.subarray(at, at + available), 0);
    return available;
  }

  write(at: number, view: Uint8Array): number {
    if (at + view.length > this.data.length) this.grow(at + view.length);
    this.data.set(view, at);
    return view.length;
  }

  truncate(size: number): void {
    this.grow(size);
  }

  residentBytes(): number {
    return this.data.length;
  }

  snapshot(): Uint8Array {
    return Uint8Array.from(this.data);
  }

  private grow(size: number): void {
    const next = new Uint8Array(size);
    next.set(this.data.subarray(0, Math.min(size, this.data.length)), 0);
    this.data = next;
  }
}

/** The byte a generated file holds at one absolute offset. */
export function patternByte(offset: number): number {
  return (Math.imul(offset + 1, 0x9e37_79b1) >>> 24) & 0xff;
}

export function patternBytes(offset: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = patternByte(offset + index);
  return bytes;
}

/**
 * A file whose bytes are computed, not kept.
 *
 * Writes are checked against the generator and only their *extent* is recorded;
 * reads regenerate inside a recorded extent and return zeros outside one. So
 * the file behaves exactly like a sparse one - including the part that matters,
 * that a segment written to the wrong place leaves a hole - while costing one
 * interval per write instead of a gigabyte.
 */
export class PatternBacking implements Backing {
  size = 0;
  /** Written extents, kept sorted and merged. Bounded by the segment count. */
  readonly written: { start: number; end: number }[] = [];
  mismatches = 0;
  /**
   * Literal bytes for writes too small to be a segment.
   *
   * The store's capability probe writes one byte and reads it back, and it has
   * every right to expect the value it wrote. Anything at or below this size is
   * stored verbatim; a segment-sized write is held to the generator, which is
   * what makes an offset error detectable.
   */
  private readonly literal = new Map<number, number>();
  private readonly literalLimitBytes = 4_096;

  read(at: number, view: Uint8Array): number {
    const available = Math.max(0, Math.min(view.length, this.size - at));
    // Zero first, then regenerate only inside recorded extents. Per-extent
    // rather than per-byte because a gigabyte of interval lookups is the
    // difference between a slow test and an unrunnable one.
    view.fill(0, 0, available);
    for (const extent of this.written) {
      const start = Math.max(at, extent.start);
      const end = Math.min(at + available, extent.end);
      for (let offset = start; offset < end; offset += 1) view[offset - at] = patternByte(offset);
    }
    for (const [offset, value] of this.literal) {
      if (offset >= at && offset < at + available) view[offset - at] = value;
    }
    return available;
  }

  write(at: number, view: Uint8Array): number {
    if (view.length <= this.literalLimitBytes) {
      for (let index = 0; index < view.length; index += 1) this.literal.set(at + index, view[index]);
    } else {
      for (let index = 0; index < view.length; index += 1) {
        if (view[index] !== patternByte(at + index)) {
          this.mismatches += 1;
          break;
        }
      }
    }
    this.record(at, at + view.length);
    if (at + view.length > this.size) this.size = at + view.length;
    return view.length;
  }

  truncate(size: number): void {
    this.size = size;
    for (let index = this.written.length - 1; index >= 0; index -= 1) {
      const extent = this.written[index];
      if (extent.start >= size) this.written.splice(index, 1);
      else if (extent.end > size) extent.end = size;
    }
    for (const offset of [...this.literal.keys()]) {
      if (offset >= size) this.literal.delete(offset);
    }
  }

  residentBytes(): number {
    return 0;
  }

  /** Bytes covered by a recorded write. Equals the file size for a complete one. */
  coveredBytes(): number {
    return this.written.reduce((total, extent) => total + (extent.end - extent.start), 0);
  }

  private record(start: number, end: number): void {
    this.written.push({ start, end });
    this.written.sort((left, right) => left.start - right.start);
    for (let index = this.written.length - 1; index > 0; index -= 1) {
      const previous = this.written[index - 1];
      const current = this.written[index];
      if (current.start <= previous.end) {
        previous.end = Math.max(previous.end, current.end);
        this.written.splice(index, 1);
      }
    }
  }
}

/* -------------------------------------------------------------------- files */

export interface FakeStorageOptions {
  /** Total bytes the whole fake filesystem may hold. */
  quotaBytes?: number;
  /** Reproduces the early Safari revision whose sync handle was not synchronous. */
  asyncWriteApi?: boolean;
  /** Omits `createSyncAccessHandle`, as a main-thread context does. */
  withoutSyncAccess?: boolean;
  /** Omits `estimate`, as a browser with no quota API does. */
  withoutEstimate?: boolean;
  /** Backing factory. Defaults to real bytes. */
  backing?: () => Backing;
}

export class FakeSyncAccessHandle implements SyncAccessHandleLike {
  /** Writes allowed before this handle starts throwing. */
  breakAfter = Number.POSITIVE_INFINITY;
  /** What it throws once broken. A quota error and a dead writer are not the same event. */
  breakWith: Error | undefined;
  /** One-shot short write, which is how some implementations report a full volume. */
  nextWriteReturns: number | undefined;
  closed = false;
  writes = 0;
  flushes = 0;

  constructor(
    private readonly file: FakeFile,
    private readonly options: FakeStorageOptions,
  ) {}

  read(buffer: ArrayBufferView, options?: { at?: number }): number {
    this.assertOpen();
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return this.file.backing.read(options?.at ?? 0, view);
  }

  write(buffer: ArrayBufferView, options?: { at?: number }): number {
    this.assertOpen();
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (this.options.asyncWriteApi) {
      // The shape that passes every type check and writes nothing.
      return Promise.resolve(view.byteLength) as unknown as number;
    }
    this.writes += 1;
    if (this.writes > this.breakAfter) throw this.breakWith ?? stateError('the access handle failed');
    if (this.nextWriteReturns !== undefined) {
      const short = this.nextWriteReturns;
      this.nextWriteReturns = undefined;
      return short;
    }
    const at = options?.at ?? 0;
    this.file.store.reserve(this.file, Math.max(this.file.backing.size, at + view.length));
    return this.file.backing.write(at, view);
  }

  truncate(newSize: number): void {
    this.assertOpen();
    this.file.store.reserve(this.file, newSize);
    this.file.backing.truncate(newSize);
  }

  getSize(): number {
    this.assertOpen();
    return this.file.backing.size;
  }

  flush(): void {
    this.assertOpen();
    this.flushes += 1;
  }

  close(): void {
    this.closed = true;
    this.file.locked = false;
  }

  private assertOpen(): void {
    if (this.closed) throw stateError('the access handle is closed');
  }
}

export class FakeFile implements FileHandleLike {
  locked = false;
  handle: FakeSyncAccessHandle | undefined;

  /**
   * Absent entirely when the context does not offer it, which is the shape a
   * main thread has. The store checks for the method rather than calling it and
   * catching, so the fake has to be able to genuinely not have it.
   */
  readonly createSyncAccessHandle: (() => Promise<SyncAccessHandleLike>) | undefined;

  constructor(
    readonly name: string,
    readonly store: FakeStorage,
    readonly backing: Backing,
    private readonly options: FakeStorageOptions,
  ) {
    this.createSyncAccessHandle = options.withoutSyncAccess
      ? undefined
      : async () => {
        if (this.locked) throw lockError();
        this.locked = true;
        this.handle = new FakeSyncAccessHandle(this, this.options);
        return this.handle;
      };
  }

  async createWritable(): Promise<FileWritableLike> {
    if (this.locked) throw lockError();
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: BufferSource | Blob | string) => {
        chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : toBytes(data));
      },
      close: async () => {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        this.store.reserve(this, total);
        this.backing.truncate(0);
        this.backing.truncate(total);
        let offset = 0;
        for (const chunk of chunks) {
          this.backing.write(offset, chunk);
          offset += chunk.length;
        }
      },
    };
  }

  async getFile(): Promise<Blob> {
    const bytes = new Uint8Array(this.backing.size);
    this.backing.read(0, bytes);
    return new Blob([bytes]);
  }
}

function toBytes(data: BufferSource | Blob): Uint8Array {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data as ArrayBuffer);
}

export class FakeDirectory implements DirectoryHandleLike {
  readonly directories = new Map<string, FakeDirectory>();
  readonly files = new Map<string, FakeFile>();

  constructor(
    readonly name: string,
    readonly store: FakeStorage,
    private readonly options: FakeStorageOptions,
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike> {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw stateError(`no directory named ${name}`);
    const created = new FakeDirectory(name, this.store, this.options);
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike> {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw stateError(`no file named ${name}`);
    const backing = this.options.backing ? this.options.backing() : new BufferBacking();
    const created = new FakeFile(name, this.store, backing, this.options);
    this.files.set(name, created);
    return created;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    const directory = this.directories.get(name);
    if (!directory) throw stateError(`no entry named ${name}`);
    if (!options?.recursive && (directory.files.size > 0 || directory.directories.size > 0)) {
      throw stateError('directory is not empty');
    }
    this.directories.delete(name);
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const name of this.directories.keys()) yield name;
    for (const name of this.files.keys()) yield name;
  }
}

export class FakeStorage implements StorageManagerLike {
  readonly root: FakeDirectory;
  /** Set once a write or truncate has been refused, for a test to assert on. */
  refusals = 0;

  readonly getDirectory: () => Promise<DirectoryHandleLike>;
  /** Absent when the browser has no quota API, which the preflight must survive. */
  readonly estimate: (() => Promise<{ quota?: number; usage?: number }>) | undefined;

  constructor(private readonly options: FakeStorageOptions = {}) {
    this.root = new FakeDirectory('', this, options);
    this.getDirectory = async () => this.root;
    this.estimate = options.withoutEstimate
      ? undefined
      : async () => ({
        quota: options.quotaBytes ?? 8 * 1024 * 1024 * 1024,
        usage: this.usedBytes(),
      });
  }

  /** Refuses a size change that would take the whole store past its quota. */
  reserve(file: FakeFile, size: number): void {
    const quota = this.options.quotaBytes;
    if (quota === undefined) return;
    const other = this.usedBytes() - file.backing.size;
    if (other + size > quota) {
      this.refusals += 1;
      throw quotaError();
    }
  }

  usedBytes(): number {
    let total = 0;
    const walk = (directory: FakeDirectory): void => {
      for (const file of directory.files.values()) total += file.backing.size;
      for (const child of directory.directories.values()) walk(child);
    };
    walk(this.root);
    return total;
  }

  /** The session directories under `/deqr/sessions`, by name. */
  sessions(): Map<string, FakeDirectory> {
    const deqr = this.root.directories.get('deqr');
    const sessions = deqr?.directories.get('sessions');
    return sessions ? sessions.directories : new Map();
  }

  sessionNames(): string[] {
    return [...this.sessions().keys()].sort();
  }
}

/** A `StorageEnvironment` around a fake, as the receiver's modules take one. */
export function fakeEnvironment(options: FakeStorageOptions = {}): {
  storage: FakeStorage;
  environment: { storage: FakeStorage; supportsSyncAccess: boolean };
} {
  const storage = new FakeStorage(options);
  return {
    storage,
    environment: { storage, supportsSyncAccess: !options.withoutSyncAccess },
  };
}
