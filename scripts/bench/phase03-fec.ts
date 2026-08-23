/**
 * Phase 03 - systematic-first FEC: recovery cost, work, and throughput.
 *
 * Two questions, two modes.
 *
 * `--mode sweep` answers the one Phase 02 left open: **how much repair overhead
 * does a segment actually need?** For each loss rate it emits a full systematic
 * pass followed by repair symbols, records the frame at which the segment
 * completed, and reports the repair-to-source ratio that implies. Running many
 * trials gives a distribution rather than an anecdote, and the p99 is the number
 * a profile should be set from - a mean that decodes half the time is not a
 * transport setting.
 *
 * `--mode compare` puts the shipping v1 fountain path and the v2 systematic-first
 * path over identical bytes and reports decode time, symbols processed, and
 * decoded original bytes per second.
 *
 *   node node_modules/vite-node/vite-node.mjs scripts/bench/phase03-fec.ts -- \
 *     --mode sweep --segment-kib 1024 --symbol 512 --trials 200
 *
 *   node node_modules/vite-node/vite-node.mjs scripts/bench/phase03-fec.ts -- \
 *     --mode compare --segment-kib 1024 --symbol 512 --loss 0,0.05,0.20
 *
 * Payload safety: deterministic synthetic bytes generated in memory. Nothing is
 * read from disk, nothing is written, and no payload byte is printed.
 */

import { performance } from 'node:perf_hooks';

import { FountainDecoder } from '../../src/core/fountain-decoder';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { PRNG } from '../../src/core/prng';
import { SegmentDecoder } from '../../src/core/segment-decoder';
import { RepairNeighborFn, SegmentEncoder } from '../../src/core/segment-encoder';

const KIB = 1024;

/* --------------------------------------------------------- candidate rules */

/**
 * Alternative degree rules, for the comparison the plan asks for.
 *
 * These live in the benchmark rather than in `src/core/` on purpose: a
 * candidate has to earn its way into the shipping profile by measurement, and
 * putting it behind the same `RepairNeighborFn` seam the encoder and decoder
 * already accept means it is measured through the real code path.
 *
 * - `soliton` is what DEQR ships: robust soliton, the v1 mathematics.
 * - `ramp` cycles a geometric degree ladder over 1, 2, 4 ... K. The theory it
 *   tests is scale diversity: a repair symbol resolves a single unknown most
 *   often when its degree is near 1/q for the current unknown fraction q, and a
 *   sender with no feedback does not know q. A ladder covers every q at the
 *   cost of spending most symbols at the wrong scale.
 * - `low3` fixes degree at 3, the setting theory favours when a third of the
 *   segment is missing, and the worst possible setting when almost none is.
 */
function selectDistinct(prng: PRNG, degree: number, population: number): number[] {
  const selected = new Set<number>();
  while (selected.size < degree) selected.add(prng.nextInt(0, population));
  return [...selected];
}

function rampNeighbors(symbolId: number, sourceSymbolCount: number): number[] {
  const levels = Math.ceil(Math.log2(Math.max(2, sourceSymbolCount))) + 1;
  const ordinal = symbolId - sourceSymbolCount;
  const degree = Math.min(sourceSymbolCount, 1 << (((ordinal % levels) + levels) % levels));
  return selectDistinct(new PRNG(symbolId), degree, sourceSymbolCount);
}

function lowDegreeNeighbors(symbolId: number, sourceSymbolCount: number): number[] {
  const degree = Math.min(3, sourceSymbolCount);
  return selectDistinct(new PRNG(symbolId), degree, sourceSymbolCount);
}

function degreeRule(name: string): RepairNeighborFn | undefined {
  if (name === 'soliton') return undefined;
  if (name === 'ramp') return rampNeighbors;
  if (name === 'low3') return lowDegreeNeighbors;
  throw new Error('--degree must be soliton, ramp, or low3');
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** Deterministic synthetic segment. Same generator the other phases use. */
function syntheticSegment(byteLength: number, seed: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < byteLength; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

/**
 * Whether frame `ordinal` survives the channel.
 *
 * `iid` is independent per-frame loss, the model for a camera that
 * occasionally misses a refresh. `burst` loses runs of eight consecutive
 * frames at the same average rate, the model for a hand that moves. Both are
 * driven by a seeded PRNG so a failing trial can be replayed exactly.
 */
type LossPattern = 'iid' | 'burst';

class Channel {
  private readonly prng: PRNG;
  private burstRemaining = 0;

  constructor(private readonly lossRate: number, private readonly pattern: LossPattern, seed: number) {
    this.prng = new PRNG(seed === 0 ? 1 : seed);
  }

  delivers(): boolean {
    if (this.lossRate <= 0) return true;
    if (this.pattern === 'iid') return this.prng.next() >= this.lossRate;

    if (this.burstRemaining > 0) {
      this.burstRemaining -= 1;
      return false;
    }
    // A burst of 8 at probability lossRate/8 keeps the mean loss identical.
    if (this.prng.next() < this.lossRate / 8) {
      this.burstRemaining = 7;
      return false;
    }
    return true;
  }
}

interface TrialResult {
  completed: boolean;
  /** Repair symbols emitted before the segment closed, over the source count. */
  requiredRepairRatio: number;
  repairEmitted: number;
  repairAccepted: number;
  symbolsRepaired: number;
  xorBytes: number;
  decodeMs: number;
}

/**
 * One systematic pass, then repair until the segment closes or the budget ends.
 *
 * The frame at which it closes *is* the answer: no binary search over ratios is
 * needed, because a run that completes after r repair symbols would also have
 * completed at any larger budget.
 */
function runTrial(
  segment: Uint8Array,
  symbolSizeBytes: number,
  lossRate: number,
  pattern: LossPattern,
  seed: number,
  repairBudgetRatio: number,
  neighborsFor?: RepairNeighborFn,
  relaxCaps = false,
): TrialResult {
  const encoder = new SegmentEncoder(symbolSizeBytes, neighborsFor);
  encoder.loadSegment(segment);
  const sourceCount = encoder.sourceSymbolCount;

  const decoder = new SegmentDecoder({
    sourceSymbolCount: sourceCount,
    symbolSizeBytes,
    segmentBytes: segment.length,
    neighborsFor,
    // Used only to separate "this rule cannot recover the segment" from "this
    // rule filled the decoder's pending budget with equations it could not
    // use". They are different findings and the report needs to tell them apart.
    limits: relaxCaps
      ? { maxPendingNeighborRefs: Number.MAX_SAFE_INTEGER, maxTrackedRepairIds: Number.MAX_SAFE_INTEGER }
      : undefined,
  });
  const channel = new Channel(lossRate, pattern, seed);
  const scratch = new Uint8Array(symbolSizeBytes);
  const repairBudget = Math.ceil(sourceCount * repairBudgetRatio);

  let repairEmitted = 0;
  let completed = false;
  const start = performance.now();

  for (let symbolId = 0; symbolId < sourceCount + repairBudget; symbolId += 1) {
    if (symbolId >= sourceCount) repairEmitted += 1;
    const delivered = channel.delivers();
    // The encoder still does its work for a lost frame: the sender has no idea
    // the camera missed it, and charging the trial for it keeps the sender-side
    // cost honest.
    encoder.symbolInto(symbolId, scratch);
    if (!delivered) continue;

    if (decoder.accept(symbolId, scratch).complete) {
      completed = true;
      break;
    }
  }

  const decodeMs = performance.now() - start;
  const stats = decoder.stats();

  if (completed) {
    const recovered = decoder.segment();
    for (let index = 0; index < segment.length; index += 1) {
      if (recovered[index] !== segment[index]) {
        throw new Error(`PHASE03 trial reconstructed a different byte at ${index}`);
      }
    }
  }
  decoder.release();
  encoder.release();

  return {
    completed,
    requiredRepairRatio: repairEmitted / sourceCount,
    repairEmitted,
    repairAccepted: stats.repairAccepted,
    symbolsRepaired: stats.repairSolvedSymbols,
    xorBytes: stats.xorBytes,
    decodeMs,
  };
}

function quantile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, position)];
}

function sweep(segmentBytes: number, symbolSizeBytes: number, trials: number, pattern: LossPattern): void {
  const lossRates = argument('loss', '0,0.01,0.05,0.10,0.20,0.30')
    .split(',')
    .map((value) => Number(value));
  // Generous enough that a failure means the code could not do it, not that the
  // harness ran out of frames.
  const budgetRatio = Number(argument('budget', '2.0'));
  const ruleName = argument('degree', 'soliton');
  const rule = degreeRule(ruleName);
  const relaxCaps = process.argv.includes('--relax-caps');

  for (const lossRate of lossRates) {
    const required: number[] = [];
    let failures = 0;
    let xorBytes = 0;
    let symbolsRepaired = 0;
    let decodeMs = 0;

    for (let trial = 0; trial < trials; trial += 1) {
      const segment = syntheticSegment(segmentBytes, 0x51ce_0000 + trial);
      const result = runTrial(segment, symbolSizeBytes, lossRate, pattern, 0x10c5_0000 + trial, budgetRatio, rule, relaxCaps);
      if (!result.completed) {
        failures += 1;
        continue;
      }
      required.push(result.requiredRepairRatio);
      xorBytes += result.xorBytes;
      symbolsRepaired += result.symbolsRepaired;
      decodeMs += result.decodeMs;
    }

    required.sort((left, right) => left - right);
    const sourceCount = Math.ceil(segmentBytes / symbolSizeBytes);
    const mean = required.reduce((sum, value) => sum + value, 0) / Math.max(1, required.length);
    console.log([
      'PHASE03_FEC_SWEEP',
      `degree=${ruleName}`,
      `caps=${relaxCaps ? 'relaxed' : 'default'}`,
      `pattern=${pattern}`,
      `segmentBytes=${segmentBytes}`,
      `symbolBytes=${symbolSizeBytes}`,
      `sourceSymbols=${sourceCount}`,
      `lossRate=${lossRate.toFixed(3)}`,
      `trials=${trials}`,
      `failures=${failures}`,
      `repairRatioMean=${mean.toFixed(4)}`,
      `repairRatioP50=${quantile(required, 0.5).toFixed(4)}`,
      `repairRatioP99=${quantile(required, 0.99).toFixed(4)}`,
      `repairRatioMax=${quantile(required, 1).toFixed(4)}`,
      `xorBytesPerTrial=${Math.round(xorBytes / Math.max(1, required.length))}`,
      `symbolsRepairedPerTrial=${(symbolsRepaired / Math.max(1, required.length)).toFixed(1)}`,
      `decodeMsPerTrial=${(decodeMs / Math.max(1, required.length)).toFixed(3)}`,
    ].join(' '));
  }
}

/* ------------------------------------------------------- v1 vs v2 compare */

interface CompareResult {
  path: 'v1' | 'v2';
  completed: boolean;
  symbolsProcessed: number;
  /** Time inside the decoder alone. Symbol production is timed separately. */
  decodeMs: number;
  /** Time inside the encoder alone, for every symbol the sender had to produce. */
  encodeMs: number;
  decodedBytesPerSecond: number;
}

/**
 * v1 over the same bytes.
 *
 * v1 has no notion of a segment, so a "segment" is simply the whole payload it
 * is given. That is the comparison: v1's cost at this size against v2's cost at
 * the same size, with the difference being that v2's cost stays there as the
 * file grows and v1's does not.
 */
function compareV1(
  payload: Uint8Array,
  blockSize: number,
  lossRate: number,
  pattern: LossPattern,
  seed: number,
  repairBudgetRatio: number,
): CompareResult {
  const buffer = Buffer.from(payload);
  const encoder = new FountainEncoder(buffer, blockSize, 0x5eed_1234);
  const decoder = new FountainDecoder();
  const channel = new Channel(lossRate, pattern, seed);
  const blockCount = encoder.getBlockCount();
  const budget = blockCount + Math.ceil(blockCount * repairBudgetRatio);

  let processed = 0;
  let completed = false;
  let encodeMs = 0;
  let decodeMs = 0;
  for (let index = 0; index < budget; index += 1) {
    const encodeStart = performance.now();
    const frame = encoder.nextFrame();
    encodeMs += performance.now() - encodeStart;
    if (!channel.delivers()) continue;
    processed += 1;

    const decodeStart = performance.now();
    const done = decoder.receiveFrame(frame);
    if (done) decoder.reconstructPayload();
    decodeMs += performance.now() - decodeStart;
    if (done) {
      completed = true;
      break;
    }
  }

  return {
    path: 'v1',
    completed,
    symbolsProcessed: processed,
    decodeMs,
    encodeMs,
    decodedBytesPerSecond: completed ? payload.length / (decodeMs / 1_000) : 0,
  };
}

function compareV2(
  payload: Uint8Array,
  symbolSizeBytes: number,
  lossRate: number,
  pattern: LossPattern,
  seed: number,
  repairBudgetRatio: number,
): CompareResult {
  const encoder = new SegmentEncoder(symbolSizeBytes);
  encoder.loadSegment(payload);
  const sourceCount = encoder.sourceSymbolCount;
  const decoder = new SegmentDecoder({
    sourceSymbolCount: sourceCount,
    symbolSizeBytes,
    segmentBytes: payload.length,
  });
  const channel = new Channel(lossRate, pattern, seed);
  const scratch = new Uint8Array(symbolSizeBytes);
  const budget = sourceCount + Math.ceil(sourceCount * repairBudgetRatio);

  let processed = 0;
  let completed = false;
  let encodeMs = 0;
  let decodeMs = 0;
  for (let symbolId = 0; symbolId < budget; symbolId += 1) {
    const encodeStart = performance.now();
    encoder.symbolInto(symbolId, scratch);
    encodeMs += performance.now() - encodeStart;
    if (!channel.delivers()) continue;
    processed += 1;

    const decodeStart = performance.now();
    const done = decoder.accept(symbolId, scratch).complete;
    if (done) decoder.segment();
    decodeMs += performance.now() - decodeStart;
    if (done) {
      completed = true;
      break;
    }
  }
  decoder.release();
  encoder.release();

  return {
    path: 'v2',
    completed,
    symbolsProcessed: processed,
    decodeMs,
    encodeMs,
    decodedBytesPerSecond: completed ? payload.length / (decodeMs / 1_000) : 0,
  };
}

function compare(segmentBytes: number, symbolSizeBytes: number, trials: number, pattern: LossPattern): void {
  const lossRates = argument('loss', '0,0.05,0.20,0.30')
    .split(',')
    .map((value) => Number(value));
  const budgetRatio = Number(argument('budget', '2.0'));

  for (const lossRate of lossRates) {
    const totals = {
      v1: { ms: 0, encodeMs: 0, symbols: 0, ok: 0, bytesPerSecond: 0 },
      v2: { ms: 0, encodeMs: 0, symbols: 0, ok: 0, bytesPerSecond: 0 },
    };

    for (let trial = 0; trial < trials; trial += 1) {
      const payload = syntheticSegment(segmentBytes, 0x51ce_0000 + trial);
      const seed = 0x10c5_0000 + trial;
      // Identical bytes, identical channel seed, so the two paths see the same
      // losses in the same places. Running order is alternated to keep one path
      // from paying for the other's warm-up.
      const first = trial % 2 === 0;
      const v1 = () => compareV1(payload, symbolSizeBytes, lossRate, pattern, seed, budgetRatio);
      const v2 = () => compareV2(payload, symbolSizeBytes, lossRate, pattern, seed, budgetRatio);
      const [a, b] = first ? [v1(), v2()] : [v2(), v1()];
      for (const result of [a, b]) {
        const bucket = totals[result.path];
        bucket.ms += result.decodeMs;
        bucket.encodeMs += result.encodeMs;
        bucket.symbols += result.symbolsProcessed;
        bucket.bytesPerSecond += result.decodedBytesPerSecond;
        if (result.completed) bucket.ok += 1;
      }
    }

    for (const path of ['v1', 'v2'] as const) {
      const bucket = totals[path];
      console.log([
        'PHASE03_FEC_COMPARE',
        `path=${path}`,
        `pattern=${pattern}`,
        `segmentBytes=${segmentBytes}`,
        `symbolBytes=${symbolSizeBytes}`,
        `lossRate=${lossRate.toFixed(3)}`,
        `trials=${trials}`,
        `completed=${bucket.ok}`,
        `symbolsProcessedPerTrial=${(bucket.symbols / trials).toFixed(1)}`,
        `decodeMsPerTrial=${(bucket.ms / trials).toFixed(3)}`,
        `encodeMsPerTrial=${(bucket.encodeMs / trials).toFixed(3)}`,
        `decodedMiBPerSecond=${(bucket.bytesPerSecond / trials / (1024 * 1024)).toFixed(1)}`,
      ].join(' '));
    }
  }
}

function main(): void {
  const mode = argument('mode', 'sweep');
  const segmentBytes = Number(argument('segment-kib', '1024')) * KIB;
  const symbolSizeBytes = Number(argument('symbol', '512'));
  const trials = Number(argument('trials', '100'));
  const pattern = argument('pattern', 'iid') as LossPattern;

  if (!Number.isInteger(segmentBytes) || segmentBytes < symbolSizeBytes) {
    throw new Error('--segment-kib must produce at least one symbol');
  }
  if (pattern !== 'iid' && pattern !== 'burst') {
    throw new Error('--pattern must be iid or burst');
  }

  if (mode === 'sweep') sweep(segmentBytes, symbolSizeBytes, trials, pattern);
  else if (mode === 'compare') compare(segmentBytes, symbolSizeBytes, trials, pattern);
  else throw new Error('--mode must be sweep or compare');
}

try {
  main();
} catch (error: unknown) {
  console.error(`PHASE03_FEC_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
