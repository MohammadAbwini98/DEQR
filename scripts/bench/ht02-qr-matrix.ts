/**
 * HT-02 benchmark matrix — single QR, ECC L vs M, 3 payload sizes, 15/24/30 FPS.
 * Synthetic, offline, no payload printed. Reports decode rate, unique/sec, goodput, module size.
 */

import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from 'canvas';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { evaluateFrameSize } from '../../src/core/qr-frame-model';
import { resolveQrRenderPlan } from '../../src/renderer/qr-render';
import type { QrEccLevel } from '../../src/core/qr-capacity';

const PAYLOAD_SIZES = [500, 1000, 1465] as const;
const ECC_LEVELS: QrEccLevel[] = ['L', 'M'];
const FPS_TARGETS = [15, 24, 30] as const;
const BUDGET_CSS_PX = 480;

async function benchmark(): Promise<void> {
  const results: unknown[] = [];
  for (const ecc of ECC_LEVELS) {
    for (const frameBytes of PAYLOAD_SIZES) {
      const evalRes = evaluateFrameSize(frameBytes, ecc);
      if (!evalRes.feasible) {
        results.push({ frameBytes, ecc, feasible: false });
        continue;
      }
      // Generate a deterministic payload of payloadBytes length
      const payload = new Uint8Array(evalRes.payloadBytes);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
      const plan = resolveQrRenderPlan({ frameBytes, eccLevel: ecc, budgetCssPx: BUDGET_CSS_PX });
      const canvas = createCanvas(plan.geometry.pixelSize, plan.geometry.pixelSize);
      const t0 = performance.now();
      await QRCode.toCanvas(canvas as unknown as HTMLCanvasElement, [{ data: payload, mode: 'byte' }], {
        errorCorrectionLevel: plan.eccLevel,
        version: plan.version,
        scale: plan.geometry.moduleScale,
        margin: plan.geometry.quietZoneModules,
      });
      const encodeMs = performance.now() - t0;
      // Decode via jsQR from canvas image data
      const ctx = canvas.getContext('2d');
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d0 = performance.now();
      const code = jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      const decodeMs = performance.now() - d0;
      const success = !!code?.binaryData && code.binaryData.length === payload.length;
      // Goodput at each FPS: payloadBytes * FPS (useful) vs decode ceiling
      const goodput = PAYLOAD_SIZES.map(() => null); // placeholder
      for (const fps of FPS_TARGETS) {
        const goodputPerFps = evalRes.payloadBytes * fps;
        results.push({
          frameBytes,
          payloadBytes: evalRes.payloadBytes,
          ecc,
          version: plan.version,
          moduleScale: plan.geometry.moduleScale,
          pixelSize: plan.geometry.pixelSize,
          physicalModuleSizeCssPx: plan.geometry.cssSize / plan.geometry.totalModules,
          feasible: true,
          encodeMs: Number(encodeMs.toFixed(2)),
          decodeMs: Number(decodeMs.toFixed(2)),
          decodeSuccess: success,
          targetFps: fps,
          goodputBytesPerSecond: goodputPerFps,
          uniqueSymbolsPerSecondEst: fps, // single QR, one unique per frame when keeping up
        });
      }
    }
  }
  const outDir = path.resolve('.local-run/bench');
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'ht02-qr-matrix.json');
  await writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`HT02_MATRIX written ${path.relative(process.cwd(), file)} with ${results.length} rows`);
  for (const r of results.slice(0, 6)) console.log(JSON.stringify(r));
}

benchmark().catch(e => { console.error(e); process.exitCode = 1; });
