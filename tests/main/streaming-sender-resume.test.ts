import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  V2_FRAME_TYPE,
  parseFrame,
  segmentByteRange,
} from '../../src/core/protocol-v2';
import { encodeResumeToken } from '../../src/core/resume-token';
import { DeqrError, ErrorCode } from '../../src/shared/errors';
import {
  SenderFileHandle,
  SenderFileOpener,
  SenderFileStat,
  StreamingSenderConfig,
  StreamingTransferSession,
  senderResumeToken,
} from '../../src/main/streaming-sender';

/**
 * What a sender does with forty characters carried across an air gap.
 *
 * The sender is the half of resume that can get it catastrophically wrong. It
 * has a file open and a token that claims to describe a transfer of it, and if
 * the two do not actually agree, everything it emits from that point lands at
 * offsets in someone else's partial file. So the tests below spend most of
 * their weight on refusals - a different file, a different segmentation, a
 * mistyped code - and only then on the thing that is supposed to work.
 *
 * The one property that makes the working case worth having: a resumed pass
 * emits the *same frames* for the segments it does emit as a fresh pass would.
 * A resume that changed frame content would be a second protocol.
 */

/* ------------------------------------------------------------- synthetic file */

const TILE_BYTES = 64 * 1024;

function buildTile(seed: number): Uint8Array {
  const tile = new Uint8Array(TILE_BYTES);
  let state = seed >>> 0;
  for (let index = 0; index < TILE_BYTES; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    tile[index] = state >>> 24;
  }
  return tile;
}

/** A file that does not exist, read from a repeating tile. Mirrors the sender suite's. */
class SyntheticFile implements SenderFileHandle {
  constructor(
    private readonly size: bigint,
    private readonly tile: Uint8Array = buildTile(0x5eed_0007),
  ) {}

  byteAt(position: bigint): number {
    return this.tile[Number(position % BigInt(TILE_BYTES))];
  }

  async stat(): Promise<SenderFileStat> {
    return { size: this.size, mtimeMs: 1_700_000_000_000n, isFile: true };
  }

  async read(buffer: Uint8Array, length: number, position: bigint): Promise<number> {
    let written = 0;
    while (written < length) {
      const tileOffset = Number((position + BigInt(written)) % BigInt(TILE_BYTES));
      const take = Math.min(length - written, TILE_BYTES - tileOffset);
      buffer.set(this.tile.subarray(tileOffset, tileOffset + take), written);
      written += take;
    }
    return length;
  }

  async close(): Promise<void> {}
}

function openerFor(file: SenderFileHandle): SenderFileOpener {
  return async () => file;
}

const config: Partial<StreamingSenderConfig> = {
  segmentSizeBytes: 64 * 1024,
  symbolSizeBytes: 512,
  frameQueueCapacity: 8,
  manifestIntervalFrames: 32,
  repairOverheadRatio: 0.1,
  hashChunkBytes: 16 * 1024,
  compressibilitySampleBytes: 16 * 1024,
  sessionId: 0x1111_2222,
  fileId: 0x3333_4444,
};

const SIZE = 320n * 1024n; // Five 64 KiB segments.

async function open(
  overrides: Partial<StreamingSenderConfig> = {},
  file = new SyntheticFile(SIZE),
): Promise<StreamingTransferSession> {
  return StreamingTransferSession.open(
    'C:\\fixtures\\resume-sample.bin',
    { ...config, ...overrides },
    openerFor(file),
  );
}

function digestOf(file: SyntheticFile, size: bigint): Uint8Array {
  const digest = createHash('sha256');
  const chunk = new Uint8Array(TILE_BYTES);
  let position = 0n;
  while (position < size) {
    const remaining = size - position;
    const want = remaining < BigInt(TILE_BYTES) ? Number(remaining) : TILE_BYTES;
    for (let index = 0; index < want; index += 1) chunk[index] = file.byteAt(position + BigInt(index));
    digest.update(chunk.subarray(0, want));
    position += BigInt(want);
  }
  return new Uint8Array(digest.digest());
}

/** Every data frame of a whole pass, grouped by the segment it belongs to. */
async function drainBySegment(session: StreamingTransferSession): Promise<Map<number, string[]>> {
  const bySegment = new Map<number, string[]>();
  for (;;) {
    const frame = await session.take();
    if (!frame) break;
    const parsed = parseFrame(frame);
    if (!parsed.ok || parsed.value.kind !== 'data') continue;
    const { segmentIndex } = parsed.value.frame;
    const list = bySegment.get(segmentIndex) ?? [];
    list.push(Buffer.from(frame).toString('base64'));
    bySegment.set(segmentIndex, list);
  }
  return bySegment;
}

/* --------------------------------------------------------------------- tests */

describe('a sender resumes where a receiver stopped', () => {
  it('starts at the token segment and skips everything before it', async () => {
    const file = new SyntheticFile(SIZE);
    const token = encodeResumeToken({
      sessionId: 0x1111_2222,
      fileId: 0x3333_4444,
      segmentCount: 5,
      resumeFromSegment: 3,
      sha256: digestOf(file, SIZE),
    });

    const session = await open({ resumeToken: token }, file);
    expect(session.preflight.resumed).toBe(true);
    expect(session.preflight.resumeFromSegment).toBe(3);
    expect(session.progress().resumeFromSegment).toBe(3);

    const bySegment = await drainBySegment(session);
    expect([...bySegment.keys()].sort((left, right) => left - right)).toEqual([3, 4]);
    await session.dispose();
  });

  it('adopts the token identity, which is what lets a receiver recognise its own file', async () => {
    const file = new SyntheticFile(SIZE);
    const token = encodeResumeToken({
      sessionId: 0x0bad_cafe,
      fileId: 0x0000_0001,
      segmentCount: 5,
      resumeFromSegment: 1,
      sha256: digestOf(file, SIZE),
    });

    // The configured ids say one thing and the token says another. The token
    // wins: its ids are the directory name the receiver's partial file is under,
    // so a session that used anything else would be resuming into nothing.
    const session = await open({ resumeToken: token }, file);
    expect(session.manifest.sessionId).toBe(0x0bad_cafe);
    expect(session.manifest.fileId).toBe(0x0000_0001);
    await session.dispose();
  });

  it('emits byte-identical frames for the segments it does send', async () => {
    const file = new SyntheticFile(SIZE);
    const fresh = await open({}, file);
    const freshFrames = await drainBySegment(fresh);
    await fresh.dispose();

    const token = senderResumeToken(fresh.manifest, fresh.plan, 3);
    const resumed = await open({ resumeToken: token }, new SyntheticFile(SIZE));
    const resumedFrames = await drainBySegment(resumed);
    await resumed.dispose();

    // A resume changes where the cursor starts and nothing else. If it changed
    // frame content it would be a second protocol wearing the same version byte.
    expect(resumedFrames.get(3)).toEqual(freshFrames.get(3));
    expect(resumedFrames.get(4)).toEqual(freshFrames.get(4));
  });

  it('still retransmits the manifest, so a receiver can re-acquire the session', async () => {
    const file = new SyntheticFile(SIZE);
    const first = await open({}, file);
    const token = senderResumeToken(first.manifest, first.plan, 4);
    await first.dispose();

    const session = await open({ resumeToken: token }, file);
    // The manifest cadence is what lets a receiver that starts scanning late
    // acquire the session at all, and a resumed pass needs it more than a fresh
    // one does: the receiver is being restarted mid-transfer by definition.
    const frame = await session.take();
    expect(frame).not.toBeNull();
    const parsed = parseFrame(frame!);
    expect(parsed.ok && parsed.value.kind).toBe('manifest');

    let manifests = 0;
    for (;;) {
      const next = await session.take();
      if (!next) break;
      const decoded = parseFrame(next);
      if (decoded.ok && decoded.value.kind === 'manifest') manifests += 1;
    }
    expect(manifests).toBeGreaterThan(0);
    await session.dispose();
  });

  it('replays the last segment when the token says nothing is missing', async () => {
    const file = new SyntheticFile(SIZE);
    const token = encodeResumeToken({
      sessionId: 0x1111_2222,
      fileId: 0x3333_4444,
      segmentCount: 5,
      // "I have all five." A receiver in that state died before verifying and
      // needs a manifest to come back to; emitting nothing would leave it with
      // no session to re-acquire.
      resumeFromSegment: 5,
      sha256: digestOf(file, SIZE),
    });

    const session = await open({ resumeToken: token }, file);
    expect(session.preflight.resumeFromSegment).toBe(4);
    const bySegment = await drainBySegment(session);
    expect([...bySegment.keys()]).toEqual([4]);
    await session.dispose();
  });

  it('covers only the bytes it actually sent', async () => {
    const file = new SyntheticFile(SIZE);
    const token = encodeResumeToken({
      sessionId: 0x1111_2222,
      fileId: 0x3333_4444,
      segmentCount: 5,
      resumeFromSegment: 4,
      sha256: digestOf(file, SIZE),
    });

    const session = await open({ resumeToken: token }, file);
    await drainBySegment(session);
    const progress = session.progress();
    const last = segmentByteRange(session.plan, 4);
    // Original bytes covered counts source symbols emitted this pass, so a
    // resumed transfer reports what it sent rather than what the receiver holds.
    // Only the receiver knows the second number, and it is not on this side.
    expect(progress.transportBytesCovered).toBe(last.end - last.start);
    expect(progress.originalBytesTotal).toBe(SIZE);
    await session.dispose();
  });
});

describe('a sender refuses a resume it cannot honour', () => {
  it('rejects a token that will not read', async () => {
    await expect(open({ resumeToken: 'NOT-A-REAL-TOKEN' })).rejects.toMatchObject({
      code: ErrorCode.RESUME_TOKEN_INVALID,
    });
  });

  it('rejects a token for a different file', async () => {
    const other = new Uint8Array(32).fill(0xa5);
    const token = encodeResumeToken({
      sessionId: 0x1111_2222,
      fileId: 0x3333_4444,
      segmentCount: 5,
      resumeFromSegment: 2,
      sha256: other,
    });

    // The digest prefix is five bytes and this is what it is for: catching the
    // wrong file in the second after selection rather than as a hash failure
    // after the receiver has scanned for an hour.
    await expect(open({ resumeToken: token })).rejects.toMatchObject({
      code: ErrorCode.RESUME_FILE_MISMATCH,
    });
  });

  it('rejects a token made with a different segmentation', async () => {
    const file = new SyntheticFile(SIZE);
    const token = encodeResumeToken({
      sessionId: 0x1111_2222,
      fileId: 0x3333_4444,
      // The same bytes divided into 128 KiB segments instead of 64 KiB. Segment
      // 2 of that plan is not segment 2 of this one, and sending one into the
      // other would place real data at wrong offsets.
      segmentCount: 3,
      resumeFromSegment: 2,
      sha256: digestOf(file, SIZE),
    });

    await expect(open({ resumeToken: token }, file)).rejects.toMatchObject({
      code: ErrorCode.RESUME_PLAN_MISMATCH,
    });
  });

  it('reports its refusals as DeqrError, so they reach a renderer sanitized', async () => {
    await expect(open({ resumeToken: 'x'.repeat(40) })).rejects.toBeInstanceOf(DeqrError);
  });

  it('closes the file it opened when a token is refused', async () => {
    let closes = 0;
    const file = new SyntheticFile(SIZE);
    const wrapped: SenderFileHandle = {
      stat: () => file.stat(),
      read: (buffer, length, position) => file.read(buffer, length, position),
      close: async () => {
        closes += 1;
      },
    };
    await expect(
      StreamingTransferSession.open(
        'C:\\fixtures\\resume-sample.bin',
        { ...config, resumeToken: 'NOT-A-REAL-TOKEN' },
        openerFor(wrapped),
      ),
    ).rejects.toBeInstanceOf(DeqrError);
    // A descriptor leaked on a refused resume is a descriptor leaked every time
    // somebody mistypes a code.
    expect(closes).toBe(1);
  });
});

describe('a fresh transfer is unchanged by the resume path existing', () => {
  it('starts at segment zero and reports no resume', async () => {
    const session = await open();
    expect(session.preflight.resumed).toBe(false);
    expect(session.preflight.resumeFromSegment).toBe(0);
    expect(session.progress().resumeFromSegment).toBe(0);

    const bySegment = await drainBySegment(session);
    expect([...bySegment.keys()].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4]);
    await session.dispose();
  });

  it('keeps its configured identifiers when no token is given', async () => {
    const session = await open();
    expect(session.manifest.sessionId).toBe(0x1111_2222);
    expect(session.manifest.fileId).toBe(0x3333_4444);
    await session.dispose();
  });

  it('mints a token a sender can hand back for its own session', async () => {
    const session = await open();
    const token = senderResumeToken(session.manifest, session.plan, 2);
    const resumed = await open({ resumeToken: token });
    expect(resumed.preflight.resumeFromSegment).toBe(2);
    // Round trip through the printable form: what the receiver shows and what
    // the desktop consumes have to be the same forty characters.
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){7}$/);
    await session.dispose();
    await resumed.dispose();
  });

  it('emits source frames whose payload is the file at the right offset', async () => {
    const file = new SyntheticFile(SIZE);
    const token = encodeResumeToken({
      sessionId: 0x1111_2222,
      fileId: 0x3333_4444,
      segmentCount: 5,
      resumeFromSegment: 2,
      sha256: digestOf(file, SIZE),
    });
    const session = await open({ resumeToken: token }, file);

    let checked = 0;
    for (;;) {
      const frame = await session.take();
      if (!frame) break;
      const parsed = parseFrame(frame);
      if (!parsed.ok || parsed.value.kind !== 'data') continue;
      const data = parsed.value.frame;
      if (data.frameType !== V2_FRAME_TYPE.SOURCE) continue;

      // The check the whole resume rests on: after skipping two segments, a
      // source symbol still carries the bytes the manifest's own segmentation
      // puts at that position. An off-by-one segment here would reconstruct a
      // file shifted by 64 KiB and fail only at the final hash.
      //
      // Compared as whole ranges rather than byte by byte: a per-byte
      // assertion over every symbol of a 320 KiB transfer is three hundred
      // thousand matcher calls, which is slow enough to time out the suite.
      const segment = segmentByteRange(session.plan, data.segmentIndex);
      const start = segment.start + BigInt(data.symbolId * 512);
      const length = Number(
        start + BigInt(data.payload.length) > SIZE ? SIZE - start : BigInt(data.payload.length),
      );
      const expected = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) expected[index] = file.byteAt(start + BigInt(index));
      expect(Buffer.from(data.payload.subarray(0, length)).equals(Buffer.from(expected))).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
    await session.dispose();
  });
});
