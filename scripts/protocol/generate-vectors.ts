import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { serializeContainer, DeqrContainer, MAX_FILE_SIZE } from '../../src/core/container';
import { serializeFrame, Frame } from '../../src/core/protocol';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { PRNG, RobustSoliton } from '../../src/core/prng';

const VECTORS_DIR = path.resolve(__dirname, '../../protocol/test-vectors');
const GENERATED_AT = '2026-08-07T17:10:00.000Z';
const SESSION_ID = 0x12345678;
const BLOCK_SIZE = 32;

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function resetVectorDirectory(): void {
  fs.rmSync(VECTORS_DIR, { recursive: true, force: true });
  fs.mkdirSync(VECTORS_DIR, { recursive: true });
}

function write(name: string, data: Buffer): void {
  fs.writeFileSync(path.join(VECTORS_DIR, name), data);
}

function makeContainer(filename: string, mimeType: string, payload: Buffer, timestamp: number): { container: Buffer; digest: Buffer } {
  const digest = sha256(payload);
  const model: DeqrContainer = {
    metadata: {
      protocolVersion: 1,
      filename,
      mimeType,
      originalSize: payload.length,
      compressed: false,
      encrypted: false,
      timestamp,
      sha256: digest,
    },
    payload,
  };
  return { container: serializeContainer(model), digest };
}

function repairExpectation(sequenceNumber: number, blockCount: number) {
  const prng = new PRNG(sequenceNumber);
  const soliton = new RobustSoliton(blockCount);
  const degree = soliton.sampleDegree(prng);
  const neighbors: number[] = [];
  const seen = new Set<number>();
  while (neighbors.length < degree) {
    const index = prng.nextInt(0, blockCount);
    if (!seen.has(index)) {
      seen.add(index);
      neighbors.push(index);
    }
  }
  return { degree, neighbors };
}

function prngVector(seed: number): number[] {
  const prng = new PRNG(seed);
  return Array.from({ length: 5 }, () => Math.floor(prng.next() * 4294967296));
}

function main(): void {
  resetVectorDirectory();

  const txtData = Buffer.from('Hello DEQR Fountain Protocol! Optical Transfer Vector Test 2026.\n', 'utf8');
  const pdfData = Buffer.alloc(5000);
  for (let i = 0; i < pdfData.length; i++) pdfData[i] = (i * 17 + 3) & 0xff;
  const zipData = Buffer.alloc(20000);
  for (let i = 0; i < zipData.length; i++) zipData[i] = (i * 31 + 101) & 0xff;

  const txt = makeContainer('hello.txt', 'text/plain', txtData, 1770480000000);
  const pdf = makeContainer('document.pdf', 'application/pdf', pdfData, 1770480001000);
  const zip = makeContainer('archive.zip', 'application/zip', zipData, 1770480002000);

  write('container-txt.bin', txt.container);
  write('container-pdf.bin', pdf.container);
  write('container-zip.bin', zip.container);

  const encoder = new FountainEncoder(txt.container, BLOCK_SIZE, SESSION_ID);
  const blockCount = encoder.getBlockCount();
  const systematicFrames: string[] = [];
  const generatedFrames: Frame[] = [];

  for (let sequence = 0; sequence < blockCount; sequence++) {
    const frame = encoder.nextFrame();
    generatedFrames.push(frame);
    const name = `frame-systematic-${String(sequence + 1).padStart(3, '0')}.bin`;
    systematicFrames.push(name);
    write(name, serializeFrame(frame));
  }

  const repairFrames: string[] = [];
  for (let i = 0; i < 2; i++) {
    const frame = encoder.nextFrame();
    generatedFrames.push(frame);
    const name = `frame-repair-${String(i + 1).padStart(3, '0')}.bin`;
    repairFrames.push(name);
    write(name, serializeFrame(frame));
  }

  const firstFrame = serializeFrame(generatedFrames[0]);
  const corrupt = Buffer.from(firstFrame);
  corrupt[19] ^= 0xff;
  write('corrupt-frame-crc.bin', corrupt);
  write('truncated-frame.bin', firstFrame.subarray(0, 15));
  write('trailing-container.bin', Buffer.concat([txt.container, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01])]));

  const inconsistent: Frame = {
    header: { ...generatedFrames[0].header, sessionId: SESSION_ID + 1, sequenceNumber: 99 },
    payload: Buffer.from(generatedFrames[0].payload),
  };
  write('inconsistent-session-frame.bin', serializeFrame(inconsistent));

  const oversized: Frame = {
    header: {
      ...generatedFrames[0].header,
      blockCount: 1,
      totalPayloadLength: MAX_FILE_SIZE + 1,
      sequenceNumber: 0,
    },
    payload: Buffer.from(generatedFrames[0].payload),
  };
  write('oversized-payload-frame.bin', serializeFrame(oversized));

  const manifest = {
    generatedAt: GENERATED_AT,
    protocolVersion: 1,
    testCases: {
      txtContainer: {
        file: 'container-txt.bin', sizeBytes: txt.container.length, filename: 'hello.txt', mimeType: 'text/plain',
        originalSize: txtData.length, sha256Hex: txt.digest.toString('hex'), timestamp: 1770480000000,
        compressed: false, encrypted: false,
      },
      pdfContainer: {
        file: 'container-pdf.bin', sizeBytes: pdf.container.length, filename: 'document.pdf', mimeType: 'application/pdf',
        originalSize: pdfData.length, sha256Hex: pdf.digest.toString('hex'), timestamp: 1770480001000,
        compressed: false, encrypted: false,
      },
      zipContainer: {
        file: 'container-zip.bin', sizeBytes: zip.container.length, filename: 'archive.zip', mimeType: 'application/zip',
        originalSize: zipData.length, sha256Hex: zip.digest.toString('hex'), timestamp: 1770480002000,
        compressed: false, encrypted: false,
      },
      fountainStream: {
        sessionId: SESSION_ID,
        blockSize: BLOCK_SIZE,
        blockCount,
        totalPayloadLength: txt.container.length,
        systematicFrames,
        repairFrames,
        repairExpectations: {
          [blockCount]: repairExpectation(blockCount, blockCount),
          [blockCount + 1]: repairExpectation(blockCount + 1, blockCount),
        },
      },
      prngVectors: {
        '0': prngVector(0),
        '1': prngVector(1),
        '5': prngVector(5),
        '6': prngVector(6),
        '305419896': prngVector(305419896),
        '4294967295': prngVector(0xffffffff),
      },
      malformedAttackVectors: {
        corruptCrcFrame: 'corrupt-frame-crc.bin',
        truncatedFrame: 'truncated-frame.bin',
        trailingContainer: 'trailing-container.bin',
        inconsistentSessionFrame: 'inconsistent-session-frame.bin',
        oversizedPayloadFrame: 'oversized-payload-frame.bin',
      },
    },
  };

  fs.writeFileSync(path.join(VECTORS_DIR, 'expected.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Generated ${Object.keys(manifest.testCases.malformedAttackVectors).length + systematicFrames.length + repairFrames.length + 3} binary vectors plus expected.json`);
}

main();
