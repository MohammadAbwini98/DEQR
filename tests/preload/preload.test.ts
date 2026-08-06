import { describe, it, expect, vi } from 'vitest';

// Mock electron
const mockIpcRenderer = {
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key, api) => {
      (global as any)[key] = api;
    })
  },
  ipcRenderer: mockIpcRenderer
}));

describe('Preload Bridge', () => {
  it('exposes strictly typed API', async () => {
    // Import preload to execute exposeInMainWorld
    await import('../../src/preload/index');
    
    const deqr = (global as any).deqr;
    expect(deqr).toBeDefined();
    expect(deqr.windowControls.minimize).toBeInstanceOf(Function);
    expect(deqr.files.selectForTransfer).toBeInstanceOf(Function);
    
    // Verify no raw ipcRenderer is exposed
    expect(deqr.ipcRenderer).toBeUndefined();
    expect(deqr.send).toBeUndefined();
    expect(deqr.invoke).toBeUndefined();
  });

  it('routes correctly to ipcRenderer', async () => {
    const deqr = (global as any).deqr;
    await deqr.files.selectForTransfer();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('files:selectForTransfer');
  });

  it('manages subscriptions correctly', async () => {
    const deqr = (global as any).deqr;
    const listener = vi.fn();
    
    const unsubscribe = deqr.transfer.subscribe(123, listener);
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('transfer:frame:123', expect.any(Function));
    
    unsubscribe();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('transfer:frame:123', expect.any(Function));
  });
});
