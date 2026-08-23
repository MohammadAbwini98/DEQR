import { describe, expect, it } from 'vitest';
import { createCanvas } from 'canvas';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

import { QR_QUIET_ZONE_MODULES, qrModuleCount } from '../../src/core/qr-capacity';
import { V2_DATA_LAYOUT, V2_FRAME_TYPE, serializeDataFrame } from '../../src/core/protocol-v2';
import { SegmentEncoder } from '../../src/core/segment-encoder';
import { TRANSPORT_PROFILES, frameBytesFor } from '../../src/core/transport-profiles';
import {
  QrPayloadTooLargeError,
  applyCanvasGeometry,
  paintQrFrame,
  planMatches,
  resolveQrRenderPlan,
} from '../../src/renderer/qr-render';

/* ------------------------------------------------------------------ helpers */

type TestCanvas = HTMLCanvasElement & { getContext(type: '2d'): CanvasRenderingContext2D };

function canvasOf(size: number): TestCanvas {
  const canvas = createCanvas(size, size) as unknown as TestCanvas;
  // node-canvas has no `style`; the component sets one and the assertion below
  // is that it does, so a plain object stands in for it.
  (canvas as unknown as { style: Record<string, string> }).style = {};
  return canvas;
}

/** A real v2 data frame of a given payload size, from the shipping serializer. */
function realFrame(symbolBytes: number, seed = 0x0404): Uint8Array {
  const segment = new Uint8Array(symbolBytes * 8);
  let state = seed >>> 0;
  for (let index = 0; index < segment.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    segment[index] = state >>> 24;
  }
  const encoder = new SegmentEncoder(symbolBytes);
  encoder.loadSegment(segment);
  const payload = new Uint8Array(symbolBytes);
  encoder.symbolInto(3, payload);
  encoder.release();

  return serializeDataFrame({
    frameType: V2_FRAME_TYPE.SOURCE,
    sessionId: 0x5eed_0404,
    fileId: 0x0404_0404,
    segmentIndex: 0,
    symbolId: 3,
    sourceSymbolCount: 8,
    frameFlags: 0,
    payload,
  });
}

function decode(canvas: TestCanvas): Uint8Array | null {
  const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(image.data as unknown as Uint8ClampedArray, image.width, image.height);
  return code ? new Uint8Array(code.binaryData) : null;
}

/**
 * The strongest possible statement of "integer module scaling".
 *
 * If every module occupies exactly `moduleScale` by `moduleScale` pixels of one
 * uniform colour, then no module is a pixel wider than its neighbour and no
 * edge in the symbol falls between pixels. A single non-uniform block is a
 * fractional boundary.
 */
function everyModuleBlockIsUniform(canvas: TestCanvas, moduleScale: number, totalModules: number): boolean {
  const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  for (let my = 0; my < totalModules; my += 1) {
    for (let mx = 0; mx < totalModules; mx += 1) {
      const first = image.data[((my * moduleScale) * canvas.width + mx * moduleScale) * 4];
      for (let dy = 0; dy < moduleScale; dy += 1) {
        for (let dx = 0; dx < moduleScale; dx += 1) {
          const value = image.data[((my * moduleScale + dy) * canvas.width + mx * moduleScale + dx) * 4];
          if (value !== first) return false;
        }
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------------- tests */

describe('every profile renders and decodes byte-exactly', () => {
  it.each(TRANSPORT_PROFILES.map((profile) => [profile.name, profile] as const))(
    '%s round-trips a full-size frame through a real encode and decode',
    async (_name, profile) => {
      const frame = realFrame(profile.symbolSizeBytes);
      expect(frame.length).toBe(frameBytesFor(profile));

      const plan = resolveQrRenderPlan({
        frameBytes: frame.length,
        eccLevel: profile.eccLevel,
        budgetCssPx: 480,
        version: profile.qrVersion,
      });
      expect(plan.version).toBe(profile.qrVersion);

      const canvas = canvasOf(plan.geometry.pixelSize);
      await paintQrFrame(canvas, frame, plan);

      const decoded = decode(canvas);
      expect(decoded, `${profile.name} decodes`).not.toBeNull();
      expect(Array.from(decoded!)).toEqual(Array.from(frame));
    },
  );

  it.each(TRANSPORT_PROFILES.map((profile) => [profile.name, profile] as const))(
    '%s draws every module on whole pixels',
    async (_name, profile) => {
      const frame = realFrame(profile.symbolSizeBytes);
      const plan = resolveQrRenderPlan({
        frameBytes: frame.length,
        eccLevel: profile.eccLevel,
        budgetCssPx: 480,
        version: profile.qrVersion,
      });
      const canvas = canvasOf(plan.geometry.pixelSize);
      await paintQrFrame(canvas, frame, plan);

      expect(canvas.width).toBe(plan.geometry.totalModules * plan.geometry.moduleScale);
      expect(everyModuleBlockIsUniform(canvas, plan.geometry.moduleScale, plan.geometry.totalModules)).toBe(true);
    },
  );

  it('paints a full quiet zone of white on all four sides', async () => {
    const profile = TRANSPORT_PROFILES[1];
    const frame = realFrame(profile.symbolSizeBytes);
    const plan = resolveQrRenderPlan({
      frameBytes: frame.length,
      eccLevel: profile.eccLevel,
      budgetCssPx: 480,
      version: profile.qrVersion,
    });
    const canvas = canvasOf(plan.geometry.pixelSize);
    await paintQrFrame(canvas, frame, plan);

    const quietPx = plan.geometry.quietZoneModules * plan.geometry.moduleScale;
    expect(plan.geometry.quietZoneModules).toBe(QR_QUIET_ZONE_MODULES);
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const at = (x: number, y: number): number => image.data[(y * canvas.width + x) * 4];

    for (let offset = 0; offset < canvas.width; offset += 1) {
      for (let depth = 0; depth < quietPx; depth += 1) {
        expect(at(offset, depth)).toBe(255);
        expect(at(offset, canvas.width - 1 - depth)).toBe(255);
        expect(at(depth, offset)).toBe(255);
        expect(at(canvas.width - 1 - depth, offset)).toBe(255);
      }
    }
  });
});

describe('the v1 frame size, which is what actually ships today', () => {
  it('renders and decodes a 532-byte v1 frame on whole pixels', async () => {
    // The shipping renderer still drives v1: a 20-byte header plus a 512-byte
    // block. It is not a profile, so the version is discovered rather than
    // pinned, and it is the size that benefits from this fix right now.
    const frame = new Uint8Array(532);
    for (let index = 0; index < frame.length; index += 1) frame[index] = (index * 37 + 11) & 0xff;

    const plan = resolveQrRenderPlan({ frameBytes: frame.length, eccLevel: 'L', budgetCssPx: 480 });
    expect(plan.version).toBe(16);

    const canvas = canvasOf(plan.geometry.pixelSize);
    await paintQrFrame(canvas, frame, plan);

    expect(Array.from(decode(canvas)!)).toEqual(Array.from(frame));
    expect(everyModuleBlockIsUniform(canvas, plan.geometry.moduleScale, plan.geometry.totalModules)).toBe(true);
  });
});

describe('the render path this replaces produced fractional modules', () => {
  it('shows the difference is real rather than cosmetic', async () => {
    // The shipping renderer asked for a 400-pixel-wide symbol. A version-18
    // frame is 97 modules with its quiet zone, and 400 / 97 is 4.12, so module
    // widths alternate between four and five pixels. This is the negative proof
    // that the integer scale changes something a camera can see.
    const frame = realFrame(686);
    const oldWay = canvasOf(400);
    await QRCode.toCanvas(oldWay as unknown as HTMLCanvasElement, [{ data: frame, mode: 'byte' }], {
      errorCorrectionLevel: 'L',
      margin: 4,
      width: 400,
      color: { dark: '#000000', light: '#ffffff' },
    });
    expect(everyModuleBlockIsUniform(oldWay, 4, 97)).toBe(false);

    const plan = resolveQrRenderPlan({ frameBytes: frame.length, eccLevel: 'L', budgetCssPx: 400 });
    const newWay = canvasOf(plan.geometry.pixelSize);
    await paintQrFrame(newWay, frame, plan);
    expect(everyModuleBlockIsUniform(newWay, plan.geometry.moduleScale, plan.geometry.totalModules)).toBe(true);

    // Slightly smaller than the budget, which is the trade being made.
    expect(newWay.width).toBe(388);
    expect(newWay.width).toBeLessThan(400);
  });
});

describe('plan resolution', () => {
  it('picks the smallest version that holds the frame when none is pinned', () => {
    const plan = resolveQrRenderPlan({ frameBytes: 718, eccLevel: 'L', budgetCssPx: 480 });
    expect(plan.version).toBe(18);
    expect(plan.geometry.totalModules).toBe(qrModuleCount(18) + 2 * QR_QUIET_ZONE_MODULES);
  });

  it('honours a pinned version even when a smaller one would fit', () => {
    // A transport profile pins the version so the symbol does not change size
    // mid-transfer when the payload happens to cross a capacity boundary.
    const plan = resolveQrRenderPlan({ frameBytes: 100, eccLevel: 'L', budgetCssPx: 480, version: 24 });
    expect(plan.version).toBe(24);
  });

  it('refuses a frame no QR version can carry', () => {
    expect(() => resolveQrRenderPlan({ frameBytes: 3000, eccLevel: 'L', budgetCssPx: 480 }))
      .toThrow(QrPayloadTooLargeError);
    expect(() => resolveQrRenderPlan({ frameBytes: 1400, eccLevel: 'H', budgetCssPx: 480 }))
      .toThrow(QrPayloadTooLargeError);
  });

  it('re-plans only when the frame length changes', () => {
    const plan = resolveQrRenderPlan({ frameBytes: 718, eccLevel: 'L', budgetCssPx: 480 });
    expect(planMatches(plan, new Uint8Array(718))).toBe(true);
    expect(planMatches(plan, new Uint8Array(717))).toBe(false);
    expect(planMatches(null, new Uint8Array(718))).toBe(false);
  });

  it('accounts for the v2 frame overhead when a caller reasons in payload bytes', () => {
    const plan = resolveQrRenderPlan({
      frameBytes: 686 + V2_DATA_LAYOUT.overheadBytes,
      eccLevel: 'L',
      budgetCssPx: 480,
    });
    expect(plan.frameBytes).toBe(718);
    expect(plan.version).toBe(18);
  });
});

describe('canvas geometry is applied to both the backing store and the box', () => {
  it('sets width and height attributes and matching CSS, so nothing resamples', () => {
    const plan = resolveQrRenderPlan({
      frameBytes: 718,
      eccLevel: 'L',
      budgetCssPx: 480,
      devicePixelRatio: 2,
    });
    const canvas = canvasOf(1);
    applyCanvasGeometry(canvas, plan.geometry);

    expect(canvas.width).toBe(plan.geometry.pixelSize);
    expect(canvas.height).toBe(plan.geometry.pixelSize);
    // Only setting the attributes is the bug this replaces: the attributes
    // decide how many pixels are drawn and the style decides how many are shown.
    expect(canvas.style.width).toBe(`${plan.geometry.cssSize}px`);
    expect(canvas.style.height).toBe(`${plan.geometry.cssSize}px`);
    expect(plan.geometry.cssSize * 2).toBeCloseTo(plan.geometry.pixelSize, 6);
  });

  it('does not touch a canvas that is already the right size', () => {
    const plan = resolveQrRenderPlan({ frameBytes: 718, eccLevel: 'L', budgetCssPx: 480 });
    const canvas = canvasOf(plan.geometry.pixelSize);
    canvas.style.width = `${plan.geometry.cssSize}px`;
    canvas.style.height = `${plan.geometry.cssSize}px`;

    // Assigning `width` clears a canvas even when the value is unchanged, which
    // would blank the symbol between frames.
    const context = canvas.getContext('2d');
    context.fillStyle = '#123456';
    context.fillRect(0, 0, 4, 4);
    applyCanvasGeometry(canvas, plan.geometry);
    expect(context.getImageData(0, 0, 1, 1).data[0]).toBe(0x12);
  });
});
