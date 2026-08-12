import { describe, expect, it } from 'vitest';
import { getSaveOutcome, isActiveTransferState } from '../../src/renderer/app-model';

describe('renderer app model', () => {
  it('reports a completed save only after an affirmative IPC result', () => {
    expect(getSaveOutcome(true)).toEqual({
      state: 'completed',
      notice: 'The received file was verified and saved to the location you selected.',
    });
  });

  it('does not claim that a file was saved when the IPC result is false', () => {
    const outcome = getSaveOutcome(false);

    expect(outcome.state).toBe('failed');
    expect(outcome.notice).toBeUndefined();
    expect(outcome.error).toContain('No saved file is being reported');
  });

  it('requires confirmation only for active send and receive states', () => {
    expect(isActiveTransferState('streaming')).toBe(true);
    expect(isActiveTransferState('receive-camera')).toBe(true);
    expect(isActiveTransferState('loopback-receiving')).toBe(true);
    expect(isActiveTransferState('preparing')).toBe(false);
    expect(isActiveTransferState('completed')).toBe(false);
  });
});
