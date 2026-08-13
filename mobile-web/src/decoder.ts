export interface DecodeResult {
  bytes?: Uint8Array;
  elapsedMs: number;
}

interface PendingDecode {
  id: number;
  resolve: (value: DecodeResult) => void;
}

/** One worker and one outstanding pixel buffer keep camera pressure bounded. */
export class RawQrDecoder {
  private readonly worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
  private sequence = 0;
  private pending?: PendingDecode;
  private disposed = false;
  private failed = false;

  /**
   * @param onFailure Raised once if the scanner itself stops working. Without
   * it a worker that never loads is indistinguishable from a camera that never
   * sees a code: both just scan forever and report nothing.
   */
  constructor(private readonly onFailure?: () => void) {
    this.worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; bytes?: ArrayBuffer; elapsedMs?: number }>) => {
      const pending = this.pending;
      if (!pending || pending.id !== event.data.id) return;
      this.pending = undefined;
      pending.resolve({
        bytes: event.data.ok && event.data.bytes ? new Uint8Array(event.data.bytes) : undefined,
        elapsedMs: Number.isFinite(event.data.elapsedMs) ? Math.max(0, event.data.elapsedMs!) : 0,
      });
    };

    this.worker.onerror = () => this.fail();
  }

  decode(image: ImageData): Promise<DecodeResult> {
    if (this.disposed || this.failed || this.pending) return Promise.resolve({ elapsedMs: 0 });

    const id = ++this.sequence;
    // The ImageData is not reused after this call, so transfer its existing
    // backing buffer instead of allocating an `image.data.slice()` clone.
    const pixels = image.data.buffer;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      try {
        this.worker.postMessage({ id, pixels, width: image.width, height: image.height }, [pixels]);
      } catch {
        // A rejected post would otherwise leave `pending` set forever, and
        // every later frame would return empty without anyone noticing.
        this.fail();
      }
    });
  }

  /** True once the scanner has stopped being able to decode anything. */
  isFailed(): boolean {
    return this.failed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending?.resolve({ elapsedMs: 0 });
    this.pending = undefined;
    this.worker.terminate();
  }

  private fail(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve({ elapsedMs: 0 });
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.onFailure?.();
  }
}
