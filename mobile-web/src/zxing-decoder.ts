/**
 * HT-06 — zxing-cpp WASM decoder stub (QR-only).
 *
 * Real build would compile upstream zxing-cpp (Apache-2.0) to WASM with
 * - QR only, -O3, -s WASM=1, -s ALLOW_MEMORY_GROWTH=1, no exceptions,
 * exposing a minimal C interface: `int decode_qr(uint8_t* rgba, int w, int h, uint8_t* out, int* out_len)`.
 * This stub implements the same JS interface over jsQR, so the worker
 * integration, offline packaging, and fallback are testable without emscripten.
 *
 * Licensing: upstream zxing-cpp is Apache-2.0 (NOTICES in `mobile-web/NOTICES.md` when real WASM lands).
 * This stub is DEQR-owned, no AGPL.
 */

import jsQR from 'jsqr';

export interface ZxingDecodeResult {
  bytes: Uint8Array | null;
  version: number | null;
  corners: { x: number; y: number }[] | null;
  status: 'ok' | 'not_found' | 'error';
  timeMs: number;
}

export interface ZxingDecoder {
  decodeFull(image: ImageData): Promise<ZxingDecodeResult>;
  // Future: decodeTracked(crop: ImageData, geometry: QrGeometry): Promise<ZxingDecodeResult>
  dispose(): void;
}

let wasmReady = false;
let wasmLoadError: string | null = null;

export async function loadZxingDecoder(): Promise<ZxingDecoder> {
  const start = performance.now();
  try {
    // In production, this would be: const mod = await import('./zxing_wasm.js'); await mod.default();
    // For now, we simulate WASM load latency and report success.
    await new Promise(r => setTimeout(r, 5));
    wasmReady = true;
    const loadMs = performance.now() - start;
    // eslint-disable-next-line no-console
    console.debug(`[zxing] QR-only decoder ready in ${loadMs.toFixed(1)} ms (stub over jsQR)`);
    return createJsQrBackedDecoder();
  } catch (e) {
    wasmLoadError = e instanceof Error ? e.message : String(e);
    // Fallback: still return jsQR-backed decoder (product policy: WASM preferred, not mandatory)
    return createJsQrBackedDecoder();
  }
}

export function isWasmReady(): boolean { return wasmReady; }
export function getWasmLoadError(): string | null { return wasmLoadError; }

function createJsQrBackedDecoder(): ZxingDecoder {
  return {
    async decodeFull(image: ImageData): Promise<ZxingDecodeResult> {
      const t0 = performance.now();
      try {
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        const timeMs = performance.now() - t0;
        if (!code?.binaryData?.length) return { bytes: null, version: null, corners: null, status: 'not_found', timeMs };
        return {
          bytes: Uint8Array.from(code.binaryData),
          version: (code as unknown as { version?: number }).version ?? null,
          corners: code.location ? [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomRightCorner, code.location.bottomLeftCorner] : null,
          status: 'ok',
          timeMs,
        };
      } catch {
        return { bytes: null, version: null, corners: null, status: 'error', timeMs: performance.now() - t0 };
      }
    },
    dispose() {},
  };
}

/** Transfer image buffer efficiently: reuse WASM memory when real, else zero-copy via jsQR. */
export function transferImageToWasm(_rgba: Uint8Array, _w: number, _h: number): void {
  // Real WASM would copy into wasmMemory; stub does nothing (jsQR reads directly)
}
