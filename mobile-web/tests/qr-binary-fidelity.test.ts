import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { createCanvas } from 'canvas';

async function roundTrip(bytes: Uint8Array): Promise<Uint8Array> {
  const canvas = createCanvas(1000, 1000) as unknown as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, [{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: 'L', margin: 4, width: 1000, color: { dark: '#000', light: '#fff' } });
  const image = (canvas as unknown as { getContext(type: string): CanvasRenderingContext2D }).getContext('2d').getImageData(0, 0, 1000, 1000); const code = jsQR(image.data, image.width, image.height); if (!code) throw new Error('QR did not decode'); return new Uint8Array(code.binaryData);
}

describe('raw QR byte fidelity selection gate', () => {
  it.each([
    ['all byte values', Uint8Array.from({ length: 256 }, (_, i) => i)],
    ['embedded zero and high-bit values', Uint8Array.of(0, 255, 0, 128, 254, 0, 1)],
    ['invalid UTF-8-looking bytes', Uint8Array.of(0xc3, 0x28, 0xa0, 0xa1, 0xed, 0xa0, 0x80)],
    ['deterministic random bytes', Uint8Array.from({ length: 512 }, (_, i) => (i * 73 + 19) & 0xff)],
    ['repeated byte pattern', Uint8Array.from({ length: 512 }, (_, i) => i % 2 ? 0xff : 0x00)],
  ])('preserves %s exactly', async (_name, source) => { expect(await roundTrip(source)).toEqual(source); });
});
