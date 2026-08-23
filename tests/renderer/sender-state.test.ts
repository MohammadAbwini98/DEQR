import { describe, expect, it } from 'vitest';
import {
  SENDER_EVENT,
  SENDER_STATE,
  acceptsEvent,
  allowedEvents,
  canCancel,
  cancelNeedsConfirmation,
  initialSenderState,
  isTerminal,
  reduceSender,
  senderPhase,
  senderPhasesAreDeclared,
  senderPhasesInUse,
  sessionExists,
  sessionIsCleared,
  shouldStream,
  type SenderEvent,
  type SenderState,
} from '../../src/renderer/sender-state';
import { SENDER_PHASES, TRANSFER_PHASE, claimsIntegrityVerified } from '../../src/shared/transfer-ui-state';

const ALL_STATES = Object.values(SENDER_STATE) as SenderState[];

function run(events: SenderEvent[]) {
  return events.reduce((machine, event) => reduceSender(machine, event), initialSenderState());
}

const select = { type: SENDER_EVENT.SELECT_REQUESTED } as SenderEvent;
const ready = { type: SENDER_EVENT.PREFLIGHT_READY } as SenderEvent;
const start = { type: SENDER_EVENT.START_REQUESTED } as SenderEvent;
const started = { type: SENDER_EVENT.STREAM_STARTED } as SenderEvent;

describe('sender state machine', () => {
  /*
   * The five behaviours the deleted `AppStateMachine` asserted, restated
   * against the machine the renderer actually renders from. That module was
   * never imported by a component, so every one of these was previously a
   * claim about dead code.
   */
  it('starts idle', () => {
    expect(initialSenderState().state).toBe(SENDER_STATE.IDLE);
    expect(initialSenderState().epoch).toBe(0);
    expect(initialSenderState().fault).toBeUndefined();
  });

  it('reaches a live stream through preflight and preparation', () => {
    expect(run([select]).state).toBe(SENDER_STATE.PREFLIGHTING);
    expect(run([select, ready]).state).toBe(SENDER_STATE.READY);
    expect(run([select, ready, start]).state).toBe(SENDER_STATE.PREPARING);
    expect(run([select, ready, start, started]).state).toBe(SENDER_STATE.TRANSFERRING);
  });

  it('holds and releases a stream without losing the session', () => {
    const held = run([select, ready, start, started, { type: SENDER_EVENT.HOLD }]);
    expect(held.state).toBe(SENDER_STATE.HELD);
    expect(sessionExists(held.state)).toBe(true);
    // A hold must not invalidate in-flight work; only an ending does that.
    expect(held.epoch).toBe(run([select, ready, start, started]).epoch);

    const released = reduceSender(held, { type: SENDER_EVENT.RELEASE });
    expect(released.state).toBe(SENDER_STATE.TRANSFERRING);
  });

  it('can be cancelled from a live stream, and lands on a named cancelled state', () => {
    const cancelled = run([select, ready, start, started, { type: SENDER_EVENT.CANCELLED }]);
    // v1 dropped straight back to idle, which is why a cancelled transfer and a
    // fresh launch were indistinguishable on screen.
    expect(cancelled.state).toBe(SENDER_STATE.CANCELLED);
    expect(sessionIsCleared(cancelled.state)).toBe(true);
    expect(isTerminal(cancelled.state)).toBe(true);
  });

  it('returns to a safe idle state from every terminal state', () => {
    for (const state of ALL_STATES.filter(isTerminal)) {
      expect(acceptsEvent(state, SENDER_EVENT.RESET), state).toBe(true);
    }
  });

  /* ------------------------------------------------------ the phase gate */

  it('never maps a sender state onto a phase that claims integrity', () => {
    for (const state of ALL_STATES) {
      expect(claimsIntegrityVerified(senderPhase(state)), state).toBe(false);
    }
    // A finished stream is COMPLETED, and COMPLETED is not a verification.
    expect(senderPhase(SENDER_STATE.STREAM_COMPLETE)).toBe(TRANSFER_PHASE.COMPLETED);
  });

  it('stays inside the phases a sender is permitted to occupy', () => {
    expect(senderPhasesAreDeclared()).toBe(true);
    for (const phase of senderPhasesInUse()) expect(SENDER_PHASES.has(phase), phase).toBe(true);
  });

  it('maps a held stream to the interrupted phase rather than to a terminal one', () => {
    expect(senderPhase(SENDER_STATE.HELD)).toBe(TRANSFER_PHASE.INTERRUPTED);
    expect(isTerminal(SENDER_STATE.HELD)).toBe(false);
  });

  /* ---------------------------------------------------------- completeness */

  it('gives every state a phase and a transition table', () => {
    for (const state of ALL_STATES) {
      expect(senderPhase(state), state).toBeDefined();
      expect(Array.isArray(allowedEvents(state)), state).toBe(true);
    }
  });

  it('ignores an event a state does not accept, and returns the same object', () => {
    const readyState = run([select, ready]);
    // Identity, not equality: React skips a render when nothing changed, and a
    // machine that returned a fresh equal object would defeat that.
    expect(reduceSender(readyState, { type: SENDER_EVENT.RELEASE })).toBe(readyState);
    expect(reduceSender(readyState, { type: SENDER_EVENT.STREAM_FINISHED })).toBe(readyState);
  });

  it('drops a late completion from an abandoned pass', () => {
    const cancelled = run([select, ready, start, started, { type: SENDER_EVENT.CANCELLED }]);
    // The scheduler can resolve one last `nextFrame` after a cancel. It must
    // not resurrect a session into a completion screen.
    expect(reduceSender(cancelled, { type: SENDER_EVENT.STREAM_FINISHED })).toBe(cancelled);
  });

  /* ------------------------------------------------------------------ epoch */

  it('bumps the epoch exactly when a session is invalidated', () => {
    let machine = initialSenderState();
    const seen: Array<[SenderState, number]> = [];
    for (const event of [select, ready, start, started, { type: SENDER_EVENT.HOLD } as SenderEvent, { type: SENDER_EVENT.RELEASE } as SenderEvent]) {
      machine = reduceSender(machine, event);
      seen.push([machine.state, machine.epoch]);
    }
    // Only the transition into PREFLIGHTING cleared anything on this path.
    expect(seen.map(([, epoch]) => epoch)).toEqual([1, 1, 1, 1, 1, 1]);

    const cancelled = reduceSender(machine, { type: SENDER_EVENT.CANCELLED });
    expect(cancelled.epoch).toBe(2);
  });

  it('bumps the epoch on every state that clears the session and on no other', () => {
    for (const from of ALL_STATES) {
      for (const event of allowedEvents(from)) {
        const before = { state: from, epoch: 7 };
        const after = reduceSender(before, { type: event, fault: { kind: 'stream', code: 'X' } } as SenderEvent);
        const expected = sessionIsCleared(after.state) ? 8 : 7;
        expect(after.epoch, `${from} --${event}--> ${after.state}`).toBe(expected);
      }
    }
  });

  /* ----------------------------------------------------------- derivations */

  it('streams in exactly one state', () => {
    expect(ALL_STATES.filter(shouldStream)).toEqual([SENDER_STATE.TRANSFERRING]);
  });

  it('holds a main-process session in exactly the states that can use one', () => {
    expect(ALL_STATES.filter(sessionExists).sort()).toEqual([
      'HELD',
      'PREPARING',
      'READY',
      'STREAM_COMPLETE',
      'TRANSFERRING',
    ]);
  });

  it('never both holds and clears a session in the same state', () => {
    for (const state of ALL_STATES) {
      expect(sessionExists(state) && sessionIsCleared(state), state).toBe(false);
    }
  });

  /*
   * Replaces `isActiveTransferState` from `app-model.ts`, which held the same
   * knowledge in a set beside the state rather than derived from it.
   */
  it('offers a meaningful cancel only while something is running', () => {
    expect(canCancel(SENDER_STATE.TRANSFERRING)).toBe(true);
    expect(canCancel(SENDER_STATE.HELD)).toBe(true);
    expect(canCancel(SENDER_STATE.PREFLIGHTING)).toBe(true);
    expect(canCancel(SENDER_STATE.PREPARING)).toBe(true);
    expect(canCancel(SENDER_STATE.IDLE)).toBe(false);
    expect(canCancel(SENDER_STATE.READY)).toBe(false);
    expect(canCancel(SENDER_STATE.STREAM_COMPLETE)).toBe(false);
    expect(canCancel(SENDER_STATE.FAILED)).toBe(false);
  });

  it('asks for confirmation only where a receiver could lose progress', () => {
    // A dismissed file picker has nothing to confirm; a live stream does.
    expect(cancelNeedsConfirmation(SENDER_STATE.TRANSFERRING)).toBe(true);
    expect(cancelNeedsConfirmation(SENDER_STATE.HELD)).toBe(true);
    expect(cancelNeedsConfirmation(SENDER_STATE.PREFLIGHTING)).toBe(false);
    expect(cancelNeedsConfirmation(SENDER_STATE.PREPARING)).toBe(false);
    for (const state of ALL_STATES) {
      if (cancelNeedsConfirmation(state)) expect(canCancel(state), state).toBe(true);
    }
  });

  /* --------------------------------------------------------------- faults */

  it('carries a fault into the failure state and clears it on the way out', () => {
    const failed = reduceSender(run([select, ready, start, started]), {
      type: SENDER_EVENT.STREAM_FAILED,
      fault: { kind: 'stream', code: 'STREAM_READ_FAILED', message: 'disk went away' },
    });
    expect(failed.state).toBe(SENDER_STATE.FAILED);
    expect(failed.fault).toEqual({ kind: 'stream', code: 'STREAM_READ_FAILED', message: 'disk went away' });

    const retried = reduceSender(failed, select);
    expect(retried.state).toBe(SENDER_STATE.PREFLIGHTING);
    // A stale fault on a fresh attempt is a message about a transfer that is
    // no longer on screen.
    expect(retried.fault).toBeUndefined();
  });

  it('routes a refused resume code back to the code screen rather than to a dead end', () => {
    const refused = reduceSender(run([select]), {
      type: SENDER_EVENT.PREFLIGHT_FAILED,
      fault: { kind: 'resume', code: 'RESUME_REFUSED' },
    });
    expect(refused.state).toBe(SENDER_STATE.FAILED);
    expect(acceptsEvent(refused.state, SENDER_EVENT.RESUME_REQUESTED)).toBe(true);
    expect(reduceSender(refused, { type: SENDER_EVENT.RESUME_REQUESTED }).state).toBe(SENDER_STATE.RESUME_ENTRY);
  });

  it('treats a dismissed file picker as a return to idle, not as a failure', () => {
    const dismissed = reduceSender(run([select]), { type: SENDER_EVENT.PREFLIGHT_EMPTY });
    expect(dismissed.state).toBe(SENDER_STATE.IDLE);
    expect(dismissed.fault).toBeUndefined();
  });

  /* ------------------------------------------------------------- resume path */

  it('reaches the resume screen from idle and from every ending', () => {
    for (const state of [SENDER_STATE.IDLE, SENDER_STATE.STREAM_COMPLETE, SENDER_STATE.CANCELLED, SENDER_STATE.FAILED]) {
      expect(acceptsEvent(state, SENDER_EVENT.RESUME_REQUESTED), state).toBe(true);
    }
  });

  it('opens the picker from the resume screen only through a submitted code', () => {
    const entry = run([{ type: SENDER_EVENT.RESUME_REQUESTED }]);
    expect(entry.state).toBe(SENDER_STATE.RESUME_ENTRY);
    expect(reduceSender(entry, { type: SENDER_EVENT.RESUME_SUBMITTED }).state).toBe(SENDER_STATE.PREFLIGHTING);
    expect(reduceSender(entry, start)).toBe(entry);
  });
});
