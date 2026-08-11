import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve, relative } from 'node:path';
import { arch, platform, release } from 'node:os';
import { computeSha256 } from '../../src/core/hash';
import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { serializeFrame } from '../../src/core/protocol';
import { ReceiverSession } from '../../mobile-web/src/protocol';

const PAYLOAD_SIZES = [5 * 1024, 25 * 1024, 100 * 1024, 500 * 1024, 1024 * 1024] as const;
const LOSS_RATES = [0, 0.3] as const;
const BLOCK_SIZE = 512;
const SESSION_ID = 0x5eed_1234;
const DEFAULT_WARMUPS = 2;
const DEFAULT_SAMPLES = 5;

type MemorySnapshot = ReturnType<typeof process.memoryUsage>;
type NumericSample = Record<string, number>;

interface Options {
  output: string;
  label: string;
  warmups: number;
  samples: number;
}

interface ScenarioSample extends NumericSample {
  payloadBytes: number;
  lossRate: number;
  sourceBlocks: number;
  containerBytes: number;
  frameBytes: number;
  framesGenerated: number;
  framesAccepted: number;
  framesDropped: number;
  receiveCalls: number;
  completed: number;
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`${name} must be an integer between 1 and 100.`);
  }
  return parsed;
}

function parseOptions(argumentsList: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }

  const label = values.get('--label') ?? 'baseline';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(label)) {
    throw new Error('--label may contain only letters, numbers, dots, underscores, and hyphens.');
  }

  return {
    output: values.get('--output') ?? `.local-run/bench/desktop-pwa-pipeline-${label}.json`,
    label,
    warmups: parsePositiveInteger(values.get('--warmups'), '--warmups', DEFAULT_WARMUPS),
    samples: parsePositiveInteger(values.get('--samples'), '--samples', DEFAULT_SAMPLES),
  };
}

function deterministicBytes(length: number, seed: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function createLossDecider(seed: number, rate: number): () => boolean {
  let state = seed >>> 0;
  return () => {
    if (rate === 0) return false;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000 < rate;
  };
}

function duration<T>(operation: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = operation();
  return { value, ms: performance.now() - start };
}

async function durationAsync<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - start };
}

function memoryDelta(before: MemorySnapshot, after: MemorySnapshot): NumericSample {
  return {
    rssDeltaBytes: after.rss - before.rss,
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    externalDeltaBytes: after.external - before.external,
    arrayBuffersDeltaBytes: after.arrayBuffers - before.arrayBuffers,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function runScenario(payloadBytes: number, lossRate: number): Promise<ScenarioSample> {
  // Every repeat uses the identical input and deterministic loss sequence.
  // That makes separate baseline/final runs directly comparable.
  const source = deterministicBytes(payloadBytes, SESSION_ID ^ payloadBytes);
  const memoryBefore = process.memoryUsage();
  const endToEndStart = performance.now();

  const hashResult = duration(() => computeSha256(source));
  const containerResult = duration(() => serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename: 'benchmark.bin',
      mimeType: 'application/octet-stream',
      originalSize: source.length,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256: hashResult.value,
    },
    payload: source,
  }));
  const encoderResult = duration(() => new FountainEncoder(containerResult.value, BLOCK_SIZE, SESSION_ID));
  const receiver = new ReceiverSession();
  const shouldDrop = createLossDecider(SESSION_ID ^ payloadBytes ^ Math.round(lossRate * 1_000), lossRate);
  const maxFrames = encoderResult.value.getBlockCount() * 10 + 100;

  let framesGenerated = 0;
  let framesAccepted = 0;
  let framesDropped = 0;
  let frameBytes = 0;
  let framePipelineMs = 0;
  let receiveMs = 0;
  let receiverState = receiver.snapshot();

  while (receiverState.state !== 'VERIFYING' && framesGenerated < maxFrames) {
    const frameStart = performance.now();
    const rawFrame = serializeFrame(encoderResult.value.nextFrame());
    framePipelineMs += performance.now() - frameStart;
    framesGenerated += 1;
    frameBytes = rawFrame.length;

    if (shouldDrop()) {
      framesDropped += 1;
      continue;
    }

    const receiveStart = performance.now();
    receiverState = receiver.receive(new Uint8Array(rawFrame));
    receiveMs += performance.now() - receiveStart;
    framesAccepted += 1;
  }

  assert(receiverState.state === 'VERIFYING', `Receiver did not reconstruct within ${maxFrames} frames.`);
  const verifyResult = await durationAsync(() => receiver.verify());
  assert(verifyResult.value.state === 'COMPLETE', `Receiver verification failed with ${verifyResult.value.error?.code ?? 'unknown error'}.`);
  assert(verifyResult.value.verified !== undefined, 'Receiver completed without verified bytes.');
  assert(equalBytes(verifyResult.value.verified.bytes, source), 'Verified bytes differ from the deterministic source.');

  const endToEndMs = performance.now() - endToEndStart;
  const memoryAfter = process.memoryUsage();
  const payloadMiB = payloadBytes / (1024 * 1024);

  return {
    payloadBytes,
    lossRate,
    sourceBlocks: encoderResult.value.getBlockCount(),
    containerBytes: containerResult.value.length,
    frameBytes,
    framesGenerated,
    framesAccepted,
    framesDropped,
    receiveCalls: framesAccepted,
    completed: 1,
    hashMs: hashResult.ms,
    containerSerializeMs: containerResult.ms,
    encoderInitMs: encoderResult.ms,
    frameGenerateSerializeMs: framePipelineMs,
    frameGenerateSerializeMeanMs: framePipelineMs / framesGenerated,
    pwaReceiveMs: receiveMs,
    pwaReceiveMeanMs: receiveMs / framesAccepted,
    pwaVerifyMs: verifyResult.ms,
    endToEndMs,
    payloadMiBPerSecond: payloadMiB / (endToEndMs / 1_000),
    repairOverheadRatio: framesGenerated / encoderResult.value.getBlockCount(),
    ...memoryDelta(memoryBefore, memoryAfter),
  };
}

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function summarize(samples: ScenarioSample[]): Record<string, NumericSample> {
  const metricNames = Object.keys(samples[0]).filter((key) => typeof samples[0][key] === 'number');
  return Object.fromEntries(metricNames.map((metric) => {
    const values = samples.map((sample) => sample[metric]);
    return [metric, {
      min: Math.min(...values),
      mean: values.reduce((total, value) => total + value, 0) / values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: Math.max(...values),
    }];
  }));
}

function gitMetadata(): { head: string | null; dirty: boolean | null } {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' }).length > 0;
    return { head, dirty };
  } catch {
    return { head: null, dirty: null };
  }
}

function resolveOutputPath(rawOutput: string): string {
  const allowedRoot = resolve(process.cwd(), '.local-run', 'bench');
  const output = resolve(process.cwd(), rawOutput);
  const outputRelative = relative(allowedRoot, output);
  if (outputRelative.startsWith('..') || outputRelative === '' || outputRelative.includes(':')) {
    throw new Error('Benchmark output must be a file below .local-run/bench/.');
  }
  return output;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const output = resolveOutputPath(options.output);
  const measured: Array<{ payloadBytes: number; lossRate: number; samples: ScenarioSample[]; summary: Record<string, NumericSample> }> = [];

  for (const payloadBytes of PAYLOAD_SIZES) {
    for (const lossRate of LOSS_RATES) {
      for (let warmup = 0; warmup < options.warmups; warmup += 1) {
        await runScenario(payloadBytes, lossRate);
      }

      const samples: ScenarioSample[] = [];
      for (let sample = 0; sample < options.samples; sample += 1) {
        if (typeof global.gc === 'function') global.gc();
        samples.push(await runScenario(payloadBytes, lossRate));
      }
      measured.push({ payloadBytes, lossRate, samples, summary: summarize(samples) });
    }
  }

  const evidence = {
    schemaVersion: 1,
    benchmark: 'desktop-container-fountain-frame-pwa-receiver',
    label: options.label,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      gcAvailable: typeof global.gc === 'function',
      ...gitMetadata(),
    },
    configuration: {
      payloadBytes: PAYLOAD_SIZES,
      lossRates: LOSS_RATES,
      blockSize: BLOCK_SIZE,
      sessionId: SESSION_ID,
      warmupsPerScenario: options.warmups,
      samplesPerScenario: options.samples,
      source: 'deterministic LCG bytes; no transferred payload is persisted in evidence',
      delivery: 'in-memory desktop serialized frames into browser-safe ReceiverSession; no camera or network transport',
    },
    scenarios: measured,
  };

  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`BENCHMARK_COMPLETE scenarios=${measured.length} output=${relative(process.cwd(), output)}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BENCHMARK_FAILED ${message}`);
  process.exitCode = 1;
});
