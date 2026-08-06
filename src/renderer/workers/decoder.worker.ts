import jsQR from 'jsqr';

// We expect messages containing:
// { type: 'DECODE', id: number, imageData: Uint8ClampedArray, width: number, height: number }
self.onmessage = (e: MessageEvent) => {
  const { type, id, imageData, width, height } = e.data;
  
  if (type === 'DECODE') {
    // Execute jsQR. This is computationally heavy, hence it's in a worker.
    try {
      const code = jsQR(imageData, width, height, {
        inversionAttempts: 'dontInvert' // for performance, assuming normal QR
      });
      
      if (code && code.binaryData) {
        // Send the raw byte array back
        self.postMessage({
          type: 'DECODE_SUCCESS',
          id,
          binaryData: new Uint8Array(code.binaryData)
        });
      } else {
        self.postMessage({
          type: 'DECODE_FAIL',
          id
        });
      }
    } catch (err) {
      self.postMessage({
        type: 'DECODE_ERROR',
        id,
        error: (err as Error).message
      });
    }
  }
};
