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

/**
 * Largest symbol the layout will ever draw, in CSS pixels.
 *
 * Past this a bigger symbol buys nothing: the receiving camera's resolution,
 * not the sender's screen, is what sets how many camera pixels land on a
 * module, and a symbol wider than the viewing distance supports is just a
 * symbol the phone has to be moved back from.
 */
export const QR_BUDGET_MAX_CSS_PX = 480;

/**
 * Smallest symbol worth drawing, in CSS pixels.
 *
 * A version-18 frame is 97 modules including its quiet zone, so this is a touch
 * under two device pixels per module. Below it `planQrGeometry` refuses to give
 * every module a whole pixel, which is the honest outcome: the caller surfaces
 * a render error saying the window is too small, rather than drawing something
 * no camera can resolve.
 */
export const QR_BUDGET_MIN_CSS_PX = 160;

/**
 * Turns the room a layout has into the budget a symbol may use.
 *
 * Separated from the DOM reading that feeds it so the decision — which is the
 * part that was wrong — can be tested without a browser. The rule is only:
 * the symbol is square, so the smaller side wins, and the result is clamped.
 *
 * A non-finite or negative input means the layout has not settled yet (a first
 * paint before styles resolve, most often). Falling back to the maximum rather
 * than to zero keeps that transient from being mistaken for a tiny window.
 */
export function chooseQrBudget(availableWidth: number, availableHeight: number): number {
  const usable = [availableWidth, availableHeight].filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  if (usable.length === 0) return QR_BUDGET_MAX_CSS_PX;
  const smaller = Math.floor(Math.min(...usable));
  return Math.max(QR_BUDGET_MIN_CSS_PX, Math.min(smaller, QR_BUDGET_MAX_CSS_PX));
}

/**
 * Vertical chrome and company the symbol must leave for the rest of its screen.
 *
 * Measured against the composition of the live transfer screen at its tightest
 * supported desktop height (720px): titlebar, content padding, heading block,
 * the guidance line under the stage, and the stage's own padding. Deriving
 * this by *subtracting measured siblings* was the previous approach and it is
 * how the oversized-symbol regression happened: on a screen whose stacked
 * column ran taller than the window, that subtraction went negative, the
 * negative height was discarded as unsettled layout, and the width alone then
 * drove the symbol to its maximum while the page scrolled under it.
 *
 * The viewport bound is a floor that holds regardless of what the siblings are
 * doing; the width bound still comes from the rendered stage. The value was
 * raised from an earlier 288 after the composition probe measured the real
 * stack at 1366x768: with the symbol one module step larger than the floor
 * demands, the action row landed below the local scroller's fold. 340 buys
 * exactly that step back on short windows and changes nothing on tall ones,
 * where the width bound is the binding constraint.
 */
export const QR_VIEWPORT_RESERVED_CSS_PX = 340;

/**
 * How much room the symbol has, from measurements that cannot feed back.
 *
 * This lives next to `chooseQrBudget` rather than in the view, because "how big
 * may this symbol be" is a rendering question and the view was the only thing
 * that knew the answer. It walks up from the canvas — stage, view, scroll
 * container — so the caller supplies nothing that can drift.
 *
 * Width comes from the stage, which CSS bounds independently of the canvas
 * inside it. Height used to be the scroll container's box minus every sibling
 * of the stage, which made the measurement a function of the very layout the
 * symbol drives: once the stacked content outgrew the window the allowance
 * went negative, was discarded as unsettled, and the width alone pushed the
 * symbol to its cap — the oversized-QR regression. The height now comes from
 * the window itself minus `QR_VIEWPORT_RESERVED_CSS_PX`, a bound that holds no
 * matter what the siblings are doing.
 */
export function measureQrBudget(canvas: HTMLCanvasElement): number {
  const stage = canvas.parentElement;
  if (!stage) return QR_BUDGET_MAX_CSS_PX;

  const px = (value: string) => Number.parseFloat(value) || 0;
  const stageStyle = getComputedStyle(stage);
  const stagePadX = px(stageStyle.paddingLeft) + px(stageStyle.paddingRight);

  // A missing or non-finite innerHeight reads as "unknown", which
  // `chooseQrBudget` treats as unsettled layout rather than as a tiny window.
  const viewportBound = typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
    ? window.innerHeight - QR_VIEWPORT_RESERVED_CSS_PX
    : Number.NaN;

  return chooseQrBudget(stage.clientWidth - stagePadX, viewportBound);
}

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
