import { createCanvas } from 'canvas';
import QRCode from 'qrcode';
import { beforeEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { computeSha256 } from '../../src/core/hash';
import { serializeFrame } from '../../src/core/protocol';
import { qrModuleCount } from '../../src/core/qr-capacity';
import { ReceiveWorker, observationOf } from '../src/receive-worker-core';
import {
  FRAME_OUTCOME,
  RECEIVE_WORKER_PROTOCOL,
  type ReceiveWorkerEvent,
  type ReceiveWorkerRequest,
} from '../src/worker-protocol';

/**
 * The worker's own rules, driven directly.
 *
 * The class takes its `postMessage`, its clock and its staleness threshold as
 * arguments precisely so this can happen without a `Worker`. The frames below
 * are real: a real DEQR frame, rendered to a real QR symbol, rasterised, and
 * handed over as the RGBA buffer a camera capture would transfer.
 */

const LIMITS = {
  maxDecodePixels: 800 * 800,
  dedupeCapacity: 64,
  maxActiveSegments: 2,
  segmentBudgetBytes: 1024 * 1024,
  storageMarginRatio: 0.15,
};

const EDGE = 400;

async function qrPixels(bytes: Uint8Array): Promise<ArrayBuffer> {
  const canvas = createCanvas(EDGE, EDGE) as unknown as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, [{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: EDGE,
    color: { dark: '#000', light: '#fff' },
  });
  const image = (canvas as unknown as {
    getContext(type: '2d'): CanvasRenderingContext2D;
  }).getContext('2d').getImageData(0, 0, EDGE, EDGE);
  // Copied, because the worker takes ownership of whatever it is handed.
  return image.data.buffer.slice(0) as ArrayBuffer;
}

function v1Frames(payload: Uint8Array): Uint8Array[] {
  const container = serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename: 'worker-fixture.bin',
      mimeType: 'application/octet-stream',
      originalSize: payload.length,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256: computeSha256(Buffer.from(payload)),
    },
    payload: Buffer.from(payload),
  });
  const encoder = new FountainEncoder(container, 512, 0x0505_0505);
  return Array.from({ length: encoder.getBlockCount() }, () => new Uint8Array(serializeFrame(encoder.nextFrame())));
}

class Harness {
  readonly events: ReceiveWorkerEvent[] = [];
  clock = 1_700_000_000_000;
  readonly worker: ReceiveWorker;

  constructor(staleFrameMs = 250) {
    this.worker = new ReceiveWorker(
      (event) => this.events.push(event),
      staleFrameMs,
      () => this.clock,
    );
  }

  send(request: ReceiveWorkerRequest): void {
    this.worker.handle(request);
  }

  open(epoch = 1): void {
    this.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch, limits: LIMITS });
  }

  frame(pixels: ArrayBuffer, overrides: Partial<Extract<ReceiveWorkerRequest, { type: 'frame' }>> = {}): void {
    this.send({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'frame',
      epoch: 1,
      frameId: this.events.length + 1,
      capturedAt: this.clock,
      width: EDGE,
      height: EDGE,
      captureScale: 1,
      pixels,
      ...overrides,
    });
  }

  frameEvents(): Array<Extract<ReceiveWorkerEvent, { type: 'frame' }>> {
    return this.events.filter((event): event is Extract<ReceiveWorkerEvent, { type: 'frame' }> => event.type === 'frame');
  }

  /** Waits for an event of one of these types, or gives up. */
  async settle(types: ReadonlyArray<ReceiveWorkerEvent['type']>, ticks = 50): Promise<void> {
    for (let tick = 0; tick < ticks; tick += 1) {
      if (this.events.some((event) => types.includes(event.type))) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  lastProgress(): Extract<ReceiveWorkerEvent, { type: 'progress' }> | undefined {
    return [...this.events].reverse().find((event): event is Extract<ReceiveWorkerEvent, { type: 'progress' }> => event.type === 'progress');
  }
}

describe('the worker decodes real camera pixels into a session', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = new Harness();
  });

  it('accepts a rendered DEQR frame and reports what the camera resolved', async () => {
    const frames = v1Frames(new Uint8Array(600).fill(0x5a));
    harness.open();
    harness.frame(await qrPixels(frames[0]));

    const [result] = harness.frameEvents();
    expect(result.outcome).toBe(FRAME_OUTCOME.ACCEPTED);
    expect(result.decodeMs).toBeGreaterThanOrEqual(0);

    // The Phase 04 hand-off: camera pixels per module, observed rather than swept.
    expect(result.observed).toBeDefined();
    expect(result.observed!.pxPerModule).toBeGreaterThan(1);
    expect(result.observed!.modulesPerSide).toBe(qrModuleCount(result.observed!.qrVersion));
    // Rendered square-on, so the quad's edges should agree with each other.
    expect(result.observed!.spanSkew).toBeGreaterThan(0.95);
  });

  it('answers a repeated frame as a duplicate', async () => {
    const frames = v1Frames(new Uint8Array(600).fill(0x5a));
    const pixels = await qrPixels(frames[0]);
    harness.open();
    harness.frame(pixels.slice(0));
    harness.frame(pixels.slice(0));

    expect(harness.frameEvents().map((event) => event.outcome))
      .toEqual([FRAME_OUTCOME.ACCEPTED, FRAME_OUTCOME.DUPLICATE]);
  });

  it('reports a frame with no code in it without touching the session', async () => {
    const blank = createCanvas(EDGE, EDGE) as unknown as HTMLCanvasElement;
    const context = (blank as unknown as { getContext(t: '2d'): CanvasRenderingContext2D }).getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, EDGE, EDGE);
    harness.open();
    harness.frame(context.getImageData(0, 0, EDGE, EDGE).data.buffer.slice(0) as ArrayBuffer);

    expect(harness.frameEvents()[0].outcome).toBe(FRAME_OUTCOME.NO_CODE);
    expect(harness.lastProgress()!.progress.sessionActive).toBe(false);
  });

  it('finishes and hashes a whole transfer without the main thread', async () => {
    const payload = Uint8Array.from({ length: 900 }, (_, index) => (index * 31 + 7) & 0xff);
    harness.open();
    for (const frame of v1Frames(payload)) harness.frame(await qrPixels(frame));

    expect(harness.lastProgress()!.progress.complete).toBe(true);
    harness.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'verify', epoch: 1 });
    await harness.settle(['verified', 'failed']);

    const failure = harness.events.find((event) => event.type === 'failed');
    expect(failure && failure.type === 'failed' ? failure.code : undefined).toBeUndefined();
    const verified = harness.events.find((event) => event.type === 'verified');
    expect(verified, 'the worker never handed the verified file back').toBeDefined();
    if (!verified || verified.type !== 'verified') return;
    expect(verified.filename).toBe('worker-fixture.bin');
    // v1 reconstructs in memory, so its verified file still crosses the port
    // as bytes. The OPFS route is asserted where it exists, in the store tests.
    expect(verified.source.kind).toBe('bytes');
    if (verified.source.kind !== 'bytes') return;
    expect(verified.size).toBe(payload.length);
    expect(Array.from(new Uint8Array(verified.source.bytes))).toEqual(Array.from(payload));
  }, 20_000);
});

describe('every frame gets exactly one terminal event', () => {
  it('answers a frame that arrived after its session ended', async () => {
    const harness = new Harness();
    const pixels = await qrPixels(v1Frames(new Uint8Array(600))[0]);
    harness.open(1);
    harness.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch: 2, limits: LIMITS });

    // Posted against the old session. The client's slot only comes back
    // because the worker still answers it.
    harness.frame(pixels, { epoch: 1, frameId: 77 });

    const answered = harness.frameEvents().filter((event) => event.frameId === 77);
    expect(answered).toHaveLength(1);
    expect(answered[0].outcome).toBe(FRAME_OUTCOME.STALE);
  });

  it('refuses to decode a capture that has aged out, and says so', async () => {
    const harness = new Harness(250);
    const pixels = await qrPixels(v1Frames(new Uint8Array(600))[0]);
    harness.open();

    const capturedAt = harness.clock;
    // A worker resumed after being descheduled finds captures of a display that
    // has replaced its symbol several times over. Decoding one costs a whole
    // slot for a picture of the past.
    harness.clock += 400;
    harness.frame(pixels, { capturedAt, frameId: 5 });

    const [event] = harness.frameEvents();
    expect(event.outcome).toBe(FRAME_OUTCOME.STALE);
    expect(event.decodeMs).toBe(0);
    expect(event.staleDropped).toBe(1);
  });

  it('answers a frame whose dimensions do not match its buffer', () => {
    const harness = new Harness();
    harness.open();
    harness.frame(new ArrayBuffer(16), { width: EDGE, height: EDGE, frameId: 3 });

    const [event] = harness.frameEvents();
    expect(event.outcome).toBe(FRAME_OUTCOME.NO_CODE);
    expect(event.frameId).toBe(3);
  });

  it('answers a frame larger than the decode budget rather than allocating for it', () => {
    const harness = new Harness();
    harness.open();
    harness.frame(new ArrayBuffer(4), { width: 4_000, height: 4_000, frameId: 4 });
    expect(harness.frameEvents()[0].outcome).toBe(FRAME_OUTCOME.NO_CODE);
  });
});

describe('a session boundary clears what the last one held', () => {
  it('drops the transfer on reset', async () => {
    const harness = new Harness();
    harness.open();
    for (const frame of v1Frames(new Uint8Array(600)).slice(0, 1)) harness.frame(await qrPixels(frame));
    expect(harness.lastProgress()!.progress.sessionActive).toBe(true);

    harness.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'reset', epoch: 1 });
    expect(harness.lastProgress()!.progress.sessionActive).toBe(false);
    expect(harness.lastProgress()!.progress.unitsRecovered).toBe(0);
  });

  it('ignores a verify for a session that has already ended', async () => {
    const harness = new Harness();
    harness.open(1);
    harness.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'close', epoch: 1 });
    harness.send({ v: RECEIVE_WORKER_PROTOCOL, type: 'verify', epoch: 1 });
    await harness.settle(['verified', 'failed'], 5);
    expect(harness.events.some((event) => event.type === 'verified' || event.type === 'failed')).toBe(false);
  });
});

describe('the optical observation is derived, so it is checked against a known quad', () => {
  const square = (span: number) => ({
    topLeftCorner: { x: 10, y: 10 },
    topRightCorner: { x: 10 + span, y: 10 },
    bottomRightCorner: { x: 10 + span, y: 10 + span },
    bottomLeftCorner: { x: 10, y: 10 + span },
  });

  it('divides by the symbol module count, not by a quiet-zone-inclusive one', () => {
    // Version 18 is 89 modules across. A 356 px span is exactly 4 px per
    // module - the density the Balanced profile is specified against. Dividing
    // by the quiet-zone-inclusive 97 would report 3.67 and quietly fail a
    // profile that was in fact being met.
    const observed = observationOf({ version: 18, location: square(356) }, 720, 1);
    expect(observed!.modulesPerSide).toBe(89);
    expect(observed!.pxPerModule).toBeCloseTo(4, 6);
    expect(observed!.spanSkew).toBeCloseTo(1, 6);
  });

  it('reports skew when the phone is held at an angle', () => {
    const oblique = {
      topLeftCorner: { x: 0, y: 0 },
      topRightCorner: { x: 200, y: 0 },
      bottomRightCorner: { x: 200, y: 100 },
      bottomLeftCorner: { x: 0, y: 100 },
    };
    const observed = observationOf({ version: 10, location: oblique }, 720, 1);
    expect(observed!.spanSkew).toBeCloseTo(0.5, 6);
    // The mean of the four edges, so neither the near nor the far edge alone
    // decides what the camera is reported to have resolved.
    expect(observed!.symbolSpanPx).toBeCloseTo(150, 6);
  });

  it('reports nothing rather than a density it cannot justify', () => {
    expect(observationOf({ version: 99, location: square(400) }, 720, 1)).toBeUndefined();
    expect(observationOf({ version: 10, location: square(0) }, 720, 1)).toBeUndefined();
    expect(observationOf({ version: 10, location: {} }, 720, 1)).toBeUndefined();
  });

  it('carries the capture scale so a downscaled ROI can be rescaled later', () => {
    const observed = observationOf({ version: 10, location: square(200) }, 720, 0.75);
    expect(observed!.captureScale).toBe(0.75);
    expect(observed!.captureEdgePx).toBe(720);
  });
});
