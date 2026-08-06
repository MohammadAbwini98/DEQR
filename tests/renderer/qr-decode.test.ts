import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { createCanvas } from 'canvas';

describe('QR Decoding Fidelity', () => {
  it('encodes and decodes every byte exactly (0x00 to 0xFF)', async () => {
    // 1. Generate an arbitrary binary payload containing all 256 byte values
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }

    // 2. Render to an offscreen Canvas
    // Use an adequate size to prevent blurriness; node-canvas simulates a real HTML5 canvas.
    const canvas = createCanvas(500, 500) as unknown as HTMLCanvasElement;
    
    await QRCode.toCanvas(canvas, [{ data: bytes, mode: 'byte' }], {
      errorCorrectionLevel: 'L',
      margin: 4,
      width: 500,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });

    // 3. Extract raw RGBA pixels from the canvas
    const ctx = (canvas as any).getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // 4. Decode using jsQR
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    
    // Assert we found a QR code
    expect(code).not.toBeNull();
    
    if (code) {
      // 5. Assert byte-for-byte equality from the decoded binary data
      // jsQR's `binaryData` contains the raw numbers decoded from byte segments.
      const decodedBytes = new Uint8Array(code.binaryData);
      
      expect(decodedBytes.length).toBe(256);
      
      let isMatch = true;
      for (let i = 0; i < 256; i++) {
        if (decodedBytes[i] !== bytes[i]) {
          isMatch = false;
          break;
        }
      }
      
      expect(isMatch).toBe(true);
    }
  });
});
