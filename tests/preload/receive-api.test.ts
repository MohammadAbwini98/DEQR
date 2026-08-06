import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcRenderer } from 'electron';

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn((key, api) => {
      (global as any)[key] = api;
    })
  }
}));

describe('Preload Receive API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes receive API on window.deqr', async () => {
    // Import preload to execute exposeInMainWorld
    await import('../../src/preload/index');
    
    const deqr = (global as any).deqr;
    expect(deqr.receive).toBeDefined();
    expect(deqr.receive.saveReceivedFile).toBeInstanceOf(Function);
  });

  it('routes saveReceivedFile to IPC', async () => {
    const deqr = (global as any).deqr;
    const dummyData = new Uint8Array([1, 2, 3]);
    
    await deqr.receive.saveReceivedFile(dummyData, 'test.txt');
    
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'receive:saveReceivedFile',
      dummyData,
      'test.txt'
    );
  });
});
