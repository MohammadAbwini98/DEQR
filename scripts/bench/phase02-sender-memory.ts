/**
 * Phase 02 — sender memory and stage throughput, v1 whole-file vs v2 streaming.
 *
 * One size and one path per process, because Phase 00 established that running
 * several memory probes in a single process contaminates the baseline: the
 * collector does not hand back the previous probe's buffers predictably and the
 * deltas stop meaning anything.
 *
 *   node --expose-gc node_modules/vite-node/vite-node.mjs \
 *     scripts/bench/phase02-sender-memory.ts -- --path v2 --mib 64
 *
 * `--expose-gc` is required: without it, un-collected garbage is
 * indistinguishable from retained state and the numbers are not worth printing.
 *
 * Payload safety: deterministic synthetic corpora, generated on demand under
 * `.local-run/phase02-corpus/`. No payload bytes are printed.
 */

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

import { computeSha256 } from '../../src/core/hash';
import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { serializeFrame } from '../../src/core/protocol';
import {
  V1_FOUNTAIN_BLOCK_SIZE_BYTES,
  V1_MAX_SERIALIZED_CONTAINER_BYTES,
} from '../../src/main/session-manager';
import { StreamingTransferSession } from '../../src/main/streaming-sender';

const MIB = 1024 * 1024;
/** Frames drained on the v2 path. Enough to cross several segment boundaries. */
const V2_FRAME_SAMPLE = 20_000;

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/**
 * Live bytes, settled — the metric Phase 00 validated against a controlled
 * allocation. `arrayBuffers` and `rss` on their own move with collection timing
 * rather than with what the program is holding.
 */
function settledLiveBytes(): number {
  for (let pass = 0; pass < 3; pass += 1) global.gc!();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
}

function peakRss(): number {
  return process.memoryUsage().rss;
}

function corpusPath(sizeMib: number): string {
  const directory = resolve(process.cwd(), '.local-run', 'phase02-corpus');
  fs.mkdirSync(directory, { recursive: true });
  const file = resolve(directory, `phase02-random-${sizeMib}mib.bin`);
  const wanted = sizeMib * MIB;
  if (fs.existsSync(file) && fs.statSync(file).size === wanted) return file;

  // Written a megabyte at a time so generating a corpus never needs the whole
  // thing resident either.
  const chunk = Buffer.allocUnsafe(MIB);
  let state = (0x5eed_1234 ^ wanted) >>> 0;
  const handle = fs.openSync(file, 'w');
  try {
    for (let written = 0; written < wanted; written += MIB) {
      for (let index = 0; index < chunk.length; index += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        chunk[index] = state >>> 24;
      }
      fs.writeSync(handle, chunk, 0, Math.min(MIB, wanted - written));
    }
  } finally {
    fs.closeSync(handle);
  }
  return file;
}

/** The shipping v1 preparation path, exactly as `SessionManager.selectFile` performs it. */
function measureV1(file: string, sizeBytes: number): Record<string, number | string> {
  const baseline = settledLiveBytes();
  let peak = peakRss();

  const readStart = performance.now();
  const source = fs.readFileSync(file);
  const readMs = performance.now() - readStart;
  peak = Math.max(peak, peakRss());

  const hashStart = performance.now();
  const sha256 = computeSha256(source);
  const hashMs = performance.now() - hashStart;

  const serializeStart = performance.now();
  const container = serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename: 'phase02-sample.bin',
      mimeType: 'application/octet-stream',
      originalSize: source.length,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256,
    },
    payload: source,
  });
  const serializeMs = performance.now() - serializeStart;
  peak = Math.max(peak, peakRss());

  const encoder = new FountainEncoder(container, V1_FOUNTAIN_BLOCK_SIZE_BYTES, 1);
  const encodeStart = performance.now();
  const sample = Math.min(V2_FRAME_SAMPLE, encoder.getBlockCount());
  for (let index = 0; index < sample; index += 1) serializeFrame(encoder.nextFrame());
  const encodeMs = performance.now() - encodeStart;
  peak = Math.max(peak, peakRss());

  // Everything above is still reachable, which is the point: v1 holds the
  // source and the container for the whole transfer.
  const held = settledLiveBytes() - baseline;
  const result = {
    path: 'v1',
    sizeMib: sizeBytes / MIB,
    heldBytes: held,
    heldOverSize: held / sizeBytes,
    peakRssBytes: peak,
    readBytesPerSecond: sizeBytes / (readMs / 1_000),
    hashBytesPerSecond: sizeBytes / (hashMs / 1_000),
    containerSerializeMs: serializeMs,
    encodeSymbolsPerSecond: sample / (encodeMs / 1_000),
    boundedByConfiguration: 'no',
  };
  source.fill(0);
  container.fill(0);
  return result;
}

async function measureV2(file: string, sizeBytes: number): Promise<Record<string, number | string>> {
  const baseline = settledLiveBytes();
  let peak = peakRss();

  const session = await StreamingTransferSession.open(file, {
    segmentSizeBytes: 1024 * 1024,
    symbolSizeBytes: 512,
    frameQueueCapacity: 32,
    manifestIntervalFrames: 64,
    repairOverheadRatio: 0,
    sampleCompressibility: true,
    sessionId: 1,
    fileId: 1,
  });
  peak = Math.max(peak, peakRss());

  const drainStart = performance.now();
  let frames = 0;
  let peakBuffered = 0;
  while (frames < V2_FRAME_SAMPLE) {
    const frame = await session.take();
    if (!frame) break;
    frames += 1;
    peakBuffered = Math.max(peakBuffered, session.bufferedBytes());
  }
  const drainMs = performance.now() - drainStart;
  peak = Math.max(peak, peakRss());

  const held = settledLiveBytes() - baseline;
  const result = {
    path: 'v2',
    sizeMib: sizeBytes / MIB,
    heldBytes: held,
    heldOverSize: held / sizeBytes,
    peakRssBytes: peak,
    memoryBudgetBytes: session.memoryBudgetBytes(),
    peakBufferedBytes: peakBuffered,
    readBytesPerSecond: session.preflight.hashBytesPerSecond,
    hashBytesPerSecond: session.preflight.hashBytesPerSecond,
    containerSerializeMs: 0,
    encodeSymbolsPerSecond: frames / (drainMs / 1_000),
    sampledCompressionRatio: session.preflight.compressibility.ratio,
    boundedByConfiguration: 'yes',
  };
  await session.dispose();
  return result;
}

async function main(): Promise<void> {
  if (typeof global.gc !== 'function') {
    console.error('PHASE02_SENDER_MEMORY_FAILED run node with --expose-gc');
    process.exitCode = 1;
    return;
  }

  const which = argument('path', 'v2');
  const sizeMib = Number(argument('mib', '16'));
  if (!Number.isInteger(sizeMib) || sizeMib < 1 || sizeMib > 4096) {
    throw new Error('--mib must be an integer between 1 and 4096');
  }
  const sizeBytes = sizeMib * MIB;
  const file = corpusPath(sizeMib);

  if (which === 'v1' && sizeBytes >= V1_MAX_SERIALIZED_CONTAINER_BYTES) {
    // Not a harness limitation: this is the ceiling Phase 00 measured, and
    // refusing here is more honest than reporting a number v1 cannot reach.
    console.log(`PHASE02_SENDER_MEMORY path=v1 sizeMib=${sizeMib} result=REFUSED reason=above-v1-capacity`);
    return;
  }

  const measured = which === 'v1' ? measureV1(file, sizeBytes) : await measureV2(file, sizeBytes);
  // Ratios matter here and rounding them to an integer reports 0.001 as 0,
  // which is exactly the number the reader is looking for.
  const format = (value: number): string => (Math.abs(value) < 1_000 ? value.toFixed(4) : String(Math.round(value)));
  const fields = Object.entries(measured)
    .map(([key, value]) => `${key}=${typeof value === 'number' ? format(value) : value}`)
    .join(' ');
  console.log(`PHASE02_SENDER_MEMORY ${fields}`);
}

void main().catch((error: unknown) => {
  console.error(`PHASE02_SENDER_MEMORY_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
