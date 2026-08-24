/**
 * Everything the receive screen computes, with no React and no DOM.
 *
 * The receiver already had one authoritative state machine; what it did not
 * have was anywhere to put the *facts about the transfer*. Phases 06 through 08
 * plumbed all of them to the component's doorstep - two sizes, a compression
 * mode, an adopted segment count, a resume token, a storage decision, a
 * verification that runs in two passes - and the screen showed a percentage and
 * a filename. Every derivation that turns those into something a person can act
 * on lives here, so it can be tested without a DOM and so the component stays a
 * function of its state.
 *
 * Two rules run through the whole file:
 *
 * - **A number is shown only when it was measured.** The storage summary is
 *   absent until a preflight has run, and it says out loud when the browser
 *   could not answer, because "we do not know how much room you have" and "you
 *   have room" are different things to tell someone about a 4 GiB transfer.
 * - **Nothing here can express success.** Verification is the worker's, and the
 *   only thing that turns into a verified file on screen is a `VerifiedTransfer`
 *   the worker produced after a hash comparison.
 */

import { V2_COMPRESSION } from '../../src/core/protocol-v2';
import { RECEIVER_POLICY } from '../../src/core/receiver-policy';
import { RECEIVER_STATE, type ReceiverFault, type ReceiverState } from './receiver-state';
import type { ReceiveProgress } from './worker-protocol';

/* ---------------------------------------------------------------- numbers */

const BYTE_UNITS = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/**
 * Binary units, matching the desktop's `formatBytes`.
 *
 * `number` rather than `bigint` here because every size on this side has
 * already been through `toSafeNumber` in the pipeline - the receiver refuses a
 * manifest it could not represent long before a screen sees one.
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 bytes';
  if (value < 1024) return `${Math.round(value)} ${Math.round(value) === 1 ? 'byte' : 'bytes'}`;
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${BYTE_UNITS[unit]}`;
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  const percent = Math.min(100, fraction * 100);
  // A decimal below one percent, so a multi-gigabyte transfer is not stuck
  // reading zero for its first several minutes.
  return percent < 1 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/* ------------------------------------------------------- transfer summary */

export interface TransferSummary {
  filename: string;
  /** What the file will weigh once it is written. */
  originalBytes: number;
  /** What has to arrive over the camera. Equal to the above when uncompressed. */
  transportBytes: number;
  compressed: boolean;
  /** Present only when compressed: the transport share of the original. */
  compressionText: string | null;
  segmentsRecovered: number;
  segmentsTotal: number;
  /** Segments adopted from a checkpoint before this run started. */
  segmentsAdopted: number;
  resumed: boolean;
  fraction: number;
}

/**
 * What is known about the transfer once its manifest has arrived.
 *
 * Null before then, which is a real state and not a loading placeholder: until
 * a manifest decodes, the receiver genuinely does not know the file's name, its
 * size, or how many segments it is in.
 */
export function summarizeTransfer(progress: ReceiveProgress): TransferSummary | null {
  if (!progress.sessionActive || !progress.unitsTotal) return null;
  const compressed = progress.compressionMode === V2_COMPRESSION.GZIP;
  return {
    filename: progress.filename ?? 'Unnamed file',
    originalBytes: progress.originalBytes,
    transportBytes: progress.transportBytes,
    compressed,
    compressionText: compressed && progress.originalBytes > 0
      ? formatPercent(progress.transportBytes / progress.originalBytes)
      : null,
    segmentsRecovered: progress.unitsRecovered,
    segmentsTotal: progress.unitsTotal,
    segmentsAdopted: progress.unitsAdopted,
    resumed: progress.resumed,
    fraction: progress.unitsTotal > 0 ? progress.unitsRecovered / progress.unitsTotal : 0,
  };
}

/**
 * The line under the segment counter.
 *
 * Says which of the two sizes is being talked about, because under compression
 * they differ by a factor of four and a single number would make a healthy
 * transfer look like it had lost most of the file.
 */
export function transferSizeLine(summary: TransferSummary): string {
  if (!summary.compressed) return formatBytes(summary.originalBytes);
  return `${formatBytes(summary.originalBytes)} · ${formatBytes(summary.transportBytes)} over the camera`;
}

/**
 * How a resumed session explains a progress bar that opens most of the way in.
 *
 * Without this a receiver that adopted 900 of 1000 segments looks like one that
 * skipped them.
 */
export function resumeLine(summary: TransferSummary): string | null {
  if (!summary.resumed || summary.segmentsAdopted <= 0) return null;
  return `Resuming: ${summary.segmentsAdopted.toLocaleString()} of ${summary.segmentsTotal.toLocaleString()} segments were already on this device.`;
}

/* --------------------------------------------------------- storage summary */

export interface StorageSummary {
  /** Room this transfer was decided to need, margin included. */
  requiredBytes: number;
  /** Room the browser reported. Meaningless unless `measured` is true. */
  availableBytes: number;
  /** True when the browser answered at all. */
  measured: boolean;
  /** True when what it answered is enough. Always true when not measured. */
  sufficient: boolean;
  headline: string;
  detail: string;
}

/**
 * The storage preflight, turned into two sentences.
 *
 * Null until a preflight has run, so the screen shows nothing rather than
 * zeroes. The `unknown` branch is the interesting one: a browser with no
 * estimate API is not a refusal - the transfer is allowed to start and the
 * write path handles a real exhaustion cleanly - but a screen that said
 * "enough room" on that evidence would be inventing a measurement.
 */
export function summarizeStorage(progress: ReceiveProgress): StorageSummary | null {
  if (progress.storageConfidence === 'none') return null;
  const measured = progress.storageConfidence === 'reported';
  const requiredBytes = progress.storageRequiredBytes;
  const availableBytes = progress.storageAvailableBytes;
  const sufficient = !measured || availableBytes >= requiredBytes;

  if (!measured) {
    return {
      requiredBytes,
      availableBytes,
      measured,
      sufficient,
      headline: `Needs about ${formatBytes(requiredBytes)}`,
      // Said plainly, because the alternative is a reassurance nobody checked.
      detail: 'This browser will not report how much room is left, so the transfer starts without that check. It stops safely if the device runs out.',
    };
  }

  if (!sufficient) {
    return {
      requiredBytes,
      availableBytes,
      measured,
      sufficient,
      headline: `Needs ${formatBytes(requiredBytes)}, ${formatBytes(availableBytes)} available`,
      detail: 'Free up space on this device, then start the transfer again. Nothing has been written.',
    };
  }

  return {
    requiredBytes,
    availableBytes,
    measured,
    sufficient,
    headline: `${formatBytes(requiredBytes)} needed · ${formatBytes(availableBytes)} available`,
    // Named as what it is. A browser quota is not the device's free space and
    // can shrink while a transfer runs, which is why the margin exists.
    detail: 'Reported by the browser as space this site may use. It is not a reading of the device’s free space.',
  };
}

/* ---------------------------------------------------------- verification */

export interface VerifyView {
  /** `decompressing` expands the transport container; `hashing` checks the file. */
  phase: 'decompressing' | 'hashing';
  bytesHashed: number;
  bytesTotal: number;
  fraction: number;
  /** Which of the passes this is, and how many there are. */
  step: number;
  steps: number;
  headline: string;
  detail: string;
}

/**
 * The verifying screen, which is deliberately its own screen.
 *
 * A gigabyte takes about nine seconds to hash and a compressed gigabyte is
 * expanded first. Showing the transfer's own progress bar - frozen at 100% -
 * for that whole time is how the receiver came to look hung at the exact moment
 * it was doing the work the entire product exists for.
 *
 * Two passes are reported as two steps rather than as one merged bar, because
 * they measure different totals: the expansion walks the container and the hash
 * walks the file, and merging them would make the bar jump backwards.
 */
export function describeVerification(
  progress: { phase: 'decompressing' | 'hashing'; bytesHashed: number; bytesTotal: number } | undefined,
  compressed: boolean,
): VerifyView | null {
  if (!progress) return null;
  const steps = compressed ? 2 : 1;
  const step = compressed && progress.phase === 'decompressing' ? 1 : steps;
  const fraction = progress.bytesTotal > 0
    ? Math.min(1, progress.bytesHashed / progress.bytesTotal)
    : 0;

  return {
    phase: progress.phase,
    bytesHashed: progress.bytesHashed,
    bytesTotal: progress.bytesTotal,
    fraction,
    step,
    steps,
    headline: progress.phase === 'decompressing' ? 'Expanding the transfer' : 'Checking the file’s hash',
    detail: progress.phase === 'decompressing'
      ? 'The optical stream was compressed. It is being expanded back to the original file before its hash is checked.'
      : 'Comparing this device’s SHA-256 of the reconstructed file against the sender’s. Nothing is offered to save until they match.',
  };
}

/* ------------------------------------------------------------ interruption */

export interface InterruptionSummary {
  segmentsRetained: number;
  segmentsTotal: number;
  bytesRetained: number;
  /** The forty characters to carry back to the desktop. Grouped for reading. */
  resumeToken: string | null;
  fraction: number;
}

/**
 * What survived an interruption, and how to continue from it.
 *
 * The receiver keeps a backgrounded transfer's bytes on the device - that is
 * the one ending of Phase 07's four that does not delete - and mints a resume
 * token for any live v2 session. Neither fact reached a screen before this
 * phase, so the retained data existed and could not be used.
 */
export function summarizeInterruption(progress: ReceiveProgress): InterruptionSummary | null {
  if (progress.protocol !== 2 || progress.unitsRecovered <= 0) return null;
  return {
    segmentsRetained: progress.unitsRecovered,
    segmentsTotal: progress.unitsTotal,
    bytesRetained: progress.bytesCommitted,
    resumeToken: progress.resumeToken ?? null,
    fraction: progress.unitsTotal > 0 ? progress.unitsRecovered / progress.unitsTotal : 0,
  };
}

/**
 * Why data on the device was not picked up, when a resume was attempted.
 *
 * Not a fault - the transfer proceeds from zero and will succeed - but the
 * difference between "there was nothing to resume" and "what was there belonged
 * to a different file" is the difference between waiting patiently and
 * wondering where the progress went. `CHECKPOINT_ABSENT` returns null on
 * purpose: it is the ordinary first-run answer and deserves no message at all.
 */
export function checkpointRejectionCopy(code: string | undefined): string | null {
  switch (code) {
    case undefined:
    case 'CHECKPOINT_ABSENT':
      return null;
    case 'CHECKPOINT_UNREADABLE':
      return 'Partly received data was found on this device but could not be read, so this transfer starts from the beginning.';
    case 'CHECKPOINT_SESSION_MISMATCH':
      return 'The data already on this device belongs to a different transfer, so this one starts from the beginning.';
    case 'CHECKPOINT_FILE_MISMATCH':
      return 'A transfer with this name was already partly received, but the file’s contents differ. This one starts from the beginning.';
    case 'CHECKPOINT_PLAN_MISMATCH':
      return 'The earlier attempt used a different transport profile, so its data cannot be reused. This transfer starts from the beginning.';
    case 'CHECKPOINT_INCONSISTENT':
      return 'The record of what was already received did not add up, so it was discarded. This transfer starts from the beginning.';
    default:
      return 'Data already on this device was not reused, so this transfer starts from the beginning.';
  }
}

/** Groups a resume token into fives, matching the sender's entry field. */
export function groupResumeToken(token: string): string {
  const clean = token.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const groups: string[] = [];
  for (let at = 0; at < clean.length; at += 5) groups.push(clean.slice(at, at + 5));
  return groups.join('-');
}

/* ------------------------------------------------------------------ faults */

export interface FaultCopy {
  heading: string;
  message: string;
  /** What to do next, when there is something. */
  action: string | null;
  /** True when the remedy is on the *sending* device rather than this one. */
  senderSide: boolean;
}

/** Codes that mean the device had nowhere to put this, not that the data was bad. */
export const STORAGE_FAULT_CODES: ReadonlySet<string> = new Set([
  'STORAGE_FULL',
  'INSUFFICIENT_STORAGE',
  'STORAGE_UNAVAILABLE',
  'STORAGE_OPEN_FAILED',
  'STORAGE_WRITE_FAILED',
  'STORAGE_READ_FAILED',
]);

/** The subset a user can act on by freeing space. */
export const CAPACITY_FAULT_CODES: ReadonlySet<string> = new Set([
  'STORAGE_FULL',
  'INSUFFICIENT_STORAGE',
]);

/**
 * Codes meaning the manifest asked for more than this receiver's own budgets.
 *
 * Deliberately not storage faults, even though they sound like capacity: they
 * are decided from the manifest before a device is touched, freeing space
 * would not change the answer, and the remedy is on the sending side. Mirrors
 * `ManifestPolicyRefusal` in `src/core/receiver-policy.ts`.
 */
export const MANIFEST_POLICY_FAULT_CODES: ReadonlySet<string> = new Set([
  'SEGMENT_COUNT_EXCEEDED',
  'TRANSFER_TOO_LARGE',
  'SEGMENT_TOO_LARGE',
]);

export function isStorageFault(code: string | undefined): boolean {
  return code !== undefined && STORAGE_FAULT_CODES.has(code);
}

/**
 * Whether the transfer has gone silent long enough to be called stalled.
 *
 * Pure, and takes its clock, because the behaviour it decides is the one the
 * physical failure turned on: a receiver that could not tell "still arriving"
 * from "stopped" showed `Receiving transfer` with a live camera until the user
 * gave up. Everything about that judgement is here, in a function a test can
 * drive without waiting twelve seconds.
 *
 * Three rules, in order:
 *
 * - **No session, no stall.** A camera pointed at nothing is `SCANNING`, and
 *   reporting that as a stalled transfer would be a fault where there is not
 *   even a transfer.
 * - **A session that has never received a unique frame cannot stall**, because
 *   the manifest arriving *is* the first unique frame. Before it there is
 *   nothing to be silent about.
 * - **A complete session cannot stall**, however long verification takes.
 */
/**
 * What the optical link is actually delivering, in bytes per second.
 *
 * The number the programme's own rule says to optimise for — "verified original
 * bytes per wall-clock second", never configured FPS. The two come apart badly
 * and in the direction that flatters: raising the frame rate raises frames per
 * second while a camera that can no longer resolve the symbol delivers *fewer*
 * useful bytes. A 20 FPS profile that beats 60 has to be visible as such, and
 * it is only visible in this unit.
 *
 * Measured from bytes the receiver has actually committed to storage, not from
 * frames multiplied by a payload size. Committed bytes have survived the CRC,
 * the fountain algebra and the write; frames counted at the decoder have
 * survived none of those, and the gap between the two is the whole difference
 * between nominal and useful.
 *
 * `originalBytesPerSecond` is what a person experiences — their file arriving —
 * and differs from the transport rate whenever the sender compressed. Both are
 * reported because optimising the wrong one is how a compressible fixture makes
 * a profile look faster than it is.
 */
export function usefulThroughput(input: {
  bytesCommitted: number;
  transportBytes: number;
  originalBytes: number;
  elapsedMs: number;
}): { transportBytesPerSecond: number; originalBytesPerSecond: number } {
  const seconds = input.elapsedMs / 1_000;
  if (!(seconds > 0) || !(input.bytesCommitted > 0)) {
    return { transportBytesPerSecond: 0, originalBytesPerSecond: 0 };
  }
  const transportBytesPerSecond = input.bytesCommitted / seconds;
  // Compression means each transported byte carries more than one original
  // byte. With no compression the ratio is 1 and the two rates are equal.
  const ratio = input.transportBytes > 0 && input.originalBytes > 0
    ? input.originalBytes / input.transportBytes
    : 1;
  return { transportBytesPerSecond, originalBytesPerSecond: transportBytesPerSecond * ratio };
}

export function transferHasStalled(input: {
  sessionActive: boolean;
  complete: boolean;
  lastUniqueFrameAtMs: number;
  nowMs: number;
  thresholdMs?: number;
}): boolean {
  const threshold = input.thresholdMs ?? RECEIVER_POLICY.stallAfterSilentMs;
  if (!input.sessionActive || input.complete) return false;
  if (input.lastUniqueFrameAtMs <= 0) return false;
  return input.nowMs - input.lastUniqueFrameAtMs >= threshold;
}

export function isCapacityFault(code: string | undefined): boolean {
  return code !== undefined && CAPACITY_FAULT_CODES.has(code);
}

/**
 * Every way the receiver can stop, in the words of the person it stopped for.
 *
 * The case this phase exists to add is `UNSUPPORTED_COMPRESSION`. A sender
 * decides to compress from the bytes it sampled and has no way to learn that
 * the receiving browser cannot expand what it sent - there is no back channel,
 * and there will not be one, because the optical link is one-way by
 * construction. The only thing that can close that loop is a sentence on this
 * screen telling the user what to ask the desktop for, so that sentence is not
 * a nicety: it is the entire remedy.
 */
export function faultCopy(fault: ReceiverFault | undefined): FaultCopy {
  if (!fault) {
    return {
      heading: 'Transfer not verified',
      message: 'This transfer could not be completed. No file was saved.',
      action: null,
      senderSide: false,
    };
  }

  if (fault.code === 'UNSUPPORTED_COMPRESSION') {
    return {
      heading: 'This browser cannot expand the transfer',
      message: 'The sending device compressed this file, and this browser cannot decompress it safely. Nothing was saved.',
      // The instruction is for the other device, and the screen has to say so
      // explicitly, because nothing else can.
      action: 'On the sending device, turn compression off for this file and send it again. It will take longer but will arrive.',
      senderSide: true,
    };
  }

  if (fault.code === 'ENCRYPTED_CONTAINER') {
    return {
      heading: 'Encrypted transfer',
      message: 'This transfer is encrypted, and this receiver does not hold a key for it. Nothing was saved.',
      action: null,
      senderSide: true,
    };
  }

  if (fault.code === 'FILE_TYPE_BLOCKED') {
    return {
      heading: 'File type refused',
      message: 'This receiver refuses this kind of file. Nothing was saved.',
      action: null,
      senderSide: true,
    };
  }

  if (MANIFEST_POLICY_FAULT_CODES.has(fault.code ?? '')) {
    // Refused at the manifest, before the camera was asked for anything, so
    // there is no partial transfer and no resume code to offer. The remedy is
    // on the sending device and the screen has to say so - a receiver that
    // said only "not verified" would send someone to re-scan a transfer it
    // will refuse identically every time.
    return {
      heading: 'Transfer too large for this receiver',
      message: 'The sending device described a transfer beyond what this receiver will accept. Nothing was scanned and nothing was saved.',
      action: 'On the sending device, send a smaller file or choose a different transport profile.',
      senderSide: true,
    };
  }

  switch (fault.kind) {
    case 'camera':
      return {
        heading: 'Camera unavailable',
        message: 'Camera access did not start. Check the iPhone permission, then try again.',
        action: 'Open Settings, find this app or Safari, and allow camera access.',
        senderSide: false,
      };
    case 'scanner':
      return {
        heading: 'Scanner unavailable',
        message: 'The QR scanner could not start on this device. Reload the app, then try again.',
        action: 'Close the app fully and open it again.',
        senderSide: false,
      };
    case 'storage':
      return isCapacityFault(fault.code)
        ? {
          heading: 'Not enough room',
          message: 'This device ran out of room for the transfer. No file was saved.',
          action: 'Free up space on this device, then start the transfer again.',
          senderSide: false,
        }
        : {
          // Deliberately different from the case above: freeing space will not
          // help here, and sending someone to delete photos for a problem that
          // is not about space is worse than saying nothing.
          heading: 'Storage unavailable',
          message: 'This device could not store the transfer. No file was saved.',
          action: null,
          senderSide: false,
        };
    default:
      return {
        heading: 'Transfer not verified',
        message: 'This transfer could not be verified. No file was saved.',
        action: 'Ask the sending device to send it again. If it kept part of the file, this screen shows a resume code.',
        senderSide: true,
      };
  }
}

/* -------------------------------------------------------------- statuses */

/**
 * Whether a state is allowed to show the file as being on this device.
 *
 * One predicate, used by the export control and by nothing else, so that
 * "offer a save" and "the hash matched" cannot come apart. `EXPORTING` is
 * included because it is reached only from `COMPLETE`.
 */
export function mayOfferExport(state: ReceiverState): boolean {
  return state === RECEIVER_STATE.COMPLETE || state === RECEIVER_STATE.EXPORTING;
}

/**
 * Whether a resume code should be offered.
 *
 * The rule is "this state still holds its bytes", not any particular state
 * name. A cancelled or failed session deleted them, and offering a resume for
 * data that is gone would be a worse lie than offering nothing.
 *
 * `INTERRUPTED` was the only such state until Phase 13. `INCOMPLETE` and
 * `RECOVERING` were added precisely *because* they keep their bytes, and they
 * are where a code is most useful of all: a stalled receiver is looking at a
 * transfer that can still finish, and the code is the only thing that can tell
 * the sending device which segments to send again. Leaving it out of the one
 * screen that exists to ask for recovery frames would have made the new states
 * decorative.
 */
export function mayOfferResume(state: ReceiverState): boolean {
  return state === RECEIVER_STATE.INTERRUPTED
    || state === RECEIVER_STATE.INCOMPLETE
    || state === RECEIVER_STATE.RECOVERING;
}
