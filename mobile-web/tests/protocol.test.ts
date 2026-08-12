import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { computeSha256 } from '../../src/core/hash';
import { serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { serializeFrame } from '../../src/core/protocol';
import { LIMITS, ReceiverSession, parseFrame, sanitizeFilename } from '../src/protocol';

function transfer(bytes: Uint8Array, filename = 'report.bin') {
  const container = serializeContainer({ metadata: { protocolVersion: 1, filename, mimeType: 'application/octet-stream', originalSize: bytes.length, compressed: false, encrypted: false, timestamp: 0, sha256: computeSha256(Buffer.from(bytes)) }, payload: Buffer.from(bytes) });
  return new FountainEncoder(container, 512, 0x10203040);
}

describe('DEQR mobile-web receiver protocol', () => {
  it('reconstructs desktop-generated frames received out of order with duplicates and verifies SHA-256', async () => {
    const source = Uint8Array.from({ length: 1700 }, (_, i) => i & 0xff); const encoder = transfer(source, 'Résumé 2026.bin'); const frames = Array.from({ length: 12 }, () => new Uint8Array(serializeFrame(encoder.nextFrame())));
    const receiver = new ReceiverSession(); for (const index of [3, 0, 3, 2, 1, 4, 5, 6, 7, 8, 9, 10, 11]) { receiver.receive(frames[index]); }
    const complete = await receiver.verify(); expect(complete.state).toBe('COMPLETE'); expect(complete.verified?.filename).toBe('Résumé 2026.bin'); expect(complete.verified?.bytes).toEqual(source); expect(complete.duplicates).toBe(1);
  });

  it('does not allow a foreign session to contaminate the active transfer', () => {
    const primary = transfer(Uint8Array.of(1, 2, 3)); const foreign = new FountainEncoder(Buffer.from([9, 8, 7]), 512, 5); const receiver = new ReceiverSession(); receiver.receive(new Uint8Array(serializeFrame(primary.nextFrame()))); const before = receiver.snapshot(); const after = receiver.receive(new Uint8Array(serializeFrame(foreign.nextFrame()))); expect(after.receivedBlocks).toBe(before.receivedBlocks); expect(after.state).toBe(before.state);
  });

  it('rejects a conflicting duplicate sequence number', () => {
    const encoder = transfer(Uint8Array.of(1, 2, 3)); const raw = new Uint8Array(serializeFrame(encoder.nextFrame())); const conflicting = raw.slice(); conflicting[30] ^= 0xff; const receiver = new ReceiverSession(); receiver.receive(raw); expect(receiver.receive(conflicting).error?.code).toBe('CONFLICTING_DUPLICATE');
  });

  it('rejects malformed, oversized, truncated, and unsupported protocol frame declarations', () => {
    const encoder = transfer(Uint8Array.of(1)); const raw = new Uint8Array(serializeFrame(encoder.nextFrame())); const truncated = raw.slice(0, raw.length - 1); expect(parseFrame(truncated).ok).toBe(false); const badVersion = raw.slice(); badVersion[0] = 2; badVersion[19] = badVersion.slice(0, 19).reduce((a, b) => a ^ b, 0); expect(parseFrame(badVersion)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_PROTOCOL' } }); const huge = raw.slice(); new DataView(huge.buffer).setUint16(11, LIMITS.maxBlockCount); new DataView(huge.buffer).setUint16(13, LIMITS.maxBlockSize + 1); huge[19] = huge.slice(0, 19).reduce((a, b) => a ^ b, 0); expect(parseFrame(huge).ok).toBe(false);
  });

  it('keeps unsafe filename metadata out of export names while retaining Unicode and spaces', async () => {
    const source = Uint8Array.of(1, 2, 3, 4); const encoder = transfer(source, '../  تقرير final .pdf'); const receiver = new ReceiverSession(); for (let i = 0; i < 4; i++) receiver.receive(new Uint8Array(serializeFrame(encoder.nextFrame()))); const result = await receiver.verify(); expect(result.verified?.filename).toBe('تقرير final .pdf'); expect(sanitizeFilename('a/b\\c..\u0000.txt')).toBe('a_b_c_.txt');
  });

  it('never completes when the sender digest does not match', async () => {
    const source = Uint8Array.of(1, 2, 3); const container = serializeContainer({ metadata: { protocolVersion: 1, filename: 'bad.bin', mimeType: 'application/octet-stream', originalSize: source.length, compressed: false, encrypted: false, timestamp: 0, sha256: Buffer.alloc(32, 0xff) }, payload: Buffer.from(source) }); const encoder = new FountainEncoder(container, 512, 9); const receiver = new ReceiverSession(); receiver.receive(new Uint8Array(serializeFrame(encoder.nextFrame()))); expect((await receiver.verify()).error?.code).toBe('HASH_MISMATCH');
  });

  it('decompresses a desktop-compatible gzip container within its declared output bound', async () => {
    const source = Uint8Array.from({ length: 1024 }, (_, i) => i % 7); const container = serializeContainer({ metadata: { protocolVersion: 1, filename: 'compressed.bin', mimeType: 'application/octet-stream', originalSize: source.length, compressed: true, encrypted: false, timestamp: 0, sha256: computeSha256(Buffer.from(source)) }, payload: gzipSync(source) }); const encoder = new FountainEncoder(container, 512, 42); const receiver = new ReceiverSession(); for (let i = 0; i < 8; i++) receiver.receive(new Uint8Array(serializeFrame(encoder.nextFrame()))); const result = await receiver.verify(); expect(result.state).toBe('COMPLETE'); expect(result.verified?.bytes).toEqual(source);
  });

  it('rejects a reconstructed container with a blocked received-file extension', async () => {
    const encoder = transfer(Uint8Array.of(1, 2, 3), 'untrusted.CmD');
    const receiver = new ReceiverSession();
    for (let i = 0; i < encoder.getBlockCount(); i++) receiver.receive(new Uint8Array(serializeFrame(encoder.nextFrame())));

    const result = await receiver.verify();
    expect(result.state).toBe('FAILED');
    expect(result.error?.code).toBe('FILE_TYPE_BLOCKED');
    expect(result.verified).toBeUndefined();
  });

  it('rejects gzip data that expands beyond its declared output size before completion', async () => {
    const expanded = Uint8Array.from({ length: 16 * 1024 }, () => 0x41);
    const container = serializeContainer({
      metadata: {
        protocolVersion: 1,
        filename: 'declared-small.bin',
        mimeType: 'application/octet-stream',
        originalSize: 512,
        compressed: true,
        encrypted: false,
        timestamp: 0,
        sha256: computeSha256(Buffer.from(expanded)),
      },
      payload: gzipSync(expanded),
    });
    const encoder = new FountainEncoder(container, 512, 43);
    const receiver = new ReceiverSession();
    for (let i = 0; i < encoder.getBlockCount(); i++) receiver.receive(new Uint8Array(serializeFrame(encoder.nextFrame())));

    const result = await receiver.verify();
    expect(result.state).toBe('FAILED');
    expect(result.error?.code).toBe('SIZE_MISMATCH');
    expect(result.verified).toBeUndefined();
  });
});
