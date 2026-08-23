/**
 * Deterministic DEQR v2 golden vector generator.
 *
 * Writes byte-for-byte fixtures for the v2 manifest and data frames, plus the
 * malformed inputs the parser must reject, into `protocol/test-vectors-v2/`.
 * Everything is derived from fixed constants, so regenerating on any machine
 * must produce an identical tree — `tests/core/protocol-v2-vectors.test.ts`
 * asserts the shipped files still match what this produces.
 *
 * The v1 vectors in `protocol/test-vectors/` are untouched. v2 is an addition,
 * not a replacement, and the C# parity suite still reads the v1 set.
 *
 *   node node_modules/vite-node/vite-node.mjs scripts/protocol/generate-v2-vectors.ts
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DeqrV2Manifest,
  V2_COMPRESSION,
  V2_COMPRESSION_WINDOW,
  V2_DATA_LAYOUT,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  V2_MANIFEST_LAYOUT,
  planSegmentation,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
} from '../../src/core/protocol-v2.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = path.resolve(here, '../../protocol/test-vectors-v2');

const SESSION_ID = 0x5eed_1234;
const FILE_ID = 0x0a0b_0c0d;
const SYMBOL_SIZE = 4_096;
const SEGMENT_SIZE = 65_536;
/** 200,000 transport bytes: four segments, the last one deliberately partial. */
const TRANSPORT_SIZE = 200_000n;

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

const records: VectorRecord[] = [];

/** Deterministic bytes. The same generator the Phase 00 harness uses. */
function deterministicBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function digestHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function write(file: string, bytes: Uint8Array, description: string, expect: VectorRecord['expect']): void {
  fs.writeFileSync(path.join(VECTORS_DIR, file), bytes);
  records.push({ file, byteLength: bytes.length, sha256: digestHex(bytes), description, expect });
}

function manifestExpectation(manifest: DeqrV2Manifest): Record<string, unknown> {
  return {
    featureFlags: manifest.featureFlags,
    sessionId: manifest.sessionId,
    fileId: manifest.fileId,
    originalSize: manifest.originalSize.toString(),
    transportSize: manifest.transportSize.toString(),
    segmentSizeBytes: manifest.segmentSizeBytes,
    symbolSizeBytes: manifest.symbolSizeBytes,
    segmentCount: manifest.segmentCount,
    fecProfileId: manifest.fecProfileId,
    compressionMode: manifest.compressionMode,
    compressionParam: manifest.compressionParam,
    transportProfileId: 0,
    sha256: Buffer.from(manifest.sha256).toString('hex'),
    filename: manifest.filename,
    mimeType: manifest.mimeType,
  };
}

function frameExpectation(frame: ReturnType<typeof buildSourceFrame>): Record<string, unknown> {
  return {
    frameType: frame.model.frameType,
    sessionId: frame.model.sessionId,
    fileId: frame.model.fileId,
    segmentIndex: frame.model.segmentIndex,
    symbolId: frame.model.symbolId,
    sourceSymbolCount: frame.model.sourceSymbolCount,
    frameFlags: frame.model.frameFlags,
    payloadLength: frame.model.payload.length,
    payloadSha256: digestHex(frame.model.payload),
  };
}

/** The transport bytes a real sender would place into segments. */
const transportSample = deterministicBytes(Number(TRANSPORT_SIZE), 0x1234_5678);
const originalDigest = new Uint8Array(createHash('sha256').update(transportSample).digest());
const plan = planSegmentation({
  transportSize: TRANSPORT_SIZE,
  segmentSizeBytes: SEGMENT_SIZE,
  symbolSizeBytes: SYMBOL_SIZE,
});

function baseManifest(overrides: Partial<DeqrV2Manifest> = {}): DeqrV2Manifest {
  return {
    featureFlags: 0,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    originalSize: TRANSPORT_SIZE,
    transportSize: TRANSPORT_SIZE,
    segmentSizeBytes: SEGMENT_SIZE,
    symbolSizeBytes: SYMBOL_SIZE,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: originalDigest,
    filename: 'vector-sample.bin',
    mimeType: 'application/octet-stream',
    ...overrides,
  };
}

/**
 * Builds one source symbol exactly the way a sender must: the segment's slice
 * of the transport stream, zero-padded up to the symbol size so every symbol in
 * a segment is the same length and XOR repair stays well defined.
 */
function buildSourceFrame(segmentIndex: number, symbolId: number) {
  const segmentStart = segmentIndex * SEGMENT_SIZE;
  const start = segmentStart + symbolId * SYMBOL_SIZE;
  const end = Math.min(start + SYMBOL_SIZE, Number(TRANSPORT_SIZE));
  const payload = new Uint8Array(SYMBOL_SIZE);
  payload.set(transportSample.subarray(start, Math.max(start, end)));
  const model = {
    frameType: V2_FRAME_TYPE.SOURCE,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    segmentIndex,
    symbolId,
    sourceSymbolCount: sourceSymbolCountForSegment(plan, segmentIndex),
    frameFlags: 0,
    payload,
  } as const;
  return { model, bytes: serializeDataFrame(model) };
}

function buildRepairFrame(segmentIndex: number, symbolId: number) {
  const model = {
    frameType: V2_FRAME_TYPE.REPAIR,
    sessionId: SESSION_ID,
    fileId: FILE_ID,
    segmentIndex,
    symbolId,
    sourceSymbolCount: sourceSymbolCountForSegment(plan, segmentIndex),
    frameFlags: 0,
    payload: deterministicBytes(SYMBOL_SIZE, 0xfeed_0000 ^ symbolId),
  } as const;
  return { model, bytes: serializeDataFrame(model) };
}

function corrupt(source: Uint8Array, mutate: (bytes: Uint8Array) => Uint8Array | void): Uint8Array {
  const copy = source.slice();
  const result = mutate(copy);
  return result ?? copy;
}

function main(): void {
  fs.rmSync(VECTORS_DIR, { recursive: true, force: true });
  fs.mkdirSync(VECTORS_DIR, { recursive: true });

  /* ------------------------------------------------------------- manifests */

  const basic = baseManifest();
  write('manifest-basic.bin', serializeManifestFrame(basic),
    'Typical uncompressed manifest: four segments, the last one partial.',
    { kind: 'manifest', manifest: manifestExpectation(basic) });

  // Byte 43 was reserved-and-must-be-zero through Phase 03 and carries the
  // transport profile id from Phase 04 on. Every vector above declares 0, so
  // they are byte-identical to the ones generated before the field existed;
  // this one declares a real profile so the new semantics are pinned too.
  const profiled = baseManifest({
    transportProfileId: 3,
    filename: 'vector-turbo.bin',
  });
  write('manifest-transport-profile.bin', serializeManifestFrame(profiled),
    'Manifest declaring transport profile 3 (Turbo) in the byte that used to be reserved.',
    { kind: 'manifest', manifest: manifestExpectation(profiled) });

  // Phase 08 gave `compressionParam` a meaning: log2 of the original bytes per
  // independently compressed window. This vector carried an arbitrary 6 while
  // the byte was opaque, and now declares the 20 (1 MiB) a real sender emits.
  // No shipped build ever wrote a non-zero value, so nothing is invalidated by
  // the change - but the vector's bytes did move, which is recorded in the
  // Phase 08 report.
  const compressed = baseManifest({
    originalSize: 1_048_576n,
    transportSize: TRANSPORT_SIZE,
    compressionMode: V2_COMPRESSION.GZIP,
    compressionParam: V2_COMPRESSION_WINDOW.defaultLog2,
    transportProfileId: 0,
    filename: 'vector-compressed.txt',
  });
  write('manifest-compressed.bin', serializeManifestFrame(compressed),
    'gzip transport: a 1 MiB file carried in 200,000 bytes, one 1 MiB compression window.',
    { kind: 'manifest', manifest: manifestExpectation(compressed) });

  // 5 GiB, represented and parsed without any buffer of that size existing.
  const fiveGib = baseManifest({
    originalSize: 5n * 1024n * 1024n * 1024n,
    transportSize: 5n * 1024n * 1024n * 1024n,
    segmentSizeBytes: 4 * 1024 * 1024,
    symbolSizeBytes: 1_024,
    segmentCount: 1_280,
    filename: 'five-gibibytes.bin',
  });
  write('manifest-5gib.bin', serializeManifestFrame(fiveGib),
    'A 5 GiB logical file. Nothing of that size is ever allocated.',
    { kind: 'manifest', manifest: manifestExpectation(fiveGib) });

  // 1 TiB at the largest legal segment size, to exercise a large segmentCount.
  const oneTib = baseManifest({
    originalSize: 1n << 40n,
    transportSize: 1n << 40n,
    segmentSizeBytes: 64 * 1024 * 1024,
    symbolSizeBytes: 2_048,
    segmentCount: 16_384,
    filename: 'one-tebibyte.bin',
  });
  write('manifest-1tib.bin', serializeManifestFrame(oneTib),
    'A 1 TiB logical file at the maximum segment size.',
    { kind: 'manifest', manifest: manifestExpectation(oneTib) });

  const unicode = baseManifest({ filename: 'ünïcode-ファイル-名前.bin', mimeType: '' });
  write('manifest-unicode-name.bin', serializeManifestFrame(unicode),
    'Multi-byte UTF-8 filename and an empty advisory MIME type.',
    { kind: 'manifest', manifest: manifestExpectation(unicode) });

  /* ---------------------------------------------------------- data frames */

  const source000 = buildSourceFrame(0, 0);
  write('frame-source-seg0-sym0.bin', source000.bytes,
    'First source symbol of the first segment.',
    { kind: 'data', frame: frameExpectation(source000) });

  const source001 = buildSourceFrame(0, 1);
  write('frame-source-seg0-sym1.bin', source001.bytes,
    'Second source symbol of the first segment.',
    { kind: 'data', frame: frameExpectation(source001) });

  const sourceLastSegment = buildSourceFrame(plan.segmentCount - 1, 0);
  write('frame-source-last-segment.bin', sourceLastSegment.bytes,
    'Only source symbol of the short final segment; payload is zero-padded to the symbol size.',
    { kind: 'data', frame: frameExpectation(sourceLastSegment) });

  const repair = buildRepairFrame(0, plan.symbolsPerFullSegment + 3);
  write('frame-repair-seg0.bin', repair.bytes,
    'Repair symbol for the first segment; its id continues past the source range.',
    { kind: 'data', frame: frameExpectation(repair) });

  /* --------------------------------------------------------- rejections */

  write('reject-bad-crc.bin',
    corrupt(source000.bytes, (bytes) => { bytes[V2_DATA_LAYOUT.payload] ^= 0xff; }),
    'A payload byte flipped after the CRC was computed.',
    { kind: 'reject', code: 'CRC_MISMATCH' });

  write('reject-truncated-manifest.bin',
    serializeManifestFrame(basic).slice(0, 40),
    'Manifest cut short inside its fixed header.',
    { kind: 'reject', code: 'FRAME_TOO_SHORT' });

  write('reject-truncated-data-frame.bin',
    source000.bytes.slice(0, source000.bytes.length - 8),
    'Data frame cut short inside its payload.',
    { kind: 'reject', code: 'FRAME_TOO_SHORT' });

  write('reject-trailing-bytes.bin',
    (() => {
      const padded = new Uint8Array(source000.bytes.length + 3);
      padded.set(source000.bytes);
      return padded;
    })(),
    'A well formed data frame with three extra bytes appended.',
    { kind: 'reject', code: 'TRAILING_BYTES' });

  write('reject-unknown-frame-type.bin',
    corrupt(source000.bytes, (bytes) => { bytes[V2_DATA_LAYOUT.frameType] = 0x7f; }),
    'A frame type this revision does not define.',
    { kind: 'reject', code: 'UNKNOWN_FRAME_TYPE' });

  write('reject-unsupported-version.bin',
    corrupt(source000.bytes, (bytes) => { bytes[V2_DATA_LAYOUT.version] = 0x03; }),
    'A future protocol version, which must be refused rather than guessed at.',
    { kind: 'reject', code: 'UNSUPPORTED_VERSION' });

  write('reject-bad-magic.bin',
    corrupt(source000.bytes, (bytes) => { bytes[0] = 0x58; }),
    'Not a DEQR frame at all.',
    { kind: 'reject', code: 'BAD_MAGIC' });

  write('reject-critical-flag.bin',
    (() => {
      // Set a critical flag bit, then repair the CRC so the rejection is
      // provably about the flag rather than about damage.
      const bytes = source000.bytes.slice();
      const view = new DataView(bytes.buffer);
      view.setUint16(V2_DATA_LAYOUT.frameFlags, 0x0100);
      view.setUint32(bytes.length - 4, crc32Local(bytes, bytes.length - 4));
      return bytes;
    })(),
    'An unknown critical frame flag. Unknown advisory bits would be ignored; critical bits must not be.',
    { kind: 'reject', code: 'UNSUPPORTED_CRITICAL_FEATURE' });

  write('reject-oversized-payload-length.bin',
    (() => {
      const bytes = source000.bytes.slice();
      const view = new DataView(bytes.buffer);
      view.setUint16(V2_DATA_LAYOUT.payloadLength, 0xffff);
      view.setUint32(bytes.length - 4, crc32Local(bytes, bytes.length - 4));
      return bytes;
    })(),
    'A declared payload length far beyond both the buffer and the protocol limit. Must be refused before any allocation.',
    { kind: 'reject', code: 'FIELD_OUT_OF_RANGE' });

  write('reject-source-symbol-out-of-range.bin',
    (() => {
      const bytes = source000.bytes.slice();
      const view = new DataView(bytes.buffer);
      view.setUint32(V2_DATA_LAYOUT.symbolId, 0xffff_fffe);
      view.setUint32(bytes.length - 4, crc32Local(bytes, bytes.length - 4));
      return bytes;
    })(),
    'A source symbol id at or above its own declared source-symbol count.',
    { kind: 'reject', code: 'SYMBOL_OUT_OF_RANGE' });

  write('reject-inconsistent-segment-count.bin',
    (() => {
      const bytes = serializeManifestFrame(basic).slice();
      const view = new DataView(bytes.buffer);
      view.setUint32(V2_MANIFEST_LAYOUT.segmentCount, 9_999);
      view.setUint32(bytes.length - 4, crc32Local(bytes, bytes.length - 4));
      return bytes;
    })(),
    'A manifest whose segmentCount disagrees with the sizes it declares.',
    { kind: 'reject', code: 'INCONSISTENT_MANIFEST' });

  write('reject-compression-window-param.bin',
    (() => {
      const bytes = serializeManifestFrame(compressed).slice();
      const view = new DataView(bytes.buffer);
      // Below the 16 (64 KiB) floor. A window this small would spend more of
      // the wire on framing than the compression saves.
      bytes[V2_MANIFEST_LAYOUT.compressionParam] = 6;
      view.setUint32(bytes.length - 4, crc32Local(bytes, bytes.length - 4));
      return bytes;
    })(),
    'A gzip manifest whose compression window exponent is outside 16..26.',
    { kind: 'reject', code: 'FIELD_OUT_OF_RANGE' });

  write('reject-compressed-expansion.bin',
    (() => {
      const bytes = serializeManifestFrame(compressed).slice();
      const view = new DataView(bytes.buffer);
      // Declares that 200,000 transport bytes carry a 100,000-byte file. A
      // sender that measured a real gain never produces this shape, and a
      // receiver that accepted it would reserve storage for an expansion.
      view.setBigUint64(V2_MANIFEST_LAYOUT.originalSize, 100_000n);
      view.setUint32(bytes.length - 4, crc32Local(bytes, bytes.length - 4));
      return bytes;
    })(),
    'A gzip manifest whose transportSize exceeds the originalSize it claims to carry.',
    { kind: 'reject', code: 'INCONSISTENT_MANIFEST' });

  write('reject-v1-frame.bin',
    (() => {
      // A real v1 frame header shape: version 1 at byte 0, twenty bytes total,
      // plus a payload. It must be reported as v1, never parsed as v2.
      const bytes = new Uint8Array(20 + 32);
      bytes[0] = 1;
      let xor = 0;
      for (let index = 0; index < 19; index += 1) xor ^= bytes[index];
      bytes[19] = xor;
      return bytes;
    })(),
    'A DEQR v1 frame offered to the v2 parser.',
    { kind: 'reject', code: 'V1_FRAME' });

  const expected = {
    schemaVersion: 1,
    protocol: 'DEQR v2',
    generator: 'scripts/protocol/generate-v2-vectors.ts',
    constants: {
      sessionId: SESSION_ID,
      fileId: FILE_ID,
      segmentSizeBytes: SEGMENT_SIZE,
      symbolSizeBytes: SYMBOL_SIZE,
      transportSize: TRANSPORT_SIZE.toString(),
      segmentCount: plan.segmentCount,
      symbolsPerFullSegment: plan.symbolsPerFullSegment,
      symbolsInLastSegment: plan.symbolsInLastSegment,
      lastSegmentBytes: plan.lastSegmentBytes,
      manifestFixedTotalBytes: V2_MANIFEST_LAYOUT.fixedTotalBytes,
      dataFrameOverheadBytes: V2_DATA_LAYOUT.overheadBytes,
    },
    vectors: records,
  };
  fs.writeFileSync(path.join(VECTORS_DIR, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`, 'utf8');

  console.log(`DEQR_V2_VECTORS_WRITTEN count=${records.length} dir=${path.relative(process.cwd(), VECTORS_DIR)}`);
}

/**
 * Local CRC so a corrupted fixture can be re-sealed.
 *
 * Deliberately a second implementation rather than an import: a malformed
 * fixture whose CRC was produced by the very function under test would prove
 * nothing about that function.
 */
function crc32Local(bytes: Uint8Array, end: number): number {
  let crc = 0xffffffff;
  for (let index = 0; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

main();
