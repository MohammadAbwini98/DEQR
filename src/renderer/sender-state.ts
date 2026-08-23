/**
 * The one authoritative sender state machine.
 *
 * The renderer used to hold its transfer state in a bare `useState` over a
 * fifteen-member union, set from inside seven different async handlers, beside
 * a second state machine in `state-machine.ts` that nothing ever rendered from
 * and that disagreed with the union it was typed against - it cast
 * `receive-camera` through `any` and had a `verified` state the renderer never
 * produced. Two models and a set of ad-hoc assignments is the same defect the
 * receiver had before Phase 05, and it has the same fix: one state, one
 * transition table written as data, and every other question the UI asks -
 * whether frames should be pulled, whether cancel means anything, whether this
 * screen is terminal - *derived* from that state rather than stored beside it.
 *
 * The states below are the sender's; `senderPhase` maps every one of them onto
 * the shared vocabulary in `src/shared/transfer-ui-state.ts`, which is what
 * keeps the two ends of a transfer describing it in the same words. One mapping
 * is deliberately absent and asserted to stay absent: **no sender state maps to
 * `VERIFIED`.** The sender never holds the reconstructed file and so can never
 * be the thing that says its hash matched.
 */

import {
  SENDER_PHASES,
  TRANSFER_PHASE,
  type TransferPhase,
} from '../shared/transfer-ui-state';

export const SENDER_STATE = {
  /** Dashboard. Nothing selected. */
  IDLE: 'IDLE',
  /**
   * Entering the forty-character code from a phone that holds part of the file.
   *
   * A state rather than a modal flag because the file picker it opens is a
   * different picker - "Select the File to Resume" - and because a refused
   * token has to come back to this screen with its reason, not to the dashboard.
   */
  RESUME_ENTRY: 'RESUME_ENTRY',
  /**
   * The picker is open, or the file behind it is being read.
   *
   * One state for both because they are one `streamTransfer.select` call: the
   * dialog, and the full SHA-256 and compression-sizing walk it triggers. For a
   * multi-gigabyte file the second half is the long one, and the screen says so.
   */
  PREFLIGHTING: 'PREFLIGHTING',
  /** Preflight finished. Sizes, compression decision and profile are on screen. */
  READY: 'READY',
  /** Start pressed. The frame scheduler is being armed. */
  PREPARING: 'PREPARING',
  /** Frames are on screen at the profile's cadence. */
  TRANSFERRING: 'TRANSFERRING',
  /**
   * The stream is held. Nothing is being pulled and nothing is lost.
   *
   * Named `HELD` rather than `PAUSED` because the receiver deliberately has no
   * pause, and one word for two different guarantees is how the two ends came
   * to be described in incompatible terms in the first place.
   */
  HELD: 'HELD',
  /**
   * Every frame of this pass has been displayed.
   *
   * This is the sender's ending and it is **not** a claim about the receiver.
   * `senderPhase` maps it to `COMPLETED`, never `VERIFIED`.
   */
  STREAM_COMPLETE: 'STREAM_COMPLETE',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type SenderState = (typeof SENDER_STATE)[keyof typeof SENDER_STATE];

export const SENDER_EVENT = {
  /** Open the picker for a fresh transfer. */
  SELECT_REQUESTED: 'SELECT_REQUESTED',
  /** Go to the resume-code screen. */
  RESUME_REQUESTED: 'RESUME_REQUESTED',
  /** Open the picker with a resume code attached. */
  RESUME_SUBMITTED: 'RESUME_SUBMITTED',
  /** Preflight returned metadata. */
  PREFLIGHT_READY: 'PREFLIGHT_READY',
  /** The user dismissed the picker. Not a failure. */
  PREFLIGHT_EMPTY: 'PREFLIGHT_EMPTY',
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  START_REQUESTED: 'START_REQUESTED',
  STREAM_STARTED: 'STREAM_STARTED',
  HOLD: 'HOLD',
  RELEASE: 'RELEASE',
  STREAM_FINISHED: 'STREAM_FINISHED',
  STREAM_FAILED: 'STREAM_FAILED',
  CANCELLED: 'CANCELLED',
  RESET: 'RESET',
} as const;
export type SenderEventType = (typeof SENDER_EVENT)[keyof typeof SENDER_EVENT];

/**
 * Why the sender stopped.
 *
 * `kind` exists because the four causes have four different remedies and only
 * one of them is about the file. A refused resume code sends the user back to
 * the code field; a preflight failure sends them to a different file; a display
 * failure is fixed by holding and releasing the stream; a stream failure is the
 * one that means start again.
 */
export interface SenderFault {
  kind: 'resume' | 'preflight' | 'stream' | 'display';
  code: string;
  message?: string;
}

export type SenderEvent =
  | { type: typeof SENDER_EVENT.PREFLIGHT_FAILED; fault: SenderFault }
  | { type: typeof SENDER_EVENT.STREAM_FAILED; fault: SenderFault }
  | {
      type: Exclude<
        SenderEventType,
        typeof SENDER_EVENT.PREFLIGHT_FAILED | typeof SENDER_EVENT.STREAM_FAILED
      >;
    };

export interface SenderMachineState {
  state: SenderState;
  fault?: SenderFault;
  /**
   * Bumped whenever a session ends or a new one begins.
   *
   * The sender pulls frames across IPC, so a `nextFrame` promise can resolve
   * after the session it belongs to was cancelled. Comparing one integer is how
   * the renderer knows a resolved frame is still its own - the same fence the
   * receiver uses against a late `getUserMedia`.
   */
  epoch: number;
}

export function initialSenderState(): SenderMachineState {
  return { state: SENDER_STATE.IDLE, epoch: 0 };
}

/**
 * Which events each state accepts.
 *
 * Data, so that the interesting property is readable: not what any single
 * transition does, but that the set is closed and a test can enumerate it. An
 * event a state does not list is ignored, which is what makes a late
 * `STREAM_FINISHED` from an abandoned pass harmless.
 */
const TRANSITIONS: Readonly<Record<SenderState, Partial<Record<SenderEventType, SenderState>>>> = {
  [SENDER_STATE.IDLE]: {
    [SENDER_EVENT.SELECT_REQUESTED]: SENDER_STATE.PREFLIGHTING,
    [SENDER_EVENT.RESUME_REQUESTED]: SENDER_STATE.RESUME_ENTRY,
  },
  [SENDER_STATE.RESUME_ENTRY]: {
    [SENDER_EVENT.RESUME_SUBMITTED]: SENDER_STATE.PREFLIGHTING,
    [SENDER_EVENT.SELECT_REQUESTED]: SENDER_STATE.PREFLIGHTING,
    [SENDER_EVENT.CANCELLED]: SENDER_STATE.IDLE,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
  },
  [SENDER_STATE.PREFLIGHTING]: {
    [SENDER_EVENT.PREFLIGHT_READY]: SENDER_STATE.READY,
    // A dismissed picker is not an error and must not land on an error screen.
    [SENDER_EVENT.PREFLIGHT_EMPTY]: SENDER_STATE.IDLE,
    [SENDER_EVENT.PREFLIGHT_FAILED]: SENDER_STATE.FAILED,
    [SENDER_EVENT.CANCELLED]: SENDER_STATE.IDLE,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
  },
  [SENDER_STATE.READY]: {
    [SENDER_EVENT.START_REQUESTED]: SENDER_STATE.PREPARING,
    [SENDER_EVENT.SELECT_REQUESTED]: SENDER_STATE.PREFLIGHTING,
    [SENDER_EVENT.CANCELLED]: SENDER_STATE.IDLE,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
  },
  [SENDER_STATE.PREPARING]: {
    [SENDER_EVENT.STREAM_STARTED]: SENDER_STATE.TRANSFERRING,
    [SENDER_EVENT.STREAM_FAILED]: SENDER_STATE.FAILED,
    [SENDER_EVENT.CANCELLED]: SENDER_STATE.CANCELLED,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
  },
  [SENDER_STATE.TRANSFERRING]: {
    [SENDER_EVENT.HOLD]: SENDER_STATE.HELD,
    [SENDER_EVENT.STREAM_FINISHED]: SENDER_STATE.STREAM_COMPLETE,
    [SENDER_EVENT.STREAM_FAILED]: SENDER_STATE.FAILED,
    [SENDER_EVENT.CANCELLED]: SENDER_STATE.CANCELLED,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
  },
  [SENDER_STATE.HELD]: {
    [SENDER_EVENT.RELEASE]: SENDER_STATE.TRANSFERRING,
    // A pass whose last frame was queued before the hold still finishes.
    [SENDER_EVENT.STREAM_FINISHED]: SENDER_STATE.STREAM_COMPLETE,
    [SENDER_EVENT.STREAM_FAILED]: SENDER_STATE.FAILED,
    [SENDER_EVENT.CANCELLED]: SENDER_STATE.CANCELLED,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
  },
  [SENDER_STATE.STREAM_COMPLETE]: {
    [SENDER_EVENT.SELECT_REQUESTED]: SENDER_STATE.PREFLIGHTING,
    [SENDER_EVENT.RESUME_REQUESTED]: SENDER_STATE.RESUME_ENTRY,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
    [SENDER_EVENT.CANCELLED]: SENDER_STATE.IDLE,
  },
  [SENDER_STATE.CANCELLED]: {
    [SENDER_EVENT.SELECT_REQUESTED]: SENDER_STATE.PREFLIGHTING,
    [SENDER_EVENT.RESUME_REQUESTED]: SENDER_STATE.RESUME_ENTRY,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
  },
  [SENDER_STATE.FAILED]: {
    [SENDER_EVENT.SELECT_REQUESTED]: SENDER_STATE.PREFLIGHTING,
    // A refused resume code has to be re-enterable without a trip home.
    [SENDER_EVENT.RESUME_REQUESTED]: SENDER_STATE.RESUME_ENTRY,
    [SENDER_EVENT.RESET]: SENDER_STATE.IDLE,
  },
};

/**
 * Every sender state's place in the shared vocabulary.
 *
 * Total by construction - the `Record` type will not compile with a state
 * missing - and asserted against `SENDER_PHASES` so that a state mapped to a
 * phase the sender may not occupy is a test failure rather than a false claim
 * on screen.
 */
const PHASE_OF: Readonly<Record<SenderState, TransferPhase>> = Object.freeze({
  [SENDER_STATE.IDLE]: TRANSFER_PHASE.IDLE,
  // A code being typed is pre-transfer input. Nothing has been committed to.
  [SENDER_STATE.RESUME_ENTRY]: TRANSFER_PHASE.IDLE,
  [SENDER_STATE.PREFLIGHTING]: TRANSFER_PHASE.PREFLIGHTING,
  [SENDER_STATE.READY]: TRANSFER_PHASE.READY,
  [SENDER_STATE.PREPARING]: TRANSFER_PHASE.PREPARING,
  [SENDER_STATE.TRANSFERRING]: TRANSFER_PHASE.TRANSFERRING,
  // A held stream is stopped, unfinished and resumable, which is exactly what
  // the shared vocabulary calls INTERRUPTED.
  [SENDER_STATE.HELD]: TRANSFER_PHASE.INTERRUPTED,
  // COMPLETED, never VERIFIED. This line is the sender half of the phase gate.
  [SENDER_STATE.STREAM_COMPLETE]: TRANSFER_PHASE.COMPLETED,
  [SENDER_STATE.CANCELLED]: TRANSFER_PHASE.CANCELLED,
  [SENDER_STATE.FAILED]: TRANSFER_PHASE.FAILED,
});

export function senderPhase(state: SenderState): TransferPhase {
  return PHASE_OF[state];
}

/** Every phase this machine can produce. Exists so a test can read it back. */
export function senderPhasesInUse(): TransferPhase[] {
  return [...new Set(Object.values(PHASE_OF))];
}

/** True when the phase set stays inside what a sender is permitted to claim. */
export function senderPhasesAreDeclared(): boolean {
  return senderPhasesInUse().every((phase) => SENDER_PHASES.has(phase));
}

/** States in which a streaming session exists in the main process. */
const SESSION_STATES: ReadonlySet<SenderState> = new Set<SenderState>([
  SENDER_STATE.READY,
  SENDER_STATE.PREPARING,
  SENDER_STATE.TRANSFERRING,
  SENDER_STATE.HELD,
  SENDER_STATE.STREAM_COMPLETE,
]);

/** States in which the scheduler should be pulling and painting frames. */
const STREAMING_STATES: ReadonlySet<SenderState> = new Set<SenderState>([
  SENDER_STATE.TRANSFERRING,
]);

const TERMINAL_STATES: ReadonlySet<SenderState> = new Set<SenderState>([
  SENDER_STATE.STREAM_COMPLETE,
  SENDER_STATE.CANCELLED,
  SENDER_STATE.FAILED,
]);

/** After these, no main-process session may still hold a descriptor. */
const SESSION_CLEARING_STATES: ReadonlySet<SenderState> = new Set<SenderState>([
  SENDER_STATE.IDLE,
  SENDER_STATE.RESUME_ENTRY,
  SENDER_STATE.PREFLIGHTING,
  SENDER_STATE.CANCELLED,
  SENDER_STATE.FAILED,
]);

export function sessionExists(state: SenderState): boolean {
  return SESSION_STATES.has(state);
}

export function shouldStream(state: SenderState): boolean {
  return STREAMING_STATES.has(state);
}

export function isTerminal(state: SenderState): boolean {
  return TERMINAL_STATES.has(state);
}

export function sessionIsCleared(state: SenderState): boolean {
  return SESSION_CLEARING_STATES.has(state);
}

/** Whether a cancel control does anything from here. */
export function canCancel(state: SenderState): boolean {
  return (
    state === SENDER_STATE.PREFLIGHTING
    || state === SENDER_STATE.PREPARING
    || state === SENDER_STATE.TRANSFERRING
    || state === SENDER_STATE.HELD
  );
}

/**
 * Whether cancelling from here should ask first.
 *
 * Only a stream that has put frames on screen has progress a receiver could
 * lose. Confirming a dismissed file picker is a dialog about nothing.
 */
export function cancelNeedsConfirmation(state: SenderState): boolean {
  return state === SENDER_STATE.TRANSFERRING || state === SENDER_STATE.HELD;
}

export function acceptsEvent(state: SenderState, event: SenderEventType): boolean {
  return TRANSITIONS[state][event] !== undefined;
}

export function allowedEvents(state: SenderState): SenderEventType[] {
  return Object.keys(TRANSITIONS[state]) as SenderEventType[];
}

/**
 * Applies one event.
 *
 * Returns the *same object* when the event is not accepted, so a caller can
 * test identity to know whether anything happened and React can skip a render
 * for an event that changed nothing.
 */
export function reduceSender(
  current: SenderMachineState,
  event: SenderEvent,
): SenderMachineState {
  const next = TRANSITIONS[current.state][event.type];
  if (next === undefined) return current;

  const fault = 'fault' in event ? event.fault : undefined;
  // Anything that ends a session, and anything that starts a new preflight,
  // invalidates work still in flight for the old one. Every such transition
  // bumps the epoch and nothing else does.
  const clears = sessionIsCleared(next);
  return {
    state: next,
    fault: fault ?? (next === SENDER_STATE.FAILED ? current.fault : undefined),
    epoch: clears ? current.epoch + 1 : current.epoch,
  };
}
