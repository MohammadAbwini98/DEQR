/**
 * Phase 06 - what incremental storage costs, and what it buys.
 *
 * The phase's claim is that the receiver's working set stops being a function
 * of the file. That is a memory claim, so this harness measures memory: peak
 * JS heap across a full receive, sampled while a file far larger than the heap
 * budget goes through the store.
 *
 * ## Why it writes to a real filesystem
 *
 * There is no OPFS in Node, and an in-memory fake would make the one number
 * that matters - what the *store* costs - unmeasurable, because the fake's own
 * allocations would dominate it. So the `SyncAccessHandleLike` implemented here
 * is a thin wrapper over `fs.writeSync`/`readSync`/`ftruncateSync`, which is a
 * one-to-one mapping of the API the receiver actually calls. Files go under
 * `.local-run/bench/phase06/` and are removed afterwards.
 *
 * What that does *not* give is a device measurement. NTFS on a desktop is not
 * iOS's OPFS on a phone, and no throughput number printed here should be quoted
 * as one. It is a lower bound on the architecture's cost - if the shape were
 * wrong, it would be wrong here too - and physical certification is Phase 11's.
 *
 *   node --expose-gc node_modules/vite-node/vite-node.mjs \
 *     scripts/bench/phase06-opfs-storage.ts -- --mode receive --sizeMib 1024
 *
 *   --mode receive   write a whole logical file through the store, then verify it
 *   --mode compare   Phase 05's assemble-then-digest against Phase 06's streaming one
 *   --mode hash      the incremental hash against the platform's one-shot digest
 *
 * Payload safety: every byte is generated from a deterministic function of its
 * own offset. Nothing is read from a user's disk and no payload byte is printed.
 */

import {
  closeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  planSegmentation,
  segmentByteRange,
  type DeqrV2Manifest,
} from '../../src/core/protocol-v2';
import { Sha256Stream, digestToHex } from '../../src/core/sha256-stream';
import { OpfsSegmentStore } from '../../mobile-web/src/opfs-segment-store';
import { digestSegmentStore } from '../../mobile-web/src/receive-pipeline';
import { STORE_WRITE } from '../../mobile-web/src/segment-store';
import type {
  DirectoryHandleLike,
  FileHandleLike,
  FileWritableLike,
  SyncAccessHandleLike,
} from '../../mobile-web/src/opfs';

/* ---------------------------------------------------------------- plumbing */

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function report(tag: string, fields: Record<string, string | number>): void {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'number' ? round(value) : value}`);
  console.log([tag, ...parts].join(' '));
}

function round(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 1 ? 4 : 2);
}

const MIB = 1024 * 1024;

/** Collects garbage when the harness was started with `--expose-gc`. */
function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
}

/**
 * Resident JavaScript memory, array buffers included.
 *
 * `heapUsed` alone is the wrong number and measuring it would have made this
 * whole harness meaningless: a `Uint8Array`'s bytes live in external memory, so
 * a receiver that held an entire gigabyte in one would report a *flat* heap.
 * `arrayBuffers` is where a held payload actually shows up.
 */
function heapMib(): number {
  const usage = process.memoryUsage();
  return (usage.heapUsed + usage.arrayBuffers) / MIB;
}

/** The payload byte at one absolute offset. Deterministic, and never on disk beforehand. */
function payloadByte(offset: number): number {
  return (Math.imul(offset + 1, 0x9e37_79b1) >>> 24) & 0xff;
}

function payloadInto(view: Uint8Array, offset: number): Uint8Array {
  for (let index = 0; index < view.length; index += 1) view[index] = payloadByte(offset + index);
  return view;
}

/* ------------------------------------------------- a filesystem-backed OPFS */

class NodeSyncAccessHandle implements SyncAccessHandleLike {
  constructor(private fd: number | null) {}

  read(buffer: ArrayBufferView, options?: { at?: number }): number {
    if (this.fd === null) throw new Error('handle closed');
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return readSync(this.fd, view, 0, view.byteLength, options?.at ?? 0);
  }

  write(buffer: ArrayBufferView, options?: { at?: number }): number {
    if (this.fd === null) throw new Error('handle closed');
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return writeSync(this.fd, view, 0, view.byteLength, options?.at ?? 0);
  }

  truncate(newSize: number): void {
    if (this.fd === null) throw new Error('handle closed');
    ftruncateSync(this.fd, newSize);
  }

  getSize(): number {
    if (this.fd === null) throw new Error('handle closed');
    return fstatSync(this.fd).size;
  }

  flush(): void {
    // `fsync` per segment is what OPFS's `flush` promises, and skipping it here
    // would make the write numbers flatter than the receiver's really are.
    if (this.fd !== null) fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

class NodeFileHandle implements FileHandleLike {
  constructor(private readonly file: string) {}

  async createSyncAccessHandle(): Promise<SyncAccessHandleLike> {
    // Created if absent, then reopened for positioned read/write. Not `a+`:
    // append mode ignores the position argument, so every offset the store
    // computed would collapse to "the end", which the capability probe catches
    // and reports as an unsupported browser.
    closeSync(openSync(this.file, 'a'));
    return new NodeSyncAccessHandle(openSync(this.file, 'r+'));
  }

  async createWritable(): Promise<FileWritableLike> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data) => {
        chunks.push(typeof data === 'string'
          ? new TextEncoder().encode(data)
          : new Uint8Array(ArrayBuffer.isView(data) ? data.buffer : (data as ArrayBuffer)));
      },
      close: async () => {
        const fd = openSync(this.file, 'w');
        for (const chunk of chunks) writeSync(fd, chunk, 0, chunk.length);
        closeSync(fd);
      },
    };
  }

  async getFile(): Promise<Blob> {
    throw new Error('the bench never exports');
  }
}

class NodeDirectoryHandle implements DirectoryHandleLike {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike> {
    const child = path.join(this.directory, name);
    if (!options?.create) return new NodeDirectoryHandle(child);
    return new NodeDirectoryHandle(child);
  }

  async getFileHandle(name: string): Promise<FileHandleLike> {
    return new NodeFileHandle(path.join(this.directory, name));
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    rmSync(path.join(this.directory, name), { recursive: options?.recursive ?? false, force: true });
  }

  async *keys(): AsyncIterableIterator<string> {
    // The sweep is not what this harness measures, and enumerating would make
    // every run depend on debris left by the last one.
  }
}

/* ----------------------------------------------------------------- fixtures */

function manifestFor(transportSize: number, sha256: Uint8Array): DeqrV2Manifest {
  // Phase 04's Turbo shape, so the segment count and the short final segment
  // are the ones a real transfer at this size would produce.
  const symbolSizeBytes = 1_139;
  const segmentSizeBytes = 2_048 * symbolSizeBytes;
  const plan = planSegmentation({ transportSize: BigInt(transportSize), segmentSizeBytes, symbolSizeBytes });
  return {
    featureFlags: 0,
    sessionId: 0x5eed_0006,
    fileId: 0x0a0b_0c0d,
    originalSize: BigInt(transportSize),
    transportSize: BigInt(transportSize),
    segmentSizeBytes,
    symbolSizeBytes,
    segmentCount: plan.segmentCount,
    fecProfileId: 1,
    compressionMode: 0,
    compressionParam: 0,
    transportProfileId: 0,
    sha256,
    filename: 'phase06-bench.bin',
    mimeType: 'application/octet-stream',
  };
}

function benchRoot(): { root: NodeDirectoryHandle; directory: string } {
  const directory = path.resolve(process.cwd(), '.local-run', 'bench', 'phase06');
  rmSync(directory, { recursive: true, force: true });
  return { root: new NodeDirectoryHandle(directory), directory };
}

/* -------------------------------------------------------------- mode: receive */

async function runReceive(sizeMib: number): Promise<void> {
  const transportSize = sizeMib * MIB;
  const manifest = manifestFor(transportSize, new Uint8Array(32));
  const plan = planSegmentation({
    transportSize: BigInt(transportSize),
    segmentSizeBytes: manifest.segmentSizeBytes,
    symbolSizeBytes: manifest.symbolSizeBytes,
  });
  const { root, directory } = benchRoot();

  const opened = await OpfsSegmentStore.open({ root, manifest, plan, filename: manifest.filename });
  if (!opened.ok) throw new Error(`store did not open: ${opened.code}`);
  const store = opened.store;

  collect();
  const baselineMib = heapMib();
  let peakHeapMib = baselineMib;
  let peakResident = 0;

  const writeStartedAt = performance.now();
  for (let index = 0; index < plan.segmentCount; index += 1) {
    const range = segmentByteRange(plan, index);
    const length = Number(range.end - range.start);
    // Allocated per segment on purpose: this is what the decoder hands over,
    // and reusing one buffer would flatter the peak the receiver really sees.
    const bytes = payloadInto(new Uint8Array(length), Number(range.start));
    const outcome = store.write({ segmentIndex: index, byteOffset: range.start, bytes });
    if (outcome !== STORE_WRITE.OK) throw new Error(`write refused at segment ${index}: ${outcome}`);
    peakResident = Math.max(peakResident, store.residentBytes());
    if ((index & 0x0f) === 0) peakHeapMib = Math.max(peakHeapMib, heapMib());
  }
  const writeMs = performance.now() - writeStartedAt;
  await store.settled();

  const verifyStartedAt = performance.now();
  const digest = await digestSegmentStore(store, transportSize, { yieldTo: async () => undefined });
  const verifyMs = performance.now() - verifyStartedAt;
  peakHeapMib = Math.max(peakHeapMib, heapMib());
  // Peak and retained are different claims and both are worth printing. Peak
  // includes segment buffers the collector has not got to yet, which is real
  // pressure on a phone; retained is what the receiver is actually still
  // holding once it has. Neither may scale with the file.
  collect();
  const retainedMib = heapMib() - baselineMib;

  report('PHASE06_RECEIVE', {
    fileMib: sizeMib,
    segments: plan.segmentCount,
    segmentMib: manifest.segmentSizeBytes / MIB,
    lastSegmentBytes: plan.lastSegmentBytes,
    bytesCommitted: store.bytesCommitted(),
    // The gate, stated as the two numbers it compares.
    storeResidentBytes: peakResident,
    peakHeapMib,
    heapGrowthMib: peakHeapMib - baselineMib,
    heapGrowthOverFile: (peakHeapMib - baselineMib) / sizeMib,
    retainedMib,
    writeSeconds: writeMs / 1000,
    writeMibPerSecond: sizeMib / (writeMs / 1000),
    verifySeconds: verifyMs / 1000,
    verifyMibPerSecond: sizeMib / (verifyMs / 1000),
    digest: digest ? `${digestToHex(digest).slice(0, 16)}...` : 'none',
  });

  store.release();
  await store.dispose('discard');
  rmSync(directory, { recursive: true, force: true });
}

/* -------------------------------------------------------------- mode: compare */

/**
 * The comparison that justifies the phase.
 *
 * Phase 05 verified by assembling every stored segment into one buffer and
 * handing it to `crypto.subtle.digest`, which is two file-sized allocations at
 * once. Phase 06 reads bounded windows. At sizes where both still work the
 * digests must agree, and the peak heaps must not.
 */
async function runCompare(sizeMib: number): Promise<void> {
  const transportSize = sizeMib * MIB;

  collect();
  const assembleBaseline = heapMib();
  const assembleStartedAt = performance.now();
  const assembled = payloadInto(new Uint8Array(transportSize), 0);
  const oneShot = new Uint8Array(await crypto.subtle.digest('SHA-256', assembled.buffer as ArrayBuffer));
  const assembleMs = performance.now() - assembleStartedAt;
  const assemblePeakMib = heapMib() - assembleBaseline;
  assembled.fill(0);

  collect();
  const streamBaseline = heapMib();
  const streamStartedAt = performance.now();
  const hasher = new Sha256Stream();
  const window = new Uint8Array(256 * 1024);
  for (let offset = 0; offset < transportSize; offset += window.length) {
    const take = Math.min(window.length, transportSize - offset);
    hasher.update(payloadInto(window.subarray(0, take), offset));
  }
  const streamed = hasher.digest();
  const streamMs = performance.now() - streamStartedAt;
  const streamPeakMib = heapMib() - streamBaseline;

  report('PHASE06_COMPARE', {
    fileMib: sizeMib,
    digestsAgree: digestToHex(oneShot) === digestToHex(streamed) ? 'yes' : 'NO',
    assembleHeapMib: assemblePeakMib,
    streamHeapMib: streamPeakMib,
    heapRatio: assemblePeakMib / Math.max(streamPeakMib, 0.001),
    assembleSeconds: assembleMs / 1000,
    streamSeconds: streamMs / 1000,
    // WebCrypto is native and this is JavaScript, so the streaming path is
    // slower per byte. It is also the only one that works past the heap.
    streamCostRatio: streamMs / Math.max(assembleMs, 1e-9),
  });
}

/* ----------------------------------------------------------------- mode: hash */

async function runHash(sizes: number[]): Promise<void> {
  for (const sizeMib of sizes) {
    const bytes = payloadInto(new Uint8Array(sizeMib * MIB), 0);

    const nativeStartedAt = performance.now();
    await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
    const nativeMs = performance.now() - nativeStartedAt;

    const streamStartedAt = performance.now();
    const hasher = new Sha256Stream();
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      hasher.update(bytes.subarray(offset, Math.min(offset + 256 * 1024, bytes.length)));
    }
    hasher.digest();
    const streamMs = performance.now() - streamStartedAt;

    report('PHASE06_HASH', {
      sizeMib,
      nativeMibPerSecond: sizeMib / (nativeMs / 1000),
      streamMibPerSecond: sizeMib / (streamMs / 1000),
      slowdown: streamMs / Math.max(nativeMs, 1e-9),
      // What a user actually waits for at the end of a large transfer.
      projectedSecondsPerGib: (streamMs / 1000) * (1024 / sizeMib),
    });
    bytes.fill(0);
  }
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const mode = argument('mode', 'receive');
  if (mode === 'receive') await runReceive(Number(argument('sizeMib', '1024')));
  else if (mode === 'compare') await runCompare(Number(argument('sizeMib', '64')));
  else if (mode === 'hash') {
    await runHash(argument('sizes', '16,64,256').split(',').map(Number).filter(Number.isFinite));
  } else throw new Error('--mode must be receive, compare, or hash');
}

main().catch((error: unknown) => {
  console.error(`PHASE06_STORAGE_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
