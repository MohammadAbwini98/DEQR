import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PRNG } from '../../src/core/prng';
import { parseFrame } from '../../src/core/protocol-v2';
import { RECEIVE_ACCEPT, SegmentedReceiver } from '../../src/core/segmented-receiver';
import {
  encodeTargetedResumeToken,
  missingRangesFromBitmap,
} from '../../src/core/resume-token';
import {
  DEFAULT_STREAMING_SENDER_CONFIG,
  SenderFileHandle,
  SenderFileOpener,
  SenderFileStat,
  StreamingSenderConfig,
  StreamingTransferSession,
  senderResumeToken,
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

/**
 * The failure Phase 13 exists for, and its fix.
 *
 * A real iPhone showed the sender reaching its end-of-pass screen while the
 * receiver stayed in "Receiving transfer" and delivered nothing. The reason was
 * not the coding or the channel: `take()` returned `null` for good once the
 * budgeted repair was spent, so a receiver short by even one symbol had no
 * possible source for it. The transfer was unrecoverable by construction.
 */
describe('a receiver the pass left short can still finish', () => {
  const content = bytes(200_000, 0x13ec);
  const expected = sha256(content);

  /** Segment indices the receiver has not committed. What recovery targets. */
  function missingSegments(receiver: SegmentedReceiver, segmentCount: number): number[] {
    const bitmap = receiver.committedBitmap();
    const missing: number[] = [];
    for (let index = 0; index < segmentCount; index += 1) {
      if ((bitmap[index >> 3] & (1 << (index & 7))) === 0) missing.push(index);
    }
    return missing;
  }

  /**
   * Runs a pass at a loss rate chosen to leave the receiver incomplete, then a
   * recovery tail over a clean channel — which is what a person does: they see
   * it stall, steady the phone, and ask the desktop to send more.
   */
  async function passThenRecovery(lossRate: number, seed: number, repairOverheadRatio: number) {
    const session = await StreamingTransferSession.open(
      'payload.bin',
      {
        segmentSizeBytes: SEGMENT_BYTES,
        symbolSizeBytes: SYMBOL_BYTES,
        sessionId: 0x5eed_0013,
        fileId: 0x0f0e_0d0c,
        repairOverheadRatio,
      },
      memoryOpener(content),
    );

    const channel = new PRNG(seed);
    const rebuilt = new Uint8Array(content.length);
    let receiver: SegmentedReceiver | null = null;
    let passFrames = 0;
    let recoveryFrames = 0;
    const recoverySymbolIds = new Map<number, number[]>();

    try {
      for (;;) {
        const frameBytes = await session.take();
        if (!frameBytes) break;
        passFrames += 1;
        if (channel.next() < lossRate) continue;
        const parsed = parseFrame(frameBytes);
        if (!parsed.ok) continue;
        if (!receiver) {
          if (parsed.value.kind !== 'manifest') continue;
          receiver = new SegmentedReceiver(parsed.value.manifest, {
            onSegmentComplete: (segment) => rebuilt.set(segment.bytes, Number(segment.byteOffset)),
          });
          continue;
        }
        receiver.acceptFrameBytes(frameBytes);
        if (receiver.isComplete) break;
      }

      expect(receiver, 'the pass never delivered a manifest').not.toBeNull();
      if (!receiver) return null;
      const completedInPass = receiver.isComplete;
      const missingAfterPass = missingSegments(receiver, 4);

      // Everything above is the old behaviour. Everything below could not
      // happen before: `take()` was finished for good.
      const targeted = session.beginRecovery(missingAfterPass);
      while (!receiver.isComplete && recoveryFrames < 20_000) {
        const frameBytes = await session.take();
        if (!frameBytes) break;
        recoveryFrames += 1;
        const parsed = parseFrame(frameBytes);
        if (!parsed.ok || parsed.value.kind === 'manifest') continue;
        const data = parsed.value.frame;
        const seen = recoverySymbolIds.get(data.segmentIndex) ?? [];
        seen.push(data.symbolId);
        recoverySymbolIds.set(data.segmentIndex, seen);
        receiver.acceptFrameBytes(frameBytes);
      }

      return {
        receiver, rebuilt, completedInPass, missingAfterPass,
        targeted, passFrames, recoveryFrames, recoverySymbolIds,
      };
    } finally {
      await session.dispose();
    }
  }

  it('completes a transfer the initial pass could not, and the bytes match', async () => {
    // 35% loss against a 0.5 repair ratio: comfortably past what one pass can
    // carry, which is the condition the physical failure happened under.
    const run = await passThenRecovery(0.35, 0x9a1e, 0.5);
    expect(run).not.toBeNull();
    if (!run) return;

    expect(run.completedInPass, 'the pass was meant to fall short').toBe(false);
    expect(run.missingAfterPass.length).toBeGreaterThan(0);
    expect(run.targeted).toBe(run.missingAfterPass.length);

    expect(run.receiver.isComplete, 'recovery did not finish the transfer').toBe(true);
    expect(sha256(run.rebuilt)).toBe(expected);
  });

  it('never repeats a repair symbol it has already sent', async () => {
    // "Do not endlessly repeat identical repair frames." A tail that resent the
    // pass's symbols would be perfectly busy and completely useless, because
    // the receiver discards them as duplicates.
    const run = await passThenRecovery(0.35, 0x77c2, 0.5);
    expect(run).not.toBeNull();
    if (!run) return;

    for (const [segment, ids] of run.recoverySymbolIds) {
      expect(new Set(ids).size, `segment ${segment} repeated a symbol id`).toBe(ids.length);
    }
  });

  it('generates only for the segments it was told are missing', async () => {
    const run = await passThenRecovery(0.35, 0x4d31, 0.5);
    expect(run).not.toBeNull();
    if (!run) return;

    for (const segment of run.recoverySymbolIds.keys()) {
      expect(run.missingAfterPass, `recovered a segment nobody asked for`).toContain(segment);
    }
  });

  it('refuses to recover when nothing is missing', async () => {
    // An empty target list means the caller believes the receiver has
    // everything. Recovering the whole file on that basis is the opposite of
    // targeted, so the tail stays shut.
    const session = await StreamingTransferSession.open(
      'payload.bin',
      { segmentSizeBytes: SEGMENT_BYTES, symbolSizeBytes: SYMBOL_BYTES, sessionId: 1, fileId: 2 },
      memoryOpener(content),
    );
    try {
      expect(session.beginRecovery([])).toBe(0);
      expect(session.isRecovering).toBe(false);
      // Out-of-range indices are not a licence to send everything either.
      expect(session.beginRecovery([99, -1])).toBe(0);
      expect(session.isRecovering).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  it('counts recovery apart from the pass, so a stuck link is visible', async () => {
    const run = await passThenRecovery(0.35, 0x2b8f, 0.5);
    expect(run).not.toBeNull();
    if (!run) return;
    expect(run.recoveryFrames).toBeGreaterThan(0);
  });
});

/**
 * Targeted resume, end to end: the receiver's gaps drive what the sender resends.
 */
describe('a resume token aims the recovery tail', () => {
  const content = bytes(200_000, 0x7a2c);
  const expected = sha256(content);

  it('recovers only the segments the token named, and the bytes match', async () => {
    // Stand up a receiver, deliberately starve two segments, then hand the
    // sender a token minted from its real bitmap.
    const first = await StreamingTransferSession.open(
      'payload.bin',
      { segmentSizeBytes: SEGMENT_BYTES, symbolSizeBytes: SYMBOL_BYTES, sessionId: 0x5eed_0023, fileId: 0x0f0e_0d0c },
      memoryOpener(content),
    );

    const rebuilt = new Uint8Array(content.length);
    let receiver: SegmentedReceiver | null = null;
    const starved = new Set([1, 3]);
    let manifest: Parameters<typeof senderResumeToken>[0] | null = null;
    let plan: Parameters<typeof senderResumeToken>[1] | null = null;

    try {
      for (;;) {
        const frameBytes = await first.take();
        if (!frameBytes) break;
        const parsed = parseFrame(frameBytes);
        if (!parsed.ok) continue;
        if (!receiver) {
          if (parsed.value.kind !== 'manifest') continue;
          manifest = parsed.value.manifest;
          receiver = new SegmentedReceiver(parsed.value.manifest, {
            onSegmentComplete: (segment) => rebuilt.set(segment.bytes, Number(segment.byteOffset)),
          });
          continue;
        }
        // Drop everything for the starved segments, deliver the rest.
        if (parsed.value.kind === 'data' && starved.has(parsed.value.frame.segmentIndex)) continue;
        receiver.acceptFrameBytes(frameBytes);
      }
      plan = first.plan;
    } finally {
      await first.dispose();
    }

    expect(receiver).not.toBeNull();
    if (!receiver || !manifest || !plan) return;
    expect(receiver.isComplete).toBe(false);

    const missing = missingRangesFromBitmap(receiver.committedBitmap(), 4);
    expect(missing).toEqual([{ start: 1, length: 1 }, { start: 3, length: 1 }]);

    const token = encodeTargetedResumeToken({
      sessionId: manifest.sessionId,
      fileId: manifest.fileId,
      segmentCount: 4,
      resumeFromSegment: 1,
      sha256: manifest.sha256,
      missing,
    });

    // A second session opened with that token: identity is validated at open,
    // and the gaps become the recovery targets without the caller naming them.
    const second = await StreamingTransferSession.open(
      'payload.bin',
      {
        segmentSizeBytes: SEGMENT_BYTES,
        symbolSizeBytes: SYMBOL_BYTES,
        sessionId: manifest.sessionId,
        fileId: manifest.fileId,
        resumeToken: token,
      },
      memoryOpener(content),
    );

    const touched = new Set<number>();
    try {
      expect(second.beginRecovery()).toBe(2);
      let frames = 0;
      while (!receiver.isComplete && frames < 20_000) {
        const frameBytes = await second.take();
        if (!frameBytes) break;
        frames += 1;
        const parsed = parseFrame(frameBytes);
        if (!parsed.ok) continue;
        if (parsed.value.kind === 'data') touched.add(parsed.value.frame.segmentIndex);
        receiver.acceptFrameBytes(frameBytes);
      }
    } finally {
      await second.dispose();
    }

    expect(receiver.isComplete, 'targeted recovery did not finish the transfer').toBe(true);
    expect(sha256(rebuilt)).toBe(expected);
    // The whole point: segments 0 and 2 were never resent.
    expect([...touched].sort()).toEqual([1, 3]);
  });

  it('refuses a token for a different file before sending anything', async () => {
    const otherFile = bytes(200_000, 0xbeef);
    const token = encodeTargetedResumeToken({
      sessionId: 1, fileId: 2, segmentCount: 4, resumeFromSegment: 1,
      sha256: new Uint8Array(32).fill(0x5a),
      missing: [{ start: 1, length: 1 }],
    });

    await expect(StreamingTransferSession.open(
      'payload.bin',
      { segmentSizeBytes: SEGMENT_BYTES, symbolSizeBytes: SYMBOL_BYTES, resumeToken: token },
      memoryOpener(otherFile),
    )).rejects.toThrow(/different file/i);
  });

  it('refuses a token made under a different segmentation', async () => {
    const session = await StreamingTransferSession.open(
      'payload.bin',
      { segmentSizeBytes: SEGMENT_BYTES, symbolSizeBytes: SYMBOL_BYTES, sessionId: 9, fileId: 9 },
      memoryOpener(content),
    );
    const manifest = session.manifest;
    await session.dispose();

    const token = encodeTargetedResumeToken({
      sessionId: manifest.sessionId,
      fileId: manifest.fileId,
      // The receiver was on a profile that split this file differently.
      segmentCount: 99,
      resumeFromSegment: 1,
      sha256: manifest.sha256,
      missing: [{ start: 1, length: 1 }],
    });

    await expect(StreamingTransferSession.open(
      'payload.bin',
      { segmentSizeBytes: SEGMENT_BYTES, symbolSizeBytes: SYMBOL_BYTES, resumeToken: token },
      memoryOpener(content),
    )).rejects.toThrow(/transport profile/i);
  });

  it('refuses a malformed token', async () => {
    await expect(StreamingTransferSession.open(
      'payload.bin',
      { segmentSizeBytes: SEGMENT_BYTES, symbolSizeBytes: SYMBOL_BYTES, resumeToken: 'NOT-A-REAL-TOKEN' },
      memoryOpener(content),
    )).rejects.toThrow(/could not be read/i);
  });
});

/**
 * Fault injection with a *chosen* channel rather than a random one.
 *
 * The lossy rows above sample independent per-frame loss, which is the average
 * case and not the interesting one. A camera does not lose frames
 * independently: a hand moves, a screen dims, a notification slides down, and
 * several hundred consecutive frames vanish together. And the failures that
 * matter most are the structured ones — every source symbol for one segment, or
 * the very last frame of a pass — because those are the ones a design either
 * survives by construction or not at all.
 */
describe('the transfer survives structured faults, not just average loss', () => {
  const content = bytes(200_000, 0x5f1a);
  const expected = sha256(content);

  /** Runs a transfer through a filter that decides, per frame, what arrives. */
  async function through(
    keep: (frame: { index: number; kind: 'manifest' | 'data'; segmentIndex: number; isSource: boolean }) => boolean,
    overrides: Partial<StreamingSenderConfig> = {},
  ) {
    const session = await StreamingTransferSession.open(
      'payload.bin',
      { segmentSizeBytes: SEGMENT_BYTES, symbolSizeBytes: SYMBOL_BYTES, sessionId: 0x5eed_0033, fileId: 0x0f0e_0d0c, ...overrides },
      memoryOpener(content),
    );

    const rebuilt = new Uint8Array(content.length);
    let receiver: SegmentedReceiver | null = null;
    let index = 0;
    let delivered = 0;

    try {
      for (;;) {
        const frameBytes = await session.take();
        if (!frameBytes) break;
        const parsed = parseFrame(frameBytes);
        if (!parsed.ok) continue;
        const isManifest = parsed.value.kind === 'manifest';
        const descriptor = {
          index,
          kind: isManifest ? 'manifest' as const : 'data' as const,
          segmentIndex: isManifest ? -1 : parsed.value.frame.segmentIndex,
          isSource: !isManifest && parsed.value.frame.frameType === 0x02,
        };
        index += 1;
        if (!keep(descriptor)) continue;
        delivered += 1;

        if (!receiver) {
          if (!isManifest) continue;
          receiver = new SegmentedReceiver(parsed.value.manifest, {
            onSegmentComplete: (segment) => rebuilt.set(segment.bytes, Number(segment.byteOffset)),
          });
          continue;
        }
        receiver.acceptFrameBytes(frameBytes);
      }
    } finally {
      await session.dispose();
    }
    return { receiver, rebuilt, framesSeen: index, delivered };
  }

  /** Runs the filtered pass, then a clean recovery tail for whatever is missing. */
  async function throughThenRecover(
    keep: Parameters<typeof through>[0],
    overrides: Partial<StreamingSenderConfig> = {},
  ) {
    const pass = await through(keep, overrides);
    const receiver = pass.receiver;
    if (!receiver) return { ...pass, completedInPass: false, recovered: false };
    const completedInPass = receiver.isComplete;
    if (completedInPass) return { ...pass, completedInPass, recovered: true };

    const missing: number[] = [];
    const bitmap = receiver.committedBitmap();
    for (let index = 0; index < 4; index += 1) {
      if ((bitmap[index >> 3] & (1 << (index & 7))) === 0) missing.push(index);
    }

    const session = await StreamingTransferSession.open(
      'payload.bin',
      { segmentSizeBytes: SEGMENT_BYTES, symbolSizeBytes: SYMBOL_BYTES, sessionId: 0x5eed_0033, fileId: 0x0f0e_0d0c, ...overrides },
      memoryOpener(content),
    );
    try {
      session.beginRecovery(missing);
      let frames = 0;
      while (!receiver.isComplete && frames < 30_000) {
        const frameBytes = await session.take();
        if (!frameBytes) break;
        frames += 1;
        receiver.acceptFrameBytes(frameBytes);
      }
    } finally {
      await session.dispose();
    }
    return { ...pass, completedInPass, recovered: receiver.isComplete };
  }

  it('rebuilds a segment whose every source symbol was lost - but only in recovery', async () => {
    // Measured, and it decides how the recovery tail has to be built. The
    // receiver's decoder holds at most `sourceSymbolCount` pending equations
    // and rejects everything after that as saturated. A segment with no source
    // symbols fills that budget with algebra it can never reduce, so the pass
    // cannot rebuild it at *any* repair budget - 1.5x, 2.5x and 4x were all
    // tried and none recovered it.
    //
    // The tail resends the segment's source symbols before generating fresh
    // repair, which is what turns this from unrecoverable into ordinary.
    const run = await throughThenRecover(
      (frame) => !(frame.kind === 'data' && frame.segmentIndex === 1 && frame.isSource),
      { repairOverheadRatio: 1.5 },
    );
    expect(run.completedInPass, 'repair alone was expected to fall short').toBe(false);
    expect(run.recovered, 'the recovery tail did not rebuild the segment').toBe(true);
    expect(sha256(run.rebuilt)).toBe(expected);
  });

  it('survives a burst that takes hundreds of consecutive frames', async () => {
    // A hand moving, or a notification banner. Independent per-frame loss never
    // produces this shape: a burst can take one segment's symbols together,
    // which is the case the pass cannot code its way out of.
    const run = await throughThenRecover(
      (frame) => frame.index < 250 || frame.index >= 650,
      { repairOverheadRatio: 1.5 },
    );
    expect(run.recovered, 'a burst survived neither the pass nor recovery').toBe(true);
    expect(sha256(run.rebuilt)).toBe(expected);
  });

  it('completes after acquiring on a later manifest, having missed the start', async () => {
    // A receiver that starts scanning late. The manifest cadence is what lets
    // it acquire the session at all; the symbols that went past before it did
    // are simply gone, and recovery is what fetches them.
    let manifests = 0;
    const run = await throughThenRecover((frame) => {
      if (frame.kind !== 'manifest') return true;
      manifests += 1;
      return manifests > 1;
    });
    expect(manifests, 'the fixture never retransmitted a manifest').toBeGreaterThan(1);
    expect(run.recovered).toBe(true);
    expect(sha256(run.rebuilt)).toBe(expected);
  });

  it('needs no repair at all on a clean channel', async () => {
    // Systematic-first, stated as a test: with every source symbol delivered,
    // discarding every repair symbol costs nothing.
    const run = await through((frame) => frame.kind !== 'data' || frame.isSource);
    expect(run.receiver?.isComplete).toBe(true);
    expect(sha256(run.rebuilt)).toBe(expected);
    expect(run.receiver?.stats().symbolsRepaired).toBe(0);
  });


  it('completes even though the last frame of the pass never arrives', async () => {
    // There is no terminal frame in v2 - completion is the segment bitmap
    // filling, not a message saying so. This is that property, held against
    // regression: losing the final frame must be as unremarkable as losing any
    // other, and the frame count is not known until the pass has run.
    const total = (await through(() => true)).framesSeen;
    const run = await through((frame) => frame.index !== total - 1);

    expect(run.receiver?.isComplete, 'the transfer depended on its final frame').toBe(true);
    expect(sha256(run.rebuilt)).toBe(expected);
  });
});
