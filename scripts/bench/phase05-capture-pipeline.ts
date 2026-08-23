/**
 * Phase 05 - what the receive pipeline costs, and where it costs it.
 *
 * The phase gate is about main-thread responsiveness and bounded queues, and
 * both are hard to prove on the device that matters: Safari does not implement
 * the `longtask` PerformanceObserver entry, so the receiver can measure its own
 * long tasks everywhere except iOS. This harness therefore measures the same
 * claims from the other side - as CPU time, in the same JavaScript, so the
 * numbers transfer even though the runtime does not.
 *
 * `--mode offload` times the work that *moved*: v1 frame parsing, fountain
 * elimination and ripple, container parsing, and the SHA-256 of the whole file.
 * Before this phase every millisecond of that ran on the main thread inside a
 * React callback. It reports the total, the per-frame cost, and - the number
 * that decides whether a Cancel tap is answered - the single longest block.
 *
 * `--mode sustained` runs a real v2 transfer through the real pipeline and
 * samples what it is holding, to show decoder memory tracking the segment size
 * rather than the file size over a long run.
 *
 * `--mode backpressure` drives the real `ReceiverClient` on a virtual clock
 * with capture faster than decode, which is the normal condition at the Phase
 * 04 cadences, and reports what the in-flight cap actually did.
 *
 * `--mode split` times jsQR against the protocol-and-FEC stage on the same
 * frames. It is the measurement behind putting both in one worker instead of
 * two.
 *
 *   node node_modules/vite-node/vite-node.mjs scripts/bench/phase05-capture-pipeline.ts -- \
 *     --mode offload --sizes 1,4,16
 *
 * Payload safety: every byte here is deterministic synthetic data built by the
 * real encoders. Nothing is read from disk and no payload byte is printed.
 */

import { performance } from 'node:perf_hooks';

import { createCanvas } from 'canvas';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { computeSha256 } from '../../src/core/hash';
import { serializeFrame } from '../../src/core/protocol';
import {
  V2_COMPRESSION,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
  type DeqrV2Manifest,
} from '../../src/core/protocol-v2';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { BALANCED_PROFILE } from '../../src/core/transport-profiles';
import { ReceivePipeline } from '../../mobile-web/src/receive-pipeline';
import { ReceiverSession, parseFrame } from '../../mobile-web/src/protocol';
import { BoundedMemorySegmentStore } from '../../mobile-web/src/segment-store';
import {
  ReceiverClient,
  type CapturedFrame,
  type WorkerLike,
} from '../../mobile-web/src/receiver-client';
import {
  FRAME_OUTCOME,
  RECEIVE_WORKER_PROTOCOL,
  type ReceiveWorkerEvent,
  type ReceiveWorkerRequest,
} from '../../mobile-web/src/worker-protocol';

/* ---------------------------------------------------------------- plumbing */

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numbers(name: string, fallback: string): number[] {
  return argument(name, fallback).split(',').map(Number).filter((value) => Number.isFinite(value));
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

function quantile(samples: number[], fraction: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

/** Deterministic, incompressible-ish bytes. Never read from disk. */
function syntheticBytes(length: number, seed = 0x9e3779b9): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b79f5) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

/* -------------------------------------------------------------- mode: offload */

/**
 * Times the work Phase 05 moved off the main thread.
 *
 * The two headline numbers are `mainThreadTotalMs` - all of it, per transfer -
 * and `longestBlockMs`, which is the single longest uninterrupted stretch. The
 * second is the one a user feels: it is how long a tap on Cancel could go
 * unanswered, and for a large file it is dominated by one SHA-256.
 */
async function runOffload(sizesMiB: number[]): Promise<void> {
  for (const sizeMiB of sizesMiB) {
    const payload = syntheticBytes(Math.round(sizeMiB * 1024 * 1024));
    const container = serializeContainer({
      metadata: {
        protocolVersion: PROTOCOL_VERSION,
        filename: 'phase05-offload.bin',
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
    const frameCount = encoder.getBlockCount();
    const session = new ReceiverSession();

    const perFrame: number[] = [];
    let parseMs = 0;
    let receiveMs = 0;

    for (let index = 0; index < frameCount; index += 1) {
      const frame = new Uint8Array(serializeFrame(encoder.nextFrame()));
      // Exactly what `onBytes` used to do on the main thread, in order.
      const parseStart = performance.now();
      parseFrame(frame);
      const parseEnd = performance.now();
      session.receive(frame);
      const receiveEnd = performance.now();

      parseMs += parseEnd - parseStart;
      receiveMs += receiveEnd - parseEnd;
      perFrame.push(receiveEnd - parseStart);
    }

    const verifyStart = performance.now();
    const snapshot = await session.verify();
    const verifyMs = performance.now() - verifyStart;
    if (snapshot.state !== 'COMPLETE') throw new Error(`offload fixture did not verify: ${snapshot.state}`);

    const frameTotal = parseMs + receiveMs;
    report('PHASE05_OFFLOAD', {
      sizeMiB,
      frames: frameCount,
      parseMs,
      fecMs: receiveMs,
      verifyMs,
      // Everything below used to run between the camera and a `setState`.
      mainThreadTotalMs: frameTotal + verifyMs,
      perFrameMeanMs: frameTotal / frameCount,
      perFrameP95Ms: quantile(perFrame, 0.95),
      // The longest single uninterrupted block, which is what a tap waits on.
      longestBlockMs: Math.max(verifyMs, quantile(perFrame, 1)),
      // A `longtask` is over 50 ms. Counted the way a browser would.
      framesOver50ms: perFrame.filter((value) => value > 50).length + (verifyMs > 50 ? 1 : 0),
    });
  }
}

/* ------------------------------------------------------------ mode: sustained */

interface V2Stream {
  manifest: DeqrV2Manifest;
  manifestFrame: Uint8Array;
  frames: Uint8Array[];
  segmentCount: number;
  payload: Uint8Array;
}

async function buildV2Stream(sizeMiB: number, symbolSizeBytes: number, symbolsPerSegment: number): Promise<V2Stream> {
  const transportSize = Math.round(sizeMiB * 1024 * 1024);
  const segmentSizeBytes = symbolSizeBytes * symbolsPerSegment;
  const payload = syntheticBytes(transportSize);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload.buffer as ArrayBuffer));
  const plan = planSegmentation({ transportSize: BigInt(transportSize), segmentSizeBytes, symbolSizeBytes });

  const manifest: DeqrV2Manifest = {
    featureFlags: 0,
    sessionId: 0x5eed_0005,
    fileId: 0x0a0b_0c0d,
    originalSize: BigInt(transportSize),
    transportSize: BigInt(transportSize),
    segmentSizeBytes,
    symbolSizeBytes,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: BALANCED_PROFILE.id,
    sha256: digest,
    filename: 'phase05-sustained.bin',
    mimeType: 'application/octet-stream',
  };

  const frames: Uint8Array[] = [];
  const scratch = new Uint8Array(symbolSizeBytes);
  for (let segmentIndex = 0; segmentIndex < plan.segmentCount; segmentIndex += 1) {
    const range = segmentByteRange(plan, segmentIndex);
    const encoder = new SegmentEncoder(symbolSizeBytes);
    encoder.loadSegment(payload.subarray(Number(range.start), Number(range.end)));
    const symbols = sourceSymbolCountForSegment(plan, segmentIndex);
    for (let symbolId = 0; symbolId < symbols; symbolId += 1) {
      encoder.symbolInto(symbolId, scratch);
      frames.push(serializeDataFrame({
        frameType: V2_FRAME_TYPE.SOURCE,
        sessionId: manifest.sessionId,
        fileId: manifest.fileId,
        segmentIndex,
        symbolId,
        sourceSymbolCount: symbols,
        frameFlags: 0,
        payload: scratch,
      }));
    }
    encoder.release();
  }

  return { manifest, manifestFrame: serializeManifestFrame(manifest), frames, segmentCount: plan.segmentCount, payload };
}

/**
 * Feeds a whole v2 transfer through the real pipeline, sampling what it holds.
 *
 * The claim under test is Phase 02's, carried into the receiver: memory is a
 * function of the segment size and the decoder budget, not of the file. The
 * store is given room for the whole file so that the *decoder* number is
 * isolated - a store that refused would end the run early and prove nothing.
 */
async function runSustained(sizesMiB: number[]): Promise<void> {
  const symbolSizeBytes = BALANCED_PROFILE.symbolSizeBytes;
  const symbolsPerSegment = BALANCED_PROFILE.symbolsPerSegment;

  for (const sizeMiB of sizesMiB) {
    const stream = await buildV2Stream(sizeMiB, symbolSizeBytes, symbolsPerSegment);
    const store = new BoundedMemorySegmentStore(stream.payload.length + symbolSizeBytes * symbolsPerSegment);
    const pipeline = new ReceivePipeline({ store, maxActiveSegments: 2 });
    pipeline.submit(stream.manifestFrame);

    let peakDecoderBytes = 0;
    const startedAt = performance.now();
    for (let index = 0; index < stream.frames.length; index += 1) {
      pipeline.submit(stream.frames[index]);
      if (index % 128 === 0) {
        peakDecoderBytes = Math.max(peakDecoderBytes, pipeline.progress().heldBytes - store.bytesHeld());
      }
    }
    const submitMs = performance.now() - startedAt;

    const verifyStart = performance.now();
    const verified = await pipeline.verify();
    const verifyMs = performance.now() - verifyStart;
    if (!verified.ok) throw new Error(`sustained fixture did not verify: ${verified.code}`);

    const segmentBytes = symbolSizeBytes * symbolsPerSegment;
    report('PHASE05_SUSTAINED', {
      sizeMiB,
      segments: stream.segmentCount,
      frames: stream.frames.length,
      symbolSizeBytes,
      segmentBytes,
      peakDecoderBytes,
      // The whole point: this ratio must stay flat as the file grows.
      peakDecoderSegments: peakDecoderBytes / segmentBytes,
      perFrameUs: (submitMs / stream.frames.length) * 1000,
      framesPerSecond: stream.frames.length / (submitMs / 1000),
      verifyMs,
    });
    pipeline.release();
  }
}

/* --------------------------------------------------------- mode: backpressure */

/** A worker that answers on a virtual clock, at a fixed decode rate. */
class VirtualWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;

  private readonly queue: Array<{ frameId: number; epoch: number; readyAt: number }> = [];
  decoded = 0;
  peakQueue = 0;

  constructor(private readonly decodeMs: number) {}

  postMessage(message: unknown): void {
    const request = message as ReceiveWorkerRequest;
    if (request.type !== 'frame') return;
    // The worker's own message queue: nothing here trims it, which is exactly
    // why the bound has to live on the other side.
    const last = this.queue.length ? this.queue[this.queue.length - 1].readyAt : this.clock;
    this.queue.push({
      frameId: request.frameId,
      epoch: request.epoch,
      readyAt: Math.max(last, this.clock) + this.decodeMs,
    });
    this.peakQueue = Math.max(this.peakQueue, this.queue.length);
  }

  terminate(): void {
    this.queue.length = 0;
  }

  clock = 0;

  /** Delivers everything whose decode has finished by `now`. */
  advance(now: number): void {
    this.clock = now;
    while (this.queue.length && this.queue[0].readyAt <= now) {
      const done = this.queue.shift()!;
      this.decoded += 1;
      this.onmessage?.({
        data: {
          v: RECEIVE_WORKER_PROTOCOL,
          type: 'frame',
          epoch: done.epoch,
          frameId: done.frameId,
          outcome: FRAME_OUTCOME.ACCEPTED,
          decodeMs: this.decodeMs,
          pipelineMs: 0.4,
          staleDropped: 0,
        } satisfies ReceiveWorkerEvent,
      } as MessageEvent<unknown>);
    }
  }
}

/**
 * Capture faster than decode, for as long as it takes to matter.
 *
 * At the Phase 04 cadences this is not an edge case: measured jsQR scan time
 * was 60-93 ms per frame and a camera presents at 30 or 60 Hz, so the decoder
 * is behind by construction. What must hold is that the gap turns into skipped
 * captures rather than into a queue.
 */
function runBackpressure(seconds: number, captureHz: number, decodeMs: number): void {
  const worker = new VirtualWorker(decodeMs);
  const client = new ReceiverClient(
    {
      onProgress: () => undefined,
      onComplete: () => undefined,
      onVerified: () => undefined,
      onFailed: () => undefined,
      onFatal: () => undefined,
    },
    { createWorker: () => worker, now: () => worker.clock },
  );
  client.open();

  const stepMs = 1000 / captureHz;
  const totalSteps = Math.round(seconds * captureHz);
  let frameId = 0;
  let submitted = 0;
  let skipped = 0;
  let peakInFlight = 0;

  for (let step = 0; step < totalSteps; step += 1) {
    const now = step * stepMs;
    worker.advance(now);
    if (client.canAccept()) {
      const frame: CapturedFrame = {
        frameId: ++frameId,
        capturedAt: now,
        width: 619,
        height: 619,
        captureScale: 1,
        pixels: new ArrayBuffer(0),
      };
      // A zero-length buffer stands in for the pixels: this mode measures the
      // accounting, and allocating 1.5 MB per step would measure the allocator.
      if (client.submit(frame)) submitted += 1;
    } else {
      skipped += 1;
    }
    peakInFlight = Math.max(peakInFlight, client.framesInFlight);
  }

  worker.advance(totalSteps * stepMs + decodeMs * 4);
  report('PHASE05_BACKPRESSURE', {
    seconds,
    captureHz,
    decodeMs,
    captureAttempts: totalSteps,
    submitted,
    skippedBusy: skipped,
    decoded: worker.decoded,
    peakInFlight,
    maxInFlight: client.maxInFlight,
    peakWorkerQueue: worker.peakQueue,
    effectiveDecodeHz: worker.decoded / seconds,
  });
  client.dispose();
}

/* ---------------------------------------------------------------- mode: split */

/**
 * jsQR against everything downstream of it, on the same frames.
 *
 * The plan allows either one worker or two. This is the measurement that chose
 * one: if the protocol, CRC, dedupe and FEC stage is a rounding error next to
 * the decode it follows, a second worker buys nothing and costs a hop.
 */
async function runSplit(trials: number): Promise<void> {
  const symbolSizeBytes = BALANCED_PROFILE.symbolSizeBytes;
  const stream = await buildV2Stream(0.25, symbolSizeBytes, BALANCED_PROFILE.symbolsPerSegment);
  const pipeline = new ReceivePipeline({ segmentBudgetBytes: 8 * 1024 * 1024 });
  pipeline.submit(stream.manifestFrame);

  const edge = 720;
  const decodeSamples: number[] = [];
  const pipelineSamples: number[] = [];

  for (let trial = 0; trial < trials; trial += 1) {
    const frame = stream.frames[trial % stream.frames.length];
    const canvas = createCanvas(edge, edge);
    await QRCode.toCanvas(canvas as unknown as HTMLCanvasElement, [{ data: frame, mode: 'byte' }], {
      errorCorrectionLevel: 'L',
      margin: BALANCED_PROFILE.quietZoneModules,
      width: edge,
      color: { dark: '#000', light: '#fff' },
    });
    const image = canvas.getContext('2d').getImageData(0, 0, edge, edge);

    const decodeStart = performance.now();
    const code = jsQR(new Uint8ClampedArray(image.data), edge, edge, { inversionAttempts: 'dontInvert' });
    decodeSamples.push(performance.now() - decodeStart);
    if (!code?.binaryData) throw new Error('split fixture did not decode');

    const bytes = Uint8Array.from(code.binaryData);
    const pipelineStart = performance.now();
    pipeline.submit(bytes);
    pipelineSamples.push(performance.now() - pipelineStart);
  }

  const decodeMean = decodeSamples.reduce((total, value) => total + value, 0) / decodeSamples.length;
  const pipelineMean = pipelineSamples.reduce((total, value) => total + value, 0) / pipelineSamples.length;
  report('PHASE05_SPLIT', {
    trials,
    symbolSizeBytes,
    captureEdgePx: edge,
    decodeMeanMs: decodeMean,
    decodeP95Ms: quantile(decodeSamples, 0.95),
    pipelineMeanMs: pipelineMean,
    pipelineP95Ms: quantile(pipelineSamples, 0.95),
    pipelineShareOfDecode: pipelineMean / decodeMean,
    // What the decode alone allows, before any of the rest of the receiver.
    decodeCeilingFps: 1000 / decodeMean,
  });
  pipeline.release();
}

/* --------------------------------------------------------------------- dedupe */

/**
 * What the fingerprint set saves on a frame the receiver has already seen.
 *
 * A DEQR display loops, so most successfully decoded frames in a long transfer
 * carry nothing new. The question is whether answering those from a hash is
 * cheaper than letting them take the ordinary path - and the answer differs by
 * protocol, because v1 and v2 spend very different amounts of work discovering
 * that a frame is a repeat.
 *
 * The control has to actually miss. A single-entry set still answers an
 * immediately repeated frame from cache, so both arms are driven with two
 * frames in alternation: at capacity 1 each one evicts the other and every
 * lookup misses, at full capacity both hit.
 */
async function runDedupe(trials: number): Promise<void> {
  const v2 = await buildV2Stream(0.25, BALANCED_PROFILE.symbolSizeBytes, BALANCED_PROFILE.symbolsPerSegment);

  const payload = syntheticBytes(256 * 1024);
  const container = serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename: 'phase05-dedupe.bin',
      mimeType: 'application/octet-stream',
      originalSize: payload.length,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256: computeSha256(Buffer.from(payload)),
    },
    payload: Buffer.from(payload),
  });
  const v1Encoder = new FountainEncoder(container, 512, 0x0505_0505);
  const v1Frames = [
    new Uint8Array(serializeFrame(v1Encoder.nextFrame())),
    new Uint8Array(serializeFrame(v1Encoder.nextFrame())),
  ];

  const arms: Array<{ protocol: string; prime: Uint8Array[]; frames: Uint8Array[]; frameBytes: number }> = [
    { protocol: 'v2', prime: [v2.manifestFrame], frames: [v2.frames[0], v2.frames[1]], frameBytes: v2.frames[0].length },
    { protocol: 'v1', prime: [], frames: v1Frames, frameBytes: v1Frames[0].length },
  ];

  for (const arm of arms) {
    const time = (dedupeCapacity: number): number => {
      const pipeline = new ReceivePipeline({ dedupeCapacity, segmentBudgetBytes: 8 * 1024 * 1024 });
      for (const frame of arm.prime) pipeline.submit(frame);
      for (const frame of arm.frames) pipeline.submit(frame);
      const startedAt = performance.now();
      for (let trial = 0; trial < trials; trial += 1) pipeline.submit(arm.frames[trial & 1]);
      const elapsed = performance.now() - startedAt;
      pipeline.release();
      return elapsed;
    };

    // Warm both paths before either is timed, so the first arm does not pay for
    // the JIT the second one benefits from.
    time(4_096);
    time(1);
    const hitMs = time(4_096);
    const missMs = time(1);

    report('PHASE05_DEDUPE', {
      protocol: arm.protocol,
      trials,
      frameBytes: arm.frameBytes,
      fingerprintHitUs: (hitMs / trials) * 1000,
      fullPathUs: (missMs / trials) * 1000,
      speedup: missMs / Math.max(hitMs, 1e-9),
    });
  }
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const mode = argument('mode', 'offload');
  if (mode === 'offload') await runOffload(numbers('sizes', '1,4,16'));
  else if (mode === 'sustained') await runSustained(numbers('sizes', '1,4,16'));
  else if (mode === 'backpressure') {
    runBackpressure(
      Number(argument('seconds', '120')),
      Number(argument('captureHz', '30')),
      Number(argument('decodeMs', '80')),
    );
  } else if (mode === 'split') await runSplit(Number(argument('trials', '24')));
  else if (mode === 'dedupe') await runDedupe(Number(argument('trials', '2000')));
  else throw new Error('--mode must be offload, sustained, backpressure, split, or dedupe');
}

main().catch((error: unknown) => {
  console.error(`PHASE05_CAPTURE_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
