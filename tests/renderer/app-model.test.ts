import { describe, expect, it } from 'vitest';
import { getIpcError, getSaveOutcome } from '../../src/renderer/app-model';

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

  // Which states a cancel is meaningful in moved to `sender-state.ts`, where it
  // is derived from the one state machine rather than kept in a set beside it,
  // and the byte formatter moved to `sender-model.ts`, where it formats from
  // `bigint` rather than stopping at MiB. Both sets of assertions - including
  // every size boundary this file used to pin - are carried in
  // `sender-state.test.ts` and `sender-model.test.ts` respectively.

  it('extracts an IPC error without mistaking a successful result for one', () => {
    expect(getIpcError({ error: { message: 'File is blocked' } })).toBe('File is blocked');
    expect(getIpcError({ sessionId: 1 })).toBeNull();
    expect(getIpcError(null)).toBeNull();
    expect(getIpcError(undefined)).toBeNull();
  });

  it('still reports a failure that arrives without a message', () => {
    // A handler can return `{ error: {} }`; silence would leave the user with a
    // stalled screen and no explanation.
    expect(getIpcError({ error: {} })).toBe('The requested action could not be completed.');
    expect(getIpcError({ error: undefined })).toBe('The requested action could not be completed.');
  });
});
