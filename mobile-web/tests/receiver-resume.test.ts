import { describe, expect, it } from 'vitest';

import {
  V2_COMPRESSION,
  V2_FEC_PROFILE,
  V2_FRAME_TYPE,
  planSegmentation,
  segmentByteRange,
  serializeDataFrame,
  serializeManifestFrame,
  sourceSymbolCountForSegment,
  type DeqrV2Manifest,
  type SegmentPlan,
} from '../../src/core/protocol-v2';
import {
  RESUME_TOKEN_CHARS,
  decodeResumeToken,
  decodeTargetedResumeToken,
  resumeTokenTargets,
} from '../../src/core/resume-token';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { digestToHex } from '../../src/core/sha256-stream';
import {
  CHECKPOINT_SCHEMA,
  OPFS_CHECKPOINT_FILE,
  OPFS_DATA_FILE,
  readCheckpoint,
  sessionDirectoryName,
  type DirectoryHandleLike,
} from '../src/opfs';
import { ReceivePipeline, SESSION_END, retentionFor } from '../src/receive-pipeline';
import { ReceiverStorage } from '../src/receiver-storage';
import { FakeStorage, fakeEnvironment } from './helpers/fake-opfs';

/**
 * The phase's gate, driven through the real pipeline against a real store.
 *
 * A resume is only worth having if it is *safe*, and safety here has an exact
 * meaning: a resumed transfer must produce the same bytes a fresh one would,
 * and must be refused whenever anything about the two runs disagrees. So the
 * matrix below interrupts a transfer at every point that has a distinct shape -
 * before anything lands, mid-segment, on a boundary, halfway, at 99% - restarts
 * the receiver from nothing but what is on the device, and verifies the result
 * against a digest computed outside the receiver entirely.
 *
 * The second half is the refusals. A checkpoint from another session, another
 * file, another segmentation; a checkpoint that is corrupt; a data file that
 * vanished under one. Each has to end with the receiver starting clean rather
 * than adopting something it cannot account for, because the failure mode of
 * getting this wrong is not an error message - it is a file with the wrong
 * bytes in it that passes every check except the last one.
 */

/* ----------------------------------------------------------------- fixtures */

const SESSION_ID = 0x5eed_0007;
const FILE_ID = 0x0a0b_0c0d;
const SEGMENT_BYTES = 65_536;
const SYMBOL_BYTES = 512;

function pseudoRandomBytes(length: number, seed = 0x9e37_79b9): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b_79f5) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

interface Fixture {
  manifest: DeqrV2Manifest;
  manifestFrame: Uint8Array;
  plan: SegmentPlan;
  payload: Uint8Array;
  directoryName: string;
  /** Systematic frames for one segment, in sender order. */
  segmentFrames(segmentIndex: number): Uint8Array[];
  /** Every systematic frame, segment 0 first - one full sender pass. */
  allFrames(): Uint8Array[];
}

async function fixture(options: {
  segments?: number;
  sessionId?: number;
  fileId?: number;
  segmentSizeBytes?: number;
  seed?: number;
  trailingBytes?: number;
} = {}): Promise<Fixture> {
  const segmentSizeBytes = options.segmentSizeBytes ?? SEGMENT_BYTES;
  const segments = options.segments ?? 6;
  // A short final segment by default: an off-by-one in the resume path that
  // treats every segment as full length shows up here and nowhere else.
  const trailingBytes = options.trailingBytes ?? 4_096;
  const transportSize = segmentSizeBytes * (segments - 1) + trailingBytes;
  const sessionId = options.sessionId ?? SESSION_ID;
  const fileId = options.fileId ?? FILE_ID;

  const payload = pseudoRandomBytes(transportSize, options.seed ?? 0x9e37_79b9);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload.buffer as ArrayBuffer));
  const plan = planSegmentation({
    transportSize: BigInt(transportSize),
    segmentSizeBytes,
    symbolSizeBytes: SYMBOL_BYTES,
  });

  const manifest: DeqrV2Manifest = {
    featureFlags: 0,
    sessionId,
    fileId,
    originalSize: BigInt(transportSize),
    transportSize: BigInt(transportSize),
    segmentSizeBytes,
    symbolSizeBytes: SYMBOL_BYTES,
    segmentCount: plan.segmentCount,
    fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
    compressionMode: V2_COMPRESSION.NONE,
    compressionParam: 0,
    transportProfileId: 0,
    sha256: digest,
    filename: 'phase07.bin',
    mimeType: 'application/octet-stream',
  };

  const segmentFrames = (segmentIndex: number): Uint8Array[] => {
    const range = segmentByteRange(plan, segmentIndex);
    const encoder = new SegmentEncoder(SYMBOL_BYTES);
    encoder.loadSegment(payload.subarray(Number(range.start), Number(range.end)));
    const frames: Uint8Array[] = [];
    for (let symbolId = 0; symbolId < encoder.sourceSymbolCount; symbolId += 1) {
      const out = new Uint8Array(SYMBOL_BYTES);
      encoder.symbolInto(symbolId, out);
      frames.push(serializeDataFrame({
        frameType: V2_FRAME_TYPE.SOURCE,
        sessionId,
        fileId,
        segmentIndex,
        symbolId,
        sourceSymbolCount: encoder.sourceSymbolCount,
        frameFlags: 0,
        payload: out,
      }));
    }
    return frames;
  };

  return {
    manifest,
    manifestFrame: serializeManifestFrame(manifest),
    plan,
    payload,
    directoryName: sessionDirectoryName(sessionId, fileId),
    segmentFrames,
    allFrames() {
      const frames: Uint8Array[] = [];
      for (let index = 0; index < plan.segmentCount; index += 1) frames.push(...segmentFrames(index));
      return frames;
    },
  };
}

/** A pipeline over a real OPFS store on a fake device. */
function pipelineOver(storage: FakeStorage, options: { resume?: boolean } = {}): ReceivePipeline {
  return new ReceivePipeline({
    storage: new ReceiverStorage({
      environment: { storage, supportsSyncAccess: true },
      now: () => 1_700_000_000_000,
    }),
    resume: options.resume ?? false,
  });
}

/**
 * Drives one receiving run and stops it at a chosen point.
 *
 * `stopAfterFrames` counts *data* frames submitted, which is what makes an
 * interruption at "1%" or "mid-segment" a precise instruction rather than an
 * approximate one.
 */
async function receiveUntil(
  pipeline: ReceivePipeline,
  at: Fixture,
  stopAfterFrames: number,
  frames = at.allFrames(),
): Promise<number> {
  pipeline.submit(at.manifestFrame);
  await pipeline.whenStorageReady();
  let submitted = 0;
  for (const frame of frames) {
    if (submitted >= stopAfterFrames) break;
    pipeline.submit(frame);
    submitted += 1;
  }
  return submitted;
}

async function sessionDirectory(storage: FakeStorage, name: string): Promise<DirectoryHandleLike | null> {
  return storage.sessions().get(name) ?? null;
}

/**
 * An exclusive handle on a session's data file, opened outside the pipeline.
 *
 * Reading the device back through anything other than the code that wrote it is
 * the point: a store that agrees with itself about where a segment went proves
 * nothing about where the segment actually is.
 */
async function openDataFile(storage: FakeStorage, directoryName: string) {
  const file = storage.sessions().get(directoryName)?.files.get(OPFS_DATA_FILE);
  if (!file?.createSyncAccessHandle) throw new Error(`no data file under ${directoryName}`);
  return file.createSyncAccessHandle();
}

/* --------------------------------------------------- the interruption matrix */

describe('an interrupted transfer resumes from what is on the device', () => {
  // Every distinct shape an interruption has. Each is the frame count at which
  // the first run stops, expressed against a six-segment transfer of 128
  // symbols per segment.
  const symbolsPerSegment = SEGMENT_BYTES / SYMBOL_BYTES;
  const cases: Array<{ name: string; frames: number; expectAdopted: number }> = [
    { name: '1% - nothing has completed yet', frames: 7, expectAdopted: 0 },
    { name: 'mid-segment', frames: symbolsPerSegment + 40, expectAdopted: 1 },
    { name: 'exactly on a segment boundary', frames: symbolsPerSegment * 2, expectAdopted: 2 },
    { name: '50%', frames: symbolsPerSegment * 3, expectAdopted: 3 },
    { name: '99% - only the short final segment is missing', frames: symbolsPerSegment * 5, expectAdopted: 5 },
  ];

  for (const scenario of cases) {
    it(`resumes after an interruption at ${scenario.name}`, async () => {
      const { storage } = fakeEnvironment();
      const at = await fixture();

      // First run: receive part of the transfer, then lose the tab.
      const first = pipelineOver(storage, { resume: true });
      await receiveUntil(first, at, scenario.frames);
      const beforeProgress = first.progress();
      expect(beforeProgress.unitsRecovered).toBe(scenario.expectAdopted);

      const token = first.resumeToken();
      expect(token).toBeDefined();
      first.reset(SESSION_END.INTERRUPTED);
      await first.settled();

      // The partial file survives an interruption. That is the whole premise.
      expect(storage.sessionNames()).toContain(at.directoryName);

      // Second run: a completely new pipeline, holding nothing from the first.
      const second = pipelineOver(storage, { resume: true });
      second.submit(at.manifestFrame);
      await second.whenStorageReady();

      const resumed = second.progress();
      expect(resumed.unitsAdopted).toBe(scenario.expectAdopted);
      expect(resumed.resumed).toBe(scenario.expectAdopted > 0);
      expect(resumed.unitsRecovered).toBe(scenario.expectAdopted);

      // The sender replays from the token's segment onward.
      const decoded = decodeResumeToken(token!);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.value.resumeFromSegment).toBe(scenario.expectAdopted);

      const replay: Uint8Array[] = [];
      for (let index = decoded.value.resumeFromSegment; index < at.plan.segmentCount; index += 1) {
        replay.push(...at.segmentFrames(index));
      }
      for (const frame of replay) second.submit(frame);

      const verified = await second.verify();
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      // Hash-identical to the file the sender had, computed outside the receiver.
      expect(digestToHex(verified.value.sha256)).toBe(digestToHex(at.manifest.sha256));
      expect(verified.value.size).toBe(at.payload.length);
      second.reset(SESSION_END.COMPLETED);
      await second.settled();
    });
  }

  it('does not re-receive the segments it adopted', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const symbols = SEGMENT_BYTES / SYMBOL_BYTES;

    const first = pipelineOver(storage, { resume: true });
    await receiveUntil(first, at, symbols * 4);
    first.reset(SESSION_END.INTERRUPTED);
    await first.settled();

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();

    // A conservative sender replays from segment 0. Every frame for an adopted
    // segment must cost one bit test and change nothing - which is what makes a
    // replay safe rather than merely tolerated.
    const before = second.progress();
    for (const frame of at.segmentFrames(0)) {
      const result = second.submit(frame);
      expect(result.outcome).toBe('duplicate');
    }
    const after = second.progress();
    expect(after.unitsRecovered).toBe(before.unitsRecovered);
    expect(after.bytesCommitted).toBe(before.bytesCommitted);
    expect(after.framesAccepted).toBe(before.framesAccepted);
  });

  it('starts verification straight away when everything was already received', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture({ segments: 3 });

    // A receiver that got every segment and died before it could hash them.
    const first = pipelineOver(storage, { resume: true });
    await receiveUntil(first, at, Number.MAX_SAFE_INTEGER);
    expect(first.isComplete).toBe(true);
    first.reset(SESSION_END.INTERRUPTED);
    await first.settled();

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();

    // Nothing else will arrive that could set this: there are no frames left.
    expect(second.isComplete).toBe(true);
    expect(second.progress().unitsAdopted).toBe(at.plan.segmentCount);

    const verified = await second.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(digestToHex(verified.value.sha256)).toBe(digestToHex(at.manifest.sha256));
  });

  it('reconstructs the file byte for byte, short final segment included', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture({ segments: 4, trailingBytes: 777 });

    const first = pipelineOver(storage, { resume: true });
    await receiveUntil(first, at, (SEGMENT_BYTES / SYMBOL_BYTES) * 2);
    first.reset(SESSION_END.INTERRUPTED);
    await first.settled();

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();
    for (const frame of at.allFrames()) second.submit(frame);

    const verified = await second.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    // Read the device back independently of the pipeline that wrote it.
    const onDisk = new Uint8Array(at.payload.length);
    const handle = await openDataFile(storage, at.directoryName);
    handle.read(onDisk, { at: 0 });
    handle.close();
    expect([...onDisk]).toEqual([...at.payload]);
  });
});

/* ------------------------------------------------------------ the refusals */

describe('a resume is refused whenever the two runs disagree', () => {
  async function interruptedSession(seed = 0x9e37_79b9): Promise<{
    storage: FakeStorage;
    at: Fixture;
  }> {
    const { storage } = fakeEnvironment();
    const at = await fixture({ seed });
    const first = pipelineOver(storage, { resume: true });
    await receiveUntil(first, at, (SEGMENT_BYTES / SYMBOL_BYTES) * 3);
    first.reset(SESSION_END.INTERRUPTED);
    await first.settled();
    return { storage, at };
  }

  it('rejects a checkpoint whose digest describes another file', async () => {
    const { storage, at } = await interruptedSession();
    // Same session and file ids, different content. Without the digest check
    // this would drive one file's bytes into another file's partial transfer.
    const other = await fixture({ seed: 0x1234_5678 });
    expect(other.manifest.sessionId).toBe(at.manifest.sessionId);

    const second = pipelineOver(storage, { resume: true });
    second.submit(other.manifestFrame);
    await second.whenStorageReady();

    const progress = second.progress();
    expect(progress.unitsAdopted).toBe(0);
    expect(progress.checkpointRejection).toBe('CHECKPOINT_FILE_MISMATCH');
    // And the mismatched partial data is gone, so nothing of it can survive
    // into the gaps of the transfer that replaced it.
    const checkpoint = await readCheckpoint((await sessionDirectory(storage, at.directoryName))!);
    expect(checkpoint?.sha256).toBe(digestToHex(other.manifest.sha256));
    expect(checkpoint?.segmentsCommitted).toBe(0);
  });

  it('rejects a checkpoint written under a different segmentation', async () => {
    const { storage, at } = await interruptedSession();
    // The same bytes at a different transport profile: 128 KiB segments rather
    // than 64 KiB. Segment 2 of one is not segment 2 of the other.
    const reprofiled = await fixture({ segmentSizeBytes: 131_072, segments: 3 });
    expect(reprofiled.manifest.sessionId).toBe(at.manifest.sessionId);

    const second = pipelineOver(storage, { resume: true });
    second.submit(reprofiled.manifestFrame);
    await second.whenStorageReady();
    expect(second.progress().unitsAdopted).toBe(0);
    expect(second.progress().checkpointRejection).toBe('CHECKPOINT_FILE_MISMATCH');
  });

  it('rejects a checkpoint for another session that landed in the same place', async () => {
    const { storage, at } = await interruptedSession();
    const directory = storage.sessions().get(at.directoryName);
    expect(directory).toBeDefined();

    // Rewrite the identity inside the checkpoint while leaving it where it is.
    // The directory name is derived from the session, so the two now disagree -
    // which is exactly what a half-finished rename or a hand-edit produces.
    const raw = await directory!.files.get(OPFS_CHECKPOINT_FILE)!.getFile();
    const parsed = JSON.parse(await raw.text());
    parsed.sessionId = 0x0bad_0bad;
    const writable = await directory!.files.get(OPFS_CHECKPOINT_FILE)!.createWritable();
    await writable.write(JSON.stringify(parsed));
    await writable.close();

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();
    expect(second.progress().unitsAdopted).toBe(0);
    expect(second.progress().checkpointRejection).toBe('CHECKPOINT_SESSION_MISMATCH');
  });

  it('refuses a checkpoint from a schema this build does not know, and clears its data', async () => {
    // The release-upgrade case, which is not the corruption case below: the
    // file is well formed and internally consistent, and every field this build
    // reads is present. Only the schema number says it was written by a
    // different DEQR. Acting on it would mean trusting a bitmap whose fields
    // may have been redefined - the one input that decides which parts of the
    // device's file are already correct.
    //
    // Refusing is half of it. The partial data has to go with the checkpoint,
    // or the next session pre-sizes a file that still holds the previous
    // build's bytes, whose gaps then read back as that data rather than as
    // zeros and fail the hash only at the very end.
    for (const schema of [CHECKPOINT_SCHEMA + 1, CHECKPOINT_SCHEMA - 1]) {
      const { storage, at } = await interruptedSession();
      const directory = storage.sessions().get(at.directoryName)!;
      const raw = await directory.files.get(OPFS_CHECKPOINT_FILE)!.getFile();
      const parsed = JSON.parse(await raw.text());
      expect(parsed.segmentsCommitted, 'the fixture must have progress to lose').toBeGreaterThan(0);
      parsed.schema = schema;
      const writable = await directory.files.get(OPFS_CHECKPOINT_FILE)!.createWritable();
      await writable.write(JSON.stringify(parsed));
      await writable.close();

      const second = pipelineOver(storage, { resume: true });
      second.submit(at.manifestFrame);
      await second.whenStorageReady();
      expect(second.progress().unitsAdopted, `schema ${schema} was adopted`).toBe(0);
      expect(second.progress().checkpointRejection).toBe('CHECKPOINT_UNREADABLE');

      // Starting clean has to mean the whole transfer still completes.
      for (const frame of at.allFrames()) second.submit(frame);
      const verified = await second.verify();
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(digestToHex(verified.value.sha256)).toBe(digestToHex(at.manifest.sha256));
    }
  });

  it('rejects a corrupt checkpoint and starts the transfer clean', async () => {
    const { storage, at } = await interruptedSession();
    const directory = storage.sessions().get(at.directoryName)!;
    const writable = await directory.files.get(OPFS_CHECKPOINT_FILE)!.createWritable();
    // Truncated mid-write, which is what a process killed during a checkpoint
    // actually leaves behind.
    await writable.write('{"schema":1,"protocol":2,"sessionId":15');
    await writable.close();

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();
    expect(second.progress().unitsAdopted).toBe(0);
    expect(second.progress().checkpointRejection).toBe('CHECKPOINT_UNREADABLE');

    // Clean means clean: a full pass still verifies.
    for (const frame of at.allFrames()) second.submit(frame);
    const verified = await second.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(digestToHex(verified.value.sha256)).toBe(digestToHex(at.manifest.sha256));
  });

  it('rejects a checkpoint whose bitmap and counters disagree', async () => {
    const { storage, at } = await interruptedSession();
    const directory = storage.sessions().get(at.directoryName)!;
    const raw = await directory.files.get(OPFS_CHECKPOINT_FILE)!.getFile();
    const parsed = JSON.parse(await raw.text());
    // The bitmap says three segments; the counter now claims five. Believing
    // either half would mark segments complete that nothing ever wrote.
    parsed.segmentsCommitted = 5;
    const writable = await directory.files.get(OPFS_CHECKPOINT_FILE)!.createWritable();
    await writable.write(JSON.stringify(parsed));
    await writable.close();

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();
    expect(second.progress().unitsAdopted).toBe(0);
    expect(second.progress().checkpointRejection).toBe('CHECKPOINT_INCONSISTENT');
  });

  it('rejects a checkpoint whose byte count disagrees with its bitmap', async () => {
    const { storage, at } = await interruptedSession();
    const directory = storage.sessions().get(at.directoryName)!;
    const raw = await directory.files.get(OPFS_CHECKPOINT_FILE)!.getFile();
    const parsed = JSON.parse(await raw.text());
    parsed.bytesCommitted = parsed.bytesCommitted + 1;
    const writable = await directory.files.get(OPFS_CHECKPOINT_FILE)!.createWritable();
    await writable.write(JSON.stringify(parsed));
    await writable.close();

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();
    expect(second.progress().checkpointRejection).toBe('CHECKPOINT_INCONSISTENT');
  });

  it('starts clean when the data file is missing under a valid checkpoint', async () => {
    const { storage, at } = await interruptedSession();
    const directory = storage.sessions().get(at.directoryName)!;
    // The checkpoint survives and the payload does not - a partial cleanup, or
    // a platform reclaiming a large file. The bitmap would otherwise mark
    // segments present in a file that is now full of nothing.
    directory.files.delete(OPFS_DATA_FILE);

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();
    expect(second.progress().unitsAdopted).toBe(0);

    for (const frame of at.allFrames()) second.submit(frame);
    const verified = await second.verify();
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(digestToHex(verified.value.sha256)).toBe(digestToHex(at.manifest.sha256));
  });

  it('starts clean when the data file was truncated under a valid checkpoint', async () => {
    const { storage, at } = await interruptedSession();
    const handle = await openDataFile(storage, at.directoryName);
    handle.truncate(1_024);
    handle.close();

    const second = pipelineOver(storage, { resume: true });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();
    expect(second.progress().unitsAdopted).toBe(0);
  });

  it('adopts nothing at all when resume was not asked for', async () => {
    const { storage, at } = await interruptedSession();
    // The data is there and the checkpoint matches. Adoption is still a
    // decision the caller makes, not something a directory causes.
    const second = pipelineOver(storage, { resume: false });
    second.submit(at.manifestFrame);
    await second.whenStorageReady();
    expect(second.progress().unitsAdopted).toBe(0);
    expect(second.progress().checkpointRejection).toBeUndefined();
  });
});

/* -------------------------------------------------------------- retention */

describe('what happens to working data depends on how the session ended', () => {
  it('maps each ending to the policy it implies', () => {
    expect(retentionFor(SESSION_END.INTERRUPTED)).toBe('retain');
    expect(retentionFor(SESSION_END.COMPLETED)).toBe('retain');
    expect(retentionFor(SESSION_END.CANCELLED)).toBe('discard');
    expect(retentionFor(SESSION_END.FAILED)).toBe('discard');
  });

  it('deletes the partial file when the user cancels', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveUntil(pipeline, at, 200);
    expect(storage.sessionNames()).toContain(at.directoryName);

    pipeline.reset(SESSION_END.CANCELLED);
    await pipeline.settled();
    // Leaving half a transfer behind after somebody pressed Cancel would be a
    // surprise, not a feature.
    expect(storage.sessionNames()).not.toContain(at.directoryName);
  });

  it('deletes the partial file when the transfer failed', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveUntil(pipeline, at, 200);
    pipeline.reset(SESSION_END.FAILED);
    await pipeline.settled();
    expect(storage.sessionNames()).not.toContain(at.directoryName);
  });

  it('keeps the partial file when the tab was backgrounded', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveUntil(pipeline, at, 200);
    pipeline.reset(SESSION_END.INTERRUPTED);
    await pipeline.settled();
    expect(storage.sessionNames()).toContain(at.directoryName);

    const checkpoint = await readCheckpoint((await sessionDirectory(storage, at.directoryName))!);
    expect(checkpoint?.segmentsCommitted).toBeGreaterThan(0);
    expect(checkpoint?.state).toBe('receiving');
  });

  it('discards by default when no reason is given', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveUntil(pipeline, at, 200);
    // A caller that ends a session without saying why gets the answer that
    // leaves nothing on the device.
    pipeline.reset();
    await pipeline.settled();
    expect(storage.sessionNames()).not.toContain(at.directoryName);
  });
});

/* -------------------------------------------------------------- the token */

describe('the resume token describes the session it came from', () => {
  it('names the lowest segment nothing has committed', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });

    // Deliver segments 0, 1 and 3 - a gap at 2, which is what a real camera
    // produces when a segment is lost and the sender has moved on.
    pipeline.submit(at.manifestFrame);
    await pipeline.whenStorageReady();
    for (const index of [0, 1, 3]) {
      for (const frame of at.segmentFrames(index)) pipeline.submit(frame);
    }

    const decoded = decodeTargetedResumeToken(pipeline.resumeToken()!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // 2, not 4. Restarting at 4 would skip a segment nothing holds; restarting
    // at 2 replays segment 3 for free.
    expect(decoded.value.resumeFromSegment).toBe(2);
    expect(decoded.value.sessionId).toBe(at.manifest.sessionId);
    expect(decoded.value.fileId).toBe(at.manifest.fileId);
    expect(decoded.value.segmentCount).toBe(at.plan.segmentCount);
    expect([...decoded.value.digestPrefix]).toEqual([...at.manifest.sha256.subarray(0, 5)]);

    // And since Phase 13 it does better than name a restart point. Segments 0,
    // 1 and 3 arrived, so the gaps are 2 and everything from 4 on - two runs,
    // which v1 could only describe as "restart at 2 and resend the rest".
    expect(decoded.value.missing).toEqual([{ start: 2, length: 1 }, { start: 4, length: 2 }]);
    // Segment 3 is not in the list, so the sender will not spend time on it.
    expect(resumeTokenTargets(decoded.value)).toEqual([2, 4, 5]);
  });

  it('stays a forty-character v1 code when the gaps are just a tail', async () => {
    // The interruption case, which is what v1 was written for: a receiver that
    // stopped has one run of missing segments reaching the end of the file, and
    // "restart from the lowest" describes it exactly. Spending sixty-four
    // characters to say the same thing would make every ordinary resume harder
    // to read aloud for no gain.
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });

    pipeline.submit(at.manifestFrame);
    await pipeline.whenStorageReady();
    for (const frame of at.segmentFrames(0)) pipeline.submit(frame);

    const token = pipeline.resumeToken()!;
    expect(token.replace(/-/g, '').length).toBe(RESUME_TOKEN_CHARS);
    const decoded = decodeTargetedResumeToken(token);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.missing).toBeUndefined();
    expect(decoded.value.resumeFromSegment).toBe(1);
  });

  it('says the segment count when nothing is missing', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture({ segments: 2 });
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveUntil(pipeline, at, Number.MAX_SAFE_INTEGER);

    const decoded = decodeResumeToken(pipeline.resumeToken()!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.resumeFromSegment).toBe(at.plan.segmentCount);
  });

  it('is absent before there is a session to describe', async () => {
    const { storage } = fakeEnvironment();
    const pipeline = pipelineOver(storage, { resume: true });
    expect(pipeline.resumeToken()).toBeUndefined();
    expect(pipeline.progress().resumeToken).toBeUndefined();
  });

  it('is carried on progress, so a screen can show it after a fault', async () => {
    const { storage } = fakeEnvironment();
    const at = await fixture();
    const pipeline = pipelineOver(storage, { resume: true });
    await receiveUntil(pipeline, at, 200);
    expect(pipeline.progress().resumeToken).toBe(pipeline.resumeToken());
  });
});
