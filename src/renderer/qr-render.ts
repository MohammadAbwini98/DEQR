/**
 * Painting a DEQR frame as a QR symbol, on whole pixels.
 *
 * The shipping renderer asked `qrcode` for a 400-pixel-wide symbol and let the
 * library divide 400 by whatever module count fell out. A version-18 frame is
 * 89 modules plus 8 of quiet zone, so 400 / 97 is 4.12 device pixels per
 * module: most modules get four pixels, roughly one in eight gets five, and
 * every edge in the symbol lands on a fractional boundary. On top of that the
 * canvas was presented at a CSS width the browser then resampled again, and on
 * a HiDPI display a third resample followed.
 *
 * Three resamples, none of them necessary. This module removes all three:
 *
 * - **Multiply, do not divide.** The module scale is an integer chosen to fit
 *   the layout budget, and the canvas is exactly `totalModules x scale` device
 *   pixels. Every module is the same size and every edge is on a pixel.
 * - **Present at the size it was drawn.** The canvas gets an explicit CSS size
 *   of `pixelSize / devicePixelRatio`, so the browser maps one module to a whole
 *   number of device pixels rather than resampling to fit a stylesheet.
 * - **Pin the version for the whole transfer.** Every frame in a transfer is
 *   the same length, so the version is constant. Resolving it once removes a
 *   per-frame `QRCode.create` and, more importantly, stops the symbol changing
 *   size mid-stream - which would make a camera re-acquire its framing every
 *   time the payload crossed a capacity boundary.
 *
 * Byte mode throughout: the payload is passed as bytes and never becomes a
 * string. That contract predates this phase and is asserted by
 * `mobile-web/tests/qr-binary-fidelity.test.ts`; it is restated here because
 * this is the file where somebody would be tempted to break it.
 */

import QRCode from 'qrcode';

import {
  QR_QUIET_ZONE_MODULES,
  QrEccLevel,
  QrRenderGeometry,
  planQrGeometry,
  smallestVersionFor,
} from '../core/qr-capacity';

export interface QrRenderPlan {
  version: number;
  eccLevel: QrEccLevel;
  geometry: QrRenderGeometry;
  /** Frame length this plan was resolved for. A different length needs a new plan. */
  frameBytes: number;
}

export class QrPayloadTooLargeError extends Error {
  constructor(public readonly frameBytes: number, public readonly eccLevel: QrEccLevel) {
    super(`a ${frameBytes}-byte frame does not fit any QR version at ECC ${eccLevel}`);
    this.name = 'QrPayloadTooLargeError';
  }
}

/**
 * Works out how to draw frames of a given size.
 *
 * Resolve once per transfer and reuse. `budgetCssPx` is the layout's allowance;
 * the result is usually a little smaller, because a symbol that leaves a few
 * pixels unused beats one that fills its box with uneven modules.
 */
export function resolveQrRenderPlan(input: {
  frameBytes: number;
  eccLevel: QrEccLevel;
  budgetCssPx: number;
  devicePixelRatio?: number;
  quietZoneModules?: number;
  /** Overrides version selection. A transport profile pins it; v1 discovers it. */
  version?: number;
}): QrRenderPlan {
  const { frameBytes, eccLevel, budgetCssPx } = input;
  const version = input.version ?? smallestVersionFor(frameBytes, eccLevel);
  if (version === null) throw new QrPayloadTooLargeError(frameBytes, eccLevel);

  return {
    version,
    eccLevel,
    frameBytes,
    geometry: planQrGeometry({
      version,
      budgetCssPx,
      devicePixelRatio: input.devicePixelRatio,
      quietZoneModules: input.quietZoneModules ?? QR_QUIET_ZONE_MODULES,
    }),
  };
}

/**
 * Sizes a canvas to a plan, backing store and CSS box together.
 *
 * Both halves matter and only setting one is the bug this replaces: the
 * attributes decide how many pixels are drawn, the style decides how many are
 * shown, and a mismatch between them is a resample.
 */
export function applyCanvasGeometry(canvas: HTMLCanvasElement, geometry: QrRenderGeometry): void {
  if (canvas.width !== geometry.pixelSize) canvas.width = geometry.pixelSize;
  if (canvas.height !== geometry.pixelSize) canvas.height = geometry.pixelSize;
  const cssSize = `${geometry.cssSize}px`;
  if (canvas.style.width !== cssSize) canvas.style.width = cssSize;
  if (canvas.style.height !== cssSize) canvas.style.height = cssSize;
}

/**
 * Draws one frame.
 *
 * `scale` and `margin` rather than `width`: the first multiplies module count
 * by whole pixels, the second divides a pixel budget by module count. They
 * differ by exactly the artefact this module exists to remove.
 */
export async function paintQrFrame(
  canvas: HTMLCanvasElement,
  payload: Uint8Array,
  plan: QrRenderPlan,
): Promise<void> {
  await QRCode.toCanvas(canvas, [{ data: payload, mode: 'byte' }], {
    errorCorrectionLevel: plan.eccLevel,
    version: plan.version,
    scale: plan.geometry.moduleScale,
    margin: plan.geometry.quietZoneModules,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/** True when a plan still describes this payload. Frame length is the only input. */
export function planMatches(plan: QrRenderPlan | null, payload: Uint8Array): plan is QrRenderPlan {
  return plan !== null && plan.frameBytes === payload.length;
}
