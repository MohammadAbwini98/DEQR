import { describe, expect, it } from 'vitest';
import { computeSha256 } from '../../src/core/hash';
import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { serializeFrame } from '../../src/core/protocol';
import {
  HEADER_SIZE,
  LIMITS,
  PROTOCOL_VERSION as MOBILE_PROTOCOL_VERSION,
  ReceiverSession,
  parseFrame,
} from '../src/protocol';

function checksumHeader(raw: Uint8Array): void {
  raw[HEADER_SIZE - 1] = raw
    .subarray(0, HEADER_SIZE - 1)
    .reduce((checksum, byte) => checksum ^ byte, 0);
}

function malformedOverdeclaredFrame(): Uint8Array {
  const blockSize = 512;
  const raw = new Uint8Array(HEADER_SIZE + blockSize);
  const view = new DataView(raw.buffer);
  view.setUint8(0, MOBILE_PROTOCOL_VERSION);
  view.setUint32(1, 0x01020304);
  view.setUint16(5, 0);
  view.setUint32(7, 0);
  view.setUint16(11, 65);
  view.setUint16(13, blockSize);
  view.setUint32(15, 1);
  checksumHeader(raw);
  return raw;
}

function completeCandidate(bytes = Uint8Array.of(1, 2, 3, 4)): ReceiverSession {
  const container = serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename: 'fixture.bin',
      mimeType: 'application/octet-stream',
      originalSize: bytes.length,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256: computeSha256(Buffer.from(bytes)),
    },
    payload: Buffer.from(bytes),
  });
  const encoder = new FountainEncoder(container, 512, 0x55667788);
  const receiver = new ReceiverSession();
  for (let index = 0; index < encoder.getBlockCount(); index += 1) {
    receiver.receive(new Uint8Array(serializeFrame(encoder.nextFrame())));
  }
  return receiver;
}

describe('PWA ReceiverSession bounds and terminal lifecycle', () => {
  it('rejects a canonically impossible frame before receiver allocation, then resets cleanly', () => {
    const malformed = malformedOverdeclaredFrame();
    expect(parseFrame(malformed)).toMatchObject({
      ok: false,
      error: { code: 'RESOURCE_LIMIT_EXCEEDED' },
    });

    const receiver = new ReceiverSession();
    const failed = receiver.receive(malformed);
    expect(failed).toMatchObject({
      state: 'FAILED',
      receivedBlocks: 0,
      totalBlocks: 0,
      error: { code: 'RESOURCE_LIMIT_EXCEEDED' },
      verified: undefined,
    });

    expect(receiver.reset()).toEqual({
      state: 'READY',
      filename: undefined,
      receivedBlocks: 0,
      totalBlocks: 0,
      duplicates: 0,
      foreignFrames: 0,
      error: undefined,
      verified: undefined,
    });
  });

  it('rejects frame bytes beyond the hard camera-input bound', () => {
    const oversized = new Uint8Array(LIMITS.maxFrameBytes + 1);
    const parsed = parseFrame(oversized);

    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'INVALID_FRAME' },
    });
  });

  it('shares one in-flight verification and remains terminal after completion', async () => {
    const receiver = completeCandidate();
    expect(receiver.snapshot().state).toBe('VERIFYING');

    const first = receiver.verify();
    const second = receiver.verify();
    expect(second).toBe(first);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.state).toBe('COMPLETE');
    expect(secondResult.state).toBe('COMPLETE');
    expect(firstResult.verified?.bytes).toEqual(Uint8Array.of(1, 2, 3, 4));

    expect(receiver.receive(malformedOverdeclaredFrame())).toMatchObject({
      state: 'COMPLETE',
      verified: { filename: 'fixture.bin' },
    });
  });

  it('invalidates a stale verification after cancellation and clears verified output', async () => {
    const receiver = completeCandidate(Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff));
    const verification = receiver.verify();

    expect(receiver.cancel()).toMatchObject({
      state: 'CANCELLED',
      receivedBlocks: 0,
      totalBlocks: 0,
      verified: undefined,
    });
    expect((await verification)).toMatchObject({
      state: 'CANCELLED',
      verified: undefined,
    });
  });
});
