/**
 * The one authoritative receiver state machine.
 *
 * Before this module the receive screen was driven by five things at once: a
 * `cameraState` string, a protocol snapshot with its own state, a
 * `startRequested` flag, a `cameraActive` ref, and a `receivingAnnounced` ref.
 * Any two of them could disagree, and the ones that did produced the receiver's
 * worst historical bugs - a preview that claimed an active camera after the
 * scan loop had died, and a shell that rendered a screen for a session that no
 * longer existed.
 *
 * So there is exactly one state here, the transition table is data, and
 * everything else the UI needs - whether the camera should be running, whether
 * cancel is meaningful, whether the screen is terminal - is *derived* from that
 * state rather than stored beside it. A derived value cannot contradict its
 * source.
 *
 * The state names follow the program plan's receiver list. Two deliberate
 * choices inside them:
 *
 * - `INTERRUPTED` is a real state rather than a silent cancel. Backgrounding
 *   still ends the session and clears its bytes, which is the receiver's
 *   standing privacy posture; making it a named state is what lets the return
 *   path be deterministic and asserted instead of inferred.
 * - There is no `PAUSED`. Resuming a partially received transfer needs the
 *   checkpoints Phase 07 defines, and a pause that silently discards progress
 *   would be a worse lie than not offering one.
 */

import {
  RECEIVER_PHASES,
  TRANSFER_PHASE,
  type TransferPhase,
} from '../../src/shared/transfer-ui-state';

export const RECEIVER_STATE = {
  /** Nothing running. Home, or after a reset. */
  IDLE: 'IDLE',
  /** The user asked to receive. Support checks run before the camera prompt. */
  PREFLIGHT: 'PREFLIGHT',
  /** `getUserMedia` is in flight, or the video has not presented a frame yet. */
  CAMERA_WARMING: 'CAMERA_WARMING',
  /** Camera live. Nothing has decoded into a session yet. */
  SCANNING: 'SCANNING',
  /** A session exists and frames are advancing it. */
  RECEIVING: 'RECEIVING',
  /** Backgrounded, or the camera track ended under us. Session cleared. */
  INTERRUPTED: 'INTERRUPTED',
  /** Every unit recovered; integrity work is running. */
  VERIFYING: 'VERIFYING',
  /** Verified and held for the user to save. */
  COMPLETE: 'COMPLETE',
  /** A save or share is in the user's hands. */
  EXPORTING: 'EXPORTING',
  /** The user stopped it. */
  CANCELLED: 'CANCELLED',
  /** The receiver refused or could not finish. `fault` says why. */
  FAILED: 'FAILED',
} as const;
export type ReceiverState = (typeof RECEIVER_STATE)[keyof typeof RECEIVER_STATE];

export const RECEIVER_EVENT = {
  RECEIVE_REQUESTED: 'RECEIVE_REQUESTED',
  /** Support checks passed; the camera prompt is about to be raised. */
  PREFLIGHT_PASSED: 'PREFLIGHT_PASSED',
  CAMERA_READY: 'CAMERA_READY',
  CAMERA_FAILED: 'CAMERA_FAILED',
  FRAME_ACCEPTED: 'FRAME_ACCEPTED',
  SESSION_COMPLETE: 'SESSION_COMPLETE',
  VERIFIED: 'VERIFIED',
  SESSION_FAILED: 'SESSION_FAILED',
  BACKGROUNDED: 'BACKGROUNDED',
  FOREGROUNDED: 'FOREGROUNDED',
  EXPORT_STARTED: 'EXPORT_STARTED',
  EXPORT_SETTLED: 'EXPORT_SETTLED',
  CANCELLED: 'CANCELLED',
  RESET: 'RESET',
  /** The decode worker died. Distinct from a camera fault on purpose. */
  WORKER_FATAL: 'WORKER_FATAL',
} as const;
export type ReceiverEventType = (typeof RECEIVER_EVENT)[keyof typeof RECEIVER_EVENT];

/**
 * Why the receiver stopped.
 *
 * `kind` separates the three causes a user can act on differently: a camera
 * fault sends them to permissions, a scanner fault sends them to a reload, and
 * a transfer fault means the sender's data did not verify and nothing they do
 * on this device fixes it.
 */
export interface ReceiverFault {
  kind: 'camera' | 'scanner' | 'transfer' | 'storage';
  code: string;
  message?: string;
}

export type ReceiverEvent =
  | { type: typeof RECEIVER_EVENT.CAMERA_FAILED; fault: ReceiverFault }
  | { type: typeof RECEIVER_EVENT.SESSION_FAILED; fault: ReceiverFault }
  | { type: typeof RECEIVER_EVENT.WORKER_FATAL; fault: ReceiverFault }
  | {
      type: Exclude<
        ReceiverEventType,
        | typeof RECEIVER_EVENT.CAMERA_FAILED
        | typeof RECEIVER_EVENT.SESSION_FAILED
        | typeof RECEIVER_EVENT.WORKER_FATAL
      >;
    };

export interface ReceiverMachineState {
  state: ReceiverState;
  fault?: ReceiverFault;
  /** Increments on every transition that ends a session, so stale async work can be fenced. */
  epoch: number;
}

export function initialReceiverState(): ReceiverMachineState {
  return { state: RECEIVER_STATE.IDLE, epoch: 0 };
}

/**
 * Which events each state accepts.
 *
 * Written as data because the interesting property is not what any one
 * transition does - it is that the set is complete, that nothing outside it can
 * happen, and that a test can read the whole thing. An event a state does not
 * list is ignored, which is the behaviour that makes a late `CAMERA_READY` from
 * an abandoned start harmless.
 */
const TRANSITIONS: Readonly<Record<ReceiverState, Partial<Record<ReceiverEventType, ReceiverState>>>> = {
  [RECEIVER_STATE.IDLE]: {
    [RECEIVER_EVENT.RECEIVE_REQUESTED]: RECEIVER_STATE.PREFLIGHT,
  },
  [RECEIVER_STATE.PREFLIGHT]: {
    // Preflight is where the receiver decides whether a camera prompt can
    // succeed at all. An insecure origin has no `mediaDevices` to prompt with,
    // and showing a permission dialog that can never appear is worse than
    // saying so.
    [RECEIVER_EVENT.PREFLIGHT_PASSED]: RECEIVER_STATE.CAMERA_WARMING,
    [RECEIVER_EVENT.CAMERA_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.WORKER_FATAL]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.BACKGROUNDED]: RECEIVER_STATE.INTERRUPTED,
    [RECEIVER_EVENT.CANCELLED]: RECEIVER_STATE.CANCELLED,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
  },
  [RECEIVER_STATE.CAMERA_WARMING]: {
    [RECEIVER_EVENT.CAMERA_READY]: RECEIVER_STATE.SCANNING,
    [RECEIVER_EVENT.CAMERA_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.WORKER_FATAL]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.BACKGROUNDED]: RECEIVER_STATE.INTERRUPTED,
    [RECEIVER_EVENT.CANCELLED]: RECEIVER_STATE.CANCELLED,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
  },
  [RECEIVER_STATE.SCANNING]: {
    [RECEIVER_EVENT.FRAME_ACCEPTED]: RECEIVER_STATE.RECEIVING,
    // A single-segment transfer can complete inside one burst of frames without
    // the UI ever observing RECEIVING.
    [RECEIVER_EVENT.SESSION_COMPLETE]: RECEIVER_STATE.VERIFYING,
    [RECEIVER_EVENT.SESSION_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.CAMERA_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.WORKER_FATAL]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.BACKGROUNDED]: RECEIVER_STATE.INTERRUPTED,
    [RECEIVER_EVENT.CANCELLED]: RECEIVER_STATE.CANCELLED,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
  },
  [RECEIVER_STATE.RECEIVING]: {
    [RECEIVER_EVENT.SESSION_COMPLETE]: RECEIVER_STATE.VERIFYING,
    [RECEIVER_EVENT.SESSION_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.CAMERA_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.WORKER_FATAL]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.BACKGROUNDED]: RECEIVER_STATE.INTERRUPTED,
    [RECEIVER_EVENT.CANCELLED]: RECEIVER_STATE.CANCELLED,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
  },
  [RECEIVER_STATE.VERIFYING]: {
    [RECEIVER_EVENT.VERIFIED]: RECEIVER_STATE.COMPLETE,
    [RECEIVER_EVENT.SESSION_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.WORKER_FATAL]: RECEIVER_STATE.FAILED,
    // Verification runs with the camera already stopped, so backgrounding it is
    // not a camera event - it is an abandoned transfer.
    [RECEIVER_EVENT.BACKGROUNDED]: RECEIVER_STATE.INTERRUPTED,
    [RECEIVER_EVENT.CANCELLED]: RECEIVER_STATE.CANCELLED,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
  },
  [RECEIVER_STATE.COMPLETE]: {
    [RECEIVER_EVENT.EXPORT_STARTED]: RECEIVER_STATE.EXPORTING,
    [RECEIVER_EVENT.RECEIVE_REQUESTED]: RECEIVER_STATE.PREFLIGHT,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
    [RECEIVER_EVENT.CANCELLED]: RECEIVER_STATE.CANCELLED,
    // A verified file is held in memory. Backgrounding drops it, exactly as it
    // drops a partial transfer, rather than leaving a decrypted file resident.
    [RECEIVER_EVENT.BACKGROUNDED]: RECEIVER_STATE.INTERRUPTED,
  },
  [RECEIVER_STATE.EXPORTING]: {
    [RECEIVER_EVENT.EXPORT_SETTLED]: RECEIVER_STATE.IDLE,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
    // The share sheet hides the page on iOS. Treating that as an interruption
    // would cancel the export the user is in the middle of confirming, so the
    // state deliberately absorbs it.
  },
  [RECEIVER_STATE.INTERRUPTED]: {
    [RECEIVER_EVENT.FOREGROUNDED]: RECEIVER_STATE.IDLE,
    [RECEIVER_EVENT.RECEIVE_REQUESTED]: RECEIVER_STATE.PREFLIGHT,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
  },
  [RECEIVER_STATE.CANCELLED]: {
    [RECEIVER_EVENT.RECEIVE_REQUESTED]: RECEIVER_STATE.PREFLIGHT,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
    [RECEIVER_EVENT.FOREGROUNDED]: RECEIVER_STATE.CANCELLED,
  },
  [RECEIVER_STATE.FAILED]: {
    [RECEIVER_EVENT.RECEIVE_REQUESTED]: RECEIVER_STATE.PREFLIGHT,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
    [RECEIVER_EVENT.FOREGROUNDED]: RECEIVER_STATE.FAILED,
  },
};

/**
 * Every receiver state's place in the shared transfer vocabulary.
 *
 * Added in Phase 09, when the desktop sender got a state machine of its own and
 * the two ends of a transfer needed to describe it in the same words. The
 * states here are unchanged - Phase 05 named them from the same program plan -
 * and this table is what makes that agreement checkable rather than incidental.
 *
 * Total by construction, and asserted against `RECEIVER_PHASES`, so a state
 * added later has to declare what phase of a transfer it represents.
 */
const PHASE_OF: Readonly<Record<ReceiverState, TransferPhase>> = Object.freeze({
  [RECEIVER_STATE.IDLE]: TRANSFER_PHASE.IDLE,
  [RECEIVER_STATE.PREFLIGHT]: TRANSFER_PHASE.PREFLIGHTING,
  [RECEIVER_STATE.CAMERA_WARMING]: TRANSFER_PHASE.PREPARING,
  // A live camera that has not decoded anything is armed and waiting, which is
  // what READY means on the sender too.
  [RECEIVER_STATE.SCANNING]: TRANSFER_PHASE.READY,
  [RECEIVER_STATE.RECEIVING]: TRANSFER_PHASE.TRANSFERRING,
  [RECEIVER_STATE.INTERRUPTED]: TRANSFER_PHASE.INTERRUPTED,
  [RECEIVER_STATE.VERIFYING]: TRANSFER_PHASE.VERIFYING,
  // The receiver's COMPLETE is a *verified* file and nothing weaker. It is the
  // only place in either surface that reaches this phase, because it is the
  // only place that has hashed the bytes.
  [RECEIVER_STATE.COMPLETE]: TRANSFER_PHASE.VERIFIED,
  [RECEIVER_STATE.EXPORTING]: TRANSFER_PHASE.EXPORTING,
  [RECEIVER_STATE.CANCELLED]: TRANSFER_PHASE.CANCELLED,
  [RECEIVER_STATE.FAILED]: TRANSFER_PHASE.FAILED,
});

export function receiverPhase(state: ReceiverState): TransferPhase {
  return PHASE_OF[state];
}

/** Every phase this machine can produce. Exists so a test can read it back. */
export function receiverPhasesInUse(): TransferPhase[] {
  return [...new Set(Object.values(PHASE_OF))];
}

export function receiverPhasesAreDeclared(): boolean {
  return receiverPhasesInUse().every((phase) => RECEIVER_PHASES.has(phase));
}

/** States in which a MediaStream should exist. Nothing else may decide this. */
const CAMERA_STATES: ReadonlySet<ReceiverState> = new Set<ReceiverState>([
  RECEIVER_STATE.CAMERA_WARMING,
  RECEIVER_STATE.SCANNING,
  RECEIVER_STATE.RECEIVING,
]);

/** States after which the session's buffers must not still be alive. */
const SESSION_CLEARING_STATES: ReadonlySet<ReceiverState> = new Set<ReceiverState>([
  RECEIVER_STATE.IDLE,
  RECEIVER_STATE.INTERRUPTED,
  RECEIVER_STATE.CANCELLED,
  RECEIVER_STATE.FAILED,
]);

const TERMINAL_STATES: ReadonlySet<ReceiverState> = new Set<ReceiverState>([
  RECEIVER_STATE.COMPLETE,
  RECEIVER_STATE.CANCELLED,
  RECEIVER_STATE.FAILED,
]);

export function cameraShouldRun(state: ReceiverState): boolean {
  return CAMERA_STATES.has(state);
}

export function sessionIsCleared(state: ReceiverState): boolean {
  return SESSION_CLEARING_STATES.has(state);
}

export function isTerminal(state: ReceiverState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Whether a cancel control does anything from here. */
export function canCancel(state: ReceiverState): boolean {
  return (
    state === RECEIVER_STATE.PREFLIGHT
    || state === RECEIVER_STATE.CAMERA_WARMING
    || state === RECEIVER_STATE.SCANNING
    || state === RECEIVER_STATE.RECEIVING
    || state === RECEIVER_STATE.VERIFYING
  );
}

export function acceptsEvent(state: ReceiverState, event: ReceiverEventType): boolean {
  return TRANSITIONS[state][event] !== undefined;
}

/** Every event a state will act on. Exists so a test can read the table back. */
export function allowedEvents(state: ReceiverState): ReceiverEventType[] {
  return Object.keys(TRANSITIONS[state]) as ReceiverEventType[];
}

/**
 * Applies one event.
 *
 * Returns the *same object* when the event is not accepted, so a caller can
 * test identity to know whether anything happened and React can skip a render
 * for an event that changed nothing.
 */
export function reduceReceiver(
  current: ReceiverMachineState,
  event: ReceiverEvent,
): ReceiverMachineState {
  const next = TRANSITIONS[current.state][event.type];
  if (next === undefined) return current;

  const fault = 'fault' in event ? event.fault : undefined;
  // A transition out of a live session invalidates anything still in flight for
  // it. Every state that clears the session bumps the epoch, and nothing else
  // does, so "is this result still mine" is one integer comparison everywhere.
  const clears = sessionIsCleared(next) || next === RECEIVER_STATE.PREFLIGHT;
  return {
    state: next,
    fault: fault ?? (next === RECEIVER_STATE.FAILED ? current.fault : undefined),
    epoch: clears ? current.epoch + 1 : current.epoch,
  };
}
