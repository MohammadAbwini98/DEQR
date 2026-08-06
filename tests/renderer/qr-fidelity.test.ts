import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';

describe('QR Code Generation Fidelity', () => {
  it('preserves all bytes exactly via Uint8Array', () => {
    // Generate a deterministic frame containing all bytes 0x00 through 0xFF
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }

    const qr = QRCode.create([{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: 'L' });
    const segments = qr.segments;
    
    expect(segments.length).toBe(1);
    expect(segments[0].mode.id).toBe('Byte');
    
    // Check that every byte matches perfectly
    const outputData = segments[0].data;
    expect(outputData.length).toBe(256);
    
    let isMatch = true;
    for (let i = 0; i < 256; i++) {
      if (outputData[i] !== bytes[i]) {
        isMatch = false;
        break;
      }
    }
    
    expect(isMatch).toBe(true);
  });
});
