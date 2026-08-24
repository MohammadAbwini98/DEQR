import { describe, expect, it } from 'vitest';
import { V2_COMPRESSION } from '../../src/core/protocol-v2';
import {
  RECEIVER_STATE,
  sessionIsCleared,
  type ReceiverFault,
  type ReceiverState,
} from '../src/receiver-state';
import { RECEIVER_POLICY } from '../../src/core/receiver-policy';
import {
  checkpointRejectionCopy,
  describeVerification,
  faultCopy,
  formatBytes,
  formatPercent,
  groupResumeToken,
  isCapacityFault,
  isStorageFault,
  mayOfferExport,
  mayOfferResume,
  resumeLine,
  summarizeInterruption,
  summarizeStorage,
  summarizeTransfer,
  transferHasStalled,
  transferSizeLine,
  usefulThroughput,
} from '../src/receiver-view-model';
import { emptyProgress, type ReceiveProgress } from '../src/worker-protocol';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const ALL_STATES = Object.values(RECEIVER_STATE) as ReceiverState[];

function progress(overrides: Partial<ReceiveProgress> = {}): ReceiveProgress {
  return {
    ...emptyProgress(),
    protocol: 2,
    sessionActive: true,
    filename: 'archive.tar',
    unitsRecovered: 0,
    unitsTotal: 1024,
    originalBytes: 4 * GIB,
    transportBytes: 4 * GIB,
    ...overrides,
  };
}

describe('receiver formatting', () => {
  it('uses binary units up to the sizes a large transfer reaches', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1024)).toBe('1.00 KiB');
    expect(formatBytes(2 * MIB)).toBe('2.00 MiB');
    expect(formatBytes(4 * GIB)).toBe('4.00 GiB');
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(Number.NaN)).toBe('0 bytes');
  });

  it('keeps a decimal below one percent so a huge transfer is not stuck at zero', () => {
    expect(formatPercent(0.0004)).toBe('0.0%');
    expect(formatPercent(0.004)).toBe('0.4%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(1.9)).toBe('100%');
  });
});

describe('transfer summary', () => {
  it('reports nothing until a manifest has decoded', () => {
    expect(summarizeTransfer(emptyProgress())).toBeNull();
    // A session that is active with no unit count is a manifest that has not
    // landed; there is genuinely nothing to say about the file yet.
    expect(summarizeTransfer(progress({ unitsTotal: 0 }))).toBeNull();
  });

  it('keeps the two sizes apart when they differ', () => {
    const summary = summarizeTransfer(progress({
      compressionMode: V2_COMPRESSION.GZIP,
      originalBytes: 4 * GIB,
      transportBytes: GIB,
    }))!;
    expect(summary.compressed).toBe(true);
    expect(summary.compressionText).toBe('25%');
    const line = transferSizeLine(summary);
    expect(line).toContain('4.00 GiB');
    expect(line).toContain('1.00 GiB');
    expect(line).toContain('over the camera');
  });

  it('shows one size when there is only one', () => {
    const summary = summarizeTransfer(progress())!;
    expect(summary.compressed).toBe(false);
    expect(summary.compressionText).toBeNull();
    expect(transferSizeLine(summary)).toBe('4.00 GiB');
    expect(transferSizeLine(summary)).not.toContain('over the camera');
  });

  it('explains a progress bar that opens most of the way in', () => {
    const summary = summarizeTransfer(progress({
      unitsRecovered: 900,
      unitsAdopted: 900,
      resumed: true,
    }))!;
    expect(summary.fraction).toBeCloseTo(900 / 1024, 5);
    const line = resumeLine(summary)!;
    // Without this, a resume is indistinguishable on screen from a transfer
    // that skipped most of the file.
    expect(line).toContain('900');
    expect(line).toContain('already on this device');
  });

  it('says nothing about resuming when nothing was adopted', () => {
    expect(resumeLine(summarizeTransfer(progress({ unitsRecovered: 12 }))!)).toBeNull();
    // `resumed` without an adopted count is a contradiction the pipeline cannot
    // produce, and this must not invent a sentence for it either.
    expect(resumeLine(summarizeTransfer(progress({ resumed: true, unitsAdopted: 0 }))!)).toBeNull();
  });
});

describe('storage summary', () => {
  it('says nothing before a preflight has run', () => {
    expect(summarizeStorage(progress())).toBeNull();
    expect(summarizeStorage(emptyProgress())).toBeNull();
  });

  it('reports both figures when the browser answered', () => {
    const summary = summarizeStorage(progress({
      storageConfidence: 'reported',
      storageRequiredBytes: 5 * GIB,
      storageAvailableBytes: 20 * GIB,
    }))!;
    expect(summary.measured).toBe(true);
    expect(summary.sufficient).toBe(true);
    expect(summary.headline).toContain('5.00 GiB');
    // One decimal above ten, two below: the precision follows the magnitude so
    // a headline stays the same width as the numbers move.
    expect(summary.headline).toContain('20.0 GiB');
    // Never calls a browser-granted quota "free space".
    expect(summary.detail).toContain('space this site may use');
    expect(summary.detail).toMatch(/not a reading of the device/);
  });

  it('does not turn a missing estimate into a reassurance', () => {
    const summary = summarizeStorage(progress({
      storageConfidence: 'unknown',
      storageRequiredBytes: 5 * GIB,
    }))!;
    expect(summary.measured).toBe(false);
    // The transfer is still allowed to start - refusing every transfer on a
    // browser that cannot answer would be worse - but the screen must not
    // claim a check that did not happen.
    expect(summary.sufficient).toBe(true);
    expect(summary.detail).toContain('will not report how much room is left');
    expect(summary.headline).not.toContain('available');
  });

  it('tells someone what to do when there is not enough room', () => {
    const summary = summarizeStorage(progress({
      storageConfidence: 'reported',
      storageRequiredBytes: 8 * GIB,
      storageAvailableBytes: 1 * GIB,
    }))!;
    expect(summary.sufficient).toBe(false);
    expect(summary.headline).toContain('8.00 GiB');
    expect(summary.headline).toContain('1.00 GiB');
    expect(summary.detail).toContain('Free up space');
    // And confirms nothing was written, so the remedy is only about space.
    expect(summary.detail).toContain('Nothing has been written');
  });
});

describe('verification view', () => {
  it('reports nothing before the first verify event', () => {
    expect(describeVerification(undefined, false)).toBeNull();
  });

  it('is one step for an uncompressed transfer', () => {
    const view = describeVerification({ phase: 'hashing', bytesHashed: GIB / 2, bytesTotal: GIB }, false)!;
    expect(view.steps).toBe(1);
    expect(view.step).toBe(1);
    expect(view.fraction).toBeCloseTo(0.5, 5);
    expect(view.headline).toContain('hash');
  });

  it('is two steps for a compressed one, and names which is running', () => {
    const expanding = describeVerification({ phase: 'decompressing', bytesHashed: 0, bytesTotal: GIB }, true)!;
    expect(expanding.steps).toBe(2);
    expect(expanding.step).toBe(1);
    expect(expanding.headline).toContain('Expanding');

    const hashing = describeVerification({ phase: 'hashing', bytesHashed: GIB, bytesTotal: GIB }, true)!;
    expect(hashing.steps).toBe(2);
    expect(hashing.step).toBe(2);
    expect(hashing.fraction).toBe(1);
  });

  it('never claims a verified file, only a verification in progress', () => {
    for (const phase of ['decompressing', 'hashing'] as const) {
      const view = describeVerification({ phase, bytesHashed: 10, bytesTotal: 10 }, true)!;
      // A full bar is a finished pass, not a matched hash. Only the worker's
      // `verified` event may produce a file, and this view cannot express one.
      expect(view.headline).not.toMatch(/\bverified\b/i);
      expect(Object.keys(view)).not.toContain('verified');
    }
    expect(describeVerification({ phase: 'hashing', bytesHashed: 1, bytesTotal: 1 }, false)!.detail)
      .toContain('Nothing is offered to save until they match');
  });

  it('does not divide by a total it does not have', () => {
    const view = describeVerification({ phase: 'hashing', bytesHashed: 5, bytesTotal: 0 }, false)!;
    expect(view.fraction).toBe(0);
  });
});

describe('interruption summary', () => {
  it('reports what was kept, with the code to continue from it', () => {
    const summary = summarizeInterruption(progress({
      unitsRecovered: 700,
      bytesCommitted: 2 * GIB,
      resumeToken: 'ABCDE12345FGHJK67890MNPQR12345STVWX67890',
    }))!;
    expect(summary.segmentsRetained).toBe(700);
    expect(summary.segmentsTotal).toBe(1024);
    expect(summary.bytesRetained).toBe(2 * GIB);
    expect(summary.resumeToken).toHaveLength(40);
  });

  it('offers nothing when nothing survived', () => {
    expect(summarizeInterruption(progress({ unitsRecovered: 0 }))).toBeNull();
    // v1 has no segment store and no resume; an interrupted v1 session left
    // nothing on the device to continue from.
    expect(summarizeInterruption(progress({ protocol: 1, unitsRecovered: 40 }))).toBeNull();
  });

  it('groups the code the same way the sender field does', () => {
    const grouped = groupResumeToken('ABCDE12345FGHJK67890MNPQR12345STVWX67890');
    expect(grouped).toBe('ABCDE-12345-FGHJK-67890-MNPQR-12345-STVWX-67890');
    // Separators are display sugar on both sides; regrouping an already
    // grouped code has to be idempotent.
    expect(groupResumeToken(grouped)).toBe(grouped);
  });
});

describe('checkpoint rejections', () => {
  it('says nothing for the ordinary first-run answer', () => {
    expect(checkpointRejectionCopy(undefined)).toBeNull();
    expect(checkpointRejectionCopy('CHECKPOINT_ABSENT')).toBeNull();
  });

  it('gives every other rejection a distinct sentence', () => {
    const codes = [
      'CHECKPOINT_UNREADABLE',
      'CHECKPOINT_SESSION_MISMATCH',
      'CHECKPOINT_FILE_MISMATCH',
      'CHECKPOINT_PLAN_MISMATCH',
      'CHECKPOINT_INCONSISTENT',
    ];
    const sentences = codes.map((code) => checkpointRejectionCopy(code));
    for (const [index, sentence] of sentences.entries()) {
      expect(sentence, codes[index]).not.toBeNull();
      // A code is the right thing to log and the wrong thing to read.
      expect(sentence, codes[index]).not.toContain('CHECKPOINT');
    }
    expect(new Set(sentences).size).toBe(codes.length);
  });

  it('still explains an unknown code rather than going silent', () => {
    expect(checkpointRejectionCopy('CHECKPOINT_FROM_THE_FUTURE')).toContain('starts from the beginning');
  });
});

describe('fault copy', () => {
  /*
   * The refusal this phase exists to close.
   *
   * A sender decides to compress from bytes it sampled and cannot learn that
   * the receiving browser has no `DecompressionStream`. The optical link is
   * one-way, so no automatic path exists; the sentence on this screen is the
   * entire remedy.
   */
  it('tells a user what to ask the desktop for when it cannot decompress', () => {
    const copy = faultCopy({ kind: 'transfer', code: 'UNSUPPORTED_COMPRESSION' });
    expect(copy.senderSide).toBe(true);
    expect(copy.action).not.toBeNull();
    expect(copy.action).toContain('turn compression off');
    expect(copy.action).toContain('send it again');
    expect(copy.message).toContain('Nothing was saved');
    // And does not blame the file or the camera.
    expect(copy.heading).not.toMatch(/camera/i);
    expect(copy.heading).not.toMatch(/not verified/i);
  });

  it('separates a full device from one that cannot store at all', () => {
    const full = faultCopy({ kind: 'storage', code: 'STORAGE_FULL' });
    const broken = faultCopy({ kind: 'storage', code: 'STORAGE_WRITE_FAILED' });
    expect(full.heading).toBe('Not enough room');
    expect(full.action).toContain('Free up space');
    expect(broken.heading).toBe('Storage unavailable');
    // Sending someone to delete photos for a problem that is not about space
    // is worse than saying nothing.
    expect(broken.action).toBeNull();
  });

  it('keeps the camera, the scanner and the transfer apart', () => {
    expect(faultCopy({ kind: 'camera', code: 'CAMERA_DENIED' }).heading).toBe('Camera unavailable');
    expect(faultCopy({ kind: 'scanner', code: 'WORKER_DEAD' }).heading).toBe('Scanner unavailable');
    expect(faultCopy({ kind: 'transfer', code: 'HASH_MISMATCH' }).heading).toBe('Transfer not verified');
    // A camera fault is fixed here; a transfer fault is not.
    expect(faultCopy({ kind: 'camera', code: 'CAMERA_DENIED' }).senderSide).toBe(false);
    expect(faultCopy({ kind: 'transfer', code: 'HASH_MISMATCH' }).senderSide).toBe(true);
  });

  it('names the two other sender-side refusals', () => {
    expect(faultCopy({ kind: 'transfer', code: 'ENCRYPTED_CONTAINER' }).senderSide).toBe(true);
    expect(faultCopy({ kind: 'transfer', code: 'FILE_TYPE_BLOCKED' }).senderSide).toBe(true);
  });

  it('never says a file was saved on any failure path', () => {
    const codes = ['UNSUPPORTED_COMPRESSION', 'ENCRYPTED_CONTAINER', 'FILE_TYPE_BLOCKED', 'HASH_MISMATCH', 'STORAGE_FULL'];
    const kinds: ReceiverFault['kind'][] = ['transfer', 'storage', 'camera', 'scanner'];
    for (const code of codes) {
      for (const kind of kinds) {
        const copy = faultCopy({ kind, code });
        expect(copy.message, `${kind}/${code}`).not.toMatch(/\bsaved\b(?!\.)/);
        expect(copy.heading.length, `${kind}/${code}`).toBeGreaterThan(0);
      }
    }
    expect(faultCopy(undefined).message).toContain('No file was saved');
  });

  it('classifies storage codes the same way the App does', () => {
    expect(isStorageFault('STORAGE_FULL')).toBe(true);
    expect(isStorageFault('HASH_MISMATCH')).toBe(false);
    expect(isStorageFault(undefined)).toBe(false);
    expect(isCapacityFault('INSUFFICIENT_STORAGE')).toBe(true);
    // Capacity is a strict subset: a broken writer is a storage fault that
    // freeing space will not fix.
    expect(isCapacityFault('STORAGE_WRITE_FAILED')).toBe(false);
  });
});

describe('what a state is allowed to offer', () => {
  /*
   * The receiver half of this phase's gate.
   *
   * Exactly one state has hashed the bytes, and only it - plus the export it
   * leads to - may put a save button on screen.
   */
  it('offers a save only after a hash comparison', () => {
    expect(ALL_STATES.filter(mayOfferExport).sort()).toEqual(['COMPLETE', 'EXPORTING']);
    for (const state of ALL_STATES) {
      if (state === RECEIVER_STATE.VERIFYING) expect(mayOfferExport(state)).toBe(false);
    }
  });

  it('offers a resume exactly where a stalled transfer still holds its bytes', () => {
    expect(ALL_STATES.filter(mayOfferResume).sort()).toEqual([
      RECEIVER_STATE.INCOMPLETE,
      RECEIVER_STATE.INTERRUPTED,
      RECEIVER_STATE.RECOVERING,
    ].sort());

    // `sessionIsCleared` is deliberately *not* the test here, and the
    // difference is worth stating because it is easy to conflate. It means the
    // in-memory session is gone - decoders, worker state - which `INTERRUPTED`
    // does on purpose as a privacy posture. It says nothing about the bytes on
    // disk, which is what a resume actually adopts through `checkpoint.json`.
    // So `INTERRUPTED` clears its session and still has data to resume, while
    // `INCOMPLETE` and `RECOVERING` keep both.
    expect(sessionIsCleared(RECEIVER_STATE.INTERRUPTED)).toBe(true);
    expect(sessionIsCleared(RECEIVER_STATE.INCOMPLETE)).toBe(false);

    // Cancelled and failed delete the stored data too, so a code for them would
    // be a worse lie than offering nothing.
    expect(mayOfferResume(RECEIVER_STATE.CANCELLED)).toBe(false);
    expect(mayOfferResume(RECEIVER_STATE.FAILED)).toBe(false);

    // Not while it is advancing: a code minted mid-flight is stale before it
    // can be read aloud, and the screen has progress to show instead.
    expect(mayOfferResume(RECEIVER_STATE.RECEIVING)).toBe(false);
    expect(mayOfferResume(RECEIVER_STATE.COMPLETE)).toBe(false);
  });
});

/**
 * The judgement the physical failure turned on.
 *
 * A receiver that cannot tell "frames are still arriving" from "the sender
 * stopped" has only one thing it can display, and it displayed it until the
 * user gave up. Every rule here is about not crying stall where there is no
 * transfer to stall.
 */
describe('a silent transfer is called stalled, and only then', () => {
  const THRESHOLD = 12_000;
  const base = { sessionActive: true, complete: false, thresholdMs: THRESHOLD };

  it('stalls once the silence reaches the threshold', () => {
    expect(transferHasStalled({ ...base, lastUniqueFrameAtMs: 1_000, nowMs: 1_000 + THRESHOLD })).toBe(true);
  });

  it('does not stall one millisecond early', () => {
    expect(transferHasStalled({ ...base, lastUniqueFrameAtMs: 1_000, nowMs: 1_000 + THRESHOLD - 1 })).toBe(false);
  });

  it('never stalls without a session', () => {
    // A camera pointed at nothing is SCANNING. Reporting a stalled transfer
    // where there is no transfer would send someone looking for a fault.
    expect(transferHasStalled({
      ...base, sessionActive: false, lastUniqueFrameAtMs: 1_000, nowMs: 1_000_000,
    })).toBe(false);
  });

  it('never stalls before the first unique frame', () => {
    // The manifest arriving *is* the first unique frame; before it there is
    // nothing to have gone quiet.
    expect(transferHasStalled({ ...base, lastUniqueFrameAtMs: 0, nowMs: 1_000_000 })).toBe(false);
  });

  it('never stalls a completed transfer, however long verification runs', () => {
    expect(transferHasStalled({
      ...base, complete: true, lastUniqueFrameAtMs: 1_000, nowMs: 1_000_000,
    })).toBe(false);
  });

  it('recovers the moment a unique frame lands', () => {
    const stalled = { ...base, lastUniqueFrameAtMs: 1_000, nowMs: 50_000 };
    expect(transferHasStalled(stalled)).toBe(true);
    expect(transferHasStalled({ ...stalled, lastUniqueFrameAtMs: 49_999 })).toBe(false);
  });

  it('defaults to the receiver policy when no threshold is given', () => {
    const justUnder = RECEIVER_POLICY.stallAfterSilentMs - 1;
    expect(transferHasStalled({ sessionActive: true, complete: false, lastUniqueFrameAtMs: 1, nowMs: 1 + justUnder })).toBe(false);
    expect(transferHasStalled({ sessionActive: true, complete: false, lastUniqueFrameAtMs: 1, nowMs: 1 + justUnder + 1 })).toBe(true);
  });
});

/**
 * The unit the programme says to optimise in.
 *
 * Configured FPS and useful throughput come apart in the direction that
 * flatters: raising the frame rate raises frames per second while a camera that
 * can no longer resolve the symbol delivers fewer bytes. Phase 13 has to be
 * able to see that, so it has to measure bytes.
 */
describe('throughput is measured in bytes that landed, not frames that arrived', () => {
  it('reports the transport rate from committed bytes', () => {
    const rate = usefulThroughput({
      bytesCommitted: 46_310, transportBytes: 100_000, originalBytes: 100_000, elapsedMs: 10_000,
    });
    expect(rate.transportBytesPerSecond).toBeCloseTo(4_631, 0);
    // No compression: the two rates are the same number.
    expect(rate.originalBytesPerSecond).toBeCloseTo(4_631, 0);
  });

  it('scales the user-visible rate by the compression the sender chose', () => {
    // 0.269 was Phase 08's measured ratio on real source: every transported
    // byte carries about 3.7 original ones, and a rate quoted in transport
    // bytes would understate the transfer by that factor.
    const rate = usefulThroughput({
      bytesCommitted: 10_000, transportBytes: 26_900, originalBytes: 100_000, elapsedMs: 1_000,
    });
    expect(rate.transportBytesPerSecond).toBeCloseTo(10_000, 0);
    expect(rate.originalBytesPerSecond).toBeCloseTo(37_175, 0);
  });

  it('reports nothing rather than infinity before anything has landed', () => {
    expect(usefulThroughput({ bytesCommitted: 0, transportBytes: 100, originalBytes: 100, elapsedMs: 5_000 }))
      .toEqual({ transportBytesPerSecond: 0, originalBytesPerSecond: 0 });
    expect(usefulThroughput({ bytesCommitted: 500, transportBytes: 100, originalBytes: 100, elapsedMs: 0 }))
      .toEqual({ transportBytesPerSecond: 0, originalBytesPerSecond: 0 });
  });
});
