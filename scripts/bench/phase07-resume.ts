/**
 * Phase 07 - what a resume saves, and what adopting one costs.
 *
 * The phase's premise is that a transfer interrupted at 90% should not have to
 * start again. That is an arithmetic claim about the optical channel, and it
 * needs no harness: 90% of a gigabyte at Turbo's 9,763 verified bytes per
 * second is about twenty-eight hours. The claim that *does* need measuring is
 * the other one - that adopting a checkpoint is cheap enough to be worth doing,
 * and that a resumed transfer costs no more to finish than a fresh one.
 *
 * So this measures three things:
 *
 * - **Adoption.** Reading a checkpoint back, validating it against a manifest,
 *   and seeding a session from it. Bounded by the segment count rather than by
 *   the file, and the number that says whether resume can be attempted on every
 *   session or has to be something a user opts into.
 * - **Verification of a resumed transfer.** The plan's warning is that a resume
 *   which re-verifies on every reconnection would hash for longer than a fresh
 *   transfer spends scanning. This prints what one end-of-transfer hash costs,
 *   so the design that runs it exactly once can be checked against the one that
 *   would run it repeatedly.
 * - **The net saving.** Segments not re-sent, expressed as the optical seconds
 *   they would have taken at the measured Phase 04 profiles - which is the only
 *   unit in which a resume is worth anything.
 *
 * ## Why it writes to a real filesystem
 *
 * Same reason as Phase 06's harness, and the same caveat: there is no OPFS in
 * Node, so the `SyncAccessHandleLike` here is a thin wrapper over positioned
 * `fs` calls, which is a one-to-one mapping of the API the receiver calls and
 * *not* a measurement of a phone. Physical certification is Phase 11's.
 *
 *   node --expose-gc node_modules/vite-node/vite-node.mjs \
 *     scripts/bench/phase07-resume.ts -- --mode resume --sizeMib 1024 --atPercent 90
 *
 *   --mode resume    interrupt at a point, adopt the checkpoint, finish, verify
 *   --mode adopt     the cost of adoption alone, swept across file sizes
 *   --mode saving    optical seconds a resume avoids, per profile, per size
 *
 * Payload safety: every byte is a deterministic function of its own offset.
 * Nothing is read from a user's disk and no payload byte is printed.
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
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import { encodeResumeToken, decodeResumeToken } from '../../src/core/resume-token';
import { Sha256Stream, digestToHex } from '../../src/core/sha256-stream';
import { TRANSPORT_PROFILES, expectedVerifiedBytesPerSecond } from '../../src/core/transport-profiles';
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

function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
}

/** Resident JavaScript memory, array buffers included. See the Phase 06 harness. */
function heapMib(): number {
  const usage = process.memoryUsage();
  return (usage.heapUsed + usage.arrayBuffers) / MIB;
}

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
    // Not `a+`: append mode ignores the position argument, so every offset the
    // store computed would collapse to "the end".
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
    // The checkpoint is read back through this, which is the whole of what a
    // resume needs from the async side of the file API.
    const size = fstatSync(openSync(this.file, 'r')).size;
    const fd = openSync(this.file, 'r');
    const bytes = new Uint8Array(size);
    readSync(fd, bytes, 0, size, 0);
    closeSync(fd);
    return new Blob([bytes]);
  }
}

class NodeDirectoryHandle implements DirectoryHandleLike {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  async getDirectoryHandle(name: string): Promise<DirectoryHandleLike> {
    return new NodeDirectoryHandle(path.join(this.directory, name));
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

const SESSION_ID = 0x5eed_0007;
const FILE_ID = 0x0a0b_0c0d;

function manifestFor(transportSize: number, sha256: Uint8Array): DeqrV2Manifest {
  // Phase 04's Turbo shape, so the segment count and the short final segment
  // are the ones a real transfer at this size would produce.
  const symbolSizeBytes = 1_139;
  const segmentSizeBytes = 2_048 * symbolSizeBytes;
  const plan = planSegmentation({ transportSize: BigInt(transportSize), segmentSizeBytes, symbolSizeBytes });
  return {
    featureFlags: 0,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
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
    filename: 'phase07-bench.bin',
    mimeType: 'application/octet-stream',
  };
}

function planOf(manifest: DeqrV2Manifest): SegmentPlan {
  return planSegmentation({
    transportSize: manifest.transportSize,
    segmentSizeBytes: manifest.segmentSizeBytes,
    symbolSizeBytes: manifest.symbolSizeBytes,
  });
}

function benchRoot(clean = true): { root: NodeDirectoryHandle; directory: string } {
  const directory = path.resolve(process.cwd(), '.local-run', 'bench', 'phase07');
  if (clean) rmSync(directory, { recursive: true, force: true });
  return { root: new NodeDirectoryHandle(directory), directory };
}

/** The digest of the whole synthetic payload, computed without materialising it. */
function payloadDigest(transportSize: number): Uint8Array {
  const hasher = new Sha256Stream();
  const window = new Uint8Array(1 * MIB);
  let offset = 0;
  while (offset < transportSize) {
    const want = Math.min(window.length, transportSize - offset);
    hasher.update(payloadInto(window.subarray(0, want), offset));
    offset += want;
  }
  return hasher.digest();
}

/** Writes segments `[from, to)` into a store, returning how long it took. */
function writeSegments(store: OpfsSegmentStore, plan: SegmentPlan, from: number, to: number): number {
  const startedAt = performance.now();
  for (let index = from; index < to; index += 1) {
    const range = segmentByteRange(plan, index);
    const length = Number(range.end - range.start);
    const bytes = payloadInto(new Uint8Array(length), Number(range.start));
    const outcome = store.write({ segmentIndex: index, byteOffset: range.start, bytes });
    if (outcome !== STORE_WRITE.OK) throw new Error(`write refused at segment ${index}: ${outcome}`);
  }
  return performance.now() - startedAt;
}

/* --------------------------------------------------------------- mode: resume */

/**
 * A whole interrupted-and-resumed transfer, end to end.
 *
 * Run 1 writes up to the interruption point and leaves the device as an
 * interruption would - handle closed, checkpoint retained. Run 2 opens with
 * `resume`, adopts whatever it finds, writes only the rest, and verifies the
 * result against a digest computed independently of the store.
 */
async function runResume(sizeMib: number, atPercent: number): Promise<void> {
  const transportSize = sizeMib * MIB;
  const digest = payloadDigest(transportSize);
  const manifest = manifestFor(transportSize, digest);
  const plan = planOf(manifest);
  const stopAt = Math.max(0, Math.min(plan.segmentCount, Math.round(plan.segmentCount * atPercent / 100)));
  const { root, directory } = benchRoot();

  // ---- Run 1: interrupted.
  const firstOpen = await OpfsSegmentStore.open({ root, manifest, plan, filename: manifest.filename });
  if (!firstOpen.ok) throw new Error(`store did not open: ${firstOpen.code}`);
  const firstWriteMs = writeSegments(firstOpen.store, plan, 0, stopAt);
  await firstOpen.store.settled();
  firstOpen.store.release();
  // `retain` is what an interruption passes. A cancel would delete here.
  await firstOpen.store.dispose('retain');

  const token = encodeResumeToken({
    sessionId: manifest.sessionId,
    fileId: manifest.fileId,
    segmentCount: plan.segmentCount,
    resumeFromSegment: stopAt,
    sha256: digest,
  });

  // ---- Run 2: a new store over the same device, holding nothing.
  collect();
  const baselineMib = heapMib();
  const adoptStartedAt = performance.now();
  const resumed = await OpfsSegmentStore.open({
    root: benchRoot(false).root,
    manifest,
    plan,
    filename: manifest.filename,
    resume: true,
  });
  const adoptMs = performance.now() - adoptStartedAt;
  if (!resumed.ok) throw new Error(`resume did not open: ${resumed.code}`);
  if (resumed.store.segmentsAdopted !== stopAt) {
    throw new Error(`adopted ${resumed.store.segmentsAdopted} segments, expected ${stopAt}`);
  }

  const decoded = decodeResumeToken(token);
  if (!decoded.ok) throw new Error(`the token this bench minted did not read back: ${decoded.code}`);

  const secondWriteMs = writeSegments(resumed.store, plan, decoded.value.resumeFromSegment, plan.segmentCount);
  await resumed.store.settled();

  const verifyStartedAt = performance.now();
  const verified = await digestSegmentStore(resumed.store, transportSize, { yieldTo: async () => undefined });
  const verifyMs = performance.now() - verifyStartedAt;
  const peakMib = heapMib();
  collect();

  if (!verified || digestToHex(verified) !== digestToHex(digest)) {
    throw new Error('the resumed transfer did not verify against the original digest');
  }

  const segmentsSkipped = decoded.value.resumeFromSegment;
  const bytesSkipped = segmentsSkipped * manifest.segmentSizeBytes;

  report('PHASE07_RESUME', {
    fileMib: sizeMib,
    segments: plan.segmentCount,
    interruptedAtPercent: atPercent,
    segmentsAdopted: resumed.store.segmentsAdopted,
    bytesAdopted: resumed.store.bytesAdopted,
    // The one measurement the design turns on: what it costs to pick a
    // half-finished transfer back up. Bounded by the segment count.
    adoptMs,
    adoptMsPerThousandSegments: plan.segmentCount > 0 ? adoptMs * 1000 / plan.segmentCount : 0,
    resumeTokenChars: token.replace(/-/g, '').length,
    firstRunSeconds: firstWriteMs / 1000,
    secondRunSeconds: secondWriteMs / 1000,
    verifySeconds: verifyMs / 1000,
    verifyMibPerSecond: sizeMib / (verifyMs / 1000),
    // Heap across the resumed run. Adoption reads a bitmap sized by the segment
    // count, so this may not scale with the file any more than Phase 06 did.
    heapGrowthMib: peakMib - baselineMib,
    storeResidentBytes: resumed.store.residentBytes(),
    segmentsSkipped,
    bytesSkipped,
    verified: 'yes',
  });

  resumed.store.release();
  await resumed.store.dispose('discard');
  rmSync(directory, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- mode: adopt */

/**
 * Adoption cost alone, swept across sizes.
 *
 * Isolated from the transfer because it is the number that decides policy: if
 * adoption were proportional to the file it could only be offered as an
 * explicit choice, and if it is proportional to the segment count it can be
 * attempted on every session - which is what the receiver actually does.
 */
async function runAdopt(sizesMib: number[]): Promise<void> {
  for (const sizeMib of sizesMib) {
    const transportSize = sizeMib * MIB;
    // The digest is not what this mode measures and hashing a gigabyte per size
    // would dominate the run, so a fixed one stands in. Adoption compares it for
    // equality; it never recomputes it.
    const digest = new Uint8Array(32).fill(0x5a);
    const manifest = manifestFor(transportSize, digest);
    const plan = planOf(manifest);
    const { root, directory } = benchRoot();

    // A checkpoint with three quarters of the segments committed, written the
    // only way the receiver ever writes one: by committing segments.
    const stopAt = Math.floor(plan.segmentCount * 0.75);
    const seeded = await OpfsSegmentStore.open({ root, manifest, plan, filename: manifest.filename });
    if (!seeded.ok) throw new Error(`store did not open: ${seeded.code}`);
    writeSegments(seeded.store, plan, 0, stopAt);
    await seeded.store.settled();
    seeded.store.release();
    await seeded.store.dispose('retain');

    collect();
    const baselineMib = heapMib();
    const startedAt = performance.now();
    const resumed = await OpfsSegmentStore.open({
      root: benchRoot(false).root,
      manifest,
      plan,
      filename: manifest.filename,
      resume: true,
    });
    const adoptMs = performance.now() - startedAt;
    if (!resumed.ok) throw new Error(`resume did not open: ${resumed.code}`);

    report('PHASE07_ADOPT', {
      fileMib: sizeMib,
      segments: plan.segmentCount,
      segmentsAdopted: resumed.store.segmentsAdopted,
      adoptMs,
      // The checkpoint's whole size, which is what a resume reads back. One bit
      // per segment before base64, so this is the file-size independence claim
      // stated as a number rather than asserted.
      checkpointBytes: JSON.stringify(resumed.store.snapshot()).length,
      bitmapBytes: Math.ceil(plan.segmentCount / 8),
      heapGrowthMib: heapMib() - baselineMib,
    });

    resumed.store.release();
    await resumed.store.dispose('discard');
    rmSync(directory, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- mode: saving */

/**
 * What a resume is worth, in the only unit that matters.
 *
 * Storage time and hash time are both irrelevant next to the optical channel -
 * Phase 06 measured storage at four orders of magnitude faster than the link.
 * So the saving from a resume is entirely the segments that do not have to be
 * put back on a screen and photographed, and this converts them into hours at
 * each of Phase 04's measured profiles.
 *
 * Nothing is written to disk here: it is arithmetic over measured constants,
 * printed so the claim can be checked rather than asserted in prose.
 */
function runSaving(sizesMib: number[], percents: number[]): void {
  for (const profile of TRANSPORT_PROFILES) {
    // Taken from the profile table's own throughput model rather than
    // recomputed here. A second copy of that arithmetic in a bench script is a
    // second copy that can drift from the one the sender actually runs.
    const verifiedBytesPerSecond = expectedVerifiedBytesPerSecond(profile, profile.designLossRate);
    if (verifiedBytesPerSecond === null) continue;
    for (const sizeMib of sizesMib) {
      const transportSize = sizeMib * MIB;
      const wholeSeconds = transportSize / verifiedBytesPerSecond;
      for (const percent of percents) {
        const savedSeconds = wholeSeconds * percent / 100;
        report('PHASE07_SAVING', {
          profile: profile.name,
          verifiedBytesPerSecond,
          fileMib: sizeMib,
          interruptedAtPercent: percent,
          wholeTransferHours: wholeSeconds / 3600,
          resumeHours: (wholeSeconds - savedSeconds) / 3600,
          savedHours: savedSeconds / 3600,
        });
      }
    }
  }
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const mode = argument('mode', 'resume');
  if (mode === 'resume') {
    await runResume(Number(argument('sizeMib', '256')), Number(argument('atPercent', '90')));
  } else if (mode === 'adopt') {
    await runAdopt(argument('sizes', '32,128,1024,4096').split(',').map(Number).filter(Number.isFinite));
  } else if (mode === 'saving') {
    runSaving(
      argument('sizes', '256,1024,4096').split(',').map(Number).filter(Number.isFinite),
      argument('percents', '50,90,99').split(',').map(Number).filter(Number.isFinite),
    );
  } else throw new Error('--mode must be resume, adopt, or saving');
}

main().catch((error: unknown) => {
  console.error(`PHASE07_RESUME_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
