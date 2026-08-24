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
 * The state names follow the program plan's receiver list. Four deliberate
 * choices inside them:
 *
 * - `INTERRUPTED` is a real state rather than a silent cancel. Backgrounding
 *   still ends the session and clears its bytes, which is the receiver's
 *   standing privacy posture; making it a named state is what lets the return
 *   path be deterministic and asserted instead of inferred.
 * - There is no `PAUSED`. Resuming a partially received transfer needs the
 *   checkpoints Phase 07 defines, and a pause that silently discards progress
 *   would be a worse lie than not offering one.
 * - `INCOMPLETE` and `RECOVERING` were added in Phase 13, after a physical
 *   iPhone transfer hung. `RECEIVING` had no exit for the one thing that
 *   actually happened — the sender running out of frames while the receiver was
 *   still short — so the phone sat in "Receiving transfer" with a live camera
 *   and no way forward. **A receiver that cannot say "incomplete" can only say
 *   "receiving" forever.**
 * - Those two states are the only non-terminal ones that keep a session alive
 *   without the camera necessarily producing progress, which is why they are
 *   absent from `SESSION_CLEARING_STATES`: a stall must not cost the segments
 *   already written to disk.
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
  /**
   * Frames stopped arriving before every segment was recovered.
   *
   * The state Phase 13 exists to add. Without it `RECEIVING` had no exit but
   * completion, failure, backgrounding or cancel — so a sender that finished
   * its pass while the receiver was one symbol short left the phone showing
   * "Receiving transfer" with a live camera, forever. That is the reported
   * physical failure, and no amount of waiting resolved it because nothing was
   * still being transmitted.
   *
   * Distinct from `INTERRUPTED` in the one way that matters: **the session and
   * its bytes survive**. This is a transfer waiting for more frames, not an
   * abandoned one, so it is absent from `SESSION_CLEARING_STATES` and does not
   * bump the epoch.
   */
  INCOMPLETE: 'INCOMPLETE',
  /**
   * Unique frames are arriving again after a stall.
   *
   * Separate from `RECEIVING` so the screen can say the difference — the first
   * pass is over and what is on the wire now is repair for the segments still
   * missing. Recovery is otherwise identical, which is the point: the same
   * store, the same checkpoint, the same segment bitmap.
   */
  RECOVERING: 'RECOVERING',
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
  /**
   * No *unique valid DEQR frame* has been accepted for the stall window.
   *
   * Deliberately not a camera event. The camera watchdog in `camera.ts` asks
   * whether the video element is presenting frames, and during the reported
   * failure it was — happily, at full rate, showing a sender that had stopped
   * transmitting anything new. Liveness of the camera says nothing about
   * liveness of the transfer, and conflating them is what let the receiver hang
   * while every component reported itself healthy.
   */
  STALLED: 'STALLED',
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
    // The exit that did not exist. Everything else here could already happen;
    // a sender that simply stopped could not be represented at all.
    [RECEIVER_EVENT.STALLED]: RECEIVER_STATE.INCOMPLETE,
    [RECEIVER_EVENT.SESSION_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.CAMERA_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.WORKER_FATAL]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.BACKGROUNDED]: RECEIVER_STATE.INTERRUPTED,
    [RECEIVER_EVENT.CANCELLED]: RECEIVER_STATE.CANCELLED,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
  },
  [RECEIVER_STATE.INCOMPLETE]: {
    // A single new unique frame is the whole signal that recovery has begun.
    // No handshake, no acknowledgement, nothing the one-way optical link
    // cannot carry.
    [RECEIVER_EVENT.FRAME_ACCEPTED]: RECEIVER_STATE.RECOVERING,
    // A stalled receiver can still be one already-buffered segment away from
    // done, so completion has to remain reachable from here.
    [RECEIVER_EVENT.SESSION_COMPLETE]: RECEIVER_STATE.VERIFYING,
    [RECEIVER_EVENT.SESSION_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.CAMERA_FAILED]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.WORKER_FATAL]: RECEIVER_STATE.FAILED,
    [RECEIVER_EVENT.BACKGROUNDED]: RECEIVER_STATE.INTERRUPTED,
    [RECEIVER_EVENT.CANCELLED]: RECEIVER_STATE.CANCELLED,
    [RECEIVER_EVENT.RESET]: RECEIVER_STATE.IDLE,
  },
  [RECEIVER_STATE.RECOVERING]: {
    [RECEIVER_EVENT.SESSION_COMPLETE]: RECEIVER_STATE.VERIFYING,
    // Recovery can stall exactly as the first pass can, and must fall back to
    // the same place rather than to a second, subtly different dead end.
    [RECEIVER_EVENT.STALLED]: RECEIVER_STATE.INCOMPLETE,
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
    /**
     * An export that failed goes back to holding the verified file.
     *
     * The screen already tried to do this — it dispatches `VERIFIED` on the
     * catch and tells the user "the verified file remains available" — but the
     * event was not in this table, so `reduceReceiver` dropped it and the
     * machine stayed in `EXPORTING`. The message was true and the state was
     * wedged: `EXPORTING` offers no cancel and no save, so the only way out of
     * a failed share was a reset, which discards the file the message had just
     * promised. **A retryable export is the whole point of separating this
     * state from `COMPLETE`**, and it was unreachable.
     */
    [RECEIVER_EVENT.VERIFIED]: RECEIVER_STATE.COMPLETE,
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
  // Recovery is bytes moving, which is what TRANSFERRING means. The screen
  // distinguishes the two; the shared vocabulary does not need to.
  [RECEIVER_STATE.RECOVERING]: TRANSFER_PHASE.TRANSFERRING,
  // `INTERRUPTED` is defined in the shared vocabulary as "stopped without being
  // finished or abandoned, and resumable" - which is exactly a stalled
  // transfer. Reusing it keeps both surfaces on one phase list rather than
  // widening a contract the sender also implements.
  [RECEIVER_STATE.INCOMPLETE]: TRANSFER_PHASE.INTERRUPTED,
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
  RECEIVER_STATE.RECOVERING,
  // The camera stays on through `INCOMPLETE` deliberately. The action that
  // ends a stall happens on the *other* device — someone starts the recovery
  // tail or types a resume code — and there is no back channel to tell this
  // one when. A receiver that stopped watching would miss the first recovery
  // frames and need a manual restart to notice a transfer that had already
  // resumed. The cost is a live camera while a transfer is idle, which is
  // visible, bounded by the user, and preferable to silently missing the
  // frames the stall was reported in order to obtain.
  RECEIVER_STATE.INCOMPLETE,
]);

/**
 * States after which the session's buffers must not still be alive.
 *
 * `INCOMPLETE` and `RECOVERING` are deliberately absent, and that absence is
 * the mechanism behind "preserve partial state": these are the only two
 * non-terminal states a stalled transfer can reach, and membership here is what
 * would discard the segments already on the device and bump the epoch out from
 * under the in-flight work. A stall is not an abandonment.
 */
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
    // A stalled transfer is the state a user is most likely to want to abandon,
    // so cancel has to mean something from both of the new states.
    || state === RECEIVER_STATE.INCOMPLETE
    || state === RECEIVER_STATE.RECOVERING
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
