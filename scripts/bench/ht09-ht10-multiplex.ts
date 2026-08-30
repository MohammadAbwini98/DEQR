/**
 * HT-09/10 — 1 vs 2 vs 4 code synthetic goodput.
 * Measures unique symbols/sec and goodput for 1,2,4-code grids at same per-code FPS and payload.
 * Synthetic: uses multiplexer layout + per-lane queue, staggered phases 0/0.5 and 0/¼/½/¾.
 */

import { layoutForGrid, densityGuardrailValid } from '../../src/renderer/multiplexer';
import { qrModuleCount } from '../../src/core/qr-capacity';

const PAYLOAD = 686; // Balanced
const PER_CODE_FPS = 12;
const VERSION = 18;
const QUIET = 4;

async function bench() {
  const results: unknown[] = [];
  for (const grid of [1, 2, 4] as const) {
    const layout = layoutForGrid(grid, 480, 480, 800, 600);
    const guard = densityGuardrailValid(layout, 480, 1, qrModuleCount(VERSION), QUIET);
    // Synthetic goodput: payload * perCodeFps * gridCount (ideal), vs overhead
    const idealGoodput = PAYLOAD * PER_CODE_FPS * grid;
    // Account for decode success: assume 95% for 1-code, 90% for 2-code, 85% for 4-code (synthetic)
    const decodeRate = grid === 1 ? 0.95 : grid === 2 ? 0.90 : 0.85;
    const goodput = Math.round(idealGoodput * decodeRate);
    const uniquePerSec = Math.round(PER_CODE_FPS * grid * decodeRate);
    results.push({
      grid,
      layout: `${layout.rows}×${layout.cols}`,
      phases: layout.cellPhases,
      moduleScale: guard.moduleScale,
      valid: guard.valid,
      reason: guard.reason ?? null,
      perCodeFps: PER_CODE_FPS,
      idealGoodput,
      goodput,
      uniquePerSec,
      decodeRate,
    });
  }
  console.log(JSON.stringify(results, null, 2));
  const one = results[0] as { goodput: number };
  const two = results[1] as { goodput: number };
  const four = results[2] as { goodput: number };
  console.log(`HT09_GAIN 1->2 ${((two.goodput/one.goodput-1)*100).toFixed(0)}% (${one.goodput} -> ${two.goodput} B/s)`);
  console.log(`HT10_GAIN 2->4 ${((four.goodput/two.goodput-1)*100).toFixed(0)}% (${two.goodput} -> ${four.goodput} B/s)`);
  console.log(`HT10_GAIN 1->4 ${((four.goodput/one.goodput-1)*100).toFixed(0)}%`);
}

bench().catch(e => { console.error(e); process.exitCode = 1; });
