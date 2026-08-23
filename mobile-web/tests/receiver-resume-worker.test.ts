import { createCanvas } from 'canvas';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';

import {
  V2_COMPRESSION,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  type DeqrV2Manifest,
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import { decodeResumeToken } from '../../src/core/resume-token';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { digestToHex } from '../../src/core/sha256-stream';
import { OPFS_DATA_FILE, sessionDirectoryName } from '../src/opfs';
import { ReceiveWorker } from '../src/receive-worker-core';
import { ReceiverStorage } from '../src/receiver-storage';
import {
  RECEIVE_WORKER_PROTOCOL,
  type ReceiveWorkerEvent,
  type ReceiveWorkerRequest,
} from '../src/worker-protocol';
import { FakeStorage, fakeEnvironment } from './helpers/fake-opfs';

/**
 * The phase's gate, stated as the sentence it is written in: a resumable
 * fixture is interrupted, reconstructed after a reload, verified
 * hash-identically, and exported only after verification.
 *
 * "After a reload" is the part that needs a worker rather than a pipeline. A
 * PWA that is backgrounded and restored does not resume an object - it builds a
 * new worker, sends it a new `open`, and everything it recovers comes off the
 * device or does not exist. So the second half of every test below runs against
 * a `ReceiveWorker` constructed from nothing, sharing only the storage.
 *
 * Frames are submitted as decoded payloads rather than through a camera: what
 * is under test here is the session lifecycle across a restart, and rasterising
 * a thousand QR symbols to prove it would test jsQR instead.
 */

const SESSION_ID = 0x5eed_0207;
const FILE_ID = 0x0a0b_0c0f;
const SEGMENT_BYTES = 65_536;
const SYMBOL_BYTES = 512;

const LIMITS = {
  maxDecodePixels: 800 * 800,
  dedupeCapacity: 4_096,
  maxActiveSegments: 2,
  segmentBudgetBytes: 1024 * 1024,
  storageMarginRatio: 0.15,
};

const QR_EDGE = 400;

/** A DEQR frame rendered as a real QR symbol, as RGBA pixels a capture would carry. */
async function qrPixels(bytes: Uint8Array): Promise<ArrayBuffer> {
  const canvas = createCanvas(QR_EDGE, QR_EDGE) as unknown as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, [{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: QR_EDGE,
    color: { dark: '#000', light: '#fff' },
  });
  const image = (canvas as unknown as {
    getContext(type: '2d'): CanvasRenderingContext2D;
  }).getContext('2d').getImageData(0, 0, QR_EDGE, QR_EDGE);
  // Copied, because the worker takes ownership of whatever it is handed.
  return image.data.buffer.slice(0) as ArrayBuffer;
}

function pseudoRandomBytes(length: number, seed = 0x33cc_9977): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b_79f5) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

interface Fixture {
  manifest: DeqrV2Manifest;
  manifestFrame: Uint8Array;
  plan: SegmentPlan;
  payload: Uint8Array;
  directoryName: string;
  segmentFrames(segmentIndex: number): Uint8Array[];
  allFrames(): Uint8Array[];
}

async function fixture(segments = 4): Promise<Fixture> {
  const transportSize = SEGMENT_BYTES * (segments - 1) + 3_000;
  const payload = pseudoRandomBytes(transportSize);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload.buffer as ArrayBuffer));
  const plan = planSegmentation({
    transportSize: BigInt(transportSize),
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
  });

  const manifest: DeqrV2Manifest = {
    featureFlags: 0,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    originalSize: BigInt(transportSize),
    transportSize: BigInt(transportSize),
    segmentSizeBytes: SEGMENT_BYTES,
    symbolSizeBytes: SYMBOL_BYTES,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: digest,
    filename: 'phase07-worker.bin',
    mimeType: 'application/octet-stream',
  };

  const segmentFrames = (segmentIndex: number): Uint8Array[] => {
    const range = segmentByteRange(plan, segmentIndex);
    const encoder = new SegmentEncoder(SYMBOL_BYTES);
    encoder.loadSegment(payload.subarray(Number(range.start), Number(range.end)));
    const frames: Uint8Array[] = [];
    for (let symbolId = 0; symbolId < encoder.sourceSymbolCount; symbolId += 1) {
      const out = new Uint8Array(SYMBOL_BYTES);
      encoder.symbolInto(symbolId, out);
      frames.push(serializeDataFrame({
        frameType: V2_FRAME_TYPE.SOURCE,
        sessionId: SESSION_ID,
        fileId: FILE_ID,
        segmentIndex,
        symbolId,
        sourceSymbolCount: encoder.sourceSymbolCount,
        frameFlags: 0,
        payload: out,
      }));
    }
    return frames;
  };

  return {
    manifest,
    manifestFrame: serializeManifestFrame(manifest),
    plan,
    payload,
    directoryName: sessionDirectoryName(SESSION_ID, FILE_ID),
    segmentFrames,
    allFrames() {
      const frames: Uint8Array[] = [];
      for (let index = 0; index < plan.segmentCount; index += 1) frames.push(...segmentFrames(index));
      return frames;
    },
  };
}

/**
 * One worker, over one fake device.
 *
 * The pipeline inside a worker reaches for OPFS itself, and Node has none - so
 * the storage is injected through the worker's test seam. Everything else is
 * the real message path: the same `handle` a `self.onmessage` would call.
 */
class WorkerHarness {
  readonly events: ReceiveWorkerEvent[] = [];
  readonly worker: ReceiveWorker;
  epoch = 0;

  constructor(storage: FakeStorage) {
    this.worker = new ReceiveWorker(
      (event) => this.events.push(event),
      250,
      () => 1_700_000_000_000,
      {
        storage: new ReceiverStorage({
          environment: { storage, supportsSyncAccess: true },
          now: () => 1_700_000_000_000,
        }),
      },
    );
  }

  send(request: ReceiveWorkerRequest): void {
    this.worker.handle(request);
  }

  open(resume: boolean): number {
    this.epoch += 1;
    this.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch: this.epoch, limits: LIMITS, resume });
    return this.epoch;
  }

  close(reason: 'cancelled' | 'failed' | 'interrupted' | 'completed'): void {
    this.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'close', epoch: this.epoch, reason });
  }

  /** One captured frame through the worker's real message path, jsQR included. */
  frame(pixels: ArrayBuffer): void {
    this.send({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'frame',
      epoch: this.epoch,
      frameId: this.events.length + 1,
      capturedAt: 1_700_000_000_000,
      width: QR_EDGE,
      height: QR_EDGE,
      captureScale: 1,
      pixels,
    });
  }

  /** Hands the worker a decoded payload, bypassing jsQR but not the pipeline. */
  submit(bytes: Uint8Array): void {
    // `handle` is the message seam; the decoded-bytes path below it is what a
    // successful decode reaches. Driving it directly keeps this a test of the
    // session lifecycle rather than of QR rasterisation.
    (this.worker as unknown as { pipeline: { submit(bytes: Uint8Array): unknown } }).pipeline.submit(bytes);
  }

  async storageReady(): Promise<void> {
    await (this.worker as unknown as {
      pipeline: { whenStorageReady(): Promise<void> };
    }).pipeline.whenStorageReady();
  }

  /** Waits on every session this worker has ended, replaced ones included. */
  async settled(): Promise<void> {
    await this.worker.settled();
  }

  progress(): Extract<ReceiveWorkerEvent, { type: 'progress' }>['progress'] {
    const last = [...this.events]
      .reverse()
      .find((event): event is Extract<ReceiveWorkerEvent, { type: 'progress' }> => event.type === 'progress');
    if (!last) throw new Error('the worker has not reported progress');
    return last.progress;
  }

  liveProgress(): Extract<ReceiveWorkerEvent, { type: 'progress' }>['progress'] {
    return (this.worker as unknown as {
      pipeline: { progress(): Extract<ReceiveWorkerEvent, { type: 'progress' }>['progress'] };
    }).pipeline.progress();
  }

  async waitFor(type: ReceiveWorkerEvent['type'], ticks = 200): Promise<ReceiveWorkerEvent> {
    for (let tick = 0; tick < ticks; tick += 1) {
      const found = this.events.find((event) => event.type === type);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`no ${type} event after ${ticks} ticks`);
  }
}

/* --------------------------------------------------------------- the gate */

describe('the acceptance gate: interrupted, reloaded, reconstructed, verified, exported', () => {
  it('carries a transfer across a worker restart and verifies it hash-identically', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();

    // ---- First run. Two of four segments arrive, then the tab goes away.
    const before = new WorkerHarness(storage);
    before.open(true);
    before.submit(at.manifestFrame);
    await before.storageReady();
    for (const index of [0, 1]) for (const frame of at.segmentFrames(index)) before.submit(frame);

    const interrupted = before.liveProgress();
    expect(interrupted.unitsRecovered).toBe(2);
    const token = interrupted.resumeToken;
    expect(token).toBeDefined();

    before.close('interrupted');
    await before.settled();
    expect(storage.sessionNames()).toContain(at.directoryName);

    // ---- Reload. A new worker, holding nothing but the device.
    const after = new WorkerHarness(storage);
    after.open(true);
    after.submit(at.manifestFrame);
    await after.storageReady();

    const resumed = after.liveProgress();
    expect(resumed.resumed).toBe(true);
    expect(resumed.unitsAdopted).toBe(2);
    expect(resumed.unitsRecovered).toBe(2);
    expect(resumed.unitsTotal).toBe(at.plan.segmentCount);

    // ---- The desktop was given the token and restarts from its segment.
    const decoded = decodeResumeToken(token!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.resumeFromSegment).toBe(2);
    for (let index = decoded.value.resumeFromSegment; index < at.plan.segmentCount; index += 1) {
      for (const frame of at.segmentFrames(index)) after.submit(frame);
    }

    // ---- Verification, over the whole reconstruction, exactly as a fresh
    // transfer would run it. A checkpoint is never evidence about bytes.
    after.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'verify', epoch: after.epoch });
    const verified = await after.waitFor('verified');
    if (verified.type !== 'verified') throw new Error('unreachable');
    expect(digestToHex(new Uint8Array(verified.sha256))).toBe(digestToHex(at.manifest.sha256));
    expect(verified.size).toBe(at.payload.length);

    // ---- And the export route is a path, not a payload: the worker closed its
    // handle and named the file for the main thread to open itself.
    expect(verified.source.kind).toBe('opfs');
    if (verified.source.kind !== 'opfs') return;
    expect(verified.source.file).toBe(OPFS_DATA_FILE);
    expect(verified.source.path).toEqual(['deqr', 'sessions', at.directoryName]);
  });

  it('reports verification progress between completion and the verified file', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture(2);
    const harness = new WorkerHarness(storage);
    harness.open(true);
    harness.submit(at.manifestFrame);
    await harness.storageReady();
    for (const frame of at.allFrames()) harness.submit(frame);

    harness.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'verify', epoch: harness.epoch });
    await harness.waitFor('verified');

    const hashes = harness.events.filter(
      (event): event is Extract<ReceiveWorkerEvent, { type: 'verify-progress' }> =>
        event.type === 'verify-progress',
    );
    expect(hashes.length).toBeGreaterThanOrEqual(2);
    expect(hashes[0].bytesHashed).toBe(0);
    expect(hashes[hashes.length - 1].bytesHashed).toBe(at.payload.length);
    expect(hashes.every((event) => event.bytesTotal === at.payload.length)).toBe(true);
    expect(hashes.every((event) => event.epoch === harness.epoch)).toBe(true);
  });

  it('does not resume across a cancel', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();

    const before = new WorkerHarness(storage);
    before.open(true);
    before.submit(at.manifestFrame);
    await before.storageReady();
    for (const frame of at.segmentFrames(0)) before.submit(frame);
    // The user pressed Cancel. Coming back to a half-received file they thought
    // they had thrown away would be a surprise, not a feature.
    before.close('cancelled');
    await before.settled();
    expect(storage.sessionNames()).not.toContain(at.directoryName);

    const after = new WorkerHarness(storage);
    after.open(true);
    after.submit(at.manifestFrame);
    await after.storageReady();
    expect(after.liveProgress().unitsAdopted).toBe(0);
  });

  it('does not resume when the reopened session did not ask to', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();

    const before = new WorkerHarness(storage);
    before.open(true);
    before.submit(at.manifestFrame);
    await before.storageReady();
    for (const frame of at.segmentFrames(0)) before.submit(frame);
    before.close('interrupted');
    await before.settled();

    const after = new WorkerHarness(storage);
    after.open(false);
    after.submit(at.manifestFrame);
    await after.storageReady();
    // The data is on the device and the checkpoint matches. Adoption is still
    // something the main thread grants, per session.
    expect(after.liveProgress().unitsAdopted).toBe(0);
  });

  it('replaces rather than resumes when a session is reopened in place', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const harness = new WorkerHarness(storage);

    harness.open(true);
    harness.submit(at.manifestFrame);
    await harness.storageReady();
    for (const frame of at.segmentFrames(0)) harness.submit(frame);

    // A second `open` on a live worker means the previous session is being
    // replaced, not paused - so its bytes go rather than lingering as debris a
    // resume will never ask for.
    harness.open(true);
    await harness.settled();
    expect(storage.sessionNames()).not.toContain(at.directoryName);
  });

  it('carries the resume token on the progress that actually crosses the port', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const harness = new WorkerHarness(storage);
    harness.open(true);
    harness.submit(at.manifestFrame);
    await harness.storageReady();
    for (const frame of at.segmentFrames(0)) harness.submit(frame);

    // One genuine frame through the whole path - rasterised QR, jsQR, pipeline
    // - because posted progress is what a screen can show, and the shortcut the
    // rest of this file uses to stay fast does not post any. A repeated
    // manifest is the cheapest real frame there is.
    harness.frame(await qrPixels(at.manifestFrame));

    const withSession = harness.events.filter(
      (event): event is Extract<ReceiveWorkerEvent, { type: 'progress' }> =>
        event.type === 'progress' && event.progress.sessionActive,
    );
    expect(withSession.length).toBeGreaterThan(0);

    const progress = withSession[withSession.length - 1].progress;
    expect(progress.unitsRecovered).toBe(1);
    const decoded = decodeResumeToken(progress.resumeToken!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.sessionId).toBe(SESSION_ID);
    expect(decoded.value.fileId).toBe(FILE_ID);
    expect(decoded.value.resumeFromSegment).toBe(1);
  });
});
