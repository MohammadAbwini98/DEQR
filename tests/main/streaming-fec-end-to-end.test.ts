import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PRNG } from '../../src/core/prng';
import { parseFrame } from '../../src/core/protocol-v2';
import { RECEIVE_ACCEPT, SegmentedReceiver } from '../../src/core/segmented-receiver';
import {
  DEFAULT_STREAMING_SENDER_CONFIG,
  SenderFileHandle,
  SenderFileOpener,
  SenderFileStat,
  StreamingSenderConfig,
  StreamingTransferSession,
} from '../../src/main/streaming-sender';

/**
 * Sender to receiver, over a channel that drops frames.
 *
 * Every other Phase 03 test drives one side. This drives both: the real
 * `StreamingTransferSession` produces frames, a seeded channel throws some of
 * them away, and the real `SegmentedReceiver` puts the file back together. What
 * it proves is the only thing that finally matters - the bytes that come out
 * are the bytes that went in, and SHA-256 says so.
 *
 * The manifest is subject to loss too. A receiver that cannot acquire a session
 * until a manifest survives is the receiver a phone actually is.
 */

const SEGMENT_BYTES = 64 * 1024;
const SYMBOL_BYTES = 512;

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A file that lives in an array, so the test knows exactly what should come back. */
function memoryOpener(content: Uint8Array): SenderFileOpener {
  return async (): Promise<SenderFileHandle> => ({
    async stat(): Promise<SenderFileStat> {
      return { size: BigInt(content.length), mtimeMs: 1_700_000_000_000n, isFile: true };
    },
    async read(buffer: Uint8Array, length: number, position: bigint): Promise<number> {
      const start = Number(position);
      const end = Math.min(start + length, content.length);
      if (start >= content.length) return 0;
      buffer.set(content.subarray(start, end));
      return end - start;
    },
    async close(): Promise<void> {},
  });
}

interface RunResult {
  file: Uint8Array;
  framesEmitted: number;
  framesDelivered: number;
  receiver: SegmentedReceiver;
  peakHeldBytes: number;
  manifestAcquiredAfter: number;
}

/**
 * Runs a whole transfer and returns what the receiver produced.
 *
 * `null` means the receiver never completed within the sender's single pass,
 * which is a real outcome and is asserted as one rather than hidden behind a
 * retry.
 */
async function transfer(
  content: Uint8Array,
  lossRate: number,
  seed: number,
  overrides: Partial<StreamingSenderConfig> = {},
): Promise<RunResult | null> {
  const session = await StreamingTransferSession.open(
    'payload.bin',
    {
      segmentSizeBytes: SEGMENT_BYTES,
      symbolSizeBytes: SYMBOL_BYTES,
      sessionId: 0x5eed_0003,
      fileId: 0x0f0e_0d0c,
      ...overrides,
    },
    memoryOpener(content),
  );

  const channel = new PRNG(seed);
  const delivers = (): boolean => (lossRate <= 0 ? true : channel.next() >= lossRate);

  const rebuilt = new Uint8Array(content.length);
  let receiver: SegmentedReceiver | null = null;
  let framesEmitted = 0;
  let framesDelivered = 0;
  let peakHeldBytes = 0;
  let manifestAcquiredAfter = -1;

  try {
    for (;;) {
      const frameBytes = await session.take();
      if (!frameBytes) break;
      framesEmitted += 1;
      if (!delivers()) continue;
      framesDelivered += 1;

      const parsed = parseFrame(frameBytes);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) break;

      if (!receiver) {
        // Nothing can be decoded before a manifest arrives; data frames seen
        // first are simply gone, exactly as they would be on a phone that
        // started scanning mid-stream.
        if (parsed.value.kind !== 'manifest') continue;
        manifestAcquiredAfter = framesEmitted;
        receiver = new SegmentedReceiver(parsed.value.manifest, {
          onSegmentComplete: (segment) => rebuilt.set(segment.bytes, Number(segment.byteOffset)),
        });
        continue;
      }

      const result = receiver.acceptFrameBytes(frameBytes);
      expect(result.status).not.toBe(RECEIVE_ACCEPT.REJECTED);
      peakHeldBytes = Math.max(peakHeldBytes, receiver.heldBytes());
      if (result.sessionComplete) break;
    }
  } finally {
    await session.dispose();
  }

  if (!receiver || !receiver.isComplete) return null;
  return { file: rebuilt, framesEmitted, framesDelivered, receiver, peakHeldBytes, manifestAcquiredAfter };
}

describe('a v2 transfer survives a lossy channel end to end', () => {
  // 200,000 bytes is four segments at 64 KiB, the last of them short. Repair
  // budgets come from `scripts/bench/phase03-fec.ts`; 128 symbols per segment is
  // the least efficient end of the measured range, so these are generous.
  const content = bytes(200_000, 0x51ce);
  const expected = sha256(content);

  it.each([
    [0, 0.05],
    [0.01, 1.0],
    [0.05, 1.5],
    [0.1, 2.0],
    [0.2, 3.0],
    [0.3, 4.0],
  ])('reconstructs at %s loss with a %s repair ratio', async (lossRate, repairOverheadRatio) => {
    const result = await transfer(content, lossRate, 0x1234 + lossRate * 1000, { repairOverheadRatio });

    expect(result, `loss ${lossRate} did not complete in one pass`).not.toBeNull();
    if (!result) return;

    expect(sha256(result.file)).toBe(expected);
    expect(result.receiver.segmentsCommitted).toBe(4);

    const stats = result.receiver.stats();
    if (lossRate === 0) {
      // The whole point of systematic-first: a clean channel does no algebra.
      expect(stats.xorBytes).toBe(0);
      expect(stats.symbolsRepaired).toBe(0);
    } else {
      expect(stats.symbolsRepaired).toBeGreaterThan(0);
    }
  });

  it('computes the same SHA-256 the sender promised before the first frame', async () => {
    const result = await transfer(content, 0.1, 0x99, { repairOverheadRatio: 2.0 });
    expect(result).not.toBeNull();
    if (!result) return;

    const manifestDigest = Buffer.from(result.receiver.manifest.sha256).toString('hex');
    expect(manifestDigest).toBe(expected);
    expect(sha256(result.file)).toBe(manifestDigest);
  });

  it('keeps receiver memory inside a segment-shaped bound for the whole transfer', async () => {
    const result = await transfer(content, 0.1, 0xabc, { repairOverheadRatio: 2.0 });
    expect(result).not.toBeNull();
    if (!result) return;

    // Two decoders at their worst case. The file is four segments; the bound
    // does not mention the file.
    const symbolsPerSegment = SEGMENT_BYTES / SYMBOL_BYTES;
    const perDecoder = SEGMENT_BYTES + Math.ceil(symbolsPerSegment / 8) + symbolsPerSegment * SYMBOL_BYTES;
    expect(result.peakHeldBytes).toBeLessThanOrEqual(2 * perDecoder + 8);
    expect(result.receiver.stats().activeSegments).toBe(0);
  });

  it('acquires the session from a repeated manifest after starting mid-stream', async () => {
    // 30% loss on a manifest that repeats every 8 frames: the first one is
    // usually lost, so acquisition has to come from a later repeat.
    const result = await transfer(content, 0.3, 0x777, {
      repairOverheadRatio: 4.0,
      manifestIntervalFrames: 8,
    });

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.manifestAcquiredAfter).toBeGreaterThan(0);
    expect(sha256(result.file)).toBe(expected);
    expect(result.receiver.stats().manifestFrames).toBeGreaterThan(1);
  });

  it('refuses a foreign transfer visible to the same camera', async () => {
    const foreign = await StreamingTransferSession.open(
      'other.bin',
      {
        segmentSizeBytes: SEGMENT_BYTES,
        symbolSizeBytes: SYMBOL_BYTES,
        sessionId: 0xdead_0001,
        fileId: 0xbeef_0001,
        repairOverheadRatio: 0,
      },
      memoryOpener(bytes(100_000, 0x2222)),
    );

    try {
      const own = await StreamingTransferSession.open(
        'payload.bin',
        {
          segmentSizeBytes: SEGMENT_BYTES,
          symbolSizeBytes: SYMBOL_BYTES,
          sessionId: 0x5eed_0003,
          fileId: 0x0f0e_0d0c,
          repairOverheadRatio: 0,
        },
        memoryOpener(content),
      );

      try {
        const manifestBytes = (await own.take())!;
        const parsed = parseFrame(manifestBytes);
        expect(parsed.ok && parsed.value.kind === 'manifest').toBe(true);
        if (!parsed.ok || parsed.value.kind !== 'manifest') return;

        const receiver = new SegmentedReceiver(parsed.value.manifest);
        let rejected = 0;
        for (let index = 0; index < 40; index += 1) {
          const frame = await foreign.take();
          if (!frame) break;
          const result = receiver.acceptFrameBytes(frame);
          expect(result.status).toBe(RECEIVE_ACCEPT.REJECTED);
          expect(result.reason).toBe('SESSION_MISMATCH');
          rejected += 1;
        }

        expect(rejected).toBe(40);
        expect(receiver.stats().activeSegments).toBe(0);
        expect(receiver.segmentsCommitted).toBe(0);
      } finally {
        await own.dispose();
      }
    } finally {
      await foreign.dispose();
    }
  });

  it('spends the shipping repair budget on a clean channel, at a cost this test states', async () => {
    const result = await transfer(content, 0, 0x1);
    expect(result).not.toBeNull();
    if (!result) return;

    // What the default costs when nothing is lost, written out rather than
    // waved at. 391 source symbols across four segments - three full, one short
    // - and a repair budget on each. Every repair frame here was insurance that
    // turned out not to be needed, which is exactly the trade the default makes
    // and the number Phase 04 has to justify against a measured link.
    const ratio = DEFAULT_STREAMING_SENDER_CONFIG.repairOverheadRatio;
    const fullSegmentSymbols = SEGMENT_BYTES / SYMBOL_BYTES;
    const lastSegmentSymbols = Math.ceil((200_000 - 3 * SEGMENT_BYTES) / SYMBOL_BYTES);
    const sourceSymbols = 3 * fullSegmentSymbols + lastSegmentSymbols;
    const repairSymbols = 3 * Math.ceil(fullSegmentSymbols * ratio) + Math.ceil(lastSegmentSymbols * ratio);

    expect(sourceSymbols).toBe(391);
    expect(repairSymbols / sourceSymbols).toBeCloseTo(ratio, 2);

    // Everything above the data frames is the manifest repeating, which is the
    // only other thing on the wire.
    const manifestFrames = result.framesEmitted - (sourceSymbols + repairSymbols);
    expect(manifestFrames).toBeGreaterThan(0);
    expect(manifestFrames).toBeLessThanOrEqual(Math.ceil(result.framesEmitted / 64) + 1);

    expect(result.receiver.stats().xorBytes).toBe(0);
    expect(sha256(result.file)).toBe(expected);
  });
});
