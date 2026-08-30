/**
 * HT-07 — Crop vs full benchmark (synthetic, offline).
 * Measures full-frame jsQR (720×720) vs tracked crop (~120×120) decode p50/p95.
 * Synthetic: generate QR, render to canvas, then decode full vs crop.
 */

import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from 'canvas';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

async function bench() {
  const sizes = [720, 120]; // full vs crop
  const payload = new Uint8Array(686); // Balanced
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
  const results: unknown[] = [];
  for (const size of sizes) {
    const canvas = createCanvas(size, size);
    // Render QR at this size (simulate crop)
    await QRCode.toCanvas(canvas as unknown as HTMLCanvasElement, [{ data: payload, mode: 'byte' }], { errorCorrectionLevel: 'L', version: 18, scale: Math.floor(size / 97), margin: 4 });
    const ctx = canvas.getContext('2d');
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const code = jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      const dt = performance.now() - t0;
      times.push(dt);
      if (!code?.binaryData) throw new Error('decode failed');
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.floor(times.length * 0.95)];
    results.push({ size, p50: Number(p50.toFixed(2)), p95: Number(p95.toFixed(2)), avg: Number((times.reduce((a,b)=>a+b,0)/times.length).toFixed(2)) });
  }
  const outDir = path.resolve('.local-run/bench');
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'ht07-crop-vs-full.json');
  await writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`HT07_BENCH written ${path.relative(process.cwd(), file)}`);
  console.log(JSON.stringify(results, null, 2));
  const full = results[0] as { p50: number; p95: number };
  const crop = results[1] as { p50: number; p95: number };
  console.log(`HT07_CROP_GAIN p50 ${full.p50} -> ${crop.p50} ms (${(full.p50/crop.p50).toFixed(1)}×), p95 ${full.p95} -> ${crop.p95} ms (${(full.p95/crop.p95).toFixed(1)}×)`);
}

bench().catch(e => { console.error(e); process.exitCode = 1; });
