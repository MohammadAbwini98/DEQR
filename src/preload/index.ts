import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { DeqrAPI, TransferStats, LoopbackStats, LoopbackOptions, FileSelectionResult } from '../shared/types';

const api: DeqrAPI = {
  windowControls: {
    minimize: () => ipcRenderer.invoke('windowControls:minimize'),
    maximizeOrRestore: () => ipcRenderer.invoke('windowControls:maximizeOrRestore'),
    close: () => ipcRenderer.invoke('windowControls:close')
  },
  files: {
    selectForTransfer: (): Promise<FileSelectionResult | null> => ipcRenderer.invoke('files:selectForTransfer'),
    discardSelection: (sessionId: number): Promise<void> => ipcRenderer.invoke('files:discardSelection', sessionId)
  },
  transfer: {
    start: (sessionId: number): Promise<void> => ipcRenderer.invoke('transfer:start', sessionId),
    pause: (sessionId: number): Promise<void> => ipcRenderer.invoke('transfer:pause', sessionId),
    resume: (sessionId: number): Promise<void> => ipcRenderer.invoke('transfer:resume', sessionId),
    cancel: (sessionId: number): Promise<void> => ipcRenderer.invoke('transfer:cancel', sessionId),
    subscribe: (sessionId: number, listener: (framePayload: Uint8Array, stats: TransferStats) => void) => {
      const channel = `transfer:frame:${sessionId}`;
      const handler = (_event: IpcRendererEvent, payload: Uint8Array, stats: TransferStats) => {
        listener(payload, stats);
      };
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    }
  },
  loopback: {
    start: (sessionId: number, options: LoopbackOptions): Promise<void> => ipcRenderer.invoke('loopback:start', sessionId, options),
    cancel: (sessionId: number): Promise<void> => ipcRenderer.invoke('loopback:cancel', sessionId),
    saveVerifiedResult: (sessionId: number): Promise<void> => ipcRenderer.invoke('loopback:saveVerifiedResult', sessionId),
    subscribe: (sessionId: number, listener: (stats: LoopbackStats) => void) => {
      const channel = `loopback:stats:${sessionId}`;
      const handler = (_event: IpcRendererEvent, stats: LoopbackStats) => {
        listener(stats);
      };
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    }
  },
  receive: {
    saveReceivedFile: (fileData: Uint8Array, defaultName: string) =>
      ipcRenderer.invoke('receive:saveReceivedFile', fileData, defaultName)
  },
  pwaHost: {
    getStatus: () => ipcRenderer.invoke('pwaHost:getStatus')
  }
};

contextBridge.exposeInMainWorld('deqr', api);
