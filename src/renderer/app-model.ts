import { TransferState } from '../shared/types';

export const ACTIVE_TRANSFER_STATES: ReadonlySet<TransferState> = new Set([
  'streaming',
  'paused',
  'loopback-receiving',
  'receive-camera',
]);

export function isActiveTransferState(state: TransferState): boolean {
  return ACTIVE_TRANSFER_STATES.has(state);
}

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
