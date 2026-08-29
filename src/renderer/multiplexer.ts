/**
 * HT-09/10 — Spatial multiplexer for 1/2/4-code grids.
 * Layouts: 1×1, 2×1 landscape (HT-09), 2×2 (HT-10).
 * Each lane: same version/ECC/moduleScale/quietZone, unique sequence, independent fountain symbol.
 * Stagger: for per-code FPS F, cell phases 0, 0.5 (2-code) and 0/¼/½/¾ (4-code). Exposure crossing one update leaves other stable.
 * Update only due cell rectangle when possible; paint all due cells if multiple deadlines coincide.
 * Density guardrails: validate canvas/devicePixelRatio/moduleCount/scale.
 */

export type GridCount = 1 | 2 | 4;

export interface MultiplexLayout {
  gridCount: GridCount;
  rows: number;
  cols: number;
  cellPhases: number[]; // 0..1 per cell, e.g. [0,0.5] for 2, [0,0.25,0.5,0.75] for 4
  cellRects: { x: number; y: number; w: number; h: number }[]; // in canvas pixels, per cell
}

export function layoutForGrid(gridCount: GridCount, canvasW: number, canvasH: number, viewportW: number, viewportH: number): MultiplexLayout {
  const landscape = viewportW >= viewportH;
  if (gridCount === 1) {
    return { gridCount: 1, rows: 1, cols: 1, cellPhases: [0], cellRects: [{ x: 0, y: 0, w: canvasW, h: canvasH }] };
  }
  if (gridCount === 2) {
    // Prefer 2×1 landscape, 1×2 portrait
    if (landscape) {
      return {
        gridCount: 2, rows: 1, cols: 2,
        cellPhases: [0, 0.5],
        cellRects: [{ x: 0, y: 0, w: canvasW / 2, h: canvasH }, { x: canvasW / 2, y: 0, w: canvasW / 2, h: canvasH }],
      };
    } else {
      return {
        gridCount: 2, rows: 2, cols: 1,
        cellPhases: [0, 0.5],
        cellRects: [{ x: 0, y: 0, w: canvasW, h: canvasH / 2 }, { x: 0, y: canvasH / 2, w: canvasW, h: canvasH / 2 }],
      };
    }
  }
  // 4-code 2×2
  return {
    gridCount: 4, rows: 2, cols: 2,
    cellPhases: [0, 0.25, 0.5, 0.75],
    cellRects: [
      { x: 0, y: 0, w: canvasW / 2, h: canvasH / 2 },
      { x: canvasW / 2, y: 0, w: canvasW / 2, h: canvasH / 2 },
      { x: 0, y: canvasH / 2, w: canvasW / 2, h: canvasH / 2 },
      { x: canvasW / 2, y: canvasH / 2, w: canvasW / 2, h: canvasH / 2 },
    ],
  };
}

export function densityGuardrailValid(
  layout: MultiplexLayout,
  canvasSize: number, // CSS px budget
  devicePixelRatio: number,
  qrModuleCount: number,
  quietZoneModules: number,
): { valid: boolean; moduleScale: number; reason?: string } {
  const totalModules = qrModuleCount + 2 * quietZoneModules;
  const cellCss = Math.min(layout.cellRects[0].w, layout.cellRects[0].h) / devicePixelRatio;
  const moduleScale = Math.floor((cellCss * devicePixelRatio) / totalModules);
  if (moduleScale < 1) return { valid: false, moduleScale, reason: `cell too small for whole-pixel modules (${cellCss} CSS px, ${totalModules} modules)` };
  if (moduleScale < 2) return { valid: false, moduleScale, reason: `moduleScale ${moduleScale} <2 risks decode reliability` };
  return { valid: true, moduleScale };
}

export function dueCellsForPhase(layout: MultiplexLayout, phase: number, epsilon = 0.01): number[] {
  // phase 0..1, return indices of cells whose phase is due within epsilon
  const due: number[] = [];
  for (let i = 0; i < layout.cellPhases.length; i++) {
    const diff = Math.abs(layout.cellPhases[i] - phase);
    const wrapped = Math.min(diff, 1 - diff);
    if (wrapped < epsilon || Math.abs(phase - layout.cellPhases[i]) < epsilon) due.push(i);
  }
  return due;
}
