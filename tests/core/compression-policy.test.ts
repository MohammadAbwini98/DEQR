import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  COMPRESSION_REASON,
  DEFAULT_COMPRESSION_THRESHOLD,
  MIN_COMPRESSIBLE_BYTES,
  WINDOW_FRAMING_BYTES,
  confirmCompression,
  decideCompression,
  framingOverheadBytes,
  maxCompressedWindowBytes,
  predictedTransportSize,
  windowCountFor,
} from '../../src/core/compression-policy';
import { V2_COMPRESSION_WINDOW, compressionWindowBytes } from '../../src/core/protocol-v2';

const WINDOW = compressionWindowBytes(V2_COMPRESSION_WINDOW.defaultLog2);
const TEN_MIB = 10 * 1024 * 1024;

function sample(ratio: number, inputBytes = 768 * 1024) {
  return { inputBytes, outputBytes: Math.round(inputBytes * ratio), elapsedMs: 4 };
}

describe('the compression decision cannot see a filename', () => {
  /**
   * The phase's central rule, asserted where it is cheapest to assert: the
   * function that makes the decision has three parameters and none of them is
   * a name, an extension, a MIME type or a path. A future change that added one
   * would fail here before it could reach a transfer.
   */
  it('takes a size, a sample and a policy - and nothing else', () => {
    expect(decideCompression.length).toBe(3);
    expect(String(decideCompression).slice(0, 200)).not.toMatch(/filename|extension|mimeType|path/i);
  });

  it('gives one answer for one set of bytes, however they are labelled', () => {
    // The same measurement, decided five times. There is no input that could
    // carry '.txt' or '.zip' into this, which is the point.
    const answers = new Set(
      [0, 1, 2, 3, 4].map(() => JSON.stringify(decideCompression(TEN_MIB, sample(0.3), { windowBytes: WINDOW }))),
    );
    expect(answers.size).toBe(1);
  });
});

describe('the threshold decides, and it is a real threshold', () => {
  it('compresses bytes that clear it', () => {
    const decision = decideCompression(TEN_MIB, sample(0.3), { windowBytes: WINDOW });
    expect(decision.compress).toBe(true);
    expect(decision.reason).toBe(COMPRESSION_REASON.ABOVE_THRESHOLD);
    expect(decision.predictedGain).toBeGreaterThan(DEFAULT_COMPRESSION_THRESHOLD);
  });

  it('refuses bytes that do not, including incompressible ones', () => {
    // 0.95 is a real gain and still not worth a second pass over the file on
    // the sender and a second file on the receiver.
    const marginal = decideCompression(TEN_MIB, sample(0.95), { windowBytes: WINDOW });
    expect(marginal.compress).toBe(false);
    expect(marginal.reason).toBe(COMPRESSION_REASON.BELOW_THRESHOLD);

    // What random bytes actually measure: gzip expands them slightly.
    const random = decideCompression(TEN_MIB, sample(1.0004), { windowBytes: WINDOW });
    expect(random.compress).toBe(false);
    expect(random.predictedGain).toBeLessThan(0);
  });

  it('accepts a gain sitting exactly on the threshold', () => {
    // Framing is charged before the comparison, so the ratio that lands exactly
    // on 0.10 is slightly below 0.90 rather than at it.
    const exact = 0.9 - framingOverheadBytes(TEN_MIB, WINDOW) / TEN_MIB;
    expect(decideCompression(TEN_MIB, sample(exact), { windowBytes: WINDOW }).compress).toBe(true);
  });

  it('is configurable, and a threshold of zero still refuses expansion', () => {
    expect(decideCompression(TEN_MIB, sample(0.95), { windowBytes: WINDOW, threshold: 0.02 }).compress).toBe(true);
    expect(decideCompression(TEN_MIB, sample(1.01), { windowBytes: WINDOW, threshold: 0 }).compress).toBe(false);
  });

  it('refuses when told to, when nothing was sampled, and when the file is tiny', () => {
    expect(decideCompression(TEN_MIB, sample(0.1), { windowBytes: WINDOW, enabled: false }).reason)
      .toBe(COMPRESSION_REASON.DISABLED);
    expect(decideCompression(TEN_MIB, { inputBytes: 0, outputBytes: 0, elapsedMs: 0 }, { windowBytes: WINDOW }).reason)
      .toBe(COMPRESSION_REASON.NO_SAMPLE);
    expect(decideCompression(MIN_COMPRESSIBLE_BYTES - 1, sample(0.05), { windowBytes: WINDOW }).reason)
      .toBe(COMPRESSION_REASON.TOO_SMALL);
  });
});

describe('framing is charged against the gain, not ignored', () => {
  it('counts one record per window', () => {
    expect(windowCountFor(TEN_MIB, WINDOW)).toBe(10);
    expect(framingOverheadBytes(TEN_MIB, WINDOW)).toBe(10 * WINDOW_FRAMING_BYTES);
    // A partial last window still costs a whole record.
    expect(windowCountFor(TEN_MIB + 1, WINDOW)).toBe(11);
  });

  it('makes a small window a worse deal than a large one for the same bytes', () => {
    const tiny = compressionWindowBytes(V2_COMPRESSION_WINDOW.minLog2);
    const atTiny = decideCompression(TEN_MIB, sample(0.9), { windowBytes: tiny });
    const atDefault = decideCompression(TEN_MIB, sample(0.9), { windowBytes: WINDOW });
    expect(atTiny.predictedGain).toBeLessThan(atDefault.predictedGain);
  });

  it('predicts a transport size, framing included', () => {
    expect(predictedTransportSize(TEN_MIB, 0.5, WINDOW)).toBe(TEN_MIB / 2 + 10 * WINDOW_FRAMING_BYTES);
  });
});

describe('the measured pass can overrule the sample', () => {
  it('confirms a real gain and refuses one the sample overstated', () => {
    expect(confirmCompression(TEN_MIB, TEN_MIB * 0.4).compress).toBe(true);
    expect(confirmCompression(TEN_MIB, TEN_MIB * 0.4).reason).toBe(COMPRESSION_REASON.MEASURED_ABOVE_THRESHOLD);

    const overstated = confirmCompression(TEN_MIB, TEN_MIB * 0.97);
    expect(overstated.compress).toBe(false);
    expect(overstated.reason).toBe(COMPRESSION_REASON.MEASURED_BELOW_THRESHOLD);
  });
});

describe('the record ceiling is a real bound on real zlib output', () => {
  /**
   * The receiver refuses a declared record length above this *before* it
   * allocates for it, so if zlib could ever exceed it the guard would be
   * refusing legitimate transfers. Checked against the worst case there is:
   * incompressible bytes, which deflate expands.
   */
  it('is never exceeded by gzip of incompressible bytes', () => {
    for (const log2 of [16, 18, 20]) {
      const windowBytes = compressionWindowBytes(log2);
      const random = new Uint8Array(windowBytes);
      let state = 0x1234_5678;
      for (let index = 0; index < windowBytes; index += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        random[index] = state >>> 24;
      }
      const record = gzipSync(random, { level: 6 }).length + 4;
      expect(record).toBeLessThanOrEqual(maxCompressedWindowBytes(windowBytes));
      // And it is a *tight* bound, not a doubling that would let a hostile
      // length through: within a percent of what zlib actually produced.
      expect(maxCompressedWindowBytes(windowBytes)).toBeLessThan(record * 1.01);
    }
  });
});
