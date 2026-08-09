export class RawQrDecoder {
  private readonly worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' }); private sequence = 0; private pending = new Map<number, (value: Uint8Array | undefined) => void>();
  constructor() { this.worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; bytes?: ArrayBuffer }>) => { const resolve = this.pending.get(event.data.id); if (!resolve) return; this.pending.delete(event.data.id); resolve(event.data.ok && event.data.bytes ? new Uint8Array(event.data.bytes) : undefined); }; }
  decode(image: ImageData): Promise<Uint8Array | undefined> { const id = ++this.sequence; const pixels = image.data.slice().buffer; return new Promise((resolve) => { this.pending.set(id, resolve); this.worker.postMessage({ id, pixels, width: image.width, height: image.height }, [pixels]); }); }
  dispose(): void { this.pending.forEach((resolve) => resolve(undefined)); this.pending.clear(); this.worker.terminate(); }
}
