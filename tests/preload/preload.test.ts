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

  it('routes the PWA host controls to their channels', async () => {
    const deqr = (global as any).deqr;

    await deqr.pwaHost.start();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('pwaHost:start');

    await deqr.pwaHost.stop();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('pwaHost:stop');
  });

  it('subscribes and unsubscribes from the app-scoped host status channel', async () => {
    const deqr = (global as any).deqr;

    const unsubscribe = deqr.pwaHost.subscribe(vi.fn());
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('pwaHost:status', expect.any(Function));

    unsubscribe();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('pwaHost:status', expect.any(Function));
  });

  it('polls the window state through a read-only channel', async () => {
    const deqr = (global as any).deqr;

    await deqr.windowControls.isMaximized();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('windowControls:isMaximized');
  });

  it('subscribes and unsubscribes from maximize-state changes', async () => {
    const deqr = (global as any).deqr;
    const listener = vi.fn();

    const unsubscribe = deqr.windowControls.onMaximizeChanged(listener);
    expect(mockIpcRenderer.on).toHaveBeenCalledWith(
      'windowControls:maximizeChanged',
      expect.any(Function),
    );

    // The wrapper forwards the payload, not the event.
    const handler = mockIpcRenderer.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'windowControls:maximizeChanged',
    )?.[1] as (event: unknown, maximized: boolean) => void;
    handler({}, true);
    expect(listener).toHaveBeenCalledWith(true);

    unsubscribe();
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      'windowControls:maximizeChanged',
      expect.any(Function),
    );
  });
});
