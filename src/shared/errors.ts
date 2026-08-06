export enum ErrorCode {
  FILE_SELECTION_CANCELLED = 'FILE_SELECTION_CANCELLED',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  FILE_NOT_REGULAR = 'FILE_NOT_REGULAR',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  FILE_TYPE_BLOCKED = 'FILE_TYPE_BLOCKED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  INVALID_TRANSFER_STATE = 'INVALID_TRANSFER_STATE',
  TRANSFER_PREPARATION_FAILED = 'TRANSFER_PREPARATION_FAILED',
  QR_RENDER_FAILED = 'QR_RENDER_FAILED',
  LOOPBACK_INSUFFICIENT_FRAMES = 'LOOPBACK_INSUFFICIENT_FRAMES',
  LOOPBACK_CORRUPTED_FRAME = 'LOOPBACK_CORRUPTED_FRAME',
  HASH_MISMATCH = 'HASH_MISMATCH',
  SAVE_CANCELLED = 'SAVE_CANCELLED',
  SAVE_FAILED = 'SAVE_FAILED',
  NETWORK_REQUEST_BLOCKED = 'NETWORK_REQUEST_BLOCKED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export class DeqrError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = 'DeqrError';
  }
}

export function sanitizeError(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof DeqrError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: ErrorCode.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : 'An unknown error occurred.',
  };
}
