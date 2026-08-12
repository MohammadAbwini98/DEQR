import { describe, expect, it } from 'vitest';
import { createCanvas } from 'canvas';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { computeSha256 } from '../../src/core/hash';
import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { serializeFrame } from '../../src/core/protocol';

async function qrRoundTrip(bytes: Uint8Array): Promise<Uint8Array> {
  const canvas = createCanvas(400, 400) as unknown as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, [{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: 400,
    color: { dark: '#000', light: '#fff' },
  });
  const image = (canvas as unknown as {
    getContext(type: '2d'): CanvasRenderingContext2D;
  }).getContext('2d').getImageData(0, 0, 400, 400);
  const decoded = jsQR(image.data, image.width, image.height, {
    inversionAttempts: 'dontInvert',
  });
  if (!decoded?.binaryData) throw new Error('jsQR did not decode the serialized DEQR frame.');
  return new Uint8Array(decoded.binaryData);
}

describe('serialized desktop-frame QR fidelity', () => {
  it('preserves an actual 532-byte desktop v1 frame at 400px', async () => {
    const source = Buffer.from(Uint8Array.from({ length: 5 * 1024 }, (_, index) => (index * 73 + 19) & 0xff));
    const container = serializeContainer({
      metadata: {
        protocolVersion: PROTOCOL_VERSION,
        filename: 'qr-frame-fixture.bin',
        mimeType: 'application/octet-stream',
        originalSize: source.length,
        compressed: false,
        encrypted: false,
        timestamp: 0,
        sha256: computeSha256(source),
      },
      payload: source,
    });
    const encoder = new FountainEncoder(container, 512, 0x10203040);
    const serializedFrame = new Uint8Array(serializeFrame(encoder.nextFrame()));

    expect(serializedFrame).toHaveLength(532);
    expect(await qrRoundTrip(serializedFrame)).toEqual(serializedFrame);
  });
});
