import jsQR from 'jsqr';

const MAX_DECODE_PIXELS = 720 * 720;
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; pixels: ArrayBuffer; width: number; height: number }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, pixels, width, height } = event.data;
  const startedAt = performance.now();
  try {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > MAX_DECODE_PIXELS ||
      pixels.byteLength !== width * height * 4
    ) {
      scope.postMessage({ id, ok: false, elapsedMs: performance.now() - startedAt });
      return;
    }

    const code = jsQR(new Uint8ClampedArray(pixels), width, height, { inversionAttempts: 'dontInvert' });
    if (!code?.binaryData) {
      scope.postMessage({ id, ok: false, elapsedMs: performance.now() - startedAt });
      return;
    }

    const bytes = Uint8Array.from(code.binaryData);
    scope.postMessage({ id, ok: true, bytes: bytes.buffer, elapsedMs: performance.now() - startedAt }, [bytes.buffer]);
  } catch {
    // Do not echo decoder errors or QR data into the renderer/logs.
    scope.postMessage({ id, ok: false, elapsedMs: performance.now() - startedAt });
  }
};
