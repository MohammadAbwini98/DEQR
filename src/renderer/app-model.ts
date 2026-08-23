interface IpcErrorResult {
  error?: { message?: string };
}

/**
 * Reads the `{ error }` shape several IPC handlers return in place of throwing,
 * and returns null for a successful result. The fallback matters: a handler can
 * report failure without a message, and the caller still has to say something.
 */
export function getIpcError(value: unknown): string | null {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as IpcErrorResult).error;
    return error?.message || 'The requested action could not be completed.';
  }
  return null;
}

/**
 * What a save attempt on the desktop receiver means.
 *
 * Kept here because it is the one piece of the desktop *receive* flow that has
 * to be provably honest: `false` from the IPC layer means no file is on disk,
 * and the outcome must never carry a success notice alongside it.
 */
export function getSaveOutcome(success: boolean): {
  state: 'completed' | 'failed';
  notice?: string;
  error?: string;
} {
  if (success) {
    return {
      state: 'completed',
      notice: 'The received file was verified and saved to the location you selected.',
    };
  }

  return {
    state: 'failed',
    error: 'Saving was not completed. No saved file is being reported. The save dialog may have been cancelled, or the received data may have been rejected.',
  };
}

/*
 * `formatFileSize`, `ACTIVE_TRANSFER_STATES` and `isActiveTransferState` were
 * removed in Phase 09 along with the `TransferState` union they were written
 * against. Nothing was dropped: the size formatter stopped at MiB, which was
 * correct under a 32 MiB ceiling and wrong for a 4 GiB transfer, and its
 * behaviour - including every boundary its tests pinned - now lives in
 * `sender-model.ts` as `formatBytes`, which formats from `bigint`. Which states
 * a cancel is meaningful in is now `canCancel` and `cancelNeedsConfirmation` in
 * `sender-state.ts`, derived from the one state machine rather than from a set
 * kept beside it.
 */
