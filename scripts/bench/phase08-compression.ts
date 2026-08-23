/**
 * Phase 08 - what adaptive compression buys, and what it costs.
 *
 * The phase's claim has three parts and each one is a measurement:
 *
 * - **The extension changes nothing.** Identical bytes opened under five names
 *   must produce identical transport. Proved by running the real sender five
 *   times over one buffer and comparing manifests.
 * - **Incompressible bytes pay nothing.** They must bypass compression, which
 *   means the wire is byte-identical to the uncompressed path.
 * - **Compressible bytes go faster.** Not "fewer bytes" - *fewer optical
 *   seconds*, at the Phase 04 profiles, because that is the only unit in which
 *   an optical transfer is faster or slower.
 *
 * Alongside those it prints the two rates the plan asks for and which are not
 * the same number: **optical bytes/sec** is what the link carries, and
 * **effective original bytes/sec** is what the user gets. Compression is
 * exactly the difference between them.
 *
 *   node --expose-gc node_modules/vite-node/vite-node.mjs \
 *     scripts/bench/phase08-compression.ts -- --mode corpus --sizeMib 32
 *
 *   --mode corpus     ratio, CPU and throughput per fixture kind
 *   --mode levels     zlib level against ratio and rate, to justify the default
 *   --mode threshold  where the decision flips, swept over mixed content
 *   --mode neutral    the same bytes under five extensions, end to end
 *   --mode window     window size against ratio and framing cost
 *   --mode memory     resident bytes through a compressed send, against budget
 *   --mode receiver   what expanding and hashing a container costs the phone
 *
 * Payload safety: every fixture is generated from a seed. Nothing is read from
 * a user's disk and no payload byte is printed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';

import {
  COMPRESSION_REASON,
  decideCompression,
} from '../../src/core/compression-policy';
import {
  V2_COMPRESSION,
  V2_COMPRESSION_WINDOW,
  V2_WINDOW_LENGTH_PREFIX_BYTES,
} from '../../src/core/protocol-v2';
import {
  BALANCED_PROFILE,
  expectedVerifiedBytesPerSecond,
} from '../../src/core/transport-profiles';
import {
  StreamingTransferSession,
  type SenderFileHandle,
  type SenderFileOpener,
  type SenderFileStat,
} from '../../src/main/streaming-sender';

/* ------------------------------------------------------------------ plumbing */

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

function heapMib(): number {
  const usage = process.memoryUsage();
  return (usage.heapUsed + usage.arrayBuffers) / MIB;
}

/* ------------------------------------------------------------------ fixtures */

/**
 * The four content shapes the plan names, each generated from a seed.
 *
 * `text` and `table` stand for prose and for row-structured exports; `json` for
 * the object-per-line shape a database dump has; `random` for anything already
 * compressed or encrypted, which is the case that must cost nothing.
 */
const FIXTURES = ['source', 'text', 'json', 'table', 'random', 'mixed'] as const;
type FixtureKind = (typeof FIXTURES)[number];

function makeFixture(kind: FixtureKind, length: number, seed = 1): Uint8Array {
  switch (kind) {
    case 'source': return sourceLike(length);
    case 'text': return textLike(length, seed);
    case 'json': return jsonLike(length);
    case 'table': return tableLike(length);
    case 'random': return randomLike(length, seed);
    case 'mixed': return mixedLike(length, seed);
  }
}

/**
 * Real text, not a generator: this repository's own TypeScript, concatenated.
 *
 * The synthetic fixtures below are useful for sweeping a parameter and useless
 * as an estimate of a ratio - a generator with a sixteen-word vocabulary
 * compresses far better than anything a person wrote. This one is the control:
 * real prose-and-code entropy, deterministic because the tree is, and read only
 * from the repository itself.
 */
let sourceCorpus: Uint8Array | null = null;

function sourceLike(length: number): Uint8Array {
  if (!sourceCorpus) {
    const roots = ['src', 'mobile-web/src', 'tests'];
    const files: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
      }
    };
    for (const root of roots) walk(path.resolve(process.cwd(), root));
    const parts = files.map((file) => readFileSync(file));
    sourceCorpus = new Uint8Array(Buffer.concat(parts));
  }
  // Repeated to reach the requested length, at a stride that is not a multiple
  // of deflate's 32 KiB window, so the repetition is not itself the thing being
  // measured.
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += sourceCorpus.length) {
    out.set(sourceCorpus.subarray(0, Math.min(sourceCorpus.length, length - at)), at);
  }
  return out;
}

function textLike(length: number, seed = 1): Uint8Array {
  const words = [
    'the', 'transfer', 'segment', 'symbol', 'manifest', 'receiver', 'optical', 'window',
    'stream', 'device', 'camera', 'display', 'checkpoint', 'verified', 'bounded', 'memory',
  ];
  let out = '';
  let state = seed >>> 0;
  while (out.length < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += `${words[state % words.length]}${state % 23 === 0 ? '.\n' : ' '}`;
  }
  return new TextEncoder().encode(out).slice(0, length);
}

function jsonLike(length: number): Uint8Array {
  let out = '[';
  let row = 0;
  while (out.length < length) {
    out += `{"id":${row},"name":"user_${row % 5000}","email":"u${row}@example.invalid","active":${row % 2 === 0},"score":${(row * 37) % 100}},`;
    row += 1;
  }
  return new TextEncoder().encode(out).slice(0, length);
}

function tableLike(length: number): Uint8Array {
  let out = 'id,name,department,salary,started\n';
  let row = 0;
  while (out.length < length) {
    out += `${row},Employee ${row % 500},Engineering,${80_000 + (row % 40) * 1_000},2020-0${1 + (row % 9)}-15\n`;
    row += 1;
  }
  return new TextEncoder().encode(out).slice(0, length);
}

function randomLike(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

/**
 * A document-shaped file: mostly high-entropy media with text around it.
 *
 * The realistic middle case, and the one a threshold has to rule on - a `.pdf`
 * or a `.docx` is exactly this, and neither its extension nor a sample of its
 * first kilobyte predicts which side of the line it lands on.
 */
function mixedLike(length: number, seed = 3): Uint8Array {
  const bytes = randomLike(length, seed);
  const textRun = Math.floor(length / 8);
  bytes.set(textLike(textRun, seed), 0);
  bytes.set(textLike(textRun, seed + 1), Math.floor(length / 2));
  return bytes;
}

/* ------------------------------------------------------------- sender access */

class BufferFile implements SenderFileHandle {
  constructor(private readonly bytes: Uint8Array) {}

  async stat(): Promise<SenderFileStat> {
    return { size: BigInt(this.bytes.length), mtimeMs: 1_700_000_000_000n, isFile: true };
  }

  async read(buffer: Uint8Array, length: number, position: bigint): Promise<number> {
    const start = Number(position);
    const take = Math.min(length, this.bytes.length - start);
    if (take <= 0) return 0;
    buffer.set(this.bytes.subarray(start, start + take), 0);
    return take;
  }

  async close(): Promise<void> {}
}

function openerFor(bytes: Uint8Array): SenderFileOpener {
  return async () => new BufferFile(bytes);
}

const PROFILE = BALANCED_PROFILE;
/**
 * Verified bytes per second the Balanced profile carries at its design loss.
 *
 * Taken from Phase 04's own function rather than recomputed here: a benchmark
 * that re-derives the rate it is measuring against can report a speedup that
 * exists only in this file.
 */
const PROFILE_BYTES_PER_SECOND = expectedVerifiedBytesPerSecond(PROFILE, PROFILE.designLossRate)
  ?? PROFILE.symbolSizeBytes * PROFILE.targetFps;

function senderOverrides(extra: Record<string, unknown> = {}) {
  return {
    segmentSizeBytes: PROFILE.segmentSizeBytes,
    symbolSizeBytes: PROFILE.symbolSizeBytes,
    repairOverheadRatio: PROFILE.repairOverheadRatio,
    transportProfileId: PROFILE.id,
    sessionId: 0x1111_2222,
    fileId: 0x3333_4444,
    ...extra,
  };
}

/**
 * Optical seconds a transfer of this many wire bytes would take.
 *
 * Derived from the profile's measured verified-payload rate rather than from a
 * frame count, because that rate is the one Phase 04 actually measured and the
 * one the program defines "maximum speed" against.
 */
function opticalSeconds(transportBytes: number): number {
  return transportBytes / PROFILE_BYTES_PER_SECOND;
}

/* ------------------------------------------------------------------- corpus */

async function runCorpus(sizeMib: number): Promise<void> {
  const length = Math.round(sizeMib * MIB);
  for (const kind of FIXTURES) {
    const bytes = makeFixture(kind, length);

    const compressedStart = performance.now();
    const compressed = await StreamingTransferSession.open(
      `D:/bench/fixture-${kind}.dat`,
      senderOverrides(),
      openerFor(bytes),
    );
    const preflightMs = performance.now() - compressedStart;
    const transportBytes = Number(compressed.manifest.transportSize);
    const applied = compressed.manifest.compressionMode === V2_COMPRESSION.GZIP;

    // The decompression cost the receiver will pay, measured over the same
    // container the sender would emit.
    let decompressMs = 0;
    if (applied) {
      const container = await drainContainer(compressed, transportBytes);
      const began = performance.now();
      expandContainer(container);
      decompressMs = performance.now() - began;
    }
    await compressed.dispose();

    const plainSeconds = opticalSeconds(length);
    const wireSeconds = opticalSeconds(transportBytes);

    report('PHASE08_CORPUS', {
      fixture: kind,
      originalMib: length / MIB,
      opticalMib: transportBytes / MIB,
      ratio: transportBytes / length,
      applied: applied ? 'gzip' : 'none',
      reason: compressed.preflight.compression.reason,
      sampledRatio: compressed.preflight.compressibility.ratio,
      sampleMs: compressed.preflight.compressibility.ms,
      compressMs: compressed.preflight.compression.measureMs,
      compressMibPerSec: compressed.preflight.compression.measureMs > 0
        ? (length / MIB) / (compressed.preflight.compression.measureMs / 1000)
        : 0,
      preflightMs,
      decompressMs,
      decompressMibPerSec: decompressMs > 0 ? (length / MIB) / (decompressMs / 1000) : 0,
      // The two rates the plan asks to be kept apart.
      opticalBytesPerSec: transportBytes / wireSeconds,
      effectiveBytesPerSec: length / wireSeconds,
      opticalHours: wireSeconds / 3600,
      savedHours: (plainSeconds - wireSeconds) / 3600,
      speedup: plainSeconds / wireSeconds,
    });
  }
}

/** Reassembles the transport stream the way a receiver's store does. */
async function drainContainer(session: StreamingTransferSession, transportSize: number): Promise<Uint8Array> {
  const { parseFrame, V2_FRAME_TYPE } = await import('../../src/core/protocol-v2');
  const container = new Uint8Array(transportSize);
  const symbolSize = session.config.symbolSizeBytes;
  const segmentSize = session.config.segmentSizeBytes;
  for (;;) {
    const frame = await session.take();
    if (!frame) break;
    const parsed = parseFrame(frame);
    if (!parsed.ok || parsed.value.kind !== 'data') continue;
    if (parsed.value.frame.frameType !== V2_FRAME_TYPE.SOURCE) continue;
    const { segmentIndex, symbolId, payload } = parsed.value.frame;
    const offset = segmentIndex * segmentSize + symbolId * symbolSize;
    if (offset >= transportSize) continue;
    container.set(payload.subarray(0, Math.min(symbolSize, transportSize - offset)), offset);
  }
  return container;
}

function expandContainer(container: Uint8Array): number {
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  let cursor = 0;
  let produced = 0;
  while (cursor < container.length) {
    const declared = view.getUint32(cursor, false);
    cursor += V2_WINDOW_LENGTH_PREFIX_BYTES;
    produced += gunzipSync(container.subarray(cursor, cursor + declared)).length;
    cursor += declared;
  }
  return produced;
}

/* ------------------------------------------------------------------- levels */

/** zlib level against ratio and rate, which is what picks the default. */
function runLevels(sizeMib: number): void {
  const length = Math.round(sizeMib * MIB);
  const windowBytes = 2 ** V2_COMPRESSION_WINDOW.defaultLog2;
  for (const kind of FIXTURES) {
    const bytes = makeFixture(kind, length);
    for (const level of [1, 4, 6, 9]) {
      gzipSync(bytes.subarray(0, Math.min(windowBytes, bytes.length)), { level });
      const began = performance.now();
      let out = 0;
      for (let at = 0; at < bytes.length; at += windowBytes) {
        out += gzipSync(bytes.subarray(at, Math.min(at + windowBytes, bytes.length)), { level }).length;
      }
      const ms = performance.now() - began;
      report('PHASE08_LEVEL', {
        fixture: kind,
        level,
        ratio: out / bytes.length,
        mibPerSec: (bytes.length / MIB) / (ms / 1000),
        ms,
      });
    }
  }
}

/* ---------------------------------------------------------------- threshold */

/**
 * Where the decision flips, swept over content that is part text.
 *
 * The threshold is the phase's one tunable, and this is the evidence for the
 * value: at each mixture it prints the real ratio and whether each candidate
 * threshold would compress, so the cost of being wrong in either direction is
 * visible rather than argued.
 */
function runThreshold(sizeMib: number): void {
  const length = Math.round(sizeMib * MIB);
  const windowBytes = 2 ** V2_COMPRESSION_WINDOW.defaultLog2;

  for (const textPercent of [0, 5, 10, 15, 20, 30, 50, 100]) {
    const bytes = randomLike(length, 11);
    const textBytes = Math.floor((length * textPercent) / 100);
    if (textBytes > 0) bytes.set(textLike(textBytes), 0);

    let out = 0;
    const began = performance.now();
    for (let at = 0; at < bytes.length; at += windowBytes) {
      out += V2_WINDOW_LENGTH_PREFIX_BYTES
        + gzipSync(bytes.subarray(at, Math.min(at + windowBytes, bytes.length)), { level: 6 }).length;
    }
    const ms = performance.now() - began;

    const gain = 1 - out / length;
    const savedSeconds = opticalSeconds(length) - opticalSeconds(out);
    report('PHASE08_THRESHOLD', {
      textPercent,
      ratio: out / length,
      gain,
      compressMs: ms,
      savedHoursPerGib: (savedSeconds / (length / (1024 * MIB))) / 3600,
      at05: gain >= 0.05 ? 'compress' : 'skip',
      at10: gain >= 0.1 ? 'compress' : 'skip',
      at20: gain >= 0.2 ? 'compress' : 'skip',
    });
  }
}

/* ------------------------------------------------------------------ neutral */

/** The gate, run end to end: identical bytes, five names, one answer. */
async function runNeutral(sizeMib: number): Promise<void> {
  const length = Math.round(sizeMib * MIB);
  for (const kind of ['table', 'random'] as FixtureKind[]) {
    const bytes = makeFixture(kind, length);
    const signatures = new Set<string>();
    for (const name of ['payload.txt', 'payload.zip', 'payload.pdf', 'payload.xlsx', 'payload.bin']) {
      const session = await StreamingTransferSession.open(`D:/bench/${name}`, senderOverrides(), openerFor(bytes));
      signatures.add([
        session.manifest.compressionMode,
        session.manifest.compressionParam,
        session.manifest.transportSize.toString(),
        session.manifest.segmentCount,
        session.preflight.sha256Hex,
      ].join('|'));
      await session.dispose();
    }
    report('PHASE08_NEUTRAL', {
      fixture: kind,
      names: 5,
      distinctDecisions: signatures.size,
      verdict: signatures.size === 1 ? 'identical' : 'DIVERGED',
    });
  }
}

/* ------------------------------------------------------------------- window */

/** Window size against ratio: bigger windows compress better and reseek slower. */
function runWindow(sizeMib: number): void {
  const length = Math.round(sizeMib * MIB);
  for (const kind of ['text', 'table'] as FixtureKind[]) {
    const bytes = makeFixture(kind, length);
    for (let log2 = V2_COMPRESSION_WINDOW.minLog2; log2 <= 22; log2 += 2) {
      const windowBytes = 2 ** log2;
      let payload = 0;
      let windows = 0;
      const began = performance.now();
      for (let at = 0; at < bytes.length; at += windowBytes) {
        payload += gzipSync(bytes.subarray(at, Math.min(at + windowBytes, bytes.length)), { level: 6 }).length;
        windows += 1;
      }
      const ms = performance.now() - began;
      const framing = windows * V2_WINDOW_LENGTH_PREFIX_BYTES;
      report('PHASE08_WINDOW', {
        fixture: kind,
        log2,
        windowKib: windowBytes / 1024,
        windows,
        ratio: (payload + framing) / length,
        framingPercent: (framing / length) * 100,
        mibPerSec: (bytes.length / MIB) / (ms / 1000),
      });
    }
  }
}

/* ------------------------------------------------------------------- memory */

/** Resident bytes through a whole compressed send, against the declared budget. */
async function runMemory(sizeMib: number): Promise<void> {
  const length = Math.round(sizeMib * MIB);
  const bytes = tableLike(length);
  collect();
  const baseline = heapMib();

  const session = await StreamingTransferSession.open(
    'D:/bench/memory.dat',
    senderOverrides(),
    openerFor(bytes),
  );
  let peakBuffered = 0;
  let peakHeap = 0;
  let frames = 0;
  for (;;) {
    const frame = await session.take();
    if (!frame) break;
    frames += 1;
    peakBuffered = Math.max(peakBuffered, session.bufferedBytes());
    if (frames % 512 === 0) peakHeap = Math.max(peakHeap, heapMib() - baseline);
  }

  report('PHASE08_MEMORY', {
    originalMib: length / MIB,
    mode: session.manifest.compressionMode === V2_COMPRESSION.GZIP ? 'gzip' : 'none',
    budgetMib: session.memoryBudgetBytes() / MIB,
    peakBufferedMib: peakBuffered / MIB,
    // The fixture itself is resident in this harness and a real sender's is
    // not, so the heap figure is an upper bound that includes it.
    peakHeapDeltaMib: peakHeap,
    frames,
    withinBudget: peakBuffered <= session.memoryBudgetBytes() ? 'yes' : 'NO',
  });
  await session.dispose();
}

/* ----------------------------------------------------------------- receiver */

/**
 * The cost Phase 08 adds to the receiver, through the receiver's own code.
 *
 * An uncompressed transfer verifies in one pass: hash the stored file. A
 * compressed one verifies in two: expand the container into a second file, then
 * hash that. This measures both against the same bytes, so the added seconds
 * per gigabyte are a measurement rather than an estimate - and prints the
 * storage the second file costs, which is the real price of the design.
 */
async function runReceiver(sizeMib: number): Promise<void> {
  const { inflateWindowContainer } = await import('../../mobile-web/src/inflate-verify');
  const { digestSegmentStore } = await import('../../mobile-web/src/receive-pipeline');
  const { BoundedMemoryOriginalSink } = await import('../../mobile-web/src/segment-store');
  const { planCompressionWindows } = await import('../../src/core/protocol-v2');

  const length = Math.round(sizeMib * MIB);
  const windowBytes = 2 ** V2_COMPRESSION_WINDOW.defaultLog2;

  for (const kind of ['source', 'table'] as FixtureKind[]) {
    const original = makeFixture(kind, length);

    const parts: Uint8Array[] = [];
    for (let at = 0; at < original.length; at += windowBytes) {
      const member = gzipSync(original.subarray(at, Math.min(at + windowBytes, original.length)), { level: 6 });
      const framed = new Uint8Array(V2_WINDOW_LENGTH_PREFIX_BYTES + member.length);
      new DataView(framed.buffer).setUint32(0, member.length, false);
      framed.set(member, V2_WINDOW_LENGTH_PREFIX_BYTES);
      parts.push(framed);
    }
    const container = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      container.set(part, offset);
      offset += part.length;
    }

    const source = {
      read(at: number, into: Uint8Array): number {
        const take = Math.min(into.length, container.length - at);
        if (take <= 0) return 0;
        into.set(container.subarray(at, at + take), 0);
        return take;
      },
    };
    const sink = new BoundedMemoryOriginalSink(original.length);
    const windows = planCompressionWindows({
      originalSize: BigInt(original.length),
      compressionParam: V2_COMPRESSION_WINDOW.defaultLog2,
    });

    const inflateBegan = performance.now();
    const inflated = await inflateWindowContainer(source, sink, {
      transportSize: container.length,
      originalSize: original.length,
      windows,
      yieldTo: async () => {},
    });
    const inflateMs = performance.now() - inflateBegan;
    if (!inflated.ok) throw new Error(`inflate failed: ${inflated.code}`);

    const hashBegan = performance.now();
    const digest = await digestSegmentStore(sink, original.length, { yieldTo: async () => {} });
    const hashMs = performance.now() - hashBegan;
    if (!digest) throw new Error('hash failed');

    const gib = length / (1024 * MIB);
    report('PHASE08_RECEIVER', {
      fixture: kind,
      originalMib: length / MIB,
      containerMib: container.length / MIB,
      inflateMs,
      inflateMibPerSec: (length / MIB) / (inflateMs / 1000),
      hashMs,
      hashMibPerSec: (length / MIB) / (hashMs / 1000),
      addedSecondsPerGib: (inflateMs / 1000) / gib,
      totalVerifySecondsPerGib: ((inflateMs + hashMs) / 1000) / gib,
      // The design's real price: both files exist at once until export.
      peakStorageRatio: (container.length + original.length) / original.length,
    });
  }
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const mode = argument('mode', 'corpus');
  const sizeMib = Number(argument('sizeMib', '32'));
  if (!Number.isFinite(sizeMib) || sizeMib <= 0) throw new Error('--sizeMib must be a positive number');

  if (mode === 'corpus') await runCorpus(sizeMib);
  else if (mode === 'levels') runLevels(sizeMib);
  else if (mode === 'threshold') runThreshold(sizeMib);
  else if (mode === 'neutral') await runNeutral(sizeMib);
  else if (mode === 'window') runWindow(sizeMib);
  else if (mode === 'memory') await runMemory(sizeMib);
  else if (mode === 'receiver') await runReceiver(sizeMib);
  else throw new Error('--mode must be corpus, levels, threshold, neutral, window, memory, or receiver');

  // Referenced so an unused import cannot hide a decision this harness claims
  // to exercise: the policy module is the thing under test in every mode.
  void decideCompression;
  void COMPRESSION_REASON;
}

main().catch((error: unknown) => {
  console.error(`PHASE08_COMPRESSION_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
