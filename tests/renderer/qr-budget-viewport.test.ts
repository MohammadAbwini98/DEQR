import { afterEach, describe, expect, it } from 'vitest';

import {
  QR_BUDGET_MAX_CSS_PX,
  QR_BUDGET_MIN_CSS_PX,
  QR_VIEWPORT_RESERVED_CSS_PX,
  measureQrBudget,
  resolveQrRenderPlan,
} from '../../src/renderer/qr-render';
import { QR_QUIET_ZONE_MODULES, qrModuleCount } from '../../src/core/qr-capacity';
import { TRANSPORT_PROFILES, frameBytesFor } from '../../src/core/transport-profiles';

/**
 * The transfer symbol is budgeted against the *window*, not against its
 * siblings.
 *
 * These are DOM-shaped tests rather than browser tests: `measureQrBudget`
 * reads exactly three things from the world — the stage's client width, the
 * stage's horizontal padding, and `window.innerHeight` — and stubbing those is
 * faithful in a way that re-deriving the arithmetic in the test would not be,
 * because the function under test is the real one doing the reading.
 *
 * The matrix covers every desktop viewport the remediation committed to, plus
 * the exact shape of the original regression: a stage that measures far wider
 * than the window can hold must not push the symbol past the viewport bound.
 */

const originalWindow = (globalThis as { window?: unknown }).window;
const originalGetComputedStyle = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;

function stubLayout(options: { stageWidth: number; stagePadX?: number; innerHeight?: number | undefined }): HTMLCanvasElement {
  const stage = { clientWidth: options.stageWidth } as unknown as HTMLElement;
  const padX = options.stagePadX ?? 0;
  (globalThis as { getComputedStyle: unknown }).getComputedStyle = () => ({
    paddingLeft: `${padX / 2}px`,
    paddingRight: `${padX / 2}px`,
    paddingTop: '0px',
    paddingBottom: '0px',
  });
  (globalThis as { window: unknown }).window =
    options.innerHeight === undefined ? undefined : { innerHeight: options.innerHeight };
  return { parentElement: stage } as unknown as HTMLCanvasElement;
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = originalGetComputedStyle;
});

/** The shipping default profile, looked up by name; the export is a list. */
function balancedFrameBytes(): number {
  const profile = TRANSPORT_PROFILES.find((entry) => entry.name.toLowerCase() === 'balanced');
  if (!profile) throw new Error('no balanced transport profile');
  return frameBytesFor(profile);
}

describe('the symbol budget holds at every committed desktop viewport', () => {
  // width x height of the validation viewports, smallest floor first.
  const VIEWPORTS = [
    { label: '1280x720', width: 1280, height: 720 },
    { label: '1366x768', width: 1366, height: 768 },
    { label: '1440x900', width: 1440, height: 900 },
    { label: '1536x864', width: 1536, height: 864 },
    { label: '1920x1080', width: 1920, height: 1080 },
  ] as const;

  /** Stage box the stylesheet produces at each width: min(100%, 592px) minus its own padding. */
  function stagePadPerSide(viewportWidth: number): number {
    return Math.min(Math.max(viewportWidth * 0.04, 24), 40);
  }

  for (const viewport of VIEWPORTS) {
    it(`bounds the symbol at ${viewport.label}`, () => {
      const pad = stagePadPerSide(viewport.width);
      const canvas = stubLayout({
        stageWidth: Math.min(viewport.width, 592),
        stagePadX: 2 * pad,
        innerHeight: viewport.height,
      });
      const budget = measureQrBudget(canvas);

      expect(budget).toBeGreaterThanOrEqual(QR_BUDGET_MIN_CSS_PX);
      expect(budget).toBeLessThanOrEqual(QR_BUDGET_MAX_CSS_PX);
      expect(budget).toBeLessThanOrEqual(viewport.height - QR_VIEWPORT_RESERVED_CSS_PX);

      // The plan the budget produces is square, whole-module, and fits.
      for (const ratio of [1, 1.25, 2]) {
        const { geometry } = resolveQrRenderPlan({
          frameBytes: balancedFrameBytes(),
          eccLevel: 'L',
          budgetCssPx: budget,
          devicePixelRatio: ratio,
        });
        expect(geometry.cssSize).toBeLessThanOrEqual(budget);
        expect(geometry.pixelSize).toBe(geometry.totalModules * geometry.moduleScale);
      }
    });
  }

  it('reserves room for everything else on the screen, at a sane size', () => {
    // The constant is part of the contract: zero would reintroduce the
    // overflow, and something enormous would shrink the symbol to a stamp.
    expect(QR_VIEWPORT_RESERVED_CSS_PX).toBeGreaterThanOrEqual(200);
    expect(QR_VIEWPORT_RESERVED_CSS_PX).toBeLessThanOrEqual(400);
  });

  it('keeps the quiet zone inside the drawn symbol', () => {
    const plan = resolveQrRenderPlan({
      frameBytes: balancedFrameBytes(),
      eccLevel: 'L',
      budgetCssPx: QR_BUDGET_MAX_CSS_PX,
      devicePixelRatio: 1,
    });
    expect(plan.geometry.quietZoneModules).toBe(QR_QUIET_ZONE_MODULES);
    expect(plan.geometry.totalModules).toBe(
      qrModuleCount(plan.version) + 2 * QR_QUIET_ZONE_MODULES,
    );
  });

  it('the viewport bound wins over a runaway width measurement', () => {
    // THE REGRESSION SHAPE. A stage measuring wider than the window used to be
    // the only live input, and the symbol went to its cap while the page
    // scrolled under it. The height bound must hold no matter what the stage
    // reports.
    const canvas = stubLayout({ stageWidth: 4000, stagePadX: 80, innerHeight: 768 });
    expect(measureQrBudget(canvas)).toBe(768 - QR_VIEWPORT_RESERVED_CSS_PX);

    // And below the tightest supported height a positive-but-tiny bound hits
    // the floor, because a symbol too small to resolve is not a fix either.
    const cramped = stubLayout({ stageWidth: 4000, stagePadX: 80, innerHeight: 360 });
    expect(measureQrBudget(cramped)).toBe(QR_BUDGET_MIN_CSS_PX);

    // A bound that went negative means the layout has not settled; that is
    // unsettled, not tiny, and gets the cap rather than the floor.
    const unsettled = stubLayout({ stageWidth: 4000, stagePadX: 80, innerHeight: 300 });
    expect(measureQrBudget(unsettled)).toBe(QR_BUDGET_MAX_CSS_PX);
  });

  it('treats an unreadable viewport as unsettled layout, not a tiny window', () => {
    const canvas = stubLayout({ stageWidth: 500, innerHeight: undefined });
    expect(measureQrBudget(canvas)).toBe(QR_BUDGET_MAX_CSS_PX);
  });

  it('falls back to the cap when there is no stage to measure', () => {
    const canvas = { parentElement: null } as unknown as HTMLCanvasElement;
    expect(measureQrBudget(canvas)).toBe(QR_BUDGET_MAX_CSS_PX);
  });
});