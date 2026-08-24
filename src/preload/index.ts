import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  DeqrAPI,
  TransferStats,
  LoopbackStats,
  LoopbackOptions,
  FileSelectionResult,
  PwaHostStatusView,
  StreamingFrameResult,
  StreamingProgressView,
  StreamingSelectionResult,
  StreamingSelectOptions,
} from '../shared/types';

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
  streamTransfer: {
    select: (options?: StreamingSelectOptions): Promise<StreamingSelectionResult | null> =>
      ipcRenderer.invoke('streamTransfer:select', options),
    nextFrame: (sessionId: number): Promise<StreamingFrameResult> =>
      ipcRenderer.invoke('streamTransfer:nextFrame', sessionId),
    progress: (sessionId: number): Promise<StreamingProgressView | null> =>
      ipcRenderer.invoke('streamTransfer:progress', sessionId),
    /**
     * Starts a recovery pass for a session whose first pass has finished.
     *
     * `targets` are segment indices; omitting them recovers every segment,
     * which is the honest default when nothing has said which are missing.
     */
    beginRecovery: (sessionId: number, targets?: number[]): Promise<number | { error: unknown }> =>
      ipcRenderer.invoke('streamTransfer:beginRecovery', sessionId, targets),
    cancel: (sessionId: number): Promise<void> => ipcRenderer.invoke('streamTransfer:cancel', sessionId)
  },
  loopback: {
    start: (sessionId: number, options: LoopbackOptions): Promise<void> => ipcRenderer.invoke('loopback:start', sessionId, options),
    cancel: (sessionId: number): Promise<void> => ipcRenderer.invoke('loopback:cancel', sessionId),
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
    getStatus: () => ipcRenderer.invoke('pwaHost:getStatus'),
    start: () => ipcRenderer.invoke('pwaHost:start'),
    stop: () => ipcRenderer.invoke('pwaHost:stop'),
    subscribe: (listener: (status: PwaHostStatusView) => void) => {
      const channel = 'pwaHost:status';
      const handler = (_event: IpcRendererEvent, status: PwaHostStatusView) => {
        listener(status);
      };
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    }
  }
};

contextBridge.exposeInMainWorld('deqr', api);
