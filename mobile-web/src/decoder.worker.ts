import jsQR from 'jsqr';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; pixels: ArrayBuffer; width: number; height: number }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, pixels, width, height } = event.data;
  try {
    const code = jsQR(new Uint8ClampedArray(pixels), width, height, { inversionAttempts: 'dontInvert' });
    if (!code?.binaryData) scope.postMessage({ id, ok: false });
    else { const bytes = Uint8Array.from(code.binaryData); scope.postMessage({ id, ok: true, bytes: bytes.buffer }, [bytes.buffer]); }
  } catch { scope.postMessage({ id, ok: false }); }
};
