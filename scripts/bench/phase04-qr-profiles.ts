/**
 * Phase 04 - QR transport profiles: capacity, CPU, optical robustness, goodput.
 *
 * The plan's rule for this phase is blunt: "Never select a profile because it
 * displays the most frames/sec. Select based on end-to-end unique/verified
 * payload bytes/sec and loss/repair cost." This harness implements that rule
 * literally, in four modes.
 *
 * `--mode capacity` re-derives byte-mode capacity by probing the shipping
 * encoder, so `src/core/qr-capacity.ts` is never a table someone typed.
 *
 * `--mode cpu` times encoding and decoding one real v2 frame per version. It
 * establishes the ceiling FPS that CPU alone allows, on this machine, for a
 * sender and a receiver that are not a phone.
 *
 * `--mode optical` is the one that matters. It renders a real frame, then
 * *simulates a camera looking at it*: resample to a chosen number of camera
 * pixels per module, at a fractional offset so the camera grid never aligns
 * with the display grid, with optional defocus and sensor noise. Decoding that
 * with the receiver's own jsQR gives a decode success rate per version, per
 * sampling density.
 *
 * `--mode goodput` composes the two measurements with Phase 03's repair curve:
 * a failed decode is a lost frame, a lost frame costs repair overhead, and
 * repair overhead costs time. The output is verified payload bytes per second.
 *
 *   node node_modules/vite-node/vite-node.mjs scripts/bench/phase04-qr-profiles.ts -- \
 *     --mode optical --versions 20,24,28,32 --ecc L,M --px 2,2.5,3,4 --trials 24
 *
 * Payload safety: deterministic synthetic frames built by the real v2
 * serializer. Nothing is read from disk and no payload byte is printed.
 */

import { performance } from 'node:perf_hooks';

import { createCanvas } from 'canvas';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

import {
  QR_BENCHMARK_VERSIONS,
  QR_QUIET_ZONE_MODULES,
  QrEccLevel,
  qrByteCapacity,
  qrModuleCount,
} from '../../src/core/qr-capacity';
import { requiredRepairRatio } from '../../src/core/transport-profiles';
import { V2_DATA_LAYOUT, V2_FRAME_TYPE, serializeDataFrame } from '../../src/core/protocol-v2';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { PRNG } from '../../src/core/prng';

/* ---------------------------------------------------------------- plumbing */

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numbers(name: string, fallback: string): number[] {
  return argument(name, fallback).split(',').map(Number).filter((value) => Number.isFinite(value));
}

function eccLevels(): QrEccLevel[] {
  return argument('ecc', 'L,M,Q').split(',').map((value) => value.trim().toUpperCase() as QrEccLevel);
}

type Canvas2D = { getContext(type: '2d'): CanvasRenderingContext2D; width: number; height: number };

function canvasOf(width: number, height = width): Canvas2D {
  return createCanvas(width, height) as unknown as Canvas2D;
}

/**
 * Where the symbol sits in what the camera actually sees.
 *
 * A phone does not receive a tightly cropped QR code; it receives a whole
 * video frame of a fixed size, with the symbol somewhere in it. That matters
 * twice over. Finder-pattern search runs over the entire frame, so decode cost
 * is dominated by the frame size and barely by the QR version - measuring a
 * crop that grows with the version invents a version-dependence the receiver
 * never pays. And a symbol competing with a background is a harder find than
 * one that fills the image.
 *
 * Stated simplification: defocus and sensor noise are applied to the symbol
 * region rather than to the whole frame, because blurring 921,600 pixels per
 * trial in JavaScript costs more than the fidelity buys. The background is
 * flat, so blurring it would change nothing except the runtime.
 */
function parseFrameSize(value: string): { width: number; height: number } | null {
  if (value === 'none') return null;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`--frame must be WxH or "none", received ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function embedInCameraFrame(
  symbol: Canvas2D,
  frame: { width: number; height: number },
  prng: PRNG,
): Canvas2D {
  if (symbol.width > frame.width || symbol.height > frame.height) {
    throw new Error(`symbol is ${symbol.width}px across; a ${frame.width}x${frame.height} frame cannot hold it`);
  }
  const canvas = canvasOf(frame.width, frame.height);
  const context = canvas.getContext('2d');
  // Not white: a white background merges with the quiet zone and hands the
  // decoder an easier find than a real scene ever does.
  context.fillStyle = '#9aa0a6';
  context.fillRect(0, 0, frame.width, frame.height);
  const x = Math.round((frame.width - symbol.width) / 2 + (prng.next() - 0.5) * 40);
  const y = Math.round((frame.height - symbol.height) / 2 + (prng.next() - 0.5) * 40);
  context.drawImage(symbol as unknown as CanvasImageSource, Math.max(0, x), Math.max(0, y));
  return canvas;
}

/* --------------------------------------------------------- deterministic frames */

/**
 * A real v2 data frame of exactly `symbolBytes` payload.
 *
 * Built by the shipping serializer over a deterministic segment, so what the
 * QR encoder sees here is byte-for-byte what it would see in a transfer -
 * header, CRC, high-entropy payload and all. A benchmark that encodes zeroes
 * measures a compressibility the optical path never gets.
 */
function deterministicFrame(symbolBytes: number, symbolId: number, seed: number): Uint8Array {
  const segment = new Uint8Array(symbolBytes * 64);
  let state = seed >>> 0;
  for (let index = 0; index < segment.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    segment[index] = state >>> 24;
  }
  const encoder = new SegmentEncoder(symbolBytes);
  encoder.loadSegment(segment);
  const payload = new Uint8Array(symbolBytes);
  encoder.symbolInto(symbolId, payload);
  encoder.release();

  return serializeDataFrame({
    frameType: symbolId < 64 ? V2_FRAME_TYPE.SOURCE : V2_FRAME_TYPE.REPAIR,
    sessionId: 0x5eed_0004,
    fileId: 0x0404_0404,
    segmentIndex: 0,
    symbolId,
    sourceSymbolCount: 64,
    frameFlags: 0,
    payload,
  });
}

/**
 * A replayable frame set: the same bytes every run, so numbers are comparable.
 *
 * One distinct frame per trial, not a small set cycled. Reusing eight frames
 * across forty trials looks like forty samples and behaves like eight: a QR
 * symbol's robustness depends on its mask pattern and module layout, so repeats
 * of the same frame are correlated outcomes. Sizing the set to the trial count
 * is what makes the success rates mean what they appear to mean.
 */
function frameSet(symbolBytes: number, count: number, seed = 0x51ce_0404): Uint8Array[] {
  return Array.from({ length: count }, (_, index) => deterministicFrame(symbolBytes, index, seed + index * 7919));
}

/* ------------------------------------------------------------------ capacity */

function fits(byteCount: number, version: number, ecc: QrEccLevel): boolean {
  try {
    QRCode.create([{ data: Buffer.alloc(byteCount), mode: 'byte' }], { errorCorrectionLevel: ecc, version });
    return true;
  } catch {
    return false;
  }
}

/** Largest byte-mode payload the shipping encoder accepts, by binary search. */
export function deriveCapacity(version: number, ecc: QrEccLevel): number {
  let low = 1;
  let high = 4096;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (fits(mid, version, ecc)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function runCapacity(versions: number[], levels: QrEccLevel[]): void {
  for (const version of versions) {
    const derived = levels.map((ecc) => `${ecc}=${deriveCapacity(version, ecc)}`).join(' ');
    const tabulated = levels.map((ecc) => `${ecc}=${qrByteCapacity(version, ecc) ?? 'none'}`).join(' ');
    const agrees = levels.every((ecc) => deriveCapacity(version, ecc) === qrByteCapacity(version, ecc));
    console.log([
      'PHASE04_CAPACITY',
      `version=${version}`,
      `modules=${qrModuleCount(version)}`,
      `derived=[${derived}]`,
      `tabulated=[${tabulated}]`,
      `agrees=${agrees ? 'yes' : 'NO'}`,
    ].join(' '));
  }
}

/* ----------------------------------------------------------------- rendering */

/**
 * Paints one frame as a QR symbol at a whole number of pixels per module.
 *
 * `QRCode.toCanvas`'s `width` option divides a pixel budget by the module count
 * and accepts whatever fraction falls out. `scale` multiplies instead, which is
 * the entire difference between crisp modules and modules that are one pixel
 * wider every so often.
 */
function renderFrame(frame: Uint8Array, version: number, ecc: QrEccLevel, moduleScale: number): Canvas2D {
  const totalModules = qrModuleCount(version) + 2 * QR_QUIET_ZONE_MODULES;
  const canvas = canvasOf(totalModules * moduleScale);
  QRCode.toCanvas(canvas as unknown as HTMLCanvasElement, [{ data: frame, mode: 'byte' }], {
    errorCorrectionLevel: ecc,
    version,
    scale: moduleScale,
    margin: QR_QUIET_ZONE_MODULES,
    color: { dark: '#000000', light: '#ffffff' },
  });
  return canvas;
}

interface DecodeTiming {
  bytes: Uint8Array | null;
  /** Pulling pixels out of the canvas. Node-canvas specific; a browser pays a different price. */
  readbackMs: number;
  /** jsQR itself - the part the receiver actually runs, and the only transferable number. */
  scanMs: number;
}

function decodeCanvas(canvas: Canvas2D): DecodeTiming {
  const context = canvas.getContext('2d');
  const readbackStart = performance.now();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const readbackMs = performance.now() - readbackStart;

  const scanStart = performance.now();
  const code = jsQR(image.data as unknown as Uint8ClampedArray, image.width, image.height);
  const scanMs = performance.now() - scanStart;

  return { bytes: code ? new Uint8Array(code.binaryData) : null, readbackMs, scanMs };
}

function isExact(result: Uint8Array | null, frame: Uint8Array): boolean {
  return result !== null && result.length === frame.length && result.every((byte, index) => byte === frame[index]);
}

/** True when a symbol at this scale cannot physically fit the camera frame. */
function fitsCameraFrame(symbolPx: number, cameraFrame: { width: number; height: number } | null): boolean {
  return cameraFrame === null || (symbolPx <= cameraFrame.width && symbolPx <= cameraFrame.height);
}

/* ---------------------------------------------------------------------- cpu */

function runCpu(
  versions: number[],
  levels: QrEccLevel[],
  trials: number,
  cameraFrame: { width: number; height: number } | null,
): void {
  for (const version of versions) {
    for (const ecc of levels) {
      const capacity = qrByteCapacity(version, ecc);
      if (capacity === null || capacity <= V2_DATA_LAYOUT.overheadBytes) continue;
      const symbolBytes = capacity - V2_DATA_LAYOUT.overheadBytes;
      const frames = frameSet(symbolBytes, trials);

      // A display-sized render: 4 device pixels per module is a realistic
      // desktop presentation of a large symbol. Decoding happens against a
      // fixed camera frame, because that is the image a phone's decoder is
      // handed regardless of which QR version is on the screen.
      const prng = new PRNG(0x0404_2000 + version);
      const displayScale = 4;
      const symbolPx = (qrModuleCount(version) + 2 * QR_QUIET_ZONE_MODULES) * displayScale;
      if (!fitsCameraFrame(symbolPx, cameraFrame)) {
        // Not a harness limitation. A version-40 symbol at four device pixels
        // per module is 740 px across, and a 720-line capture stream cannot see
        // all of it at once however good the optics are.
        console.log(['PHASE04_CPU', 'version=' + version, 'ecc=' + ecc, 'symbolPx=' + symbolPx,
          'result=SKIPPED', 'reason=symbol-exceeds-camera-frame'].join(' '));
        continue;
      }

      let encodeMs = 0;
      let readbackMs = 0;
      let scanMs = 0;
      let decoded = 0;
      for (let trial = 0; trial < trials; trial += 1) {
        const frame = frames[trial % frames.length];
        const encodeStart = performance.now();
        const canvas = renderFrame(frame, version, ecc, displayScale);
        encodeMs += performance.now() - encodeStart;

        const presented = cameraFrame ? embedInCameraFrame(canvas, cameraFrame, prng) : canvas;
        const timing = decodeCanvas(presented);
        readbackMs += timing.readbackMs;
        scanMs += timing.scanMs;
        if (isExact(timing.bytes, frame)) decoded += 1;
      }

      const encodePerFrame = encodeMs / trials;
      const scanPerFrame = scanMs / trials;
      console.log([
        'PHASE04_CPU',
        `frame=${cameraFrame ? `${cameraFrame.width}x${cameraFrame.height}` : 'crop'}`,
        `version=${version}`,
        `ecc=${ecc}`,
        `symbolBytes=${symbolBytes}`,
        `frameBytes=${capacity}`,
        `symbolPx=${symbolPx}`,
        `encodeMsPerFrame=${encodePerFrame.toFixed(3)}`,
        `scanMsPerFrame=${scanPerFrame.toFixed(3)}`,
        `readbackMsPerFrame=${(readbackMs / trials).toFixed(3)}`,
        `encodeCeilingFps=${(1000 / Math.max(encodePerFrame, 1e-6)).toFixed(1)}`,
        `scanCeilingFps=${(1000 / Math.max(scanPerFrame, 1e-6)).toFixed(1)}`,
        `exactRoundTrips=${decoded}/${trials}`,
      ].join(' '));
    }
  }
}

/* ------------------------------------------------------------------ optical */

/**
 * What a camera does to a displayed symbol, as far as a decoder can tell.
 *
 * Three effects, and the first is the one people forget: **the camera's pixel
 * grid does not line up with the display's.** Sampling at a fractional offset
 * is not a detail, it is the normal case, and a benchmark that resamples on
 * whole pixels measures a machine reading its own output rather than a phone
 * reading a screen.
 *
 * The resample is an explicit **area average** rather than `drawImage`. That is
 * not fussiness. Relying on the canvas filter produced a curve where 3.5 pixels
 * per module decoded far worse than either 3 or 4, which is not something
 * optics does - it was the filter aliasing at non-integer ratios. An area
 * average has no preferred ratio, and it is also the physically right model: a
 * sensor pixel integrates the light falling on its footprint.
 *
 * Defocus is a separable Gaussian with sigma in captured pixels, and sensor
 * noise is uniform. Neither is a calibrated optical model and neither is
 * claimed to be; they are the degradations that separate a symbol with margin
 * from one without. The absolute numbers belong to Phase 11 and a real iPhone.
 */
function toGrayscale(canvas: Canvas2D): { data: Float32Array; size: number } {
  const size = canvas.width;
  const image = canvas.getContext('2d').getImageData(0, 0, size, size);
  const data = new Float32Array(size * size);
  for (let index = 0; index < data.length; index += 1) data[index] = image.data[index * 4];
  return { data, size };
}

/** Area-averaged downsample with a sub-pixel offset, in grayscale. */
function resampleArea(
  source: { data: Float32Array; size: number },
  targetSize: number,
  offsetX: number,
  offsetY: number,
): Float32Array {
  const out = new Float32Array(targetSize * targetSize);
  const step = source.size / targetSize;

  for (let ty = 0; ty < targetSize; ty += 1) {
    const y0 = (ty + offsetY) * step;
    const y1 = y0 + step;
    const sy0 = Math.max(0, Math.floor(y0));
    const sy1 = Math.min(source.size - 1, Math.ceil(y1) - 1);

    for (let tx = 0; tx < targetSize; tx += 1) {
      const x0 = (tx + offsetX) * step;
      const x1 = x0 + step;
      const sx0 = Math.max(0, Math.floor(x0));
      const sx1 = Math.min(source.size - 1, Math.ceil(x1) - 1);

      let sum = 0;
      let weight = 0;
      for (let sy = sy0; sy <= sy1; sy += 1) {
        const coverY = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (coverY <= 0) continue;
        for (let sx = sx0; sx <= sx1; sx += 1) {
          const coverX = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (coverX <= 0) continue;
          const area = coverX * coverY;
          sum += source.data[sy * source.size + sx] * area;
          weight += area;
        }
      }
      // Off the edge of the source is the white surround the display shows.
      out[ty * targetSize + tx] = weight > 0 ? sum / weight : 255;
    }
  }
  return out;
}

/** Separable Gaussian blur, sigma in captured pixels. */
function gaussianBlur(data: Float32Array, size: number, sigma: number): Float32Array {
  if (sigma <= 0) return data;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const value = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + radius] = value;
    total += value;
  }
  for (let index = 0; index < kernel.length; index += 1) kernel[index] /= total;

  const horizontal = new Float32Array(data.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sx = Math.min(size - 1, Math.max(0, x + offset));
        sum += data[y * size + sx] * kernel[offset + radius];
      }
      horizontal[y * size + x] = sum;
    }
  }

  const blurred = new Float32Array(data.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sy = Math.min(size - 1, Math.max(0, y + offset));
        sum += horizontal[sy * size + x] * kernel[offset + radius];
      }
      blurred[y * size + x] = sum;
    }
  }
  return blurred;
}

function simulateCapture(
  source: { data: Float32Array; size: number },
  targetSize: number,
  offset: { x: number; y: number },
  blurSigma: number,
  noise: number,
  prng: PRNG,
): Canvas2D {
  const sampled = gaussianBlur(resampleArea(source, targetSize, offset.x, offset.y), targetSize, blurSigma);

  const captured = canvasOf(targetSize);
  const context = captured.getContext('2d');
  const image = context.createImageData(targetSize, targetSize);
  for (let index = 0; index < sampled.length; index += 1) {
    const jitter = noise > 0 ? (prng.next() - 0.5) * 2 * noise : 0;
    const value = Math.max(0, Math.min(255, sampled[index] + jitter));
    const pixel = index * 4;
    image.data[pixel] = value;
    image.data[pixel + 1] = value;
    image.data[pixel + 2] = value;
    image.data[pixel + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return captured;
}

function runOptical(
  versions: number[],
  levels: QrEccLevel[],
  pxPerModule: number[],
  trials: number,
  blurSigma: number,
  noise: number,
  cameraFrame: { width: number; height: number } | null,
): void {
  // Rendered well above any sampling density under test, so the capture step is
  // always downsampling - which is what a camera does.
  const sourceScale = Number(argument('source-scale', '8'));

  for (const version of versions) {
    for (const ecc of levels) {
      const capacity = qrByteCapacity(version, ecc);
      if (capacity === null || capacity <= V2_DATA_LAYOUT.overheadBytes) continue;
      const symbolBytes = capacity - V2_DATA_LAYOUT.overheadBytes;
      const totalModules = qrModuleCount(version) + 2 * QR_QUIET_ZONE_MODULES;
      const frames = frameSet(symbolBytes, trials);

      for (const px of pxPerModule) {
        const targetSize = Math.round(totalModules * px);
        if (!fitsCameraFrame(targetSize, cameraFrame)) {
          console.log(['PHASE04_OPTICAL', 'version=' + version, 'ecc=' + ecc, 'pxPerModule=' + px,
            'capturedPx=' + targetSize, 'result=SKIPPED', 'reason=symbol-exceeds-camera-frame'].join(' '));
          continue;
        }
        const prng = new PRNG(0x0404_0000 + version * 97 + Math.round(px * 10));
        let exact = 0;
        let decodedWrong = 0;
        let decodeMs = 0;

        for (let trial = 0; trial < trials; trial += 1) {
          const frame = frames[trial % frames.length];
          const source = toGrayscale(renderFrame(frame, version, ecc, sourceScale));
          const captured = simulateCapture(
            source,
            targetSize,
            { x: prng.next(), y: prng.next() },
            blurSigma,
            noise,
            prng,
          );
          const presented = cameraFrame ? embedInCameraFrame(captured, cameraFrame, prng) : captured;
          const timing = decodeCanvas(presented);
          decodeMs += timing.scanMs;

          if (!timing.bytes) continue;
          if (isExact(timing.bytes, frame)) exact += 1;
          // A decode that returns different bytes is far worse than no decode.
          // The frame CRC catches it, but it must be counted, never averaged in.
          else decodedWrong += 1;
        }

        console.log([
          'PHASE04_OPTICAL',
          `frame=${cameraFrame ? `${cameraFrame.width}x${cameraFrame.height}` : 'crop'}`,
          `version=${version}`,
          `ecc=${ecc}`,
          `symbolBytes=${symbolBytes}`,
          `pxPerModule=${px}`,
          `capturedPx=${targetSize}`,
          `blurSigma=${blurSigma}`,
          `noise=${noise}`,
          `trials=${trials}`,
          `exactDecodes=${exact}`,
          `wrongDecodes=${decodedWrong}`,
          `successRate=${(exact / trials).toFixed(4)}`,
          `scanMsPerFrame=${(decodeMs / trials).toFixed(3)}`,
        ].join(' '));
      }
    }
  }
}

/* ------------------------------------------------------------------ goodput */

/**
 * The decision metric, composed from the two measurements above.
 *
 * A failed decode is a lost frame. Phase 03 measured what a lost frame costs in
 * repair overhead, and repair overhead costs time, so:
 *
 *   goodput = symbolBytes x achievableFps / (1 + requiredRepairRatio(lossRate))
 *
 * `achievableFps` is the target capped by what encode and decode CPU allow.
 * Above the loss rate Phase 03 measured, `requiredRepairRatio` returns null and
 * the combination is reported as unusable rather than extrapolated.
 */
function runGoodput(
  versions: number[],
  levels: QrEccLevel[],
  pxPerModule: number[],
  targetFpsList: number[],
  trials: number,
  blurSigma: number,
  noise: number,
  cameraFrame: { width: number; height: number } | null,
): void {
  const sourceScale = Number(argument('source-scale', '8'));

  for (const version of versions) {
    for (const ecc of levels) {
      const capacity = qrByteCapacity(version, ecc);
      if (capacity === null || capacity <= V2_DATA_LAYOUT.overheadBytes) continue;
      const symbolBytes = capacity - V2_DATA_LAYOUT.overheadBytes;
      const totalModules = qrModuleCount(version) + 2 * QR_QUIET_ZONE_MODULES;
      const frames = frameSet(symbolBytes, trials);

      for (const px of pxPerModule) {
        const targetSize = Math.round(totalModules * px);
        if (!fitsCameraFrame(targetSize, cameraFrame)) continue;
        const prng = new PRNG(0x0404_1000 + version * 89 + Math.round(px * 10));
        let exact = 0;
        let encodeMs = 0;
        let decodeMs = 0;

        for (let trial = 0; trial < trials; trial += 1) {
          const frame = frames[trial % frames.length];
          const encodeStart = performance.now();
          const rendered = renderFrame(frame, version, ecc, sourceScale);
          encodeMs += performance.now() - encodeStart;

          const captured = simulateCapture(
            toGrayscale(rendered),
            targetSize,
            { x: prng.next(), y: prng.next() },
            blurSigma,
            noise,
            prng,
          );
          const presented = cameraFrame ? embedInCameraFrame(captured, cameraFrame, prng) : captured;
          const timing = decodeCanvas(presented);
          decodeMs += timing.scanMs;
          if (isExact(timing.bytes, frame)) exact += 1;
        }

        const successRate = exact / trials;
        const lossRate = 1 - successRate;
        const repair = requiredRepairRatio(lossRate);
        const encodeCeiling = 1000 / Math.max(encodeMs / trials, 1e-6);
        const decodeCeiling = 1000 / Math.max(decodeMs / trials, 1e-6);

        for (const targetFps of targetFpsList) {
          const achievableFps = Math.min(targetFps, encodeCeiling, decodeCeiling);
          const goodput = repair === null ? 0 : (symbolBytes * achievableFps) / (1 + repair);
          console.log([
            'PHASE04_GOODPUT',
            `frame=${cameraFrame ? `${cameraFrame.width}x${cameraFrame.height}` : 'crop'}`,
            `version=${version}`,
            `ecc=${ecc}`,
            `symbolBytes=${symbolBytes}`,
            `pxPerModule=${px}`,
            `targetFps=${targetFps}`,
            `successRate=${successRate.toFixed(4)}`,
            `lossRate=${lossRate.toFixed(4)}`,
            `repairRatio=${repair === null ? 'unmeasured' : repair.toFixed(3)}`,
            `achievableFps=${achievableFps.toFixed(1)}`,
            `verifiedBytesPerSecond=${repair === null ? 'unusable' : goodput.toFixed(0)}`,
          ].join(' '));
        }
      }
    }
  }
}

/* --------------------------------------------------------------------- main */

function main(): void {
  const mode = argument('mode', 'goodput');
  const versions = numbers('versions', QR_BENCHMARK_VERSIONS.join(','));
  const levels = eccLevels();
  const trials = Number(argument('trials', '16'));
  // Defocus as a Gaussian sigma in captured pixels. 0.7 is a mild, realistic
  // softness for a phone that has focused; the sweep varies it deliberately.
  const blurSigma = Number(argument('blur', '0.7'));
  const noise = Number(argument('noise', '10'));
  // 1280x720 is a conservative stand-in for an iPhone capture stream: real
  // devices offer more, and more pixels only make the finder-pattern search
  // more expensive, so this is the optimistic end of decode cost.
  const cameraFrame = parseFrameSize(argument('frame', '1280x720'));

  for (const version of versions) {
    if (!QR_BENCHMARK_VERSIONS.includes(version)) {
      throw new Error(`version ${version} is not in the capacity table; add it with --mode capacity first`);
    }
  }

  if (mode === 'capacity') runCapacity(versions, levels);
  else if (mode === 'cpu') runCpu(versions, levels, trials, cameraFrame);
  else if (mode === 'optical') {
    runOptical(versions, levels, numbers('px', '2,2.5,3,4'), trials, blurSigma, noise, cameraFrame);
  } else if (mode === 'goodput') {
    runGoodput(versions, levels, numbers('px', '3'), numbers('fps', '15,20,24,30,45,60'), trials, blurSigma, noise, cameraFrame);
  } else throw new Error('--mode must be capacity, cpu, optical, or goodput');
}

try {
  main();
} catch (error: unknown) {
  console.error(`PHASE04_QR_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
