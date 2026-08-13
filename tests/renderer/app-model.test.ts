import { describe, expect, it } from 'vitest';
import {
  formatFileSize,
  getIpcError,
  getSaveOutcome,
  isActiveTransferState,
} from '../../src/renderer/app-model';

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

  // Coverage moved here from the orphaned `ui-model` module, whose own version
  // of this labelled 1024-based values KB/MB. These now sit on the module the
  // renderer actually imports.
  it('labels sizes with the binary units its divisor actually produces', () => {
    expect(formatFileSize(512)).toBe('512 bytes');
    expect(formatFileSize(1536)).toBe('1.5 KiB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.00 MiB');
    expect(formatFileSize(1023)).toBe('1023 bytes');
    expect(formatFileSize(1024)).toBe('1.0 KiB');
  });

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
