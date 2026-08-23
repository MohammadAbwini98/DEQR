import { describe, expect, it } from 'vitest';

import {
  RECEIVER_EVENT,
  RECEIVER_STATE,
  acceptsEvent,
  allowedEvents,
  cameraShouldRun,
  canCancel,
  initialReceiverState,
  isTerminal,
  reduceReceiver,
  sessionIsCleared,
  type ReceiverEvent,
  type ReceiverEventType,
  type ReceiverMachineState,
  type ReceiverState,
} from '../src/receiver-state';

/**
 * The state machine replaced five flags that could contradict each other, so
 * these tests are mostly about what *cannot* happen rather than what can.
 *
 * The properties worth holding are structural: the camera runs in exactly one
 * set of states, an event a state does not accept changes nothing at all, and
 * every path that ends a session bumps the epoch that fences its async work.
 */

const ALL_STATES = Object.values(RECEIVER_STATE) as ReceiverState[];
const ALL_EVENTS = Object.values(RECEIVER_EVENT) as ReceiverEventType[];

function event(type: ReceiverEventType): ReceiverEvent {
  if (
    type === RECEIVER_EVENT.CAMERA_FAILED
    || type === RECEIVER_EVENT.SESSION_FAILED
    || type === RECEIVER_EVENT.WORKER_FATAL
  ) {
    return { type, fault: { kind: 'camera', code: 'TEST' } };
  }
  return { type } as ReceiverEvent;
}

function drive(from: ReceiverMachineState, types: ReceiverEventType[]): ReceiverMachineState {
  return types.reduce((current, type) => reduceReceiver(current, event(type)), from);
}

/** The happy path, as the UI walks it. */
const TO_SCANNING: ReceiverEventType[] = [
  RECEIVER_EVENT.RECEIVE_REQUESTED,
  RECEIVER_EVENT.PREFLIGHT_PASSED,
  RECEIVER_EVENT.CAMERA_READY,
];

describe('the receiver state machine admits only the transitions it lists', () => {
  it('walks a whole successful receive', () => {
    const complete = drive(initialReceiverState(), [
      ...TO_SCANNING,
      RECEIVER_EVENT.FRAME_ACCEPTED,
      RECEIVER_EVENT.SESSION_COMPLETE,
      RECEIVER_EVENT.VERIFIED,
    ]);
    expect(complete.state).toBe(RECEIVER_STATE.COMPLETE);

    const exported = drive(complete, [RECEIVER_EVENT.EXPORT_STARTED, RECEIVER_EVENT.EXPORT_SETTLED]);
    expect(exported.state).toBe(RECEIVER_STATE.IDLE);
  });

  it('completes a single-burst transfer that never observes RECEIVING', () => {
    const verifying = drive(initialReceiverState(), [...TO_SCANNING, RECEIVER_EVENT.SESSION_COMPLETE]);
    expect(verifying.state).toBe(RECEIVER_STATE.VERIFYING);
  });

  it('returns the identical object for an event a state does not accept', () => {
    const scanning = drive(initialReceiverState(), TO_SCANNING);
    // Identity, not equality: React skips the render and a caller can tell
    // "nothing happened" from "happened to land on the same state".
    expect(reduceReceiver(scanning, event(RECEIVER_EVENT.VERIFIED))).toBe(scanning);
    expect(reduceReceiver(scanning, event(RECEIVER_EVENT.EXPORT_SETTLED))).toBe(scanning);
  });

  it('never leaves a state for an event outside its table', () => {
    for (const state of ALL_STATES) {
      const machine: ReceiverMachineState = { state, epoch: 7 };
      for (const type of ALL_EVENTS) {
        const next = reduceReceiver(machine, event(type));
        if (acceptsEvent(state, type)) {
          expect(next, `${state} accepts ${type} but did not move`).not.toBe(machine);
        } else {
          expect(next, `${state} moved on an unlisted ${type}`).toBe(machine);
        }
      }
    }
  });

  it('lists no transition to a state that does not exist', () => {
    for (const state of ALL_STATES) {
      for (const type of allowedEvents(state)) {
        const next = reduceReceiver({ state, epoch: 0 }, event(type));
        expect(ALL_STATES).toContain(next.state);
      }
    }
  });
});

describe('the camera runs in exactly the states that say so', () => {
  it('runs only while warming, scanning or receiving', () => {
    const running = ALL_STATES.filter(cameraShouldRun);
    expect(running.sort()).toEqual([
      RECEIVER_STATE.CAMERA_WARMING,
      RECEIVER_STATE.RECEIVING,
      RECEIVER_STATE.SCANNING,
    ].sort());
  });

  it('stops the camera the moment verification starts', () => {
    const verifying = drive(initialReceiverState(), [...TO_SCANNING, RECEIVER_EVENT.SESSION_COMPLETE]);
    // The receive screen promises "the camera stops before integrity
    // verification", and this is where that promise is actually kept.
    expect(cameraShouldRun(verifying.state)).toBe(false);
  });

  it('offers cancel only where cancelling means something', () => {
    for (const state of ALL_STATES) {
      if (canCancel(state)) {
        expect(acceptsEvent(state, RECEIVER_EVENT.CANCELLED), `${state} offers cancel it cannot honour`).toBe(true);
      }
    }
    expect(canCancel(RECEIVER_STATE.COMPLETE)).toBe(false);
    expect(canCancel(RECEIVER_STATE.IDLE)).toBe(false);
  });
});

describe('backgrounding is deterministic from anywhere', () => {
  it('lands on INTERRUPTED from every live state and on IDLE when it returns', () => {
    const live = [
      RECEIVER_STATE.PREFLIGHT,
      RECEIVER_STATE.CAMERA_WARMING,
      RECEIVER_STATE.SCANNING,
      RECEIVER_STATE.RECEIVING,
      RECEIVER_STATE.VERIFYING,
      RECEIVER_STATE.COMPLETE,
    ];
    for (const state of live) {
      const interrupted = reduceReceiver({ state, epoch: 1 }, event(RECEIVER_EVENT.BACKGROUNDED));
      expect(interrupted.state, `${state} did not interrupt`).toBe(RECEIVER_STATE.INTERRUPTED);
      expect(sessionIsCleared(interrupted.state)).toBe(true);
      expect(interrupted.epoch, `${state} did not fence its in-flight work`).toBe(2);

      const returned = reduceReceiver(interrupted, event(RECEIVER_EVENT.FOREGROUNDED));
      expect(returned.state, `${state} did not return deterministically`).toBe(RECEIVER_STATE.IDLE);
    }
  });

  it('does not interrupt an export the user is in the middle of confirming', () => {
    // The iOS share sheet hides the page. Treating that as a background event
    // would cancel the save at the moment it was being confirmed.
    const exporting: ReceiverMachineState = { state: RECEIVER_STATE.EXPORTING, epoch: 3 };
    expect(reduceReceiver(exporting, event(RECEIVER_EVENT.BACKGROUNDED))).toBe(exporting);
  });

  it('leaves a terminal screen alone when the app comes back', () => {
    for (const state of [RECEIVER_STATE.FAILED, RECEIVER_STATE.CANCELLED]) {
      const machine: ReceiverMachineState = { state, epoch: 4 };
      expect(reduceReceiver(machine, event(RECEIVER_EVENT.FOREGROUNDED)).state).toBe(state);
    }
  });
});

describe('the epoch fences everything a dead session left in flight', () => {
  it('bumps on every transition that clears a session, and only those', () => {
    for (const state of ALL_STATES) {
      for (const type of allowedEvents(state)) {
        const before: ReceiverMachineState = { state, epoch: 10 };
        const after = reduceReceiver(before, event(type));
        const clears = sessionIsCleared(after.state) || after.state === RECEIVER_STATE.PREFLIGHT;
        expect(after.epoch, `${state} -> ${type} -> ${after.state}`).toBe(clears ? 11 : 10);
      }
    }
  });

  it('carries the fault that caused a failure', () => {
    const scanning = drive(initialReceiverState(), TO_SCANNING);
    const failed = reduceReceiver(scanning, {
      type: RECEIVER_EVENT.WORKER_FATAL,
      fault: { kind: 'scanner', code: 'SCANNER_UNAVAILABLE' },
    });
    expect(failed.state).toBe(RECEIVER_STATE.FAILED);
    expect(failed.fault).toEqual({ kind: 'scanner', code: 'SCANNER_UNAVAILABLE' });

    // And drops it as soon as the receiver is asked to start over, so a stale
    // "scanner unavailable" cannot be shown against a healthy retry.
    const retry = reduceReceiver(failed, event(RECEIVER_EVENT.RECEIVE_REQUESTED));
    expect(retry.state).toBe(RECEIVER_STATE.PREFLIGHT);
    expect(retry.fault).toBeUndefined();
  });

  it('marks exactly the states after which no session data may be alive', () => {
    expect(ALL_STATES.filter(sessionIsCleared).sort()).toEqual([
      RECEIVER_STATE.CANCELLED,
      RECEIVER_STATE.FAILED,
      RECEIVER_STATE.IDLE,
      RECEIVER_STATE.INTERRUPTED,
    ].sort());
    expect(ALL_STATES.filter(isTerminal).sort()).toEqual([
      RECEIVER_STATE.CANCELLED,
      RECEIVER_STATE.COMPLETE,
      RECEIVER_STATE.FAILED,
    ].sort());
  });
});
