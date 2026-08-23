/**
 * Minimal ambient surface for `qrcode`, covering only what DEQR calls.
 *
 * Deliberately narrow rather than a full port of the package's types: every
 * member here is one this codebase actually uses, so an unused option cannot
 * quietly become a supported one.
 */
declare module 'qrcode' {
  /**
   * The symbol `qrcode` would build for this input, without drawing it.
   *
   * Used to learn the `version` — and therefore the module count — before
   * sizing a canvas. Passing that same version back to `toCanvas` is what keeps
   * the geometry and the drawn symbol describing the same thing.
   */
  export function create(
    text: any,
    options?: any,
  ): { version: number; modules: { size: number; data: Uint8Array } };

  export function toCanvas(canvas: HTMLCanvasElement, text: any, options?: any): Promise<void>;
}
