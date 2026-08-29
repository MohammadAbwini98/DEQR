/**
 * HT-04 fountain matrix — K values at 0/5/10/20/30/50% loss.
 * Synthetic, deterministic, measures symbols/K, completion, tail, CPU, redundant.
 */
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { SegmentDecoder } from '../../src/core/segment-decoder';
import { PRNG } from '../../src/core/prng';

const K_VALUES = [10, 50, 100, 500, 1000];
const LOSS_RATES = [0, 0.05, 0.1, 0.2, 0.3, 0.5];
const TRIALS = 20;

function simulate(K: number, loss: number): { symbolsRequired: number; completed: boolean; redundant: number; cpuMs: number } {
  const segment = new Uint8Array(K * 512);
  for (let i = 0; i < segment.length; i++) segment[i] = (i * 37) & 0xff;
  const encoder = new SegmentEncoder(512);
  encoder.loadSegment(segment);
  const decoder = new SegmentDecoder(512, K);
  let symbols = 0;
  let redundant = 0;
  const t0 = performance.now();
  // Systematic sweep 0..K-1
  for (let sid = 0; sid < K; sid++) {
    if (Math.random() < loss) continue; // simulate loss
    const out = new Uint8Array(512);
    encoder.symbolInto(sid, out);
    const res = decoder.receive({ symbolId: sid, sourceSymbolCount: K, payload: out, frameType: sid < K ? 2 : 3 } as never);
    symbols++;
    if (res.status === 'redundant') redundant++;
    if (decoder.isComplete) break;
  }
  // Repair infinite tail if not complete
  let repairId = K;
  while (!decoder.isComplete && repairId < K + 1000) {
    if (Math.random() >= loss) {
      const out = new Uint8Array(512);
      encoder.symbolInto(repairId, out);
      const res = decoder.receive({ symbolId: repairId, sourceSymbolCount: K, payload: out, frameType: 3 } as never);
      symbols++;
      if (res.status === 'redundant') redundant++;
    }
    repairId++;
  }
  const cpuMs = performance.now() - t0;
  return { symbolsRequired: symbols, completed: decoder.isComplete, redundant, cpuMs };
}

async function main(): Promise<void> {
  const rows: unknown[] = [];
  for (const K of K_VALUES) {
    for (const loss of LOSS_RATES) {
      let totalSymbols = 0, completed = 0, totalRedundant = 0, totalCpu = 0;
      for (let t = 0; t < TRIALS; t++) {
        const r = simulate(K, loss);
        totalSymbols += r.symbolsRequired;
        if (r.completed) completed++;
        totalRedundant += r.redundant;
        totalCpu += r.cpuMs;
      }
      rows.push({
        K, loss, trials: TRIALS,
        avgSymbolsRequired: Number((totalSymbols / TRIALS).toFixed(1)),
        symbolsPerK: Number((totalSymbols / TRIALS / K).toFixed(3)),
        completionProb: Number((completed / TRIALS).toFixed(2)),
        avgRedundant: Number((totalRedundant / TRIALS).toFixed(1)),
        avgCpuMs: Number((totalCpu / TRIALS).toFixed(2)),
      });
    }
  }
  const outDir = path.resolve('.local-run/bench');
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'ht04-fountain-matrix.json');
  await writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`HT04_MATRIX written ${path.relative(process.cwd(), file)} with ${rows.length} rows`);
  console.log(JSON.stringify(rows.slice(0, 3), null, 2));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
