/**
 * Phase 11 - the receiver, in a browser, against a real OPFS.
 *
 * Every phase from 06 onward has written its storage claims against a
 * `SyncAccessHandleLike` backed by Node's `fs`. That is the same *shape* as the
 * API and a different implementation, and three of the things the receiver
 * depends on are not shape at all:
 *
 * - a sync access handle is **exclusive**, so nothing else can open the file
 *   while the worker holds it - which is why `seal()` has to close it before
 *   the main thread can export;
 * - `truncate()` on a real origin-private file system **reserves quota**, and
 *   is where a device that cannot hold the transfer says so;
 * - `getFile()` on the main thread must see the bytes the worker wrote, which
 *   is a cross-context durability claim that `fs` cannot test.
 *
 * This worker is where those become measurements. It builds real v2 frames
 * from the shipping serializer, feeds them to the shipping `ReceivePipeline`,
 * and lets `ReceiverStorage` find the browser's own OPFS with no injection at
 * all - `defaultEnvironment()` reads the real `navigator.storage`.
 *
 * What it is not: an iPhone. Chromium's OPFS and WebKit's are two
 * implementations, and the iOS row of the certification stays PENDING.
 */

import {
  V2_COMPRESSION,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  type DeqrV2Manifest,
} from '../../../src/core/protocol-v2';
import { SegmentEncoder } from '../../../src/core/segment-encoder';
import { Sha256Stream, digestToHex } from '../../../src/core/sha256-stream';
import { BALANCED_PROFILE } from '../../../src/core/transport-profiles';
import { ReceivePipeline } from '../../../mobile-web/src/receive-pipeline';
import { ReceiverStorage } from '../../../mobile-web/src/receiver-storage';
import {
  OPFS_ROOT_DIR,
  OPFS_SESSIONS_DIR,
  defaultEnvironment,
  detectStorageSupport,
} from '../../../mobile-web/src/opfs';

const MIB = 1024 * 1024;

export interface CertifyRow {
  name: string;
  ok: boolean;
  detail: Record<string, string | number | boolean>;
}

interface CertifyRequest {
  sizes: number[];
}

/* --------------------------------------------------------------- fixtures */

/**
 * The same positional generator the Node harness uses, so a digest computed
 * there and one computed here describe the same file.
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
      view[index] = ((byte < 4 ? low : high) >>> ((byte % 4) * 8)) & 0xff;
    }
  }
}

/**
 * The sender, reduced to what the wire needs.
 *
 * Not `StreamingTransferSession`: that reads files with `node:fs` and cannot
 * run here. What it shares with the real sender is everything downstream of
 * the read - `SegmentEncoder`, `serializeDataFrame`, `serializeManifestFrame`
 * and the manifest cadence are the shipping objects, so the bytes this
 * produces are the bytes a desktop would put on a screen.
 */
class FrameSource {
  readonly manifest: DeqrV2Manifest;
  private readonly plan: ReturnType<typeof planSegmentation>;
  private readonly encoder: SegmentEncoder;
  private readonly symbol: Uint8Array;
  private readonly segment: Uint8Array;
  private readonly manifestFrame: Uint8Array;

  constructor(
    readonly sizeBytes: number,
    readonly seed: number,
    sessionId: number,
    fileId: number,
    private readonly manifestInterval = 64,
  ) {
    const profile = BALANCED_PROFILE;
    this.plan = planSegmentation({
      transportSize: BigInt(sizeBytes),
      segmentSizeBytes: profile.segmentSizeBytes,
      symbolSizeBytes: profile.symbolSizeBytes,
    });
    this.manifest = {
      featureFlags: 0,
      sessionId,
      fileId,
      originalSize: BigInt(sizeBytes),
      transportSize: BigInt(sizeBytes),
      segmentSizeBytes: profile.segmentSizeBytes,
      symbolSizeBytes: profile.symbolSizeBytes,
      segmentCount: this.plan.segmentCount,
      fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
      compressionMode: V2_COMPRESSION.NONE,
      compressionParam: 0,
      transportProfileId: profile.id,
      sha256: this.digest(),
      filename: 'phase11-browser.bin',
      mimeType: 'application/octet-stream',
    };
    this.encoder = new SegmentEncoder(profile.symbolSizeBytes);
    this.symbol = new Uint8Array(profile.symbolSizeBytes);
    this.segment = new Uint8Array(profile.segmentSizeBytes);
    this.manifestFrame = serializeManifestFrame(this.manifest);
  }

  /** SHA-256 over the fixture, one bounded window at a time. */
  private digest(): Uint8Array {
    const stream = new Sha256Stream();
    const window = new Uint8Array(1 * MIB);
    for (let offset = 0; offset < this.sizeBytes; offset += window.length) {
      const count = Math.min(window.length, this.sizeBytes - offset);
      const view = window.subarray(0, count);
      fillRandom(view, offset, this.seed);
      stream.update(view);
    }
    return stream.digest();
  }

  get digestHex(): string {
    return digestToHex(this.manifest.sha256);
  }

  /**
   * Every frame of one pass, manifest cadence included.
   *
   * `repairRatio` is a parameter rather than the profile's value because two
   * scenarios below want a clean channel and no wasted optical time, and one
   * wants the repair symbols present so the receiver's recovery path is the
   * one being exercised.
   */
  *frames(repairRatio: number, stopAfterSegments = Number.POSITIVE_INFINITY): Generator<Uint8Array> {
    let produced = 0;
    const limit = Math.min(this.plan.segmentCount, stopAfterSegments);
    for (let segmentIndex = 0; segmentIndex < limit; segmentIndex += 1) {
      const range = segmentByteRange(this.plan, segmentIndex);
      const length = Number(range.end - range.start);
      const view = this.segment.subarray(0, length);
      fillRandom(view, Number(range.start), this.seed);
      this.encoder.loadSegment(view);

      const source = this.encoder.sourceSymbolCount;
      const total = source + Math.ceil(source * repairRatio);
      for (let symbolId = 0; symbolId < total; symbolId += 1) {
        if (produced % this.manifestInterval === 0) {
          produced += 1;
          yield this.manifestFrame;
        }
        produced += 1;
        this.encoder.symbolInto(symbolId, this.symbol);
        yield serializeDataFrame({
          frameType: symbolId < source ? V2_FRAME_TYPE.SOURCE : V2_FRAME_TYPE.REPAIR,
          sessionId: this.manifest.sessionId,
          fileId: this.manifest.fileId,
          segmentIndex,
          symbolId,
          sourceSymbolCount: source,
          frameFlags: 0,
          payload: this.symbol,
        });
      }
      this.encoder.release();
    }
  }
}

/* ------------------------------------------------------------- scenarios */

function post(row: CertifyRow): void {
  (self as unknown as Worker).postMessage({ kind: 'row', row });
}

function yieldOnce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function heapMib(): number {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / MIB : -1;
}

/** Bytes the origin reports as used. The only external view of what OPFS holds. */
async function usedBytes(): Promise<number> {
  try {
    const estimate = await navigator.storage.estimate();
    return estimate.usage ?? -1;
  } catch {
    return -1;
  }
}

/**
 * The receiver's own incremental hasher, checked against the platform's.
 *
 * Everything below compares a digest this file computed with a digest the
 * pipeline computed, and both use `Sha256Stream`. That comparison is worth
 * nothing unless `Sha256Stream` is itself right, so it is checked once here
 * against `crypto.subtle` before any of it is relied on.
 */
async function certifyDigest(): Promise<void> {
  const bytes = new Uint8Array(3 * MIB + 17);
  fillRandom(bytes, 0, 9);
  const stream = new Sha256Stream();
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    stream.update(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)));
  }
  const ours = digestToHex(stream.digest());
  const theirs = digestToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  post({
    name: 'sha256-stream agrees with crypto.subtle',
    ok: ours === theirs,
    detail: { bytes: bytes.length, ours: ours.slice(0, 16), theirs: theirs.slice(0, 16) },
  });
}

/** What this browser says it can do, before anything is attempted. */
async function certifySupport(): Promise<void> {
  const environment = defaultEnvironment();
  const support = detectStorageSupport(environment);
  const estimate = await navigator.storage.estimate().catch(() => ({ quota: -1, usage: -1 }));
  post({
    name: 'storage support in a worker',
    ok: support.opfs && support.syncAccess && support.estimate,
    detail: {
      opfs: support.opfs,
      syncAccess: support.syncAccess,
      estimate: support.estimate,
      quotaMib: Math.round((estimate.quota ?? 0) / MIB),
      usageMib: Math.round((estimate.usage ?? 0) / MIB),
      userAgent: navigator.userAgent,
    },
  });
}

interface TransferOutcome {
  ok: boolean;
  detail: Record<string, string | number | boolean>;
  exportPath?: string[];
  exportFile?: string;
  exportSize?: number;
}

/**
 * One whole transfer into the real OPFS, verified and sealed.
 *
 * `storage` is constructed with no environment, which is the point: it finds
 * `navigator.storage.getDirectory` for itself, exactly as the shipping
 * receiver does inside its decode worker.
 */
async function transfer(options: {
  sizeBytes: number;
  seed: number;
  sessionId: number;
  fileId: number;
  repairRatio: number;
  stopAfterSegments?: number;
  resume?: boolean;
}): Promise<TransferOutcome> {
  const source = new FrameSource(options.sizeBytes, options.seed, options.sessionId, options.fileId);
  const pipeline = new ReceivePipeline({
    storage: new ReceiverStorage({ allowMemoryFallback: false }),
    resume: options.resume === true,
  });

  const usedBefore = await usedBytes();
  const started = performance.now();
  let frames = 0;
  let peakHeld = 0;
  let peakHeap = heapMib();
  let complete = false;

  let ready = false;
  for (const frame of source.frames(options.repairRatio, options.stopAfterSegments)) {
    frames += 1;
    pipeline.submit(frame);
    // Opening a store is asynchronous and this channel is a `for` loop, so
    // without waiting once the whole transfer would be submitted into a session
    // that has nowhere to put it. A real receiver loses those frames to a
    // sender that repeats everything; here there is no repetition to rely on,
    // and measuring storage is the point rather than measuring loss.
    if (!ready) {
      await pipeline.whenStorageReady();
      ready = pipeline.progress().storageKind !== 'none';
    }
    if (frames <= 4 || frames % 512 === 0) {
      await yieldOnce();
      const progress = pipeline.progress();
      peakHeld = Math.max(peakHeld, progress.heldBytes);
      peakHeap = Math.max(peakHeap, heapMib());
      if (progress.fault) break;
      if (progress.complete) {
        complete = true;
        break;
      }
    }
  }
  await yieldOnce();
  const progress = pipeline.progress();
  complete = complete || progress.complete;
  const transferMs = performance.now() - started;

  let verifiedHex = '';
  let verifyMs = 0;
  let exportKind = 'none';
  let outcome: TransferOutcome = { ok: false, detail: {} };

  if (complete) {
    const verifyStart = performance.now();
    const verified = await pipeline.verify();
    verifyMs = performance.now() - verifyStart;
    if (verified.ok) {
      verifiedHex = digestToHex(verified.value.sha256);
      exportKind = verified.value.source.kind;
      if (verified.value.source.kind === 'opfs') {
        outcome.exportPath = verified.value.source.path;
        outcome.exportFile = verified.value.source.file;
        outcome.exportSize = verified.value.source.size;
      }
    } else {
      outcome.detail.verifyError = `${verified.code}: ${verified.message}`;
    }
  }

  const usedAfter = await usedBytes();
  outcome = {
    ...outcome,
    ok: complete && verifiedHex === source.digestHex,
    detail: {
      ...outcome.detail,
      sizeMib: options.sizeBytes / MIB,
      frames,
      storageKind: progress.storageKind,
      complete,
      segments: `${progress.unitsRecovered}/${progress.unitsTotal}`,
      adopted: progress.unitsAdopted,
      resumed: progress.resumed,
      heldMib: Number((peakHeld / MIB).toFixed(3)),
      peakHeapMib: Number(peakHeap.toFixed(1)),
      transferMs: Math.round(transferMs),
      verifyMs: Math.round(verifyMs),
      opfsWriteMibPerSecond: transferMs > 0 ? Number(((options.sizeBytes / MIB) / (transferMs / 1000)).toFixed(1)) : 0,
      hashMibPerSecond: verifyMs > 0 ? Number(((options.sizeBytes / MIB) / (verifyMs / 1000)).toFixed(1)) : 0,
      originUsedDeltaMib: usedBefore >= 0 && usedAfter >= 0 ? Number(((usedAfter - usedBefore) / MIB).toFixed(1)) : -1,
      expected: source.digestHex.slice(0, 16),
      verified: verifiedHex.slice(0, 16) || '-',
      exportKind,
      fault: progress.fault ?? '-',
    },
  };

  // `completed` rather than `release()` with no reason: the export route holds
  // a path into a file that must still exist when the main thread opens it.
  pipeline.release(outcome.ok ? 'completed' : 'failed');
  await pipeline.settled();
  return outcome;
}

/**
 * The handoff the Node harness cannot test.
 *
 * A sync access handle is exclusive. If `seal()` did not close it, this open
 * throws - and it would throw on a phone, after a completed transfer, at the
 * moment the user pressed save. Reading the file back through the *async* file
 * API is the only proof that the exclusive handle was released and that the
 * bytes are visible outside the worker that wrote them.
 */
async function certifyExportHandoff(outcome: TransferOutcome, expectedHex: string): Promise<void> {
  if (!outcome.exportPath || !outcome.exportFile) {
    post({ name: 'export handoff: file opens after seal', ok: false, detail: { reason: 'no OPFS export source' } });
    return;
  }
  try {
    let directory = await navigator.storage.getDirectory();
    for (const segment of outcome.exportPath) {
      directory = await directory.getDirectoryHandle(segment);
    }
    const handle = await directory.getFileHandle(outcome.exportFile);
    const file = await handle.getFile();

    // Hashed through a stream, because a `File` of a gigabyte must never be
    // turned into one `ArrayBuffer` - which is the same rule the export path
    // itself is written to.
    const stream = new Sha256Stream();
    const reader = file.stream().getReader();
    let read = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stream.update(chunk.value);
      read += chunk.value.length;
    }
    const hex = digestToHex(stream.digest());
    post({
      name: 'export handoff: file opens after seal',
      ok: hex === expectedHex && read === outcome.exportSize,
      detail: {
        path: `${outcome.exportPath.join('/')}/${outcome.exportFile}`,
        declaredSize: outcome.exportSize ?? -1,
        readBytes: read,
        digestMatches: hex === expectedHex,
      },
    });
  } catch (error) {
    post({
      name: 'export handoff: file opens after seal',
      ok: false,
      detail: { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
    });
  }
}

/**
 * What is still on the device when the run ends.
 *
 * Not a cleanup gate. A session released as `completed` is *retained* on
 * purpose - the export route holds a path into a file the user may not have
 * saved yet, and deleting it would race them. This row exists to make the cost
 * of that policy visible: the bytes stay until the sweep's bounds - 24 hours,
 * three sessions - reclaim them at the next session open.
 */
async function certifyRetention(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const deqr = await root.getDirectoryHandle(OPFS_ROOT_DIR).catch(() => null);
    if (!deqr) {
      post({ name: 'sessions retained after export', ok: true, detail: { sessions: 0, note: 'no deqr root' } });
      return;
    }
    const sessions = await deqr.getDirectoryHandle(OPFS_SESSIONS_DIR).catch(() => null);
    if (!sessions) {
      post({ name: 'sessions retained after export', ok: true, detail: { sessions: 0 } });
      return;
    }
    const names: string[] = [];
    for await (const name of (sessions as unknown as { keys(): AsyncIterableIterator<string> }).keys()) {
      names.push(name);
    }
    const estimate = await navigator.storage.estimate().catch(() => ({ usage: -1 }));
    post({
      name: 'sessions retained after export',
      ok: true,
      detail: {
        sessions: names.length,
        retainedByPolicy: true,
        originUsageMib: Math.round((estimate.usage ?? 0) / MIB),
        names: names.join(',') || '-',
      },
    });
  } catch (error) {
    post({
      name: 'sessions retained after export',
      ok: false,
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** Everything under `/deqr`, removed, so a run starts from a clean origin. */
async function wipe(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_ROOT_DIR, { recursive: true });
  } catch {
    /* nothing to remove */
  }
}

async function run(request: CertifyRequest): Promise<void> {
  await wipe();
  await certifySupport();
  await certifyDigest();

  let sessionId = 0xb0_00_00_01;
  for (const sizeMib of request.sizes) {
    sessionId += 1;
    const sizeBytes = sizeMib * MIB;
    const outcome = await transfer({
      sizeBytes,
      seed: 0x51_ab + sizeMib,
      sessionId,
      fileId: 0xb0_00_00_02,
      // No repair symbols: this channel is a function call and loses nothing,
      // so emitting them would only make the run longer. Recovery under loss is
      // the Node harness's measurement; this one is about storage.
      repairRatio: 0,
    });
    post({ name: `transfer ${sizeMib} MiB into real OPFS`, ok: outcome.ok, detail: outcome.detail });
    if (outcome.ok) {
      const source = new FrameSource(sizeBytes, 0x51_ab + sizeMib, sessionId, 0xb0_00_00_02);
      await certifyExportHandoff(outcome, source.digestHex);
    }
  }

  await certifyInterruptAndResume();
  await certifyRetention();
  (self as unknown as Worker).postMessage({ kind: 'done' });
}

/**
 * Half a transfer, a new pipeline, and the rest of it.
 *
 * The second pipeline is given nothing except `resume: true`. Everything it
 * needs to continue - which segments exist, what the file is, and whether the
 * bytes on the device belong to this transfer at all - has to come from the
 * checkpoint the first one wrote into the real file system.
 */
async function certifyInterruptAndResume(): Promise<void> {
  const sizeBytes = 8 * MIB;
  const sessionId = 0xb0_00_0f_01;
  const fileId = 0xb0_00_0f_02;
  const seed = 0x4444;

  const source = new FrameSource(sizeBytes, seed, sessionId, fileId);
  const first = new ReceivePipeline({ storage: new ReceiverStorage({ allowMemoryFallback: false }) });
  let frames = 0;
  const halfway = Math.ceil(source.manifest.segmentCount / 2);
  let firstReady = false;
  for (const frame of source.frames(0, halfway)) {
    frames += 1;
    first.submit(frame);
    if (!firstReady) {
      await first.whenStorageReady();
      firstReady = first.progress().storageKind !== 'none';
    }
    if (frames <= 4 || frames % 512 === 0) await yieldOnce();
  }
  await yieldOnce();
  const interrupted = first.progress();
  first.release('interrupted');
  await first.settled();

  const second = new ReceivePipeline({
    storage: new ReceiverStorage({ allowMemoryFallback: false }),
    resume: true,
  });
  let resumedFrames = 0;
  let secondReady = false;
  for (const frame of new FrameSource(sizeBytes, seed, sessionId, fileId).frames(0)) {
    resumedFrames += 1;
    second.submit(frame);
    if (!secondReady) {
      await second.whenStorageReady();
      secondReady = second.progress().storageKind !== 'none';
    }
    if (resumedFrames <= 4 || resumedFrames % 512 === 0) {
      await yieldOnce();
      if (second.progress().complete) break;
    }
  }
  await yieldOnce();
  const resumed = second.progress();
  let verifiedHex = '';
  if (resumed.complete) {
    const verified = await second.verify();
    if (verified.ok) verifiedHex = digestToHex(verified.value.sha256);
  }
  second.release(verifiedHex ? 'completed' : 'failed');
  await second.settled();

  post({
    name: 'interrupt and resume across pipelines, on real OPFS',
    ok: verifiedHex === source.digestHex && resumed.unitsAdopted > 0,
    detail: {
      segmentsBeforeInterrupt: `${interrupted.unitsRecovered}/${interrupted.unitsTotal}`,
      adoptedOnResume: resumed.unitsAdopted,
      resumedFlag: resumed.resumed,
      framesFirstPass: frames,
      framesSecondPass: resumedFrames,
      rejection: resumed.checkpointRejection ?? '-',
      digestMatches: verifiedHex === source.digestHex,
    },
  });
}

self.onmessage = (event: MessageEvent<CertifyRequest>) => {
  run(event.data).catch((error) => {
    (self as unknown as Worker).postMessage({
      kind: 'row',
      row: {
        name: 'harness',
        ok: false,
        detail: { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
      },
    });
    (self as unknown as Worker).postMessage({ kind: 'done' });
  });
};
