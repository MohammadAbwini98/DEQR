import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve, relative } from 'node:path';
import { arch, platform, release } from 'node:os';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { createCanvas } from 'canvas';
import { computeSha256 } from '../../src/core/hash';
import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { serializeFrame } from '../../src/core/protocol';

const RASTER_SIZES = [400, 1000] as const;
const DEFAULT_WARMUPS = 2;
const DEFAULT_SAMPLES = 5;
const BLOCK_SIZE = 512;
const SESSION_ID = 0x5eed_1234;

interface Options {
  output: string;
  label: string;
  warmups: number;
  samples: number;
}

interface Sample {
  rasterSize: number;
  frameKind: 'systematic' | 'repair';
  frameBytes: number;
  qrEncodeMs: number;
  pixelReadMs: number;
  qrDecodeMs: number;
  roundTripMs: number;
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`${name} must be an integer between 1 and 100.`);
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
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(label)) throw new Error('--label may contain only letters, numbers, dots, underscores, and hyphens.');
  return {
    output: values.get('--output') ?? `.local-run/bench/qr-frame-roundtrip-${label}.json`,
    label,
    warmups: parsePositiveInteger(values.get('--warmups'), '--warmups', DEFAULT_WARMUPS),
    samples: parsePositiveInteger(values.get('--samples'), '--samples', DEFAULT_SAMPLES),
  };
}

function deterministicBytes(length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = 0x1234_5678;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createFrames(): { systematic: Uint8Array; repair: Uint8Array } {
  const source = deterministicBytes(5 * 1024);
  const container = serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename: 'benchmark.bin',
      mimeType: 'application/octet-stream',
      originalSize: source.length,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256: computeSha256(source),
    },
    payload: source,
  });
  const encoder = new FountainEncoder(container, BLOCK_SIZE, SESSION_ID);
  const systematic = new Uint8Array(serializeFrame(encoder.nextFrame()));
  for (let index = 1; index < encoder.getBlockCount(); index += 1) encoder.nextFrame();
  const repair = new Uint8Array(serializeFrame(encoder.nextFrame()));
  return { systematic, repair };
}

async function roundTrip(frame: Uint8Array, frameKind: Sample['frameKind'], rasterSize: number): Promise<Sample> {
  const canvas = createCanvas(rasterSize, rasterSize) as unknown as HTMLCanvasElement;
  const roundTripStart = performance.now();
  const encodeStart = performance.now();
  await QRCode.toCanvas(canvas, [{ data: frame, mode: 'byte' }], {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: rasterSize,
    color: { dark: '#000000', light: '#ffffff' },
  });
  const qrEncodeMs = performance.now() - encodeStart;
  const context = (canvas as unknown as { getContext(type: string): CanvasRenderingContext2D }).getContext('2d');
  assert(context, 'Node canvas did not provide a 2D context.');
  const pixelStart = performance.now();
  const image = context.getImageData(0, 0, rasterSize, rasterSize);
  const pixelReadMs = performance.now() - pixelStart;
  const decodeStart = performance.now();
  const decoded = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  const qrDecodeMs = performance.now() - decodeStart;
  assert(decoded?.binaryData, 'jsQR did not decode the rendered serialized desktop frame.');
  assert(equalBytes(new Uint8Array(decoded.binaryData), frame), 'QR roundtrip changed raw frame bytes.');
  return { rasterSize, frameKind, frameBytes: frame.length, qrEncodeMs, pixelReadMs, qrDecodeMs, roundTripMs: performance.now() - roundTripStart };
}

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function summarize(samples: Sample[]): Record<string, { min: number; mean: number; p50: number; p95: number; max: number }> {
  const metrics: Array<keyof Sample> = ['frameBytes', 'qrEncodeMs', 'pixelReadMs', 'qrDecodeMs', 'roundTripMs'];
  return Object.fromEntries(metrics.map((metric) => {
    const values = samples.map((sample) => sample[metric] as number);
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
  const frames = createFrames();
  const scenarios: Array<{ rasterSize: number; frameKind: Sample['frameKind']; samples: Sample[]; summary: ReturnType<typeof summarize> }> = [];

  for (const rasterSize of RASTER_SIZES) {
    for (const [frameKind, frame] of Object.entries(frames) as Array<[Sample['frameKind'], Uint8Array]>) {
      for (let warmup = 0; warmup < options.warmups; warmup += 1) await roundTrip(frame, frameKind, rasterSize);
      const samples: Sample[] = [];
      for (let sample = 0; sample < options.samples; sample += 1) samples.push(await roundTrip(frame, frameKind, rasterSize));
      scenarios.push({ rasterSize, frameKind, samples, summary: summarize(samples) });
    }
  }

  const evidence = {
    schemaVersion: 1,
    benchmark: 'serialized-desktop-frame-node-canvas-qr-roundtrip',
    label: options.label,
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), release: release(), arch: arch(), ...gitMetadata() },
    configuration: {
      sourceBytes: 5 * 1024,
      blockSize: BLOCK_SIZE,
      actualFrameBytes: scenarios[0]?.samples[0]?.frameBytes ?? null,
      rasterSizes: RASTER_SIZES,
      errorCorrectionLevel: 'L',
      margin: 2,
      warmupsPerScenario: options.warmups,
      samplesPerScenario: options.samples,
      proxy: 'Node canvas + jsQR; not a browser display, camera sensor, Safari worker, or physical optical measurement',
    },
    scenarios,
  };

  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`BENCHMARK_COMPLETE scenarios=${scenarios.length} output=${relative(process.cwd(), output)}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`BENCHMARK_FAILED ${message}`);
  process.exitCode = 1;
});
