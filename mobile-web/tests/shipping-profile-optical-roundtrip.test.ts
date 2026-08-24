import { describe, expect, it } from 'vitest';
import { createCanvas } from 'canvas';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

import { TRANSPORT_PROFILES, frameBytesFor } from '../../src/core/transport-profiles';
import { planQrGeometry, QR_QUIET_ZONE_MODULES, smallestVersionFor } from '../../src/core/qr-capacity';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import {
  V2_FRAME_TYPE,
  serializeDataFrame,
  serializeManifestFrame,
  type DeqrV2Manifest,
} from '../../src/core/protocol-v2';
import { computeSha256 } from '../../src/core/hash';
import { ReceivePipeline } from '../src/receive-pipeline';
import { FRAME_OUTCOME } from '../src/worker-protocol';

/**
 * The link nothing tested: a shipping frame, through a real QR, into the real
 * receiver.
 *
 * Two tests already covered halves of this and neither covered the join. The
 * composition test drives sender bytes straight into the receiver, skipping the
 * optical stage entirely. The fidelity test renders a QR and decodes it, but
 * with a **v1** frame at ECC L and 400 px, and it stops at the bytes - it never
 * hands them to a pipeline.
 *
 * So the one path a phone actually takes - a v2 frame at the shipping profile's
 * version and ECC, rendered at the shipping module scale, decoded by jsQR, and
 * submitted to `ReceivePipeline` - was never exercised. A physical run then
 * produced 71 decoded QR codes and zero accepted blocks, which is exactly the
 * shape of a failure in this join.
 */


function fixtureBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

/** Renders exactly as `qr-render.ts` does, then decodes exactly as the worker does. */
async function opticalRoundTrip(frame: Uint8Array, eccLevel: 'L' | 'M' | 'Q' | 'H'): Promise<Uint8Array | null> {
  const version = smallestVersionFor(frame.length, eccLevel);
  if (version === null) throw new Error(`no QR version fits ${frame.length} bytes at ECC ${eccLevel}`);
  const geometry = planQrGeometry({
    version,
    budgetCssPx: 480,
    devicePixelRatio: 2,
    quietZoneModules: QR_QUIET_ZONE_MODULES,
  });

  const canvas = createCanvas(geometry.pixelSize, geometry.pixelSize) as unknown as HTMLCanvasElement;
  await QRCode.toCanvas(canvas, [{ data: frame, mode: 'byte' }], {
    errorCorrectionLevel: eccLevel,
    version,
    scale: geometry.moduleScale,
    margin: geometry.quietZoneModules,
    color: { dark: '#000000', light: '#ffffff' },
  });

  const context = (canvas as unknown as { getContext(t: '2d'): CanvasRenderingContext2D }).getContext('2d');
  const image = context.getImageData(0, 0, geometry.pixelSize, geometry.pixelSize);
  const decoded = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  if (!decoded?.binaryData?.length) return null;
  return Uint8Array.from(decoded.binaryData);
}

describe('a shipping frame survives a real QR and is accepted by the real receiver', () => {
  for (const profile of TRANSPORT_PROFILES) {
    it(`round-trips a ${profile.name} data frame byte for byte`, async () => {
      const symbolBytes = profile.symbolSizeBytes;
      const segment = fixtureBytes(symbolBytes * 8, 0x4a1b);
      const encoder = new SegmentEncoder(symbolBytes);
      encoder.loadSegment(segment);
      const payload = new Uint8Array(symbolBytes);
      encoder.symbolInto(0, payload);

      const frame = serializeDataFrame({
        frameType: V2_FRAME_TYPE.SOURCE,
        sessionId: 0x1234_5678,
        fileId: 0x9abc_def0,
        segmentIndex: 0,
        symbolId: 0,
        sourceSymbolCount: 8,
        frameFlags: 0,
        payload,
      });
      expect(frame.length).toBe(frameBytesFor(profile));

      const decoded = await opticalRoundTrip(frame, profile.eccLevel);
      expect(decoded, `${profile.name} did not decode at all`).not.toBeNull();
      // Byte for byte. A single flipped byte fails the frame CRC and the
      // receiver refuses it, which on a phone looks like a camera problem.
      expect(decoded).toEqual(frame);
    });
  }

  it('accepts a manifest and a segment through the optical path, not just the bytes', async () => {
    const profile = TRANSPORT_PROFILES.find((entry) => entry.name.toLowerCase() === 'balanced')!;
    const symbolBytes = profile.symbolSizeBytes;
    // A segment is a whole number of symbols and at least 64 KiB, so it is
    // derived from the symbol size rather than assumed to be a round number of
    // kibibytes - 65,536 is not divisible by Balanced's 686-byte symbol.
    const sourceSymbolCount = Math.ceil(65_536 / symbolBytes);
    const segmentBytes = sourceSymbolCount * symbolBytes;
    const file = fixtureBytes(segmentBytes, 0x77aa);

    const manifest: DeqrV2Manifest = {
      featureFlags: 0,
      sessionId: 0x0bad_cafe,
      fileId: 0x0000_0001,
      originalSize: BigInt(file.length),
      transportSize: BigInt(file.length),
      segmentSizeBytes: segmentBytes,
      symbolSizeBytes: symbolBytes,
      segmentCount: 1,
      fecProfileId: 1,
      compressionMode: 0,
      compressionParam: 0,
      transportProfileId: profile.id,
      sha256: computeSha256(Buffer.from(file)),
      filename: 'optical.bin',
      mimeType: 'application/octet-stream',
    };

    const pipeline = new ReceivePipeline();

    // The manifest goes through the camera too. A receiver that cannot acquire
    // a session optically shows "QR codes read" climbing with no total beside
    // its segment count - which is precisely what the physical run showed.
    const manifestFrame = serializeManifestFrame(manifest);
    const decodedManifest = await opticalRoundTrip(manifestFrame, profile.eccLevel);
    expect(decodedManifest, 'the manifest did not survive the optical path').toEqual(manifestFrame);
    const manifestResult = pipeline.submit(decodedManifest!);
    expect(manifestResult.outcome, `manifest refused: ${manifestResult.reason}`).toBe(FRAME_OUTCOME.MANIFEST);
    await pipeline.whenStorageReady();

    const encoder = new SegmentEncoder(symbolBytes);
    encoder.loadSegment(file);
    const payload = new Uint8Array(symbolBytes);

    let accepted = 0;
    for (let symbolId = 0; symbolId < sourceSymbolCount; symbolId += 1) {
      encoder.symbolInto(symbolId, payload);
      const frame = serializeDataFrame({
        frameType: V2_FRAME_TYPE.SOURCE,
        sessionId: manifest.sessionId,
        fileId: manifest.fileId,
        segmentIndex: 0,
        symbolId,
        sourceSymbolCount,
        frameFlags: 0,
        payload,
      });
      const decoded = await opticalRoundTrip(frame, profile.eccLevel);
      expect(decoded, `symbol ${symbolId} did not decode`).not.toBeNull();
      const result = pipeline.submit(decoded!);
      expect(
        result.outcome,
        `symbol ${symbolId} refused: ${result.reason}`,
      ).not.toBe(FRAME_OUTCOME.REJECTED);
      accepted += 1;
    }

    expect(accepted).toBe(sourceSymbolCount);
    const progress = pipeline.progress();
    expect(progress.rejectionsByReason, 'frames were refused on the optical path').toEqual({});
    expect(progress.unitsRecovered, 'the segment never completed').toBe(1);
  }, 120_000);
});
