/**
 * HT-09 — Two-code sender stub (2×1 staggered 0/0.5).
 * Each lane: same sessionId/fileId, unique sequence, independent fountain symbol, identical version/ECC/scale/quietZone.
 * Staggered: per-code FPS F, lane A phase 0, lane B phase 0.5 — exposure crossing one update leaves other stable.
 * Lookahead 3 per lane, bounded, no duplicate symbols across lanes.
 */

import type { GridCount } from './multiplexer';
import { layoutForGrid } from './multiplexer';

export interface TwoCodeFrame {
  lane: 0 | 1;
  sequence: number;
  bytes: Uint8Array;
  phase: number; // 0 or 0.5
}

export class TwoCodeSender {
  private seq = 0;
  private readonly layout = layoutForGrid(2, 480, 480, 800, 600);

  constructor(private readonly source: { next(): Promise<Uint8Array | null> }) {}

  async nextPair(): Promise<[TwoCodeFrame, TwoCodeFrame] | null> {
    const a = await this.source.next();
    const b = await this.source.next();
    if (!a || !b) return null;
    const seqA = this.seq++;
    const seqB = this.seq++;
    return [
      { lane: 0, sequence: seqA, bytes: a, phase: 0 },
      { lane: 1, sequence: seqB, bytes: b, phase: 0.5 },
    ];
  }

  getLayout(): ReturnType<typeof layoutForGrid> { return this.layout; }
  getGridCount(): GridCount { return 2; }
}
