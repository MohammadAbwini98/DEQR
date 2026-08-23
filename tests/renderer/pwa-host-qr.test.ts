import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas } from 'canvas';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

import { QR_QUIET_ZONE_MODULES, planQrGeometry } from '../../src/core/qr-capacity';

/**
 * The dashboard's address QR — the code someone points a phone at to install the
 * receiver.
 *
 * It was drawn by asking `qrcode` for `width: 168` and letting the library
 * divide 168 by whatever module count fell out of the address. A tailnet URL is
 * a version-2 symbol, and with the quiet zone that call was also using it came
 * to 168 / 29 = 5.79 pixels per module. `qrcode` maps each destination pixel
 * back through `floor(px / scale)`, so most modules got five pixels and roughly
 * one in five got six: the module grid a decoder looks for was not regular, and
 * every edge in the symbol sat on a fractional boundary.
 *
 * The optical renderer had already learned this (`src/renderer/qr-render.ts`
 * opens with it). This is the same rule applied to the one symbol that was
 * still dividing: multiply an integer module scale, never divide a pixel budget.
 */

const ECC = 'M' as const;
const BUDGET_CSS_PX = 168;

/** Addresses the card actually shows: a tailnet IP, a LAN IP, and a long name. */
const ADDRESSES = [
  'https://100.95.40.3:5174/',
  'https://192.168.100.41:5174/',
  'https://a-much-longer-hostname.example.internal:5174/',
];

type TestCanvas = HTMLCanvasElement & { getContext(type: '2d'): CanvasRenderingContext2D };

/** Draws exactly as `PwaHostCard` does: version resolved first, then scale. */
async function drawAddress(url: string, devicePixelRatio: number) {
  const { version } = QRCode.create(url, { errorCorrectionLevel: ECC });
  const geometry = planQrGeometry({
    version,
    budgetCssPx: BUDGET_CSS_PX,
    devicePixelRatio,
    quietZoneModules: QR_QUIET_ZONE_MODULES,
  });
  const canvas = createCanvas(geometry.pixelSize, geometry.pixelSize) as unknown as TestCanvas;
  await QRCode.toCanvas(canvas, url, {
    errorCorrectionLevel: ECC,
    version,
    scale: geometry.moduleScale,
    margin: geometry.quietZoneModules,
    color: { dark: '#000000', light: '#ffffff' },
  });
  return { canvas, geometry };
}

/**
 * Every x and y at which the image changes colour.
 *
 * On a symbol drawn at a whole-pixel module scale, every one of these is a
 * multiple of that scale. On one drawn by dividing a pixel budget, they are not
 * — which is the defect, stated as something a test can see.
 */
function edgePositions(canvas: TestCanvas, size: number): { columns: number[]; rows: number[] } {
  const { data } = canvas.getContext('2d').getImageData(0, 0, size, size);
  const dark = (x: number, y: number) => data[(y * size + x) * 4] < 128;
  const columns = new Set<number>();
  const rows = new Set<number>();
  for (let y = 0; y < size; y += 1) {
    for (let x = 1; x < size; x += 1) {
      if (dark(x, y) !== dark(x - 1, y)) columns.add(x);
      if (dark(y, x) !== dark(y, x - 1)) rows.add(x);
    }
  }
  return { columns: [...columns].sort((a, b) => a - b), rows: [...rows].sort((a, b) => a - b) };
}

describe('the dashboard address QR is drawn on whole modules', () => {
  for (const url of ADDRESSES) {
    for (const devicePixelRatio of [1, 2]) {
      it(`puts every edge on a module boundary — ${new URL(url).hostname} at ${devicePixelRatio}x`, async () => {
        const { canvas, geometry } = await drawAddress(url, devicePixelRatio);

        // The canvas is the module grid multiplied out, with nothing left over.
        expect(geometry.pixelSize).toBe(geometry.totalModules * geometry.moduleScale);
        expect(Number.isInteger(geometry.moduleScale)).toBe(true);
        expect(geometry.moduleScale).toBeGreaterThanOrEqual(1);

        const { columns, rows } = edgePositions(canvas, geometry.pixelSize);
        expect(columns.length, 'a blank symbol would pass everything below').toBeGreaterThan(0);

        // The whole assertion, in one line each way: nothing changes colour
        // part-way through a module.
        const strayColumns = columns.filter((x) => x % geometry.moduleScale !== 0);
        const strayRows = rows.filter((y) => y % geometry.moduleScale !== 0);
        expect(strayColumns, 'vertical edges inside a module').toEqual([]);
        expect(strayRows, 'horizontal edges inside a module').toEqual([]);
      });

      it(`stays scannable — ${new URL(url).hostname} at ${devicePixelRatio}x`, async () => {
        const { canvas, geometry } = await drawAddress(url, devicePixelRatio);
        const { data } = canvas
          .getContext('2d')
          .getImageData(0, 0, geometry.pixelSize, geometry.pixelSize);

        const decoded = jsQR(
          new Uint8ClampedArray(data),
          geometry.pixelSize,
          geometry.pixelSize,
        );
        expect(decoded?.data).toBe(url);
      });
    }
  }

  it('gives the symbol the quiet zone the specification requires', async () => {
    // The call this replaces passed `margin: 2`, half the specified minimum.
    // A decoder measures the quiet zone in modules, so the card's white tile
    // around the canvas is not a substitute for it.
    const { geometry } = await drawAddress(ADDRESSES[0], 2);
    expect(geometry.quietZoneModules).toBe(QR_QUIET_ZONE_MODULES);
    expect(geometry.totalModules).toBe(geometry.moduleCount + 2 * QR_QUIET_ZONE_MODULES);
  });

  it('keeps the size decision in one place', () => {
    const component = readFileSync(
      path.resolve(__dirname, '../../src/renderer/components/PwaHostCard.tsx'),
      'utf8',
    );
    const css = readFileSync(
      path.resolve(__dirname, '../../src/renderer/styles/index.css'),
      'utf8',
    );

    // `width` divides a pixel budget by module count; `scale` multiplies module
    // count by whole pixels. They differ by exactly the artefact above.
    expect(component, 'a pixel width is what caused the fractional module scale')
      .not.toMatch(/width:\s*\d+\s*,/);
    expect(component).toMatch(/scale:\s*geometry\.moduleScale/);
    expect(component, 'the canvas must be sized from the resolved geometry')
      .toMatch(/applyCanvasGeometry\(canvas, geometry\)/);

    // A stylesheet size is a second opinion the browser resolves by resampling,
    // which undoes the integer scale no matter how carefully it was chosen.
    const qrCanvasRule = css.match(/\.pwa-host-qr canvas \{[^}]*\}/)?.[0] ?? '';
    expect(qrCanvasRule, 'the QR canvas rule went missing').not.toBe('');
    expect(qrCanvasRule, 'a fixed CSS size resamples the symbol').not.toMatch(/width|height/);
  });
});
