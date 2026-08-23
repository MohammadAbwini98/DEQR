/**
 * QR byte-mode capacity and module geometry.
 *
 * Two things live here, and both exist to stop a transport profile being
 * chosen from a textbook.
 *
 * **Capacity** is what the shipping encoder will actually accept, derived by
 * probing `qrcode` rather than copied from a specification table. The table
 * below was produced by binary-searching the largest byte-mode payload that
 * `QRCode.create` accepts at each version and error-correction level, and
 * `tests/core/qr-capacity.test.ts` re-derives it from the installed library and
 * fails on any disagreement. A capacity table that drifts from its encoder is
 * worse than no table: it turns a profile definition into a runtime throw.
 *
 * **Geometry** is the arithmetic that keeps modules on whole pixels. A QR
 * symbol is a grid of modules; a camera reads it by sampling that grid. If the
 * rendered size is not an integer multiple of the module count, some modules
 * get one more pixel than their neighbours and every edge in the symbol lands
 * on a fractional boundary. The decoder can often still cope, and "often" is
 * not a property worth shipping when the fix is to multiply instead of divide.
 *
 * No `qrcode` import, no Node built-ins: this module is arithmetic and data, so
 * the receiver can reason about a sender's profile without carrying an encoder.
 */

export type QrEccLevel = 'L' | 'M' | 'Q' | 'H';

export const QR_ECC_LEVELS: readonly QrEccLevel[] = Object.freeze(['L', 'M', 'Q', 'H']);

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

/**
 * Largest byte-mode payload, in bytes, per version and ECC level.
 *
 * All forty versions, so choosing the smallest version that holds a frame is
 * exact rather than rounded up to whichever version happened to be sampled.
 * Rounding up costs module size, and module size is the axis the whole phase
 * turns on.
 *
 * Every number is derived, none typed:
 * `scripts/bench/phase04-qr-profiles.ts --mode capacity` binary-searches the
 * installed encoder, and `tests/core/qr-capacity.test.ts` fails on any
 * disagreement between this table and that encoder.
 */
export const QR_BYTE_CAPACITY: Readonly<Record<number, Readonly<Record<QrEccLevel, number>>>> = Object.freeze({
  1: Object.freeze({ L: 17, M: 14, Q: 11, H: 7 }),
  2: Object.freeze({ L: 32, M: 26, Q: 20, H: 14 }),
  3: Object.freeze({ L: 53, M: 42, Q: 32, H: 24 }),
  4: Object.freeze({ L: 78, M: 62, Q: 46, H: 34 }),
  5: Object.freeze({ L: 106, M: 84, Q: 60, H: 44 }),
  6: Object.freeze({ L: 134, M: 106, Q: 74, H: 58 }),
  7: Object.freeze({ L: 154, M: 122, Q: 86, H: 64 }),
  8: Object.freeze({ L: 192, M: 152, Q: 108, H: 84 }),
  9: Object.freeze({ L: 230, M: 180, Q: 130, H: 98 }),
  10: Object.freeze({ L: 271, M: 213, Q: 151, H: 119 }),
  11: Object.freeze({ L: 321, M: 251, Q: 177, H: 137 }),
  12: Object.freeze({ L: 367, M: 287, Q: 203, H: 155 }),
  13: Object.freeze({ L: 425, M: 331, Q: 241, H: 177 }),
  14: Object.freeze({ L: 458, M: 362, Q: 258, H: 194 }),
  15: Object.freeze({ L: 520, M: 412, Q: 292, H: 220 }),
  16: Object.freeze({ L: 586, M: 450, Q: 322, H: 250 }),
  17: Object.freeze({ L: 644, M: 504, Q: 364, H: 280 }),
  18: Object.freeze({ L: 718, M: 560, Q: 394, H: 310 }),
  19: Object.freeze({ L: 792, M: 624, Q: 442, H: 338 }),
  20: Object.freeze({ L: 858, M: 666, Q: 482, H: 382 }),
  21: Object.freeze({ L: 929, M: 711, Q: 509, H: 403 }),
  22: Object.freeze({ L: 1003, M: 779, Q: 565, H: 439 }),
  23: Object.freeze({ L: 1091, M: 857, Q: 611, H: 461 }),
  24: Object.freeze({ L: 1171, M: 911, Q: 661, H: 511 }),
  25: Object.freeze({ L: 1273, M: 997, Q: 715, H: 535 }),
  26: Object.freeze({ L: 1367, M: 1059, Q: 751, H: 593 }),
  27: Object.freeze({ L: 1465, M: 1125, Q: 805, H: 625 }),
  28: Object.freeze({ L: 1528, M: 1190, Q: 868, H: 658 }),
  29: Object.freeze({ L: 1628, M: 1264, Q: 908, H: 698 }),
  30: Object.freeze({ L: 1732, M: 1370, Q: 982, H: 742 }),
  31: Object.freeze({ L: 1840, M: 1452, Q: 1030, H: 790 }),
  32: Object.freeze({ L: 1952, M: 1538, Q: 1112, H: 842 }),
  33: Object.freeze({ L: 2068, M: 1628, Q: 1168, H: 898 }),
  34: Object.freeze({ L: 2188, M: 1722, Q: 1228, H: 958 }),
  35: Object.freeze({ L: 2303, M: 1809, Q: 1283, H: 983 }),
  36: Object.freeze({ L: 2431, M: 1911, Q: 1351, H: 1051 }),
  37: Object.freeze({ L: 2563, M: 1989, Q: 1423, H: 1093 }),
  38: Object.freeze({ L: 2699, M: 2099, Q: 1499, H: 1139 }),
  39: Object.freeze({ L: 2809, M: 2213, Q: 1579, H: 1219 }),
  40: Object.freeze({ L: 2953, M: 2331, Q: 1663, H: 1273 }),
});

/** Every version the table covers, ascending. */
export const QR_ALL_VERSIONS: readonly number[] = Object.freeze(
  Object.keys(QR_BYTE_CAPACITY).map(Number).sort((left, right) => left - right),
);

/**
 * The versions this program benchmarks.
 *
 * The plan names 20/24/28/32/36/40; the smaller entries are here because the
 * measurement turned out to need them - decode robustness falls away long
 * before capacity does, so the interesting region is lower than the plan
 * assumed.
 */
export const QR_BENCHMARK_VERSIONS: readonly number[] = Object.freeze(
  [10, 14, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40],
);

/**
 * Quiet zone required by the QR specification, in modules, on every side.
 *
 * Four is the specified minimum and DEQR does not go below it. It is stated as
 * a constant rather than a render option because a render option is a thing
 * somebody eventually sets to zero to fit a layout.
 */
export const QR_QUIET_ZONE_MODULES = 4;

/** Modules across one side of a QR symbol, excluding the quiet zone. */
export function qrModuleCount(version: number): number {
  if (!Number.isInteger(version) || version < QR_MIN_VERSION || version > QR_MAX_VERSION) {
    throw new Error(`QR version must be an integer in ${QR_MIN_VERSION}..${QR_MAX_VERSION}, received ${version}`);
  }
  return version * 4 + 17;
}

/** Byte-mode capacity for a version and ECC level, or `null` when not tabulated. */
export function qrByteCapacity(version: number, ecc: QrEccLevel): number | null {
  return QR_BYTE_CAPACITY[version]?.[ecc] ?? null;
}

/** Smallest tabulated version whose capacity holds `payloadBytes`, or `null`. */
export function smallestVersionFor(payloadBytes: number, ecc: QrEccLevel): number | null {
  for (const version of QR_ALL_VERSIONS) {
    const capacity = qrByteCapacity(version, ecc);
    if (capacity !== null && capacity >= payloadBytes) return version;
  }
  return null;
}

export interface QrRenderGeometry {
  version: number;
  /** Modules per side, symbol only. */
  moduleCount: number;
  quietZoneModules: number;
  /** Modules per side including both quiet zones. */
  totalModules: number;
  /** Device pixels per module. Always an integer at or above 1. */
  moduleScale: number;
  /** Canvas backing-store size in device pixels. Square. */
  pixelSize: number;
  /** CSS size to present the canvas at, so no browser resampling happens. */
  cssSize: number;
}

/**
 * Largest whole-pixel module scale that fits a budget, and the geometry it implies.
 *
 * `budgetCssPx` is how much room the layout has; `devicePixelRatio` converts
 * that to real pixels. The scale is floored to an integer, so the rendered
 * symbol is usually a little smaller than the budget - which is the point. A
 * symbol that fills its box with fractional modules is worse than one that
 * leaves a few pixels unused.
 *
 * Throws when even one device pixel per module does not fit, because silently
 * rendering an unreadable symbol is the failure this function exists to
 * prevent.
 */
export function planQrGeometry(input: {
  version: number;
  budgetCssPx: number;
  devicePixelRatio?: number;
  quietZoneModules?: number;
}): QrRenderGeometry {
  const { version, budgetCssPx } = input;
  const devicePixelRatio = input.devicePixelRatio ?? 1;
  const quietZoneModules = input.quietZoneModules ?? QR_QUIET_ZONE_MODULES;

  if (!Number.isFinite(budgetCssPx) || budgetCssPx <= 0) {
    throw new Error(`budgetCssPx must be a positive number, received ${budgetCssPx}`);
  }
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error(`devicePixelRatio must be a positive number, received ${devicePixelRatio}`);
  }
  if (!Number.isInteger(quietZoneModules) || quietZoneModules < QR_QUIET_ZONE_MODULES) {
    throw new Error(`quietZoneModules must be an integer of at least ${QR_QUIET_ZONE_MODULES}`);
  }

  const moduleCount = qrModuleCount(version);
  const totalModules = moduleCount + 2 * quietZoneModules;
  const budgetDevicePx = budgetCssPx * devicePixelRatio;
  const moduleScale = Math.floor(budgetDevicePx / totalModules);

  if (moduleScale < 1) {
    throw new Error(
      `version ${version} needs ${totalModules} modules per side; ${budgetCssPx} CSS px at ratio ${devicePixelRatio} cannot give each one a whole pixel`,
    );
  }

  const pixelSize = totalModules * moduleScale;
  return {
    version,
    moduleCount,
    quietZoneModules,
    totalModules,
    moduleScale,
    pixelSize,
    // Presenting at exactly `pixelSize / devicePixelRatio` CSS pixels means the
    // browser maps one module to a whole number of device pixels and does no
    // resampling. Any other CSS size undoes the integer scale above.
    cssSize: pixelSize / devicePixelRatio,
  };
}

/**
 * Device pixels a camera must resolve per module for a decode to be plausible.
 *
 * Not a law and not measured here: it is the sampling floor a QR decoder needs
 * before anything about lighting or focus matters, and it is the axis
 * `scripts/bench/phase04-qr-profiles.ts` sweeps. The value a real iPhone
 * achieves at a real distance is Phase 11's to certify.
 */
export const QR_NOMINAL_CAMERA_PX_PER_MODULE = 3;

/**
 * Camera pixels one side of a symbol occupies at a given sampling density.
 *
 * The useful form of the question "will this fit in the frame": a version-32
 * symbol at 3 px per module needs 459 camera pixels across the symbol alone,
 * before the quiet zone, before the symbol stops filling the viewfinder, and
 * before any of it is out of focus.
 */
export function cameraPixelsForSymbol(version: number, pxPerModule: number, quietZoneModules = QR_QUIET_ZONE_MODULES): number {
  return (qrModuleCount(version) + 2 * quietZoneModules) * pxPerModule;
}
