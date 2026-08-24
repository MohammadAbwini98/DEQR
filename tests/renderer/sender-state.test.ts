import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

/**
 * The gap a physical run found: a pass that ends with nowhere to go.
 *
 * The sender displayed its last frame, the QR surface unmounted, and
 * `STREAM_COMPLETE` offered four actions - a new file, a resume code, reset,
 * cancel - every one of which abandons the transfer. A receiver still scanning,
 * a few symbols short, could only be helped by starting the whole file again.
 *
 * Phase 13 had built the recovery tail by then. Nothing could call it.
 */
describe('a finished pass can continue instead of only being abandoned', () => {
  it('offers a way back to displaying frames', () => {
    const complete = { state: SENDER_STATE.STREAM_COMPLETE, epoch: 0 };
    const recovering = reduceSender(complete, { type: SENDER_EVENT.RECOVERY_REQUESTED });

    // Back to TRANSFERRING, because that is what recovery is: the same session
    // and the same manifest, with more symbols. A second surface could drift
    // from the first.
    expect(recovering.state).toBe(SENDER_STATE.TRANSFERRING);
  });

  it('keeps every other exit from a finished pass', () => {
    // Recovery is an addition, not a replacement. Abandoning has to stay as
    // easy as it was.
    for (const type of [
      SENDER_EVENT.SELECT_REQUESTED,
      SENDER_EVENT.RESUME_REQUESTED,
      SENDER_EVENT.RESET,
      SENDER_EVENT.CANCELLED,
    ]) {
      const next = reduceSender({ state: SENDER_STATE.STREAM_COMPLETE, epoch: 0 }, { type });
      expect(next.state, `${type} no longer leaves STREAM_COMPLETE`).not.toBe(SENDER_STATE.STREAM_COMPLETE);
    }
  });

  it('does not let recovery be requested from a state with no session behind it', () => {
    // The event only means something where a finished session is still
    // registered. Anywhere else it must be ignored rather than invent one.
    for (const state of [SENDER_STATE.IDLE, SENDER_STATE.PREFLIGHTING, SENDER_STATE.CANCELLED]) {
      const next = reduceSender({ state, epoch: 0 }, { type: SENDER_EVENT.RECOVERY_REQUESTED });
      expect(next.state, `${state} accepted a recovery request`).toBe(state);
    }
  });
});

/**
 * A pass that ends is not a transfer that ends.
 *
 * `SEGMENTS SENT: 1` on a real run: a one-segment file is about 170 frames, so
 * the whole pass is over in roughly fifteen seconds - while someone is still
 * lining up a phone. The sender then removed the only thing the camera was
 * reading and waited for a button press from the person holding the camera.
 *
 * The link is one-way, so the sender can never learn that the receiver is
 * finished. Stopping is therefore always a guess, and the wrong guess costs the
 * whole transfer while the right one costs some redundant frames.
 */
describe('the sender keeps streaming rather than guessing that it is done', () => {
  it('does not treat a finished pass as a finished transfer in the view', async () => {
    const view = await readFile(
      path.resolve(__dirname, '../../src/renderer/components/StreamTransferView.tsx'),
      'utf8',
    );
    // The frame source rolls straight into the recovery tail and pulls the next
    // frame, rather than reporting the pass finished and letting the QR unmount.
    expect(view).toMatch(/beginRecovery\(sessionId\)/);
    expect(view).toMatch(/onRecoveringRef\.current\(\)/);
    // Finishing stays reachable, but only when recovery itself produced nothing.
    const source = view.slice(view.indexOf('if (result.frame) return result.frame;'));
    const recoveryFirst = source.indexOf('beginRecovery');
    const finishedAfter = source.indexOf('finishedReported = true');
    expect(recoveryFirst).toBeGreaterThan(-1);
    expect(finishedAfter).toBeGreaterThan(recoveryFirst);
  });

  it('says on screen that the stream has not stopped', async () => {
    const view = await readFile(
      path.resolve(__dirname, '../../src/renderer/components/StreamTransferView.tsx'),
      'utf8',
    );
    // A screen where the QR still cycles but every number has stopped climbing
    // reads as stuck. It has to say otherwise.
    expect(view).toContain('Sending recovery frames');
    expect(view).toMatch(/Still sending/);
  });
});
