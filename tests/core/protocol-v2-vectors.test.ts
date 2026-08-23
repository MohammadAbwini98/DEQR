import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  V2_FRAME_TYPE,
  parseDataFrame,
  parseFrame,
  parseManifestFrame,
} from '../../src/core/protocol-v2';

const VECTORS_DIR = path.resolve(__dirname, '../../protocol/test-vectors-v2');

interface VectorRecord {
  file: string;
  byteLength: number;
  sha256: string;
  description: string;
  expect:
    | { kind: 'manifest'; manifest: Record<string, unknown> }
    | { kind: 'data'; frame: Record<string, unknown> }
    | { kind: 'reject'; code: string };
}

const expected = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, 'expected.json'), 'utf8')) as {
  schemaVersion: number;
  constants: Record<string, unknown>;
  vectors: VectorRecord[];
};

function readVector(file: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(VECTORS_DIR, file)));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('DEQR v2 golden vectors', () => {
  it('ships the vector set the generator describes', () => {
    expect(expected.schemaVersion).toBe(1);
    expect(expected.vectors.length).toBeGreaterThanOrEqual(20);
    const onDisk = fs.readdirSync(VECTORS_DIR).filter((name) => name.endsWith('.bin')).sort();
    expect(onDisk).toEqual(expected.vectors.map((vector) => vector.file).sort());
  });

  it.each(expected.vectors.map((vector) => [vector.file, vector] as const))(
    '%s is byte-identical to its recorded digest',
    (_file, vector) => {
      const bytes = readVector(vector.file);
      expect(bytes.length).toBe(vector.byteLength);
      expect(sha256Hex(bytes)).toBe(vector.sha256);
    },
  );

  const manifests = expected.vectors.filter((vector) => vector.expect.kind === 'manifest');
  it.each(manifests.map((vector) => [vector.file, vector] as const))(
    '%s parses to its recorded manifest fields',
    (_file, vector) => {
      if (vector.expect.kind !== 'manifest') throw new Error('unreachable');
      const parsed = parseManifestFrame(readVector(vector.file));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const value = parsed.value;
      expect({
        featureFlags: value.featureFlags,
        sessionId: value.sessionId,
        fileId: value.fileId,
        originalSize: value.originalSize.toString(),
        transportSize: value.transportSize.toString(),
        segmentSizeBytes: value.segmentSizeBytes,
        symbolSizeBytes: value.symbolSizeBytes,
        segmentCount: value.segmentCount,
        fecProfileId: value.fecProfileId,
        compressionMode: value.compressionMode,
        compressionParam: value.compressionParam,
        transportProfileId: 0,
        sha256: Buffer.from(value.sha256).toString('hex'),
        filename: value.filename,
        mimeType: value.mimeType,
      }).toEqual(vector.expect.manifest);
    },
  );

  const frames = expected.vectors.filter((vector) => vector.expect.kind === 'data');
  it.each(frames.map((vector) => [vector.file, vector] as const))(
    '%s parses to its recorded frame fields',
    (_file, vector) => {
      if (vector.expect.kind !== 'data') throw new Error('unreachable');
      const parsed = parseDataFrame(readVector(vector.file));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const value = parsed.value;
      expect({
        frameType: value.frameType,
        sessionId: value.sessionId,
        fileId: value.fileId,
        segmentIndex: value.segmentIndex,
        symbolId: value.symbolId,
        sourceSymbolCount: value.sourceSymbolCount,
        frameFlags: value.frameFlags,
        payloadLength: value.payload.length,
        payloadSha256: sha256Hex(value.payload),
      }).toEqual(vector.expect.frame);
    },
  );

  const rejections = expected.vectors.filter((vector) => vector.expect.kind === 'reject');
  it.each(rejections.map((vector) => [vector.file, vector] as const))(
    '%s is rejected with its recorded code',
    (_file, vector) => {
      if (vector.expect.kind !== 'reject') throw new Error('unreachable');
      const result = parseFrame(readVector(vector.file));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(vector.expect.code);
    },
  );

  it('keeps the final segment padded to a full symbol', () => {
    // A short final segment still emits a full-size symbol, zero-filled past
    // the real data. XOR repair needs every symbol in a segment to be the same
    // length, so shortening the last one would break recovery, not save bytes.
    const parsed = parseDataFrame(readVector('frame-source-last-segment.bin'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.payload.length).toBe(expected.constants.symbolSizeBytes);
    expect(parsed.value.sourceSymbolCount).toBe(expected.constants.symbolsInLastSegment);
    const realBytes = Number(expected.constants.lastSegmentBytes);
    expect(parsed.value.payload.subarray(realBytes).every((byte) => byte === 0)).toBe(true);
  });

  it('keeps a manifest for a 5 GiB transfer inside one small QR payload', () => {
    const bytes = readVector('manifest-5gib.bin');
    expect(bytes.length).toBeLessThan(200);
    const parsed = parseManifestFrame(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.originalSize).toBe(5n * 1024n * 1024n * 1024n);
  });

  it('routes every non-rejection vector through parseFrame with the right kind', () => {
    for (const vector of expected.vectors) {
      if (vector.expect.kind === 'reject') continue;
      const result = parseFrame(readVector(vector.file));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.kind).toBe(vector.expect.kind);
      if (result.value.kind === 'data') {
        expect([V2_FRAME_TYPE.SOURCE, V2_FRAME_TYPE.REPAIR]).toContain(result.value.frame.frameType);
      }
    }
  });
});
