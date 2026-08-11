export function formatFileSize(sizeInBytes: number): string {
  if (sizeInBytes < 1024) return `${sizeInBytes} bytes`;
  if (sizeInBytes < 1024 * 1024) return `${(sizeInBytes / 1024).toFixed(1)} KB`;
  return `${(sizeInBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function estimateMinimumStreamSeconds(sizeInBytes: number, blockSize = 512, framesPerSecond = 30): number {
  return Math.max(1, Math.ceil(sizeInBytes / blockSize) / framesPerSecond);
}

export function getIpcErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('error' in result)) return undefined;

  const error = (result as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return undefined;
}

export function getQrRasterSize(displaySize: number, devicePixelRatio: number): number {
  return Math.max(1, Math.round(displaySize * Math.max(1, devicePixelRatio)));
}
