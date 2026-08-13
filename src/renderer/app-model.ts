import { TransferState } from '../shared/types';

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
 * Binary units, because the divisor is 1024. An earlier renderer model divided
 * by 1024 while labelling the result KB/MB; that module is gone and this is the
 * behaviour that ships.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

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
