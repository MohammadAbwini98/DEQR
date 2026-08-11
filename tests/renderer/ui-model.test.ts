import { describe, expect, it } from 'vitest';
import { estimateMinimumStreamSeconds, formatFileSize, getIpcErrorMessage, getQrRasterSize } from '../../src/renderer/ui-model';

describe('renderer UI model', () => {
  it('formats byte, kilobyte, and megabyte metadata without hiding the unit', () => {
    expect(formatFileSize(512)).toBe('512 bytes');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('reports a conservative nonzero minimum stream duration at the configured frame rate', () => {
    expect(estimateMinimumStreamSeconds(1)).toBe(1);
    expect(estimateMinimumStreamSeconds(512 * 30)).toBe(1);
    expect(estimateMinimumStreamSeconds(512 * 90)).toBe(3);
  });

  it('extracts structured IPC errors without treating successful values as errors', () => {
    expect(getIpcErrorMessage({ error: { message: 'File is blocked' } })).toBe('File is blocked');
    expect(getIpcErrorMessage({ error: 'Transfer failed' })).toBe('Transfer failed');
    expect(getIpcErrorMessage({ sessionId: 1 })).toBeUndefined();
  });

  it('uses an intrinsic QR bitmap sized for the display scale', () => {
    expect(getQrRasterSize(400, 1)).toBe(400);
    expect(getQrRasterSize(400, 1.25)).toBe(500);
    expect(getQrRasterSize(400, 2)).toBe(800);
  });
});
