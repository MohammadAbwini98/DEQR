import { describe, expect, it } from 'vitest';
import { createCanvas } from 'canvas';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { computeSha256 } from '../../src/core/hash';
import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { serializeFrame } from '../../src/core/protocol';
import { ReceiverSession, parseFrame } from '../src/protocol';

/**
 * Mirrors the desktop sender exactly: `QRCanvas` paints byte-mode frames at
 * 400 px with margin 4 and error correction L. Any drift here stops being a
 * composition test and starts testing a hypothetical sender.
 */
const SENDER_QR_OPTIONS = {
  errorCorrectionLevel: 'L' as const,
  margin: 4,
  width: 400,
  color: { dark: '#000000', light: '#ffffff' },
};

/** The desktop v1 fountain block size from `session-manager.ts`. */
const BLOCK_SIZE = 512;

async function paintAndDecode(frameBytes: Uint8Array): Promise<Uint8Array> {
  const canvas = createCanvas(SENDER_QR_OPTIONS.width, SENDER_QR_OPTIONS.width) as unknown as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, [{ data: frameBytes, mode: 'byte' }], SENDER_QR_OPTIONS);
  const context = (canvas as unknown as { getContext(type: '2d'): CanvasRenderingContext2D }).getContext('2d');
  const image = context.getImageData(0, 0, SENDER_QR_OPTIONS.width, SENDER_QR_OPTIONS.width);
  const decoded = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  if (!decoded?.binaryData) throw new Error('jsQR did not decode a painted desktop frame.');
  return new Uint8Array(decoded.binaryData);
}

function senderContainer(source: Buffer, filename: string): Buffer {
  return serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename,
      mimeType: 'application/octet-stream',
      originalSize: source.length,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256: computeSha256(source),
    },
    payload: source,
  });
}

/** Deterministic drop decisions, so a failure reproduces exactly. */
function lossSequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Drives the real production path end to end with frames dropped on the way,
 * which is what an optical link actually does. The QR raster step is exercised
 * separately by `serialized-frame-qr-fidelity` and `qr-binary-fidelity`; at
 * these sizes painting every frame would cost minutes without testing anything
 * those two do not already prove byte-for-byte.
 */
async function transferUnderLoss(source: Buffer, lossPercent: number, seed: number) {
  const encoder = new FountainEncoder(senderContainer(source, 'matrix.bin'), BLOCK_SIZE, seed);
  const receiver = new ReceiverSession();
  const blockCount = encoder.getBlockCount();
  const nextRandom = lossSequence(seed);
  const frameBudget = blockCount * 4 + 512;

  let emitted = 0;
  let accepted = 0;
  let snapshot = receiver.snapshot();
  while (emitted < frameBudget && snapshot.state !== 'VERIFYING') {
    const frame = new Uint8Array(serializeFrame(encoder.nextFrame()));
    emitted += 1;
    if (nextRandom() * 100 < lossPercent) continue;
    accepted += 1;
    snapshot = receiver.receive(frame);
    if (snapshot.state === 'FAILED') throw new Error('receiver rejected a valid frame');
  }

  expect(snapshot.state, `did not complete within ${frameBudget} frames`).toBe('VERIFYING');
  const verified = await receiver.verify();
  return { verified, blockCount, emitted, accepted };
}

describe('desktop to PWA reconstruction matrix', () => {
  it.each([
    ['5 KiB', 5 * 1024, 20],
    ['100 KiB', 100 * 1024, 20],
    ['500 KiB', 500 * 1024, 15],
    ['1 MiB', 1024 * 1024, 10],
  ])('reconstructs %s byte-for-byte under simulated frame loss', async (_label, size, loss) => {
    const source = Buffer.from(Uint8Array.from({ length: size }, (_, index) => (index * 131 + 29) & 0xff));
    const { verified, blockCount, emitted, accepted } = await transferUnderLoss(source, loss, 0x5eed_1234);

    expect(blockCount).toBe(Math.ceil((size + 60) / BLOCK_SIZE));
    expect(accepted).toBeLessThan(emitted);
    expect(verified.state).toBe('COMPLETE');
    expect(Buffer.from(verified.verified!.bytes)).toEqual(source);
    expect(Buffer.from(verified.verified!.sha256)).toEqual(computeSha256(source));
  }, 300_000);
});

describe('desktop sender to PWA receiver composition', () => {
  it('reconstructs and verifies a multi-frame transfer through real painted QR codes', async () => {
    const source = Buffer.from(Uint8Array.from({ length: 2 * 1024 }, (_, index) => (index * 31 + 7) & 0xff));
    const encoder = new FountainEncoder(senderContainer(source, 'composition.bin'), BLOCK_SIZE, 0x0a0b0c0d);
    const receiver = new ReceiverSession();

    expect(encoder.getBlockCount()).toBeGreaterThan(1);

    let snapshot = receiver.snapshot();
    for (let index = 0; index < encoder.getBlockCount(); index += 1) {
      const painted = await paintAndDecode(new Uint8Array(serializeFrame(encoder.nextFrame())));
      expect(painted).toHaveLength(20 + BLOCK_SIZE);
      snapshot = receiver.receive(painted);
    }

    expect(snapshot).toMatchObject({
      state: 'VERIFYING',
      receivedBlocks: encoder.getBlockCount(),
      totalBlocks: encoder.getBlockCount(),
      duplicates: 0,
    });

    const verified = await receiver.verify();
    expect(verified.state).toBe('COMPLETE');
    expect(verified.verified?.filename).toBe('composition.bin');
    expect(Buffer.from(verified.verified!.bytes)).toEqual(source);
    expect(Buffer.from(verified.verified!.sha256)).toEqual(computeSha256(source));
  }, 60_000);

  it('recovers from repair frames after systematic frames are missed, ignoring duplicates', async () => {
    const source = Buffer.from(Uint8Array.from({ length: 2 * 1024 }, (_, index) => (index * 17 + 3) & 0xff));
    const encoder = new FountainEncoder(senderContainer(source, 'repair.bin'), BLOCK_SIZE, 0x11223344);
    const blockCount = encoder.getBlockCount();
    const receiver = new ReceiverSession();

    // A phone that starts scanning late misses the first systematic frames and
    // must rebuild them from repair symbols alone.
    const missed = 2;
    const painted: Uint8Array[] = [];
    for (let index = 0; index < blockCount + 40; index += 1) {
      const frame = new Uint8Array(serializeFrame(encoder.nextFrame()));
      if (index < missed) continue;
      painted.push(await paintAndDecode(frame));
    }

    let snapshot = receiver.snapshot();
    let duplicatesFed = 0;
    for (const frame of painted) {
      snapshot = receiver.receive(frame);
      // Camera oversampling re-reads the same displayed code constantly.
      snapshot = receiver.receive(frame);
      duplicatesFed += 1;
      if (snapshot.state === 'VERIFYING') break;
    }

    expect(snapshot.state).toBe('VERIFYING');
    expect(snapshot.duplicates).toBe(duplicatesFed);
    expect(snapshot.receivedBlocks).toBe(blockCount);

    const verified = await receiver.verify();
    expect(verified.state).toBe('COMPLETE');
    expect(Buffer.from(verified.verified!.bytes)).toEqual(source);
  }, 120_000);

  it('keeps a foreign session from corrupting the active transfer', async () => {
    const source = Buffer.from(Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff));
    const active = new FountainEncoder(senderContainer(source, 'active.bin'), BLOCK_SIZE, 0x00c0ffee);
    const foreign = new FountainEncoder(senderContainer(source, 'foreign.bin'), BLOCK_SIZE, 0x0badf00d);
    const receiver = new ReceiverSession();

    const first = await paintAndDecode(new Uint8Array(serializeFrame(active.nextFrame())));
    expect(receiver.receive(first).state).toBe('RECEIVING');

    const intruder = await paintAndDecode(new Uint8Array(serializeFrame(foreign.nextFrame())));
    expect(parseFrame(intruder).ok).toBe(true);
    const afterIntruder = receiver.receive(intruder);
    expect(afterIntruder.state).toBe('RECEIVING');
    expect(afterIntruder.receivedBlocks).toBe(1);

    let snapshot = afterIntruder;
    for (let index = 1; index < active.getBlockCount(); index += 1) {
      snapshot = receiver.receive(await paintAndDecode(new Uint8Array(serializeFrame(active.nextFrame()))));
    }

    expect(snapshot.state).toBe('VERIFYING');
    const verified = await receiver.verify();
    expect(verified.state).toBe('COMPLETE');
    expect(verified.verified?.filename).toBe('active.bin');
  }, 60_000);
});
